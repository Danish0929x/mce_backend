import { z } from 'zod';
import { Plantation } from '../../models/Plantation.js';
import { Plot } from '../../models/Plot.js';
import { DiagnosisScan } from '../../models/DiagnosisScan.js';
import {
  diagnose,
  currentDiagnosisProvider,
  isNonDiagnosis,
} from '../../services/diagnosis.service.js';
import {
  buildDiagnosisContext,
  PLANT_PARTS,
} from '../../services/diagnosis-context.service.js';
import {
  accuracyReport,
  followUpInstant,
  detectRecurrence,
  parsePerAcreKg,
  inferApplicationMethod,
} from '../../services/diagnosis-feedback.service.js';
import { Fertilizer } from '../../models/Fertilizer.js';
import { FertilizerSchedule } from '../../models/FertilizerSchedule.js';
import { zDateOnly } from '../../utils/dates.js';
import { env } from '../../config/env.js';
import {
  aiScansThisMonth,
  getEntitlements,
} from '../../services/subscription.service.js';

const scanSchema = z.object({
  imageBase64: z.string().min(64),
  imageMime: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
  plotId: z.string().min(8).optional().nullable(),
  /** Optional — the model infers the part from the image when omitted. */
  plantPart: z.enum(PLANT_PARTS).optional().nullable(),
  /** Photos 2–3 of the same problem (Pro only). */
  extraImages: z
    .array(
      z.object({
        data: z.string().min(64),
        mime: z
          .enum(['image/jpeg', 'image/png', 'image/webp'])
          .default('image/jpeg'),
      }),
    )
    .max(2)
    .optional()
    .default([]),
});

async function getPlantation(req) {
  return Plantation.findOne({ ownerId: req.user.sub });
}

function toHttpError(err) {
  if (err?.name === 'ZodError') {
    const e = new Error(
      err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    e.status = 400;
    e.code = 'validation_error';
    return e;
  }
  return err;
}

/** POST /diagnosis/scan — run AI diagnosis on a new image. */
export async function createScan(req, res, next) {
  try {
    const body = scanSchema.parse(req.body);

    const p = await getPlantation(req);
    if (!p) {
      return res.status(404).json({
        error: 'no_plantation',
        message: 'Complete onboarding first.',
      });
    }

    // Reject oversize images up front (the express.json limit catches anything
    // bigger but a clean 413 message beats a generic body-too-large error).
    const oversize = [
      body.imageBase64,
      ...body.extraImages.map((i) => i.data),
    ].some((b64) => (b64.length * 3) / 4 > env.diagnosis.maxImageBytes);
    if (oversize) {
      return res.status(413).json({
        error: 'image_too_large',
        message: `Image too large. Max ${(env.diagnosis.maxImageBytes / 1024 / 1024).toFixed(1)} MB per photo.`,
      });
    }

    // Free plan: 5 AI scans a month (brief §6.1). Checked before calling
    // the AI, so a
    // refused scan costs nothing.
    const { entitlements } = await getEntitlements(req.user.sub);

    // Multi-photo is a Pro feature. Checked before the quota so a free user
    // sending 3 photos is told why, rather than spending a scan to find out.
    const photoCount = 1 + body.extraImages.length;
    if (photoCount > entitlements.photosPerScan) {
      return res.status(403).json({
        error: 'photos_per_scan',
        message:
          `Your plan allows ${entitlements.photosPerScan} photo per scan. ` +
          'Upgrade to Pro to scan up to 3 angles of the same problem at once.',
      });
    }

    const limit = entitlements.aiScansPerMonth;
    if (limit != null && (await aiScansThisMonth(p._id)) >= limit) {
      return res.status(403).json({
        error: 'scan_limit',
        message:
          `You've used all ${limit} free AI scans this month. Upgrade to ` +
          'Pro for unlimited scans, or scan again from the 1st of next month.',
      });
    }

    // Brief §6.1: quantities sized to the planter's acreage — the plot's
    // when one was picked, otherwise the whole estate.
    let areaAcres = p.totalAcres ?? null;
    let areaLabel = 'the whole estate';
    if (body.plotId) {
      const plot = await Plot.findOne({
        _id: body.plotId,
        plantationId: p._id,
      });
      if (!plot) return res.status(404).json({ error: 'plot_not_found' });
      areaAcres = plot.acres;
      areaLabel = `plot "${plot.name}"`;
    }

    // District / month / season / weather / plant part — Phase 2 spec §1.
    // Built after the quota gate so a refused scan never costs a weather call.
    const context = await buildDiagnosisContext({
      district: p.district,
      plantPart: body.plantPart ?? null,
      areaAcres,
      areaLabel,
    });

    const result = await diagnose({
      imageBase64: body.imageBase64,
      mime: body.imageMime,
      areaAcres,
      areaLabel,
      contextBlock: context.promptBlock,
      extraImages: body.extraImages,
    });

    // A refusal is not advice, so it is recorded but not billed.
    const diagnostic = !isNonDiagnosis(result.topDiagnosis);

    const doc = await DiagnosisScan.create({
      plantationId: p._id,
      plotId: body.plotId ?? null,
      plantPart: body.plantPart ?? null,
      contextSnapshot: context.snapshot,
      scannedBy: req.user.sub,
      imageBase64: body.imageBase64,
      imageMime: body.imageMime,
      extraImages: body.extraImages,
      provider: result.provider,
      modelUsed: result.modelUsed,
      rawResponse: result.rawResponse,
      topDiagnosis: result.topDiagnosis,
      symptoms: result.symptoms ?? '',
      confidence: result.confidence,
      severity: result.severity,
      isHealthy: result.isHealthy,
      alternatives: result.alternatives,
      treatment: result.treatment,
      advice: result.advice,
      areaAcres: result.areaAcres ?? null,
      isDiagnostic: diagnostic,
      // Nothing to follow up on when we did not diagnose anything.
      followUpAt: diagnostic ? followUpInstant(new Date()) : null,
      latencyMs: result.latencyMs,
    });

    // Same disease, same plot, last 30 days → the planter is told this is
    // not a fresh outbreak. Computed after the save so the new scan is
    // excluded explicitly rather than by timing.
    const recurrence = diagnostic
      ? await detectRecurrence({
          plantationId: p._id,
          plotId: body.plotId ?? null,
          topDiagnosis: result.topDiagnosis,
          excludeScanId: doc._id,
        }).catch(() => null)
      : null;

    res.status(201).json({
      ok: true,
      scan: doc.toPublicJSON({ includeImage: true }),
      recurrence,
      // So the app can tell the planter this one was free.
      chargedToQuota: diagnostic,
    });
  } catch (err) {
    next(toHttpError(err));
  }
}

/** GET /diagnosis — list this user's scans (newest first, no image bytes). */
export async function listScans(req, res, next) {
  try {
    const p = await getPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const scans = await DiagnosisScan.find({ plantationId: p._id })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json({
      ok: true,
      provider: currentDiagnosisProvider,
      scans: scans.map((s) => s.toPublicJSON({ includeImage: false })),
    });
  } catch (err) {
    next(err);
  }
}

/** GET /diagnosis/:id — full scan including image bytes. */
export async function getScan(req, res, next) {
  try {
    const p = await getPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const scan = await DiagnosisScan.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });
    res.json({
      ok: true,
      scan: scan.toPublicJSON({ includeImage: true }),
    });
  } catch (err) {
    next(err);
  }
}

