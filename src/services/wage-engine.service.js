/**
 * Wage Engine — CGA-compliant payroll calculation.
 *
 * THIS IS THE MOST CONSEQUENTIAL FILE IN THE PROJECT.
 *
 * The brief is explicit: "Every other feature is recoverable; this one is
 * not." Every change to this file must keep the canonical test passing:
 *
 *   18-year tenure union worker, working on 2026-04-15, with spraying flag
 *   set → daily wage MUST equal ₹578.31 (57831 paise).
 *
 * Architectural rules (from brief §7.6):
 *   1. Money is stored and computed as integer paise. Never floats.
 *   2. Wage period for a payroll calculation is the period ACTIVE on the
 *      work_date — not today's. Retroactive attendance uses the old rate.
 *   3. Temp workers ignore wage_periods entirely; they use their own rate.
 *   4. All calculations happen server-side; the client never recomputes.
 *
 * @see Developer brief §7 (full wage spec)
 */

import { WagePeriod } from '../models/WagePeriod.js';
import { AnnualConfig } from '../models/AnnualConfig.js';
import { FestivalDate } from '../models/FestivalDate.js';

// ---------- weightage bands (brief §7.2) ----------

/**
 * Tenure-based weightage per CGA PLC Settlement 02-06-2023.
 * Brief §7.2 — bands are inclusive on both ends:
 *   Below 5 yrs → ₹0 (interpret as 0–5 full years inclusive — i.e. you must
 *   have *completed* 5 years and started the 6th before weightage kicks in)
 *   6–10 → ₹1.25 · 11–15 → ₹1.75 · 16–20 → ₹2.30 · 21+ → ₹2.80
 *
 * Returns the weightage amount in paise.
 */
export function weightagePaise(tenureYears) {
  if (tenureYears < 6) return 0;
  if (tenureYears <= 10) return 125;  // ₹1.25
  if (tenureYears <= 15) return 175;  // ₹1.75
  if (tenureYears <= 20) return 230;  // ₹2.30
  return 280;                          // ₹2.80 (21+ years)
}

export function bandLabel(tenureYears) {
  if (tenureYears < 6) return 'Below 5 yrs';
  if (tenureYears <= 10) return '6–10 yrs';
  if (tenureYears <= 15) return '11–15 yrs';
  if (tenureYears <= 20) return '16–20 yrs';
  return '21+ yrs';
}

/**
 * Completed full years between joinedAt and refDate — exactly like age.
 * Uses month/day comparison so leap-year drift doesn't bite (an earlier
 * ms-based version under-counted because the actual leap-day total varies).
 */
export function tenureYearsAt(joinedAt, refDate) {
  if (!joinedAt) return 0;
  let years = refDate.getUTCFullYear() - joinedAt.getUTCFullYear();
  const beforeAnniversary =
    refDate.getUTCMonth() < joinedAt.getUTCMonth() ||
    (refDate.getUTCMonth() === joinedAt.getUTCMonth() &&
      refDate.getUTCDate() < joinedAt.getUTCDate());
  if (beforeAnniversary) years--;
  return Math.max(0, years);
}

// ---------- daily wage (brief §7.1) ----------

/**
 * Compute one day's wage for a UNION worker, in paise.
 *
 * @param {object} args
 * @param {{ joinedAt: Date }} args.worker
 * @param {Date}   args.workDate
 * @param {{ basicPaise: number, daPaise: number }} args.period - active wage period
 * @param {{ sprayingAllowancePaise: number, shadeAllowancePaise: number }} args.config
 * @param {boolean} args.sprayingFlag
 * @param {boolean} args.shadeFlag
 * @returns {{ totalPaise: number, parts: object }}
 */
export function calculateUnionDailyWage({
  worker,
  workDate,
  period,
  config,
  sprayingFlag,
  shadeFlag,
}) {
  const tenure = tenureYearsAt(worker.joinedAt, workDate);
  const weightage = weightagePaise(tenure);
  const spraying = sprayingFlag ? config.sprayingAllowancePaise : 0;
  const shade = shadeFlag ? config.shadeAllowancePaise : 0;

  const totalPaise =
    period.basicPaise + period.daPaise + weightage + spraying + shade;

  return {
    totalPaise,
    parts: {
      basicPaise: period.basicPaise,
      daPaise: period.daPaise,
      weightagePaise: weightage,
      sprayingPaise: spraying,
      shadePaise: shade,
      tenureYears: tenure,
      bandLabel: bandLabel(tenure),
    },
  };
}

/**
 * Compute one day's wage for a TEMP worker.
 *
 * Temp workers ignore the CGA circular entirely:
 *  - daily pay type: full rate per attended day
 *  - hourly pay type: rate × hours
 *
 * @param {object} args
 * @param {{ tempPayType: 'daily'|'hourly', tempRatePaise: number }} args.worker
 * @param {{ isPresent: boolean, hoursWorked: number }} args.attendance
 */
