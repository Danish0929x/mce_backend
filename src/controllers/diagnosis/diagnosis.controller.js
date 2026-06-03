import { z } from 'zod';
import { Plantation } from '../../models/Plantation.js';
import { Plot } from '../../models/Plot.js';
import { DiagnosisScan } from '../../models/DiagnosisScan.js';
import {
  diagnose,
  currentDiagnosisProvider,
} from '../../services/diagnosis.service.js';
import { env } from '../../config/env.js';

const scanSchema = z.object({
  imageBase64: z.string().min(64),
  imageMime: z.enum(['image/jpeg', 'image/png', 'image/webp']).default('image/jpeg'),
  plotId: z.string().min(8).optional().nullable(),
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
    const estimatedBytes = (body.imageBase64.length * 3) / 4;
    if (estimatedBytes > env.diagnosis.maxImageBytes) {
      return res.status(413).json({
        error: 'image_too_large',
        message: `Image too large. Max ${(env.diagnosis.maxImageBytes / 1024 / 1024).toFixed(1)} MB.`,
      });
    }

    if (body.plotId) {
      const plot = await Plot.findOne({
        _id: body.plotId,
        plantationId: p._id,
      });
      if (!plot) return res.status(404).json({ error: 'plot_not_found' });
    }

    const result = await diagnose({
      imageBase64: body.imageBase64,
      mime: body.imageMime,
    });

    const doc = await DiagnosisScan.create({
      plantationId: p._id,
      plotId: body.plotId ?? null,
      scannedBy: req.user.sub,
      imageBase64: body.imageBase64,
      imageMime: body.imageMime,
      provider: result.provider,
      modelUsed: result.modelUsed,
      rawResponse: result.rawResponse,
      topDiagnosis: result.topDiagnosis,
      confidence: result.confidence,
      severity: result.severity,
      isHealthy: result.isHealthy,
      alternatives: result.alternatives,
      treatment: result.treatment,
      advice: result.advice,
      latencyMs: result.latencyMs,
    });

    res.status(201).json({
      ok: true,
      scan: doc.toPublicJSON({ includeImage: true }),
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
