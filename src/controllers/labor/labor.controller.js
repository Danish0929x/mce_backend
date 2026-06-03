import { z } from 'zod';
import { Plantation } from '../../models/Plantation.js';
import { Worker } from '../../models/Worker.js';
import { Attendance } from '../../models/Attendance.js';
import { WagePeriod } from '../../models/WagePeriod.js';
import { FestivalDate } from '../../models/FestivalDate.js';
import { AnnualConfig } from '../../models/AnnualConfig.js';
import { PayrollWeek } from '../../models/PayrollWeek.js';
import { BonusRule } from '../../models/BonusRule.js';
import { BonusPayment } from '../../models/BonusPayment.js';
import { rupeesToPaise } from '../../utils/money.js';
import { calculateWeeklyPayroll } from '../../services/wage-engine.service.js';
import { calculateYearEndSettlement } from '../../services/settlement.service.js';

// ---------- helpers ----------

function startOfDayUTC(dateStr) {
  const d = new Date(dateStr);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Start of the ISO week (Monday) containing `date`, at 00:00 UTC. */
function startOfWeekMonday(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const diff = (dow + 6) % 7; // days since most recent Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

async function getCallerPlantation(req) {
  const p = await Plantation.findOne({ ownerId: req.user.sub });
  return p;
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

// ============================================================
// WORKERS
// ============================================================

export async function listWorkers(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const workers = await Worker.find({ plantationId: p._id, active: true })
      .sort({ createdAt: 1 });
    res.json({ ok: true, workers: workers.map((w) => w.toPublicJSON()) });
  } catch (err) {
    next(err);
  }
}

const createWorkerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  type: z.enum(['union', 'temp']),
  phone: z.string().regex(/^\+91\d{10}$/).optional().nullable(),
  joinedAt: z.coerce.date(),
  tempPayType: z.enum(['daily', 'hourly']).optional().nullable(),
  tempRateRupees: z.number().positive().optional().nullable(),
});

