import mongoose from 'mongoose';
import { z } from 'zod';
import { Plantation } from '../../models/Plantation.js';
import { Plot } from '../../models/Plot.js';
import { Worker } from '../../models/Worker.js';
import { rupeesToPaise } from '../../utils/money.js';
import { seedDefaultSchedule } from '../../services/cardamom-seed.service.js';

// ---------- validation schemas ----------

const plotSchema = z.object({
  name: z.string().trim().min(1).max(80),
  acres: z.number().positive().max(10_000),
  soilType: z.string().trim().min(1).max(40).optional().nullable(),
});

const firstWorkerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  type: z.enum(['union', 'temp']),
  phone: z
    .string()
    .regex(/^\+91\d{10}$/)
    .optional()
    .nullable(),
  joinedAt: z.coerce.date(),
  tempPayType: z.enum(['daily', 'hourly']).optional().nullable(),
  // Rupees from the client; we convert to paise before save.
  tempRateRupees: z.number().positive().optional().nullable(),
});

const createPlantationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  district: z.string().trim().min(2).max(60),
  totalAcres: z.number().positive().max(10_000),
  primaryCrop: z.string().trim().min(2).max(40).optional(),
  plots: z.array(plotSchema).min(1).max(100),
  firstWorker: firstWorkerSchema.optional().nullable(),
});

// ---------- controllers ----------

// Create — finalize onboarding. Creates the plantation, all plots, and the
// optional first worker in a single transaction so partial failures roll back.
export async function create(req, res, next) {
  const session = await mongoose.startSession();
  try {
    const body = createPlantationSchema.parse(req.body);

    // Plot acreage sanity (must not exceed estate total).
    const assigned = body.plots.reduce((sum, p) => sum + p.acres, 0);
    if (assigned - body.totalAcres > 0.0001) {
      return res.status(400).json({
        error: 'plots_exceed_total',
        message: `Plot acreage (${assigned}) exceeds estate total (${body.totalAcres}).`,
      });
    }

    // Temp workers must supply pay type + rate.
    if (body.firstWorker?.type === 'temp') {
      const w = body.firstWorker;
      if (!w.tempPayType || !w.tempRateRupees) {
        return res.status(400).json({
          error: 'temp_rate_required',
          message: 'Temp workers require pay type and rate.',
        });
      }
    }

    // One user, one plantation (MVP rule).
    const existing = await Plantation.findOne({ ownerId: req.user.sub });
    if (existing) {
      return res.status(409).json({
        error: 'plantation_exists',
        message: 'You already have an estate registered.',
      });
    }

    let plantation, plots, workers;
    await session.withTransaction(async () => {
      [plantation] = await Plantation.create(
        [
          {
            ownerId: req.user.sub,
            name: body.name,
            district: body.district,
            totalAcres: body.totalAcres,
            primaryCrop: body.primaryCrop ?? 'Cardamom',
          },
        ],
        { session },
      );

      plots = await Plot.create(
        body.plots.map((p) => ({
          plantationId: plantation._id,
          name: p.name,
          acres: p.acres,
          soilType: p.soilType ?? null,
        })),
        { session, ordered: true },
      );

      workers = [];
      if (body.firstWorker) {
        const w = body.firstWorker;
        const [worker] = await Worker.create(
          [
            {
              plantationId: plantation._id,
              fullName: w.fullName,
              phone: w.phone ?? null,
              type: w.type,
              joinedAt: w.joinedAt,
              tempPayType: w.type === 'temp' ? w.tempPayType : null,
              tempRatePaise:
                w.type === 'temp'
                  ? rupeesToPaise(String(w.tempRateRupees))
                  : null,
            },
          ],
          { session },
        );
        workers.push(worker);
      }

      // Seed the default 12-app cardamom fertilizer schedule for this
      // plantation. Brief §5.1.2 step 4 (default schedule activation).
      await seedDefaultSchedule({
        plantationId: plantation._id,
        totalAcres: body.totalAcres,
        startDate: new Date(),
        session,
      });
    });

    res.status(201).json({
      ok: true,
      plantation: plantation.toPublicJSON(),
      plots: plots.map((p) => p.toPublicJSON()),
      workers: workers.map((w) => w.toPublicJSON()),
    });
  } catch (err) {
    next(toHttpError(err));
  } finally {
    session.endSession();
  }
}

// Mine — return the caller's plantation + plots + workers.
export async function mine(req, res, next) {
  try {
    const plantation = await Plantation.findOne({ ownerId: req.user.sub });
    if (!plantation) {
      return res.status(404).json({
        error: 'no_plantation',
        message: 'No estate registered yet. Complete onboarding first.',
      });
    }
    const [plots, workers] = await Promise.all([
      Plot.find({ plantationId: plantation._id }),
      Worker.find({ plantationId: plantation._id, active: true }),
    ]);
    res.json({
      ok: true,
      plantation: plantation.toPublicJSON(),
      plots: plots.map((p) => p.toPublicJSON()),
      workers: workers.map((w) => w.toPublicJSON()),
    });
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
  if (err?.code === 11000) {
    const e = new Error('Duplicate value violates a unique constraint.');
    e.status = 409;
    e.code = 'duplicate';
    return e;
  }
  return err;
}