export function calculateTempDailyWage({ worker, attendance }) {
  if (!attendance.isPresent) {
    return { totalPaise: 0, parts: { ratePaise: worker.tempRatePaise } };
  }
  const totalPaise =
    worker.tempPayType === 'hourly'
      ? Math.round(worker.tempRatePaise * (attendance.hoursWorked || 0))
      : worker.tempRatePaise;
  return {
    totalPaise,
    parts: {
      ratePaise: worker.tempRatePaise,
      hoursWorked: attendance.hoursWorked || 0,
      payType: worker.tempPayType,
    },
  };
}

// ---------- weekly payroll (brief §5.4.4) ----------

/**
 * Aggregate one worker's pay for the week starting [weekStart] (Monday).
 * Pulls the right wage period for EACH day (handles a CGA circular
 * boundary mid-week correctly), then sums the daily wages.
 *
 * @param {object} args
 * @param {object} args.worker
 * @param {Array<object>} args.attendance - one row per day worked (worker scoped)
 * @param {Date} args.weekStart
 * @returns {Promise<object>} Weekly summary + per-day breakdown.
 */
export async function calculateWeeklyPayroll({
  worker,
  attendance,
  weekStart,
  festivalDatesInWeek = null,
}) {
  const days = 7;
  const config = await loadAnnualConfig(weekStart);
  const weekEnd = new Date(weekStart.getTime() + 6 * 86_400_000);

  // Fetch festival dates for this plantation that fall inside the week.
  // Brief §5.4.6: union workers are paid on marked festival days regardless
  // of attendance. Caller can pass a precomputed list for batch payroll.
  const festivals =
    festivalDatesInWeek ??
    (await FestivalDate.find({
      plantationId: worker.plantationId,
      date: { $gte: weekStart, $lte: weekEnd },
    }));
  const festivalByDay = new Map();
  for (const f of festivals) {
    festivalByDay.set(_dayKey(f.date), f);
  }

  const dayBreakdowns = [];
  let totalPaise = 0;
  let daysPresent = 0;
  let festivalDays = 0;
  let totalHours = 0;

  for (let i = 0; i < days; i++) {
    const workDate = new Date(weekStart);
    workDate.setUTCDate(weekStart.getUTCDate() + i);

    const row = attendance.find((a) => sameDay(a.workDate, workDate));
    const isPresent = row?.isPresent === true;
    const hoursWorked = row?.hoursWorked ?? 0;
    const festival = festivalByDay.get(_dayKey(workDate));

    if (isPresent) {
      daysPresent++;
      totalHours += hoursWorked;
    }

    let dayResult;
    if (worker.type === 'union') {
      const period = await WagePeriod.activeOn(workDate);
      if (!period) {
        dayResult = { totalPaise: 0, parts: { missingPeriod: true } };
      } else if (isPresent) {
        dayResult = calculateUnionDailyWage({
          worker,
          workDate,
          period,
          config,
          sprayingFlag: row?.sprayingFlag === true,
          shadeFlag: row?.shadeFlag === true,
        });
      } else if (festival) {
        // Paid festival day, worker absent — pay Basic + DA + weightage
        // (no allowance flags possible since worker didn't actually work).
        const tenure = tenureYearsAt(worker.joinedAt, workDate);
        const weightage = weightagePaise(tenure);
        const festivalPay = period.basicPaise + period.daPaise + weightage;
        dayResult = {
          totalPaise: festivalPay,
          parts: {
            basicPaise: period.basicPaise,
            daPaise: period.daPaise,
            weightagePaise: weightage,
            sprayingPaise: 0,
            shadePaise: 0,
            tenureYears: tenure,
            bandLabel: bandLabel(tenure),
            festival: true,
            festivalLabel: festival.label,
          },
        };
        festivalDays++;
      } else {
        dayResult = { totalPaise: 0, parts: { absent: true } };
      }
    } else {
      // Temp workers don't receive festival pay (CGA-only rule).
      dayResult = calculateTempDailyWage({
        worker,
        attendance: { isPresent, hoursWorked },
      });
    }

    totalPaise += dayResult.totalPaise;
    dayBreakdowns.push({
      workDate,
      isPresent,
      hoursWorked,
      sprayingFlag: row?.sprayingFlag === true,
      shadeFlag: row?.shadeFlag === true,
      isFestival: !!festival,
      festivalLabel: festival?.label ?? null,
      dailyPaise: dayResult.totalPaise,
      parts: dayResult.parts,
    });
  }

  const payableDays = daysPresent + festivalDays;
  return {
    workerId: worker._id.toString(),
    weekStart,
    weekEnd,
    daysPresent,
    festivalDays,
    totalHours,
    avgDailyPaise: payableDays > 0 ? Math.round(totalPaise / payableDays) : 0,
    totalPaise,
    days: dayBreakdowns,
  };
}

// ---------- helpers ----------

function sameDay(a, b) {
  if (!a || !b) return false;
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function _dayKey(d) {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

async function loadAnnualConfig(refDate) {
  const year = refDate.getUTCFullYear();
  let cfg = await AnnualConfig.findOne({ year });
  if (cfg) return cfg.toObject();
  // Fall back to the most recent year on file (e.g. attendance dated in
  // the future before this year's config is created).
  cfg = await AnnualConfig.findOne().sort({ year: -1 });
  return cfg ? cfg.toObject() : {
    sprayingAllowancePaise: 325,
    shadeAllowancePaise: 325,
  };
}
