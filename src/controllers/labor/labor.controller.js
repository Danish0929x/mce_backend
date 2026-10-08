import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import { Plantation } from '../../models/Plantation.js';
import { User } from '../../models/User.js';
import { Worker } from '../../models/Worker.js';
import { Attendance } from '../../models/Attendance.js';
import { WagePeriod } from '../../models/WagePeriod.js';
import { FestivalDate } from '../../models/FestivalDate.js';
import { AnnualConfig } from '../../models/AnnualConfig.js';
import { PayrollWeek } from '../../models/PayrollWeek.js';
import { BonusRule } from '../../models/BonusRule.js';
import { BonusPayment } from '../../models/BonusPayment.js';
import { YearEndSettlement } from '../../models/YearEndSettlement.js';
import { rupeesToPaise } from '../../utils/money.js';
import {
  addDays,
  currentYearIST,
  daysBetween,
  endOfDay,
  istDateOnly,
  istInstantRange,
  startOfWeekMonday,
  todayIST,
  zDateKey,
  zDateOnly,
} from '../../utils/dates.js';
import {
  calculateWeeklyPayroll,
  tempRateOn,
  tenureYearsAt,
  weightagePaise,
} from '../../services/wage-engine.service.js';
import {
  calculateYearEndSettlement,
  isSettlementYearOver,
  settlementTotals,
  settlementYearRange,
} from '../../services/settlement.service.js';
import { materializeDueRuleBonuses } from '../../services/bonus-rules.service.js';
import { fixedHolidaysFor } from '../../services/festival-calendar.service.js';
import { getEntitlements } from '../../services/subscription.service.js';

// ---------- helpers ----------

/** Parse an optional date-only query param, falling back to today (IST). */
function queryDateOr(value, fallback) {
  if (!value) return fallback;
  const d = istDateOnly(String(value));
  return Number.isNaN(d.getTime()) ? fallback : d;
}

async function getCallerPlantation(req) {
  const p = await Plantation.findOne({ ownerId: req.user.sub });
  return p;
}

/**
 * Workers to include for [from]–[to]: active ones plus any deactivated
 * worker who has attendance or paid payroll in the range, so wages owed or
 * already paid never drop out of payroll or settlement on deactivation.
 */
async function workersForRange(plantationId, from, to, filter = {}) {
  const [attendedIds, paidIds] = await Promise.all([
    Attendance.distinct('workerId', {
      plantationId,
      workDate: { $gte: from, $lte: to },
      isPresent: true,
    }),
    PayrollWeek.distinct('workerId', {
      plantationId,
      weekStart: { $gte: from, $lte: to },
    }),
  ]);
  return Worker.find({
    plantationId,
    ...filter,
    $or: [{ active: true }, { _id: { $in: [...attendedIds, ...paidIds] } }],
  }).sort({ createdAt: 1 });
}

/** The paid PayrollWeek of the week containing [date], or null. */
function paidWeekContaining(workerId, date) {
  return PayrollWeek.findOne({
    workerId,
    weekStart: startOfWeekMonday(date),
    paidAt: { $ne: null },
  });
}

/**
 * 403 response if the caller's plan can't take [adding] more active
 * workers (free plan: 5), else null. Brief §5.5.3.
 */
async function workerLimitResponse(req, res, plantationId, adding = 1) {
  const { entitlements } = await getEntitlements(req.user.sub);
  const limit = entitlements.workerLimit;
  if (limit == null) return null;
  const active = await Worker.countDocuments({ plantationId, active: true });
  if (active + adding <= limit) return null;
  return res.status(403).json({
    error: 'plan_limit',
    message:
      `The free plan allows up to ${limit} active workers. ` +
      'Upgrade to Pro to add more.',
  });
}