/** DELETE /diagnosis/:id — remove a scan from history. */
export async function deleteScan(req, res, next) {
  try {
    const p = await getPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const r = await DiagnosisScan.deleteOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (r.deletedCount === 0) {
      return res.status(404).json({ error: 'scan_not_found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ---------- feedback (Phase 2 spec: "did the treatment work?") ----------

const feedbackSchema = z.object({
  outcome: z.enum(['worked', 'partial', 'failed']),
  note: z.string().max(1000).optional().default(''),
});

/**
 * POST /diagnosis/:id/feedback — record whether the treatment worked.
 *
 * Idempotent by design: re-posting overwrites the previous answer rather
 * than erroring, because a planter who first said "partial" and later sees
 * it clear up should be able to correct themselves.
 */
export async function submitFeedback(req, res, next) {
  try {
    const body = feedbackSchema.parse(req.body);
    const p = await getPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const scan = await DiagnosisScan.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });

    scan.feedback = { outcome: body.outcome, note: body.note, at: new Date() };
    // Reporting an outcome implies they acted on it.
    if (!scan.treatmentTaken) {
      scan.treatmentTaken = true;
      scan.treatmentTakenAt = scan.treatmentTakenAt ?? new Date();
    }
    // Nothing left to ask about.
    scan.followUpAt = null;
    await scan.save();

    res.json({ ok: true, scan: scan.toPublicJSON({ includeImage: false }) });
  } catch (err) {
    next(toHttpError(err));
  }
}

const treatmentTakenSchema = z.object({ taken: z.boolean() });

/** PATCH /diagnosis/:id/treatment-taken — the planter's own checkbox. */
export async function setTreatmentTaken(req, res, next) {
  try {
    const body = treatmentTakenSchema.parse(req.body);
    const p = await getPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const scan = await DiagnosisScan.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });

    scan.treatmentTaken = body.taken;
    scan.treatmentTakenAt = body.taken ? new Date() : null;
    // Un-ticking it means there is nothing to follow up on.
    if (!body.taken && !scan.feedback) scan.followUpAt = null;
    await scan.save();

    res.json({ ok: true, scan: scan.toPublicJSON({ includeImage: false }) });
  } catch (err) {
    next(toHttpError(err));
  }
}

/**
 * GET /diagnosis/follow-ups — scans still awaiting an outcome.
 *
 * The phone schedules its own local notifications, so this exists only so
 * the app can rebuild them after a reinstall or a new device.
 */
export async function listFollowUps(req, res, next) {
  try {
    const p = await getPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const scans = await DiagnosisScan.find({
      plantationId: p._id,
      followUpAt: { $ne: null },
      feedback: null,
    })
      .sort({ followUpAt: 1 })
      .limit(50)
      .select('_id topDiagnosis followUpAt createdAt');

    res.json({
      ok: true,
      followUps: scans.map((s) => ({
        scanId: s._id.toString(),
        topDiagnosis: s.topDiagnosis,
        followUpAt: s.followUpAt,
        scannedAt: s.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ---------- admin ----------

/** GET /admin/diagnosis/accuracy — model performance for the Griffon team. */
export async function getAccuracyReport(req, res, next) {
  try {
    const q = z
      .object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        minScans: z.coerce.number().int().min(1).max(1000).optional(),
      })
      .parse(req.query);

    res.json({ ok: true, report: await accuracyReport(q) });
  } catch (err) {
    next(toHttpError(err));
  }
}

// ---------- add a recommended treatment to the schedule ----------

const addToScheduleSchema = z.object({
  /** Which recommended product. Defaults to the first one listed. */
  product: z.string().min(2).max(120).optional(),
  scheduledDate: zDateOnly,
  /**
   * kg per acre. Required when the dose is expressed by concentration
   * ("2 ml/litre") rather than weight, since there is no kg to infer.
   */
  perAcreKg: z.number().positive().max(10_000).optional(),
  applicationMethod: z
    .enum(['soil-drench', 'foliar-spray', 'broadcasting', 'fertigation'])
    .optional(),
});

/**
 * POST /diagnosis/:id/add-to-schedule — spec: "'Add to schedule' CTA adds
 * the treatment to fertilizer_schedule with a pre-filled entry".
 *
 * ## Why a crop-protection product becomes a Fertilizer row
 * The schedule references `Fertilizer`, but a diagnosis recommends
 * fungicides and insecticides, which are not fertilizers. Rather than
 * duplicate the whole schedule/inventory/reminder pipeline for a parallel
 * "treatment schedule", the product is registered as a plantation-scoped
 * custom Fertilizer with nutrientType 'crop-protection'. The planter gets
 * reminders, inventory and application logging for free, and the spec's
 * instruction to use fertilizer_schedule is honoured literally.
 */
export async function addTreatmentToSchedule(req, res, next) {
  try {
    const body = addToScheduleSchema.parse(req.body);
    const p = await getPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const scan = await DiagnosisScan.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!scan) return res.status(404).json({ error: 'scan_not_found' });

    const products = scan.treatment?.products ?? [];
    const product = body.product ?? products[0];
    if (!product) {
      return res.status(422).json({
        error: 'no_product',
        message: 'This diagnosis does not recommend a product to schedule.',
      });
    }
    if (body.product && !products.includes(body.product)) {
      return res.status(422).json({
        error: 'product_not_recommended',
        message: 'That product is not one this diagnosis recommended.',
      });
    }

    // kg/acre: the planter's number wins; otherwise read it off the dose.
    const perAcreKg =
      body.perAcreKg ?? parsePerAcreKg(scan.treatment?.doseringPerAcre);
    if (!perAcreKg) {
      return res.status(422).json({
        error: 'dose_not_in_kg',
        message:
          'This treatment is dosed by concentration, not weight. Enter how ' +
          'many kg per acre you plan to use.',
      });
    }

    const acres = scan.areaAcres ?? p.totalAcres ?? 0;
    if (!(acres > 0)) {
      return res.status(422).json({ error: 'no_acreage' });
    }

    // Find-or-create the custom product, so repeat treatments reuse one row.
    const fertilizer = await Fertilizer.findOneAndUpdate(
      { plantationId: p._id, name: product },
      {
        $setOnInsert: {
          plantationId: p._id,
          name: product,
          nutrientType: 'crop-protection',
          form: 'powder',
          description: `Added from an AI diagnosis — ${scan.topDiagnosis}.`,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    const entry = await FertilizerSchedule.create({
      plantationId: p._id,
      fertilizerId: fertilizer._id,
      plotId: scan.plotId ?? null,
      scheduledDate: body.scheduledDate,
      perAcreKg,
      totalQuantityKg: Number((perAcreKg * acres).toFixed(3)),
      applicationMethod:
        body.applicationMethod ?? inferApplicationMethod(scan.treatment),
      // Carry the dose text and safety guidance across — the schedule screen
      // is where the planter will next see this, possibly weeks later.
      notes: [
        `From AI scan: ${scan.topDiagnosis}.`,
        scan.treatment?.doseringPerAcre &&
          `Dose: ${scan.treatment.doseringPerAcre}.`,
        scan.treatment?.reEntryInterval &&
          `Re-entry: ${scan.treatment.reEntryInterval}`,
      ]
        .filter(Boolean)
        .join(' '),
    });

    res.status(201).json({
      ok: true,
      scheduleEntry: entry.toPublicJSON(),
      fertilizer: fertilizer.toPublicJSON(),
    });
  } catch (err) {
    next(toHttpError(err));
  }
}