export async function createWorker(req, res, next) {
  try {
    const body = createWorkerSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    if (body.type === 'temp') {
      if (!body.tempPayType || !body.tempRateRupees) {
        return res.status(400).json({
          error: 'temp_rate_required',
          message: 'Temp workers require pay type and rate.',
        });
      }
    }

    const w = await Worker.create({
      plantationId: p._id,
      fullName: body.fullName,
      type: body.type,
      phone: body.phone ?? null,
      joinedAt: body.joinedAt,
      tempPayType: body.type === 'temp' ? body.tempPayType : null,
      tempRatePaise:
        body.type === 'temp'
          ? rupeesToPaise(String(body.tempRateRupees))
          : null,
    });
    res.status(201).json({ ok: true, worker: w.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

const updateWorkerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().regex(/^\+91\d{10}$/).nullable().optional(),
    joinedAt: z.coerce.date().optional(),
    tempRateRupees: z.number().positive().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update.',
  });

export async function updateWorker(req, res, next) {
  try {
    const body = updateWorkerSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const w = await Worker.findOne({ _id: req.params.id, plantationId: p._id });
    if (!w) return res.status(404).json({ error: 'worker_not_found' });

    if (body.fullName !== undefined) w.fullName = body.fullName;
    if (body.phone !== undefined) w.phone = body.phone;
    if (body.joinedAt !== undefined) w.joinedAt = body.joinedAt;
    if (body.active !== undefined) w.active = body.active;
    if (body.tempRateRupees !== undefined && w.type === 'temp') {
      w.tempRatePaise =
        body.tempRateRupees == null
          ? null
          : rupeesToPaise(String(body.tempRateRupees));
    }
    await w.save();
    res.json({ ok: true, worker: w.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// ============================================================
// ATTENDANCE
// ============================================================

const attendanceUpsertSchema = z.object({
  workerId: z.string().min(8),
  workDate: z.coerce.date(),
  isPresent: z.boolean(),
  hoursWorked: z.number().min(0).max(24).optional(),
  sprayingFlag: z.boolean().optional(),
  shadeFlag: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
});

/** GET /labor/attendance?date=YYYY-MM-DD — one row per active worker for that day. */
export async function getAttendanceByDate(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const date = req.query.date ? startOfDayUTC(req.query.date) : startOfDayUTC(new Date().toISOString());

    const workers = await Worker.find({ plantationId: p._id, active: true })
      .sort({ createdAt: 1 });
    const rows = await Attendance.find({
      plantationId: p._id,
      workDate: date,
    });
    const byId = new Map(rows.map((r) => [r.workerId.toString(), r]));

    res.json({
      ok: true,
      date,
      attendance: workers.map((w) => {
        const r = byId.get(w._id.toString());
        return {
          worker: w.toPublicJSON(),
          attendance: r
            ? r.toPublicJSON()
            : {
                workerId: w._id.toString(),
                workDate: date,
                isPresent: false,
                hoursWorked: 0,
                sprayingFlag: false,
                shadeFlag: false,
              },
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}

/** POST /labor/attendance — upsert a single worker's row for a date. */
export async function upsertAttendance(req, res, next) {
  try {
    const body = attendanceUpsertSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const w = await Worker.findOne({ _id: body.workerId, plantationId: p._id });
    if (!w) return res.status(404).json({ error: 'worker_not_found' });

    const workDate = startOfDayUTC(body.workDate);

    const row = await Attendance.findOneAndUpdate(
      { workerId: w._id, workDate },
      {
        $set: {
          plantationId: p._id,
          workerId: w._id,
          workDate,
          isPresent: body.isPresent,
          hoursWorked: body.isPresent ? body.hoursWorked ?? 8 : 0,
          sprayingFlag:
            w.type === 'union' && body.isPresent
              ? body.sprayingFlag ?? false
              : false,
          shadeFlag:
            w.type === 'union' && body.isPresent
              ? body.shadeFlag ?? false
              : false,
          notes: body.notes ?? '',
        },
      },
      { upsert: true, new: true },
    );

    res.status(201).json({ ok: true, attendance: row.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// ============================================================
// PAYROLL
// ============================================================

/** GET /labor/payroll/week?start=YYYY-MM-DD — all workers' pay for week starting Monday. */
export async function getWeeklyPayroll(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const baseDate = req.query.start
      ? startOfDayUTC(req.query.start)
      : new Date();
    const weekStart = startOfWeekMonday(baseDate);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    const workers = await Worker.find({ plantationId: p._id, active: true });

    // Pull a single attendance snapshot once and pass per-worker filtered slices.
    const allAttendance = await Attendance.find({
      plantationId: p._id,
      workDate: { $gte: weekStart, $lte: weekEnd },
    });

    // Pull any already-paid PayrollWeek rows for this week.
    const paidRows = await PayrollWeek.find({
      plantationId: p._id,
      weekStart,
    });
    const paidByWorker = new Map(
      paidRows.map((r) => [r.workerId.toString(), r]),
    );

    // Bonuses paid out during this week — per brief §5.4.9 they add to the
    // worker's current-week payroll. We index them per workerId for fast
    // merge in the breakdowns loop below.
    const bonusesInWeek = await BonusPayment.find({
      plantationId: p._id,
      paidAt: { $gte: weekStart, $lte: weekEnd },
    });
    const bonusByWorker = new Map();
    for (const b of bonusesInWeek) {
      const key = b.workerId.toString();
      bonusByWorker.set(key, (bonusByWorker.get(key) ?? 0) + b.amountPaise);
    }

    const breakdowns = [];
    for (const w of workers) {
      const wId = w._id.toString();
      const bonusPaise = bonusByWorker.get(wId) ?? 0;
      const paid = paidByWorker.get(wId);
      if (paid && paid.paidAt) {
        // Use the frozen snapshot — payroll is immutable once paid.
        breakdowns.push({
          worker: w.toPublicJSON(),
          weekStart: paid.weekStart,
          weekEnd: paid.weekEnd,
          workerId: wId,
          daysPresent: paid.daysPresent,
          festivalDays: paid.festivalDays,
          totalHours: paid.totalHours,
          avgDailyPaise: paid.daysPresent + paid.festivalDays > 0
              ? Math.round(paid.totalPaise / (paid.daysPresent + paid.festivalDays))
              : 0,
          basePayPaise: paid.totalPaise,
          bonusPaise,
          totalPaise: paid.totalPaise + bonusPaise,
          days: paid.days,
          paidAt: paid.paidAt,
        });
        continue;
      }
      const att = allAttendance.filter(
        (a) => a.workerId.toString() === wId,
      );
      const r = await calculateWeeklyPayroll({
        worker: w,
        attendance: att,
        weekStart,
      });
      breakdowns.push({
        worker: w.toPublicJSON(),
        ...r,
        basePayPaise: r.totalPaise,
        bonusPaise,
        totalPaise: r.totalPaise + bonusPaise,
        paidAt: null,
      });
    }

    // Group totals — wages + bonuses across all workers for this week.
    const totalPaise = breakdowns.reduce((s, b) => s + b.totalPaise, 0);
    const unionTotal = breakdowns
      .filter((b) => b.worker.type === 'union')
      .reduce((s, b) => s + b.totalPaise, 0);
    const tempTotal = breakdowns
      .filter((b) => b.worker.type === 'temp')
      .reduce((s, b) => s + b.totalPaise, 0);
    const bonusTotal = breakdowns.reduce(
      (s, b) => s + (b.bonusPaise ?? 0),
      0,
    );

    // Active wage period + warning if it expires within 30 days
    const active = await WagePeriod.activeOn(weekStart);
    const warning =
      active &&
      Math.ceil(
        (active.effectiveTo.getTime() - Date.now()) / 86_400_000,
      ) <= 30
        ? {
            label: active.label,
            endsInDays: Math.max(
              0,
              Math.ceil(
                (active.effectiveTo.getTime() - Date.now()) / 86_400_000,
              ),
            ),
          }
        : null;

    res.json({
      ok: true,
      weekStart,
      weekEnd,
      totals: {
        totalPaise,
        unionTotalPaise: unionTotal,
        tempTotalPaise: tempTotal,
        bonusTotalPaise: bonusTotal,
      },
      activePeriod: active?.toPublicJSON() ?? null,
      wagePeriodWarning: warning,
      breakdowns,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /labor/payroll/mark-paid — freeze a worker's week into PayrollWeek.
 *
 * Body: { workerId, weekStart }
 *
 * Idempotent: returns the existing PayrollWeek if it's already paid.
 * Once paid, future GET /payroll/week calls return the frozen snapshot
 * (the wage engine is bypassed for that row).
 */
const markPaidSchema = z.object({
  workerId: z.string().min(8),
  weekStart: z.coerce.date(),
});

export async function markPayrollPaid(req, res, next) {
  try {
    const body = markPaidSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const weekStart = startOfWeekMonday(body.weekStart);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    const worker = await Worker.findOne({
      _id: body.workerId,
      plantationId: p._id,
    });
    if (!worker) return res.status(404).json({ error: 'worker_not_found' });

    const existing = await PayrollWeek.findOne({
      workerId: worker._id,
      weekStart,
    });
    if (existing && existing.paidAt) {
      return res.json({ ok: true, alreadyPaid: true, payroll: existing.toPublicJSON() });
    }

    // Compute and freeze.
    const att = await Attendance.find({
      workerId: worker._id,
      workDate: { $gte: weekStart, $lte: weekEnd },
    });
    const r = await calculateWeeklyPayroll({
      worker,
      attendance: att,
      weekStart,
    });

    const doc = await PayrollWeek.findOneAndUpdate(
      { workerId: worker._id, weekStart },
      {
        $set: {
          plantationId: p._id,
          workerId: worker._id,
          weekStart,
          weekEnd,
          daysPresent: r.daysPresent,
          festivalDays: r.festivalDays ?? 0,
          totalHours: r.totalHours,
          basePayPaise: r.totalPaise,
          bonusPaise: 0,
          totalPaise: r.totalPaise,
          paidAt: new Date(),
          paidBy: req.user.sub,
          days: r.days,
        },
      },
      { upsert: true, new: true },
    );

    res.status(201).json({ ok: true, payroll: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// ============================================================
// WAGE PERIODS (read-only for now)
// ============================================================

export async function listWagePeriods(_req, res, next) {
  try {
    const periods = await WagePeriod.find({}).sort({ effectiveFrom: 1 });
    const now = new Date();
    res.json({
      ok: true,
      periods: periods.map((p) => ({
        ...p.toPublicJSON(),
        status:
          p.effectiveFrom > now
            ? 'upcoming'
            : p.effectiveTo < now
            ? 'past'
            : 'active',
      })),
    });
  } catch (err) {
    next(err);
  }
}

const wagePeriodFields = z.object({
  label: z.string().trim().min(2).max(40),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date(),
  basicRupees: z.number().positive().max(10_000),
  daRupees: z.number().nonnegative().max(10_000),
});

const wagePeriodCreateSchema = wagePeriodFields.refine(
  (v) => v.effectiveTo > v.effectiveFrom,
  { message: 'effectiveTo must be after effectiveFrom' },
);

/** POST /labor/wage-periods — add a new CGA circular. */
export async function createWagePeriod(req, res, next) {
  try {
    const body = wagePeriodCreateSchema.parse(req.body);

    // Reject overlaps with any existing period.
    const overlap = await WagePeriod.findOne({
      effectiveFrom: { $lte: body.effectiveTo },
      effectiveTo: { $gte: body.effectiveFrom },
    });
    if (overlap) {
      return res.status(409).json({
        error: 'overlap',
        message: `Date range overlaps with "${overlap.label}".`,
      });
    }

    const basicPaise = Math.round(body.basicRupees * 100);
    const daPaise = Math.round(body.daRupees * 100);
    const doc = await WagePeriod.create({
      label: body.label,
      effectiveFrom: body.effectiveFrom,
      effectiveTo: body.effectiveTo,
      basicPaise,
      daPaise,
      totalPaise: basicPaise + daPaise,
    });
    res.status(201).json({ ok: true, period: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

const wagePeriodUpdateSchema = wagePeriodFields.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'Provide at least one field to update.' },
);

// ============================================================
// FESTIVAL CALENDAR
// ============================================================

/** GET /labor/festivals?year=YYYY — list this year's marked dates. */
export async function listFestivals(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

    const [festivals, cfg] = await Promise.all([
      FestivalDate.find({
        plantationId: p._id,
        date: { $gte: start, $lte: end },
      }).sort({ date: 1 }),
      AnnualConfig.findOne({ year }),
    ]);

    res.json({
      ok: true,
      year,
      maxDays: cfg?.festivalDays ?? 13,
      marked: festivals.map((f) => f.toPublicJSON()),
    });
  } catch (err) {
    next(err);
  }
}

const festivalSchema = z.object({
  date: z.coerce.date(),
  label: z.string().trim().min(1).max(80),
});

/** POST /labor/festivals — mark a date as a paid festival day. */
export async function createFestival(req, res, next) {
  try {
    const body = festivalSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const date = startOfDayUTC(body.date);
    const year = date.getUTCFullYear();

    // Enforce annual cap from AnnualConfig.festivalDays (defaults to 13).
    const cfg = await AnnualConfig.findOne({ year });
    const maxDays = cfg?.festivalDays ?? 13;
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const count = await FestivalDate.countDocuments({
      plantationId: p._id,
      date: { $gte: yearStart, $lte: yearEnd },
    });
    if (count >= maxDays) {
      return res.status(409).json({
        error: 'limit_reached',
        message: `You already have ${count} festival days marked for ${year} (max ${maxDays}).`,
      });
    }

    try {
      const doc = await FestivalDate.create({
        plantationId: p._id,
        date,
        label: body.label,
      });
      res.status(201).json({ ok: true, festival: doc.toPublicJSON() });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({
          error: 'already_marked',
          message: 'That date is already marked as a festival.',
        });
      }
      throw err;
    }
  } catch (err) {
    next(toHttpError(err));
  }
}

/** DELETE /labor/festivals/:id — unmark a festival day. */
export async function deleteFestival(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const result = await FestivalDate.deleteOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'festival_not_found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// YEAR-END SETTLEMENT
// ============================================================

/**
 * GET /labor/settlement?year=YYYY — settlement for every active union
 * worker plus a roll-up of bonus pool and grand total.
 */
export async function getYearEndSettlement(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const year = Number(req.query.year) || new Date().getUTCFullYear();

    const workers = await Worker.find({
      plantationId: p._id,
      active: true,
    });

    const breakdowns = [];
    for (const w of workers) {
      const s = await calculateYearEndSettlement({ worker: w, year });
      breakdowns.push({
        worker: w.toPublicJSON(),
        ...s,
      });
    }

    const bonusPoolPaise = breakdowns.reduce(
      (s, b) => s + (b.components?.bonusPaise ?? 0),
      0,
    );
    const settlementTotalPaise = breakdowns.reduce(
      (s, b) => s + (b.settlementTotalPaise ?? 0),
      0,
    );
    const grandTotalPaise = breakdowns.reduce(
      (s, b) => s + (b.grandTotalPaise ?? 0),
      0,
    );

    res.json({
      ok: true,
      year,
      totals: {
        bonusPoolPaise,
        settlementTotalPaise,
        grandTotalPaise,
      },
      breakdowns,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// GRATUITY TRACKER
// ============================================================

/**
 * GET /labor/gratuity — standing liability per CGA rule:
 *   gratuity = 15 days × tenure_years × current_daily_wage
 *
 * Workers under 5 years tenure are not eligible per Indian gratuity law.
 */
export async function getGratuityTracker(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const workers = await Worker.find({
      plantationId: p._id,
      active: true,
      type: 'union',
    });

    const now = new Date();
    const activePeriod = await WagePeriod.activeOn(now);
    const config = await AnnualConfig.findOne({
      year: now.getUTCFullYear(),
    });

    const rows = [];
    let totalLiabilityPaise = 0;
    for (const w of workers) {
      const tenure = w.tenureYears();
      let dailyPaise = 0;
      if (activePeriod) {
        const result = calculateWeeklyPayroll
          ? null
          : null;
        // Compute today's daily wage for this worker (no spraying/shade).
        // Inline lightweight calc to avoid circular import on wage-engine.
        const weightage = tenure < 6
            ? 0
            : tenure <= 10
                ? 125
                : tenure <= 15
                    ? 175
                    : tenure <= 20
                        ? 230
                        : 280;
        dailyPaise = activePeriod.basicPaise + activePeriod.daPaise + weightage;
        void result;
        void config;
      }
      const eligible = tenure >= 5;
      const liabilityPaise = eligible ? 15 * tenure * dailyPaise : 0;
      if (eligible) totalLiabilityPaise += liabilityPaise;
      rows.push({
        worker: w.toPublicJSON(),
        tenureYears: tenure,
        currentDailyWagePaise: dailyPaise,
        eligible,
        liabilityPaise,
      });
    }
    rows.sort((a, b) => b.liabilityPaise - a.liabilityPaise);

    res.json({
      ok: true,
      totalLiabilityPaise,
      activePeriodLabel: activePeriod?.label ?? null,
      rows,
    });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// BONUS MANAGEMENT
// ============================================================

/** GET /labor/bonuses — list rules + recent payments + upcoming triggers. */
export async function listBonuses(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const [rules, payments, workers] = await Promise.all([
      BonusRule.find({ plantationId: p._id, active: true }).sort({ createdAt: 1 }),
      BonusPayment.find({ plantationId: p._id })
        .sort({ paidAt: -1 })
        .limit(50),
      Worker.find({ plantationId: p._id, active: true }),
    ]);

    // Compute upcoming firings within the next 30 days.
    const now = new Date();
    const horizon = new Date(now.getTime() + 30 * 86_400_000);
    const upcoming = [];
    for (const rule of rules) {
      if (rule.type === 'festive') {
        const year = now.getUTCFullYear();
        for (const y of [year, year + 1]) {
          const fireDate = new Date(Date.UTC(y, (rule.triggerMonth ?? 1) - 1, rule.triggerDay ?? 1));
          if (fireDate >= now && fireDate <= horizon) {
            upcoming.push({
              ruleId: rule._id.toString(),
              ruleName: rule.name,
              ruleType: rule.type,
              fireDate,
              amountPaise: rule.amountPaise,
              workerCount: workers.filter((w) =>
                rule.appliesTo === 'all'
                  ? true
                  : w.type === rule.appliesTo,
              ).length,
            });
          }
        }
      } else if (rule.type === 'tenure_milestone') {
        // Workers who *will hit* the milestone within the next 30 days.
        const matching = workers.filter((w) => {
          if (rule.appliesTo !== 'all' && w.type !== rule.appliesTo) return false;
          const joined = w.joinedAt;
          if (!joined) return false;
          // Find the upcoming anniversary date.
          const yrs = rule.triggerYears ?? 0;
          const anniversary = new Date(joined);
          anniversary.setUTCFullYear(joined.getUTCFullYear() + yrs);
          return anniversary >= now && anniversary <= horizon;
        });
        if (matching.length) {
          upcoming.push({
            ruleId: rule._id.toString(),
            ruleName: rule.name,
            ruleType: rule.type,
            fireDate: null,
            amountPaise: rule.amountPaise,
            workerCount: matching.length,
          });
        }
      }
    }

    res.json({
      ok: true,
      rules: rules.map((r) => r.toPublicJSON()),
      recentPayments: payments.map((p) => p.toPublicJSON()),
      upcoming,
    });
  } catch (err) {
    next(err);
  }
}

const bonusRuleCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(['festive', 'tenure_milestone']),
  amountRupees: z.number().positive().max(1_000_000),
  triggerMonth: z.number().int().min(1).max(12).optional().nullable(),
  triggerDay: z.number().int().min(1).max(31).optional().nullable(),
  triggerYears: z.number().int().min(1).max(60).optional().nullable(),
  appliesTo: z.enum(['union', 'temp', 'all']).default('union'),
});

export async function createBonusRule(req, res, next) {
  try {
    const body = bonusRuleCreateSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    if (body.type === 'festive' && (!body.triggerMonth || !body.triggerDay)) {
      return res.status(400).json({
        error: 'missing_trigger',
        message: 'Festive bonuses need a month and day.',
      });
    }
    if (body.type === 'tenure_milestone' && !body.triggerYears) {
      return res.status(400).json({
        error: 'missing_trigger',
        message: 'Tenure-milestone bonuses need a years threshold.',
      });
    }

    const doc = await BonusRule.create({
      plantationId: p._id,
      name: body.name,
      type: body.type,
      amountPaise: Math.round(body.amountRupees * 100),
      triggerMonth: body.triggerMonth ?? null,
      triggerDay: body.triggerDay ?? null,
      triggerYears: body.triggerYears ?? null,
      appliesTo: body.appliesTo,
    });
    res.status(201).json({ ok: true, rule: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

export async function deleteBonusRule(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const result = await BonusRule.deleteOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'rule_not_found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

const oneOffBonusSchema = z.object({
  workerId: z.string().min(8),
  amountRupees: z.number().positive().max(1_000_000),
  reason: z.string().trim().max(280).optional(),
});

export async function logOneOffBonus(req, res, next) {
  try {
    const body = oneOffBonusSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const w = await Worker.findOne({ _id: body.workerId, plantationId: p._id });
    if (!w) return res.status(404).json({ error: 'worker_not_found' });

    const doc = await BonusPayment.create({
      plantationId: p._id,
      workerId: w._id,
      ruleId: null,
      amountPaise: Math.round(body.amountRupees * 100),
      reason: body.reason ?? '',
      paidAt: new Date(),
    });
    res.status(201).json({ ok: true, payment: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

/** DELETE /labor/bonuses/payments/:id — undo a logged bonus. */
export async function deleteBonusPayment(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const result = await BonusPayment.deleteOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'payment_not_found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** PATCH /labor/wage-periods/:id — edit an existing circular. */
export async function updateWagePeriod(req, res, next) {
  try {
    const body = wagePeriodUpdateSchema.parse(req.body);
    const doc = await WagePeriod.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'period_not_found' });

    if (body.label !== undefined) doc.label = body.label;
    if (body.effectiveFrom !== undefined) doc.effectiveFrom = body.effectiveFrom;
    if (body.effectiveTo !== undefined) doc.effectiveTo = body.effectiveTo;
    if (body.basicRupees !== undefined) doc.basicPaise = Math.round(body.basicRupees * 100);
    if (body.daRupees !== undefined) doc.daPaise = Math.round(body.daRupees * 100);
    doc.totalPaise = doc.basicPaise + doc.daPaise;

    if (doc.effectiveTo <= doc.effectiveFrom) {
      return res.status(400).json({
        error: 'invalid_range',
        message: 'effectiveTo must be after effectiveFrom',
      });
    }

    await doc.save();
    res.json({ ok: true, period: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}