/** 409 for writes that would change a week that is already paid. */
function weekPaidResponse(res, what) {
  return res.status(409).json({
    error: 'week_paid',
    message:
      `This week's payroll is already marked paid, so ${what} can no longer ` +
      'be changed for it.',
  });
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
    const today = todayIST();
    await WagePeriod.ensureCoversToday(p._id, today);
    const [workers, period] = await Promise.all([
      Worker.find({ plantationId: p._id, active: true }).sort({ createdAt: 1 }),
      WagePeriod.activeOn(p._id, today),
    ]);
    res.json({
      ok: true,
      workers: workers.map((w) => {
        const json = w.toPublicJSON();
        if (w.type !== 'union') return json;
        // Today's Basic + DA + weightage (brief §5.4.1); null when no CGA
        // circular covers today.
        const weightage = period
          ? weightagePaise(tenureYearsAt(w.joinedAt, today))
          : null;
        return {
          ...json,
          weightagePaise: weightage,
          currentDailyWagePaise: period
            ? period.basicPaise + period.daPaise + weightage
            : null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
}

const createWorkerSchema = z.object({
  // Set by the app for workers added offline, so attendance queued for
  // them right after can reference the worker before it syncs.
  id: z.string().regex(/^[0-9a-f]{24}$/).optional(),
  fullName: z.string().trim().min(2).max(120),
  type: z.enum(['union', 'temp']),
  phone: z.string().regex(/^\+91\d{10}$/).optional().nullable(),
  joinedAt: zDateOnly,
  tempPayType: z.enum(['daily', 'hourly']).optional().nullable(),
  tempRateRupees: z.number().positive().optional().nullable(),
});

export async function createWorker(req, res, next) {
  try {
    const body = createWorkerSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    // Offline replay: the worker was already created by an earlier attempt.
    if (body.id) {
      const existing = await Worker.findById(body.id);
      if (existing) {
        if (!existing.plantationId.equals(p._id)) {
          return res.status(409).json({ error: 'id_conflict' });
        }
        return res.json({ ok: true, worker: existing.toPublicJSON() });
      }
    }

    const limited = await workerLimitResponse(req, res, p._id);
    if (limited) return limited;

    if (body.type === 'temp') {
      if (!body.tempPayType || !body.tempRateRupees) {
        return res.status(400).json({
          error: 'temp_rate_required',
          message: 'Temp workers require pay type and rate.',
        });
      }
    }

    const w = await Worker.create({
      ...(body.id ? { _id: body.id } : {}),
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

// ---------- Bulk CSV import ----------

const bulkImportBodySchema = z.object({
  csv: z.string().min(1).max(1_000_000), // ~1 MB of CSV text is plenty.
});

/**
 * Per-row Zod schema. `phone` normalized to E.164 (+91XXXXXXXXXX). `type`
 * accepts either "union"/"temp" case-insensitively. Empty strings from the
 * CSV parser are stripped BEFORE parsing so `.optional()` behaves as expected.
 */
const bulkImportRowSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  type: z.enum(['union', 'temp']),
  phone: z.string().regex(/^\+91\d{10}$/).optional(),
  joinedAt: zDateOnly,
  tempPayType: z.enum(['daily', 'hourly']).optional(),
  tempRateRupees: z.coerce.number().positive().optional(),
});

/**
 * Column names accepted by the CSV import: the brief's snake_case template
 * (full_name, phone, type, pay_type, rate_inr, joined_at) and the app's
 * original camelCase headers. Matched case-insensitively.
 */
const CSV_HEADER_ALIASES = {
  full_name: 'fullName',
  fullname: 'fullName',
  name: 'fullName',
  phone: 'phone',
  type: 'type',
  pay_type: 'tempPayType',
  temppaytype: 'tempPayType',
  rate_inr: 'tempRateRupees',
  tempraterupees: 'tempRateRupees',
  joined_at: 'joinedAt',
  joinedat: 'joinedAt',
};

function csvHeaderKey(header) {
  const h = String(header).trim();
  return CSV_HEADER_ALIASES[h.toLowerCase()] ?? h;
}

/** Normalize a phone into E.164 (+91XXXXXXXXXX) or return null. */
function normalizePhone(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[\s\-()]/g, '');
  if (!s) return null;
  if (/^\+91\d{10}$/.test(s)) return s;
  if (/^91\d{10}$/.test(s)) return `+${s}`;
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  return s; // Let the schema reject it.
}

export async function bulkImportWorkers(req, res, next) {
  try {
    const { csv } = bulkImportBodySchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const { entitlements } = await getEntitlements(req.user.sub);
    if (!entitlements.canBulkImport) {
      return res.status(403).json({
        error: 'pro_required',
        message: 'CSV import is a Pro feature. Upgrade to Pro to import workers.',
      });
    }

    let rawRows;
    try {
      rawRows = parseCsv(csv, {
        columns: (headers) => headers.map(csvHeaderKey),
        skip_empty_lines: true,
        trim: true,
        bom: true,
        relax_column_count: true,
      });
    } catch (e) {
      return res
        .status(400)
        .json({ error: 'csv_parse_error', message: e.message });
    }

    if (rawRows.length === 0) {
      return res
        .status(400)
        .json({ error: 'empty_csv', message: 'CSV has no data rows.' });
    }

    // De-dup against phones already on file for this plantation.
    const existing = await Worker.find({ plantationId: p._id })
      .select('phone')
      .lean();
    const existingPhones = new Set(
      existing.map((w) => w.phone).filter(Boolean),
    );

    const seenPhones = new Set();
    const toCreate = [];
    const skipped = [];

    for (let i = 0; i < rawRows.length; i++) {
      const rowNumber = i + 2; // Row 1 is the header line.
      const raw = rawRows[i];

      // Strip empty strings so `.optional()` fires instead of failing on "".
      const cleaned = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v === undefined || v === null) continue;
        const s = typeof v === 'string' ? v.trim() : v;
        if (s === '') continue;
        cleaned[k] = s;
      }
      if (cleaned.phone !== undefined) {
        cleaned.phone = normalizePhone(cleaned.phone);
      }
      if (typeof cleaned.type === 'string') {
        cleaned.type = cleaned.type.toLowerCase();
      }
      if (typeof cleaned.tempPayType === 'string') {
        cleaned.tempPayType = cleaned.tempPayType.toLowerCase();
      }

      const parsed = bulkImportRowSchema.safeParse(cleaned);
      if (!parsed.success) {
        skipped.push({
          row: rowNumber,
          reason: parsed.error.issues
            .map((iss) => `${iss.path.join('.') || 'row'}: ${iss.message}`)
            .join('; '),
        });
        continue;
      }
      const b = parsed.data;

      if (b.type === 'temp') {
        if (!b.tempPayType || b.tempRateRupees == null) {
          skipped.push({
            row: rowNumber,
            reason: 'Temp workers require pay_type and rate_inr.',
          });
          continue;
        }
      }

      if (b.phone) {
        if (existingPhones.has(b.phone) || seenPhones.has(b.phone)) {
          skipped.push({
            row: rowNumber,
            reason: `Duplicate phone ${b.phone}`,
          });
          continue;
        }
        seenPhones.add(b.phone);
      }

      toCreate.push({
        plantationId: p._id,
        fullName: b.fullName,
        type: b.type,
        phone: b.phone ?? null,
        joinedAt: b.joinedAt,
        tempPayType: b.type === 'temp' ? b.tempPayType : null,
        tempRatePaise:
          b.type === 'temp'
            ? rupeesToPaise(String(b.tempRateRupees))
            : null,
      });
    }

    const created = toCreate.length ? await Worker.insertMany(toCreate) : [];

    res.json({
      ok: true,
      imported: created.length,
      skipped,
      workers: created.map((w) => w.toPublicJSON()),
    });
  } catch (err) {
    next(toHttpError(err));
  }
}

const updateWorkerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(120).optional(),
    phone: z.string().regex(/^\+91\d{10}$/).nullable().optional(),
    joinedAt: zDateOnly.optional(),
    tempRateRupees: z.number().positive().optional(),
    /** When a new temp rate starts applying (defaults to today). */
    tempRateEffectiveFrom: zDateOnly.optional(),
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

    if (body.active === true && !w.active) {
      const limited = await workerLimitResponse(req, res, p._id);
      if (limited) return limited;
    }

    if (body.fullName !== undefined) w.fullName = body.fullName;
    if (body.phone !== undefined) w.phone = body.phone;
    if (body.joinedAt !== undefined) w.joinedAt = body.joinedAt;
    if (body.active !== undefined) w.active = body.active;
    if (body.tempRateRupees !== undefined && w.type === 'temp') {
      const ratePaise = rupeesToPaise(String(body.tempRateRupees));
      const from = body.tempRateEffectiveFrom ?? todayIST();
      const history = w.tempRateHistory?.length
        ? w.tempRateHistory.map((h) => h.toObject?.() ?? h)
        : [{ effectiveFrom: w.joinedAt, ratePaise: w.tempRatePaise }];
      // The new rate replaces anything already scheduled from that date on;
      // days before it keep the rate they were worked at.
      w.tempRateHistory = [
        ...history.filter((h) => h.effectiveFrom < from),
        { effectiveFrom: from, ratePaise },
      ];
      w.tempRatePaise = tempRateOn(w, todayIST());
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
  workDate: zDateOnly,
  isPresent: z.boolean(),
  hoursWorked: z.number().min(0).max(24).optional(),
  sprayingFlag: z.boolean().optional(),
  shadeFlag: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
}).refine(
  (v) =>
    !v.isPresent ||
    v.hoursWorked == null ||
    (v.hoursWorked >= 0.5 && v.hoursWorked <= 16 && (v.hoursWorked * 2) % 1 === 0),
  {
    path: ['hoursWorked'],
    message: 'Hours must be 0.5–16 in steps of 0.5 when present.',
  },
);

/** GET /labor/attendance?date=YYYY-MM-DD — one row per active worker for that day. */
export async function getAttendanceByDate(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const date = queryDateOr(req.query.date, todayIST());

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

    const workDate = body.workDate;
    if (workDate > todayIST()) {
      return res.status(400).json({
        error: 'future_date',
        message: 'Attendance cannot be marked for a future date.',
      });
    }
    if (await paidWeekContaining(w._id, workDate)) {
      return weekPaidResponse(res, 'attendance');
    }

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

    const today = todayIST();
    await WagePeriod.ensureCoversToday(p._id, today);
    await materializeDueRuleBonuses(p._id, today);
    const weekStart = startOfWeekMonday(queryDateOr(req.query.start, today));
    const weekEnd = endOfDay(addDays(weekStart, 6));

    const workers = await workersForRange(p._id, weekStart, weekEnd);

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
      paidAt: istInstantRange(weekStart, weekEnd),
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
        // Use the frozen snapshot — payroll is immutable once paid. Its
        // totalPaise already includes the bonuses frozen at payment time.
        const paidBonusPaise =
          paid.bonusPaise ?? 0;
        const paidBasePaise =
          paid.basePayPaise ?? paid.totalPaise - paidBonusPaise;
        breakdowns.push({
          worker: w.toPublicJSON(),
          weekStart: paid.weekStart,
          weekEnd: paid.weekEnd,
          workerId: wId,
          daysPresent: paid.daysPresent,
          festivalDays: paid.festivalDays,
          totalHours: paid.totalHours,
          avgDailyPaise: paid.daysPresent + paid.festivalDays > 0
              ? Math.round(paidBasePaise / (paid.daysPresent + paid.festivalDays))
              : 0,
          basePayPaise: paidBasePaise,
          bonusPaise: paidBonusPaise,
          totalPaise: paid.totalPaise,
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
    const active = await WagePeriod.activeOn(p._id, weekStart);
    const endsInDays = active
      ? daysBetween(today, istDateOnly(active.effectiveTo))
      : null;
    const warning =
      active && endsInDays <= 30
        ? { label: active.label, endsInDays: Math.max(0, endsInDays) }
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
      missingWagePeriodDates: await datesWithoutWagePeriod(p._id, weekStart, 7),
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
  weekStart: zDateOnly,
});

export async function markPayrollPaid(req, res, next) {
  try {
    const body = markPaidSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const weekStart = startOfWeekMonday(body.weekStart);
    const weekEnd = endOfDay(addDays(weekStart, 6));

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
    const [att, bonuses] = await Promise.all([
      Attendance.find({
        workerId: worker._id,
        workDate: { $gte: weekStart, $lte: weekEnd },
      }),
      BonusPayment.find({
        workerId: worker._id,
        paidAt: istInstantRange(weekStart, weekEnd),
      }),
    ]);
    const r = await calculateWeeklyPayroll({
      worker,
      attendance: att,
      weekStart,
    });

    // Paying now would freeze ₹0 for days with no CGA circular on file.
    if (r.missingPeriodDays > 0) {
      return res.status(409).json({
        error: 'missing_wage_period',
        message:
          `No CGA wage rate is on file for ${r.missingPeriodDays} day(s) this week, ` +
          'so they would be paid ₹0. Wait until the new circular rates are added.',
      });
    }

    const bonusPaise = bonuses.reduce((s, b) => s + b.amountPaise, 0);

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
          bonusPaise,
          totalPaise: r.totalPaise + bonusPaise,
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
// WAGE PERIODS (CGA circulars — entered per estate by the planter)
// ============================================================

function periodStatus(period, today) {
  if (period.effectiveFrom > today) return 'upcoming';
  if (period.effectiveTo < today) return 'past';
  return 'active';
}

/**
 * 'YYYY-MM-DD' keys of the [days] days from [from] that no wage period of
 * this plantation covers. Union pay for those days is ₹0 until the planter
 * adds the circular.
 */
async function datesWithoutWagePeriod(plantationId, from, days) {
  const to = endOfDay(addDays(from, days - 1));
  const periods = await WagePeriod.find({
    plantationId,
    effectiveFrom: { $lte: to },
    effectiveTo: { $gte: from },
  });
  const missing = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    const covered = periods.some(
      (p) => p.effectiveFrom <= day && p.effectiveTo >= day,
    );
    if (!covered) missing.push(day.toISOString().slice(0, 10));
  }
  return missing;
}

/**
 * Paid (settled) union payroll weeks of this plantation overlapping
 * [from, to]. Those weeks were frozen at the rates in force when paid.
 */
function countPaidUnionWeeks(plantationId, from, to) {
  return PayrollWeek.countDocuments({
    plantationId,
    paidAt: { $ne: null },
    weekStart: { $lte: to },
    weekEnd: { $gte: from },
    // Union days carry basicPaise in their breakdown; temp days don't.
    'days.parts.basicPaise': { $exists: true },
  });
}

async function findOverlappingPeriod(plantationId, from, to, excludeId = null) {
  return WagePeriod.findOne({
    plantationId,
    effectiveFrom: { $lte: to },
    effectiveTo: { $gte: from },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
}

export async function listWagePeriods(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const today = todayIST();
    await WagePeriod.ensureCoversToday(p._id, today);
    const periods = await WagePeriod.find({ plantationId: p._id }).sort({
      effectiveFrom: 1,
    });
    res.json({
      ok: true,
      periods: periods.map((p) => ({
        ...p.toPublicJSON(),
        status: periodStatus(p, today),
      })),
    });
  } catch (err) {
    next(err);
  }
}

const wagePeriodFields = z.object({
  label: z.string().trim().min(2).max(40),
  effectiveFrom: zDateKey,
  effectiveTo: zDateKey,
  basicRupees: z.number().positive().max(10_000),
  daRupees: z.number().nonnegative().max(10_000),
});

const wagePeriodCreateSchema = wagePeriodFields.refine(
  (v) => v.effectiveTo > v.effectiveFrom,
  { message: 'effectiveTo must be after effectiveFrom' },
);

/** POST /labor/wage-periods — add a new CGA circular for the caller's estate. */
export async function createWagePeriod(req, res, next) {
  try {
    const body = wagePeriodCreateSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const effectiveFrom = body.effectiveFrom;
    const effectiveTo = endOfDay(body.effectiveTo);

    const overlap = await findOverlappingPeriod(p._id, effectiveFrom, effectiveTo);
    if (overlap) {
      return res.status(409).json({
        error: 'overlap',
        message: `Date range overlaps with "${overlap.label}".`,
      });
    }

    const basicPaise = Math.round(body.basicRupees * 100);
    const daPaise = Math.round(body.daRupees * 100);
    const doc = await WagePeriod.create({
      plantationId: p._id,
      label: body.label,
      effectiveFrom,
      effectiveTo,
      basicPaise,
      daPaise,
      totalPaise: basicPaise + daPaise,
    });
    res.status(201).json({ ok: true, period: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

const wagePeriodUpdateSchema = wagePeriodFields
  .partial()
  .extend({
    /** Caller has confirmed editing a period that has already started. */
    confirm: z.boolean().optional(),
    /** Admin override for a period with settled (paid) payroll. */
    override: z.boolean().optional(),
  })
  .refine(
    (v) =>
      ['label', 'effectiveFrom', 'effectiveTo', 'basicRupees', 'daRupees'].some(
        (k) => v[k] !== undefined,
      ),
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

    const year = Number(req.query.year) || currentYearIST();
    const start = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

    // A year with nothing marked yet starts with the fixed-date holidays
    // still ahead; the planter adds the lunar festivals.
    const marked = await FestivalDate.countDocuments({
      plantationId: p._id,
      date: { $gte: start, $lte: end },
    });
    if (marked === 0) {
      const defaults = fixedHolidaysFor(year, todayIST());
      if (defaults.length) {
        try {
          await FestivalDate.insertMany(
            defaults.map((h) => ({ plantationId: p._id, ...h })),
            { ordered: false },
          );
        } catch (err) {
          // A concurrent request preloaded them first.
          if (err?.code !== 11000) throw err;
        }
      }
    }

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
  date: zDateOnly,
  label: z.string().trim().min(1).max(80),
});

/** POST /labor/festivals — mark a date as a paid festival day. */
export async function createFestival(req, res, next) {
  try {
    const body = festivalSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const date = body.date;
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

const festivalUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80),
});

/** PATCH /labor/festivals/:id — rename a festival day. */
export async function updateFestival(req, res, next) {
  try {
    const body = festivalUpdateSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const doc = await FestivalDate.findOneAndUpdate(
      { _id: req.params.id, plantationId: p._id },
      { $set: { label: body.label } },
      { new: true },
    );
    if (!doc) return res.status(404).json({ error: 'festival_not_found' });
    res.json({ ok: true, festival: doc.toPublicJSON() });
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

/** Live settlement rows for [year]'s union workers (not yet finalised). */
async function liveSettlementRows(plantationId, year) {
  const { yearStart, yearEnd } = settlementYearRange(year);
  // Union workers only (CGA rules), including anyone deactivated during
  // the year who still worked or was paid in it.
  const workers = await workersForRange(plantationId, yearStart, yearEnd, {
    type: 'union',
  });
  const rows = [];
  for (const w of workers) {
    const s = await calculateYearEndSettlement({ worker: w, year });
    rows.push({ worker: w.toPublicJSON(), ...s });
  }
  return rows;
}

function finalizedRows(plantationId, year) {
  return YearEndSettlement.find({ plantationId, year }).sort({ createdAt: 1, _id: 1 });
}

function settlementResponse(year, breakdowns, finalizedAt) {
  return {
    ok: true,
    year,
    // Last day of the settlement year, and whether it can be finalised now.
    yearEnd: settlementYearRange(year).yearEnd,
    canFinalize:
      !finalizedAt && breakdowns.length > 0 && isSettlementYearOver(year, todayIST()),
    finalizedAt,
    totals: settlementTotals(breakdowns),
    breakdowns,
  };
}

/**
 * GET /labor/settlement?year=YYYY — settlement for every union worker plus
 * a roll-up of bonus pool and grand total. A finalised year returns the
 * locked figures (`finalizedAt` set); otherwise a live preview
 * (`finalizedAt: null`).
 */
export async function getYearEndSettlement(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const year = Number(req.query.year) || currentYearIST();
    const locked = await finalizedRows(p._id, year);
    if (locked.length) {
      return res.json(
        settlementResponse(
          year,
          locked.map((d) => d.toPublicJSON()),
          locked[0].finalizedAt,
        ),
      );
    }
    const rows = await liveSettlementRows(p._id, year);
    res.json(settlementResponse(year, rows, null));
  } catch (err) {
    next(err);
  }
}

const finalizeSettlementSchema = z.object({
  year: z.number().int().min(2000).max(2100),
});

/**
 * POST /labor/settlement/finalize { year } — compute and lock [year]'s
 * settlement (brief §5.4.7: "Generated once per year and locked"). Only
 * after the settlement year has ended. Idempotent: a finalised year returns
 * its stored figures unchanged.
 */
export async function finalizeYearEndSettlement(req, res, next) {
  try {
    const { year } = finalizeSettlementSchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const existing = await finalizedRows(p._id, year);
    if (existing.length) {
      return res.json({
        ...settlementResponse(
          year,
          existing.map((d) => d.toPublicJSON()),
          existing[0].finalizedAt,
        ),
        alreadyFinalized: true,
      });
    }

    if (!isSettlementYearOver(year, todayIST())) {
      const { yearEnd } = settlementYearRange(year);
      return res.status(409).json({
        error: 'year_not_ended',
        message:
          `The ${year} settlement year runs until ` +
          `${yearEnd.toISOString().slice(0, 10)}. It can be finalised once ` +
          'the year has ended.',
      });
    }

    const rows = await liveSettlementRows(p._id, year);
    if (!rows.length) {
      return res.status(400).json({
        error: 'no_workers',
        message: `There are no union workers to settle for ${year}.`,
      });
    }

    const finalizedAt = new Date();
    try {
      await YearEndSettlement.insertMany(
        rows.map((r) => ({
          ...r,
          plantationId: p._id,
          workerId: r.workerId,
          finalizedAt,
          finalizedBy: req.user.sub,
        })),
        { ordered: false },
      );
    } catch (err) {
      // A concurrent finalise stored some rows first — keep theirs.
      if (err?.code !== 11000) throw err;
    }

    const locked = await finalizedRows(p._id, year);
    res.status(201).json(
      settlementResponse(
        year,
        locked.map((d) => d.toPublicJSON()),
        locked[0]?.finalizedAt ?? finalizedAt,
      ),
    );
  } catch (err) {
    next(toHttpError(err));
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
    await WagePeriod.ensureCoversToday(p._id, todayIST());

    const workers = await Worker.find({
      plantationId: p._id,
      active: true,
      type: 'union',
    });

    const activePeriod = await WagePeriod.activeOn(p._id, todayIST());

    const rows = [];
    let totalLiabilityPaise = 0;
    for (const w of workers) {
      const tenure = w.tenureYears();
      let dailyPaise = 0;
      if (activePeriod) {
        // Today's daily wage for this worker (no spraying/shade).
        dailyPaise =
          activePeriod.basicPaise + activePeriod.daPaise + weightagePaise(tenure);
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
      // No circular covers today → every daily wage above is ₹0.
      missingWagePeriod: !activePeriod,
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

    await materializeDueRuleBonuses(p._id, todayIST());
    const [rules, payments, workers] = await Promise.all([
      BonusRule.find({ plantationId: p._id, active: true }).sort({ createdAt: 1 }),
      BonusPayment.find({ plantationId: p._id })
        .sort({ paidAt: -1 })
        .limit(50),
      Worker.find({ plantationId: p._id, active: true }),
    ]);

    // Compute upcoming firings within the next 30 days (today included).
    const now = todayIST();
    const horizon = addDays(now, 30);
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
          if (!w.joinedAt) return false;
          const joined = istDateOnly(w.joinedAt);
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

    // A one-off bonus joins the current week's payroll (brief §5.4.9).
    if (await paidWeekContaining(w._id, todayIST())) {
      return weekPaidResponse(res, 'bonuses');
    }

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

    const payment = await BonusPayment.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!payment) {
      return res.status(404).json({ error: 'payment_not_found' });
    }
    if (await paidWeekContaining(payment.workerId, istDateOnly(payment.paidAt))) {
      return weekPaidResponse(res, 'bonuses');
    }
    // A rule payment the planter removes must not be paid again by the
    // lazy rule payout.
    if (payment.ruleId && payment.occurrenceKey) {
      await BonusRule.updateOne(
        { _id: payment.ruleId, plantationId: p._id },
        { $addToSet: { skippedOccurrenceKeys: payment.occurrenceKey } },
      );
    }
    await payment.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /labor/wage-periods/:id — edit a circular of the caller's estate.
 *
 * Changing dates or rates is guarded (brief AC 72, §7.6 rule 103):
 *   - period has settled (paid) payroll → needs an admin override:
 *       planter → 409 `period_locked` (can't change it from the app)
 *       admin   → 409 `override_required` unless `override`
 *   - period has already started        → 409 `confirmation_required`
 *                                         unless `confirm` (or `override`)
 * Label-only edits skip both checks. Paid weeks are never recalculated —
 * they keep the frozen snapshot from when they were paid.
 *
 * Admins may edit any estate's period (support); planters only their own.
 */
export async function updateWagePeriod(req, res, next) {
  try {
    const body = wagePeriodUpdateSchema.parse(req.body);
    const caller = await User.findById(req.user.sub).select('role');
    const isAdmin = caller?.role === 'admin';

    let doc;
    if (isAdmin) {
      doc = await WagePeriod.findById(req.params.id);
    } else {
      const p = await getCallerPlantation(req);
      if (!p) return res.status(404).json({ error: 'no_plantation' });
      doc = await WagePeriod.findOne({ _id: req.params.id, plantationId: p._id });
    }
    if (!doc) return res.status(404).json({ error: 'period_not_found' });

    const effectiveFrom = body.effectiveFrom ?? doc.effectiveFrom;
    const effectiveTo =
      body.effectiveTo !== undefined ? endOfDay(body.effectiveTo) : doc.effectiveTo;
    const basicPaise =
      body.basicRupees !== undefined
        ? Math.round(body.basicRupees * 100)
        : doc.basicPaise;
    const daPaise =
      body.daRupees !== undefined
        ? Math.round(body.daRupees * 100)
        : doc.daPaise;

    if (effectiveTo <= effectiveFrom) {
      return res.status(400).json({
        error: 'invalid_range',
        message: 'effectiveTo must be after effectiveFrom',
      });
    }

    const payImpacting =
      effectiveFrom.getTime() !== doc.effectiveFrom.getTime() ||
      effectiveTo.getTime() !== doc.effectiveTo.getTime() ||
      basicPaise !== doc.basicPaise ||
      daPaise !== doc.daPaise;

    if (payImpacting) {
      const overlap = await findOverlappingPeriod(
        doc.plantationId,
        effectiveFrom,
        effectiveTo,
        doc._id,
      );
      if (overlap) {
        return res.status(409).json({
          error: 'overlap',
          message: `Date range overlaps with "${overlap.label}".`,
        });
      }

      // Cover both the old and new range — shrinking a period also changes
      // pay for the days it no longer covers.
      const rangeFrom = new Date(
        Math.min(effectiveFrom.getTime(), doc.effectiveFrom.getTime()),
      );
      const rangeTo = new Date(
        Math.max(effectiveTo.getTime(), doc.effectiveTo.getTime()),
      );
      const paidWeekCount = await countPaidUnionWeeks(
        doc.plantationId,
        rangeFrom,
        rangeTo,
      );
      if (paidWeekCount > 0 && !isAdmin) {
        return res.status(409).json({
          error: 'period_locked',
          paidWeekCount,
          message:
            `${paidWeekCount} paid payroll week(s) used these rates, so they can't ` +
            'be changed from the app. Contact My Cardamom Estate support — an ' +
            'admin can override it.',
        });
      }
      if (paidWeekCount > 0 && !body.override) {
        return res.status(409).json({
          error: 'override_required',
          paidWeekCount,
          message:
            `${paidWeekCount} paid payroll week(s) used these rates. Paid weeks ` +
            'will stay as they were paid, but unpaid weeks and year-end figures ' +
            'will use the new rates. Override?',
        });
      }

      const hasStarted = doc.effectiveFrom <= todayIST();
      if (hasStarted && !body.confirm && !body.override) {
        return res.status(409).json({
          error: 'confirmation_required',
          message:
            'This period has already started. Editing it will recalculate payroll ' +
            "that hasn't been paid yet. Continue?",
        });
      }
    }

    if (body.label !== undefined) doc.label = body.label;
    doc.effectiveFrom = effectiveFrom;
    doc.effectiveTo = effectiveTo;
    doc.basicPaise = basicPaise;
    doc.daPaise = daPaise;
    doc.totalPaise = basicPaise + daPaise;
    // The planter has now checked this quarter's rates.
    doc.carriedForwardFrom = null;

    await doc.save();
    res.json({ ok: true, period: doc.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

/**
 * DELETE /labor/wage-periods/:id — remove a circular entered by mistake.
 * Refused once any paid union payroll week overlaps it: those weeks were
 * paid at its rates. Union pay for its dates is ₹0 until another circular
 * covers them (a period covering today is recreated by ensureCoversToday
 * with the latest carried-forward rates).
 */
export async function deleteWagePeriod(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const doc = await WagePeriod.findOne({ _id: req.params.id, plantationId: p._id });
    if (!doc) return res.status(404).json({ error: 'period_not_found' });

    const paidWeekCount = await countPaidUnionWeeks(
      p._id,
      doc.effectiveFrom,
      doc.effectiveTo,
    );
    if (paidWeekCount > 0) {
      return res.status(409).json({
        error: 'period_has_paid_payroll',
        paidWeekCount,
        message:
          `${paidWeekCount} paid payroll week(s) used the rates of "${doc.label}", ` +
          "so it can't be deleted. Edit it instead, or contact support.",
      });
    }

    await doc.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
