import mongoose from 'mongoose';
import { z } from 'zod';
import { Plantation } from '../../models/Plantation.js';
import { Plot } from '../../models/Plot.js';
import { Fertilizer } from '../../models/Fertilizer.js';
import { Inventory } from '../../models/Inventory.js';
import { FertilizerSchedule } from '../../models/FertilizerSchedule.js';
import { ApplicationLog } from '../../models/ApplicationLog.js';
import { StockPurchase } from '../../models/StockPurchase.js';
import { rupeesToPaise } from '../../utils/money.js';

/**
 * Composite read for the Fertilizer / Schedule screen. Returns everything
 * the 3 tabs need in a single round trip:
 *   - upcoming     (status in ['upcoming', 'due'])
 *   - applicationLog (recent completed apps, newest first)
 *   - inventory    (one row per fertilizer)
 *   - fertilizers  (lookup table for names)
 *   - plots        (lookup table for plot names)
 *
 * The Flutter client does the tab splitting + sorting. Keeping it server-
 * driven would mean three round-trips and slower screen open.
 */
export async function fertilizerOverview(req, res, next) {
  try {
    const plantation = await Plantation.findOne({ ownerId: req.user.sub });
    if (!plantation) {
      return res.status(404).json({
        error: 'no_plantation',
        message: 'Complete onboarding first.',
      });
    }
    const plantationId = plantation._id;

    // Promote due upcoming items so the status badge is accurate. Done
    // server-side at every read; no cron job needed.
    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    await FertilizerSchedule.updateMany(
      {
        plantationId,
        status: 'upcoming',
        scheduledDate: { $lte: today },
      },
      { $set: { status: 'due' } },
    );

    const [upcoming, log, inventory, fertilizers, plots] = await Promise.all([
      FertilizerSchedule.find({
        plantationId,
        status: { $in: ['upcoming', 'due'] },
      }).sort({ scheduledDate: 1 }),
      ApplicationLog.find({ plantationId }).sort({ appliedAt: -1 }).limit(50),
      Inventory.find({ plantationId }),
      Fertilizer.find({
        $or: [{ plantationId: null }, { plantationId }],
      }),
      Plot.find({ plantationId }),
    ]);

    res.json({
      ok: true,
      upcoming: upcoming.map((s) => s.toPublicJSON()),
      applicationLog: log.map((l) => l.toPublicJSON()),
      inventory: inventory.map((i) => i.toPublicJSON()),
      fertilizers: fertilizers.map((f) => f.toPublicJSON()),
      plots: plots.map((p) => p.toPublicJSON()),
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// WRITES
// ============================================================

const markAppliedSchema = z.object({
  scheduleId: z.string().min(8),
  quantityUsedKg: z.number().positive(),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Mark a scheduled application as done.
 * Atomically: schedule → completed, ApplicationLog row, Inventory $inc -used.
 */
export async function markApplied(req, res, next) {
  const session = await mongoose.startSession();
  try {
    const body = markAppliedSchema.parse(req.body);

    const plantation = await Plantation.findOne({ ownerId: req.user.sub });
    if (!plantation) {
      return res.status(404).json({ error: 'no_plantation' });
    }
    const plantationId = plantation._id;

    const schedule = await FertilizerSchedule.findOne({
      _id: body.scheduleId,
      plantationId,
    });
    if (!schedule) {
      return res.status(404).json({ error: 'schedule_not_found' });
    }
    if (schedule.status === 'completed') {
      return res.status(409).json({
        error: 'already_completed',
        message: 'This application was already marked as done.',
      });
    }

    const usedGrams = Math.round(body.quantityUsedKg * 1000);
    let logDoc, invDoc;

    await session.withTransaction(async () => {
      schedule.status = 'completed';
      await schedule.save({ session });

      [logDoc] = await ApplicationLog.create(
        [
          {
            plantationId,
            fertilizerId: schedule.fertilizerId,
            plotId: schedule.plotId,
            scheduleId: schedule._id,
            quantityUsedGrams: usedGrams,
            applicationMethod: schedule.applicationMethod,
            appliedAt: new Date(),
            appliedBy: req.user.sub,
          },
        ],
        { session },
      );

      // Upsert inventory row, atomically decrement (floor at 0).
      const inv = await Inventory.findOne(
        { plantationId, fertilizerId: schedule.fertilizerId },
        null,
        { session },
      );
      if (inv) {
        inv.quantityGrams = Math.max(0, inv.quantityGrams - usedGrams);
        invDoc = await inv.save({ session });
      } else {
        // No prior purchases — create a zero-balance row so subsequent
        // tracking is consistent.
        [invDoc] = await Inventory.create(
          [
            {
              plantationId,
              fertilizerId: schedule.fertilizerId,
              quantityGrams: 0,
            },
          ],
          { session },
        );
      }
    });

    res.status(201).json({
      ok: true,
      schedule: schedule.toPublicJSON(),
      applicationLog: logDoc.toPublicJSON(),
      inventory: invDoc.toPublicJSON(),
    });
  } catch (err) {
    next(toHttpError(err));
  } finally {
    session.endSession();
  }
}

const logStockSchema = z.object({
  fertilizerId: z.string().min(8),
  quantityKg: z.number().positive(),
  pricePerKgRupees: z.number().positive(),
  supplier: z.string().trim().max(120).optional().nullable(),
});

/**
 * Log a fertilizer stock purchase. Atomically: StockPurchase row +
 * Inventory $inc +quantity (upserts the row if it doesn't exist).
 */
export async function logStockPurchase(req, res, next) {
  const session = await mongoose.startSession();
  try {
    const body = logStockSchema.parse(req.body);

    const plantation = await Plantation.findOne({ ownerId: req.user.sub });
    if (!plantation) {
      return res.status(404).json({ error: 'no_plantation' });
    }
    const plantationId = plantation._id;

    // Confirm the fertilizer exists AND is accessible (system or owned).
    const fert = await Fertilizer.findOne({
      _id: body.fertilizerId,
      $or: [{ plantationId: null }, { plantationId }],
    });
    if (!fert) {
      return res.status(404).json({ error: 'fertilizer_not_found' });
    }

    const grams = Math.round(body.quantityKg * 1000);
    const pricePerKgPaise = rupeesToPaise(String(body.pricePerKgRupees));
    const totalCostPaise = Math.round((grams / 1000) * pricePerKgPaise);

    let purchaseDoc, invDoc;
    await session.withTransaction(async () => {
      [purchaseDoc] = await StockPurchase.create(
        [
          {
            plantationId,
            fertilizerId: fert._id,
            quantityGrams: grams,
            pricePerKgPaise,
            totalCostPaise,
            supplier: body.supplier ?? null,
            purchasedAt: new Date(),
          },
        ],
        { session },
      );

      invDoc = await Inventory.findOneAndUpdate(
        { plantationId, fertilizerId: fert._id },
        { $inc: { quantityGrams: grams } },
        { upsert: true, new: true, session },
      );
    });

    res.status(201).json({
      ok: true,
      purchase: purchaseDoc.toPublicJSON(),
      inventory: invDoc.toPublicJSON(),
    });
  } catch (err) {
    next(toHttpError(err));
  } finally {
    session.endSession();
  }
}

const createScheduleSchema = z.object({
  fertilizerId: z.string().min(8),
  plotId: z.string().min(8).optional().nullable(),
  scheduledDate: z.coerce.date(),
  perAcreKg: z.number().positive(),
  totalQuantityKg: z.number().positive().optional(),
  applicationMethod: z
    .enum(['broadcasting', 'soil-drench', 'foliar-spray', 'fertigation'])
    .default('broadcasting'),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Create a custom (off-calendar) schedule entry.
 * Total qty defaults to perAcreKg × (plot.acres OR plantation.totalAcres).
 */
export async function createScheduleEntry(req, res, next) {
  try {
    const body = createScheduleSchema.parse(req.body);

    const plantation = await Plantation.findOne({ ownerId: req.user.sub });
    if (!plantation) {
      return res.status(404).json({ error: 'no_plantation' });
    }

    const fert = await Fertilizer.findOne({
      _id: body.fertilizerId,
      $or: [{ plantationId: null }, { plantationId: plantation._id }],
    });
    if (!fert) {
      return res.status(404).json({ error: 'fertilizer_not_found' });
    }

    let acreage = plantation.totalAcres;
    if (body.plotId) {
      const plot = await Plot.findOne({
        _id: body.plotId,
        plantationId: plantation._id,
      });
      if (!plot) {
        return res.status(404).json({ error: 'plot_not_found' });
      }
      acreage = plot.acres;
    }

    const totalQty =
      body.totalQuantityKg ??
      Math.round(body.perAcreKg * acreage * 100) / 100;

    const doc = await FertilizerSchedule.create({
      plantationId: plantation._id,
      fertilizerId: fert._id,
      plotId: body.plotId ?? null,
      scheduledDate: body.scheduledDate,
      perAcreKg: body.perAcreKg,
      totalQuantityKg: totalQty,
      applicationMethod: body.applicationMethod,
      status: 'upcoming',
      notes: body.notes ?? '',
    });

    res.status(201).json({ ok: true, schedule: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

const updateScheduleSchema = z
  .object({
    plotId: z.string().min(8).nullable().optional(),
    scheduledDate: z.coerce.date().optional(),
    perAcreKg: z.number().positive().optional(),
    totalQuantityKg: z.number().positive().optional(),
    applicationMethod: z
      .enum(['broadcasting', 'soil-drench', 'foliar-spray', 'fertigation'])
      .optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) => Object.keys(v).length > 0,
    { message: 'Provide at least one field to update.' },
  );

/**
 * Edit an existing schedule entry. Completed/skipped entries cannot be edited
 * (they're historical record).
 */
export async function updateScheduleEntry(req, res, next) {
  try {
    const body = updateScheduleSchema.parse(req.body);

    const plantation = await Plantation.findOne({ ownerId: req.user.sub });
    if (!plantation) {
      return res.status(404).json({ error: 'no_plantation' });
    }

    const doc = await FertilizerSchedule.findOne({
      _id: req.params.id,
      plantationId: plantation._id,
    });
    if (!doc) {
      return res.status(404).json({ error: 'schedule_not_found' });
    }
    if (doc.status === 'completed' || doc.status === 'skipped') {
      return res.status(409).json({
        error: 'locked',
        message:
          'This entry is already completed or skipped and cannot be edited.',
      });
    }

    if (body.plotId !== undefined) {
      if (body.plotId !== null) {
        const plot = await Plot.findOne({
          _id: body.plotId,
          plantationId: plantation._id,
        });
        if (!plot) return res.status(404).json({ error: 'plot_not_found' });
      }
      doc.plotId = body.plotId;
    }
    if (body.scheduledDate !== undefined) doc.scheduledDate = body.scheduledDate;
    if (body.perAcreKg !== undefined) doc.perAcreKg = body.perAcreKg;
    if (body.totalQuantityKg !== undefined) doc.totalQuantityKg = body.totalQuantityKg;
    if (body.applicationMethod !== undefined) doc.applicationMethod = body.applicationMethod;
    if (body.notes !== undefined) doc.notes = body.notes;

    // Re-promote due/upcoming based on the new date.
    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    if (doc.status === 'upcoming' && doc.scheduledDate <= today) {
      doc.status = 'due';
    } else if (doc.status === 'due' && doc.scheduledDate > today) {
      doc.status = 'upcoming';
    }

    await doc.save();
    res.json({ ok: true, schedule: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

/** Mark a schedule entry as skipped (e.g. weather pushed it out). */
export async function skipScheduleEntry(req, res, next) {
  try {
    const plantation = await Plantation.findOne({ ownerId: req.user.sub });
    if (!plantation) {
      return res.status(404).json({ error: 'no_plantation' });
    }
    const doc = await FertilizerSchedule.findOne({
      _id: req.params.id,
      plantationId: plantation._id,
    });
    if (!doc) {
      return res.status(404).json({ error: 'schedule_not_found' });
    }
    if (doc.status === 'completed') {
      return res.status(409).json({
        error: 'already_completed',
        message: 'This application is already completed — it cannot be skipped.',
      });
    }
    doc.status = 'skipped';
    await doc.save();
    res.json({ ok: true, schedule: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// ---------- shared error mapper ----------

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
