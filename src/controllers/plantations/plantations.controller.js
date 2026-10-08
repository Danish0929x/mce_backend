import mongoose from 'mongoose';
import { z } from 'zod';
import { Plantation } from '../../models/Plantation.js';
import { Plot } from '../../models/Plot.js';
import { Worker } from '../../models/Worker.js';
import { FertilizerSchedule } from '../../models/FertilizerSchedule.js';
import { ApplicationLog } from '../../models/ApplicationLog.js';
import { DiagnosisScan } from '../../models/DiagnosisScan.js';
import { rupeesToPaise } from '../../utils/money.js';
import { zDateOnly } from '../../utils/dates.js';
import {
  seedDefaultSchedule,
  seedWagePeriodsForPlantation,
} from '../../services/cardamom-seed.service.js';

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
  joinedAt: zDateOnly,
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

      // The published CGA circulars (brief §7.3). The planter adds newer
      // ones from the Wage Periods screen.
      await seedWagePeriodsForPlantation({
        plantationId: plantation._id,
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

// ---------- estate + plot editing (brief §5.5.1) ----------

const updatePlantationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    district: z.string().trim().min(2).max(60).optional(),
    totalAcres: z.number().positive().max(10_000).optional(),
    primaryCrop: z.string().trim().min(2).max(40).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update.',
  });

const updatePlotSchema = plotSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update.',
  });

async function callerPlantationOr404(req, res) {
  const p = await Plantation.findOne({ ownerId: req.user.sub });
  if (!p) {
    res.status(404).json({
      error: 'no_plantation',
      message: 'No estate registered yet. Complete onboarding first.',
    });
  }
  return p;
}

/** Sum of plot acreage, optionally replacing one plot's acres. */
async function plotAcreage(plantationId, { replaceId = null, replaceAcres = 0 } = {}) {
  const plots = await Plot.find({ plantationId });
  return plots.reduce(
    (sum, p) =>
      sum + (replaceId && p._id.equals(replaceId) ? replaceAcres : p.acres),
    0,
  );
}

function plotsExceedTotal(res, assigned, total) {
  return res.status(400).json({
    error: 'plots_exceed_total',
    message:
      `Plot acreage (${+assigned.toFixed(2)}) would exceed the estate total ` +
      `(${total}). Adjust the plots or the total first.`,
  });
}

// PATCH /plantations/mine — edit estate details.
export async function updateMine(req, res, next) {
  try {
    const body = updatePlantationSchema.parse(req.body);
    const p = await callerPlantationOr404(req, res);
    if (!p) return;

    if (body.totalAcres !== undefined) {
      const assigned = await plotAcreage(p._id);
      if (assigned - body.totalAcres > 0.0001) {
        return plotsExceedTotal(res, assigned, body.totalAcres);
      }
    }
    Object.assign(p, body);
    await p.save();
    res.json({ ok: true, plantation: p.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// POST /plantations/mine/plots — add a plot.
export async function addPlot(req, res, next) {
  try {
    const body = plotSchema.parse(req.body);
    const p = await callerPlantationOr404(req, res);
    if (!p) return;

    const assigned = (await plotAcreage(p._id)) + body.acres;
    if (assigned - p.totalAcres > 0.0001) {
      return plotsExceedTotal(res, assigned, p.totalAcres);
    }
    const plot = await Plot.create({
      plantationId: p._id,
      name: body.name,
      acres: body.acres,
      soilType: body.soilType ?? null,
    });
    res.status(201).json({ ok: true, plot: plot.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// PATCH /plantations/mine/plots/:id — rename / resize a plot.
export async function updatePlot(req, res, next) {
  try {
    const body = updatePlotSchema.parse(req.body);
    const p = await callerPlantationOr404(req, res);
    if (!p) return;
    const plot = await Plot.findOne({ _id: req.params.id, plantationId: p._id });
    if (!plot) return res.status(404).json({ error: 'plot_not_found' });

    if (body.acres !== undefined) {
      const assigned = await plotAcreage(p._id, {
        replaceId: plot._id,
        replaceAcres: body.acres,
      });
      if (assigned - p.totalAcres > 0.0001) {
        return plotsExceedTotal(res, assigned, p.totalAcres);
      }
    }
    if (body.name !== undefined) plot.name = body.name;
    if (body.acres !== undefined) plot.acres = body.acres;
    if (body.soilType !== undefined) plot.soilType = body.soilType ?? null;
    await plot.save();
    res.json({ ok: true, plot: plot.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// DELETE /plantations/mine/plots/:id — only for plots nothing refers to,
// so schedules, application history and scans never lose their plot.
export async function deletePlot(req, res, next) {
  try {
    const p = await callerPlantationOr404(req, res);
    if (!p) return;
    const plot = await Plot.findOne({ _id: req.params.id, plantationId: p._id });
    if (!plot) return res.status(404).json({ error: 'plot_not_found' });

    if ((await Plot.countDocuments({ plantationId: p._id })) <= 1) {
      return res.status(409).json({
        error: 'last_plot',
        message: 'An estate needs at least one plot.',
      });
    }
    const [schedules, logs, scans] = await Promise.all([
      FertilizerSchedule.countDocuments({ plotId: plot._id }),
      ApplicationLog.countDocuments({ plotId: plot._id }),
      DiagnosisScan.countDocuments({ plotId: plot._id }),
    ]);
    if (schedules + logs + scans > 0) {
      return res.status(409).json({
        error: 'plot_in_use',
        message:
          `${plot.name} is used by ${schedules} scheduled application(s), ` +
          `${logs} application record(s) and ${scans} scan(s), so it can't be ` +
          'deleted. You can rename it or change its acreage instead.',
      });
    }
    await plot.deleteOne();
    res.json({ ok: true });
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
