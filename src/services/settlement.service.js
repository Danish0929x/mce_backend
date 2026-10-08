/**
 * Year-end Settlement — brief §7.4. Union workers only (CGA rules).
 *
 * Computed on demand from PayrollWeek + Attendance + BonusPayment +
 * WagePeriod records.
 *
 * Components per CGA rules:
 *   1. Total wages paid YTD       (sum of paid weeks' WAGES — bonuses excluded)
 *   2. Bonus                      = total_wages × bonus_pct
 *   3. Festival pay               = (13 − festival days already paid weekly) × avg daily wage
 *   4. Sick allowance             = 6 × avg daily wage
 *   5. Leave with wages           = (days worked ÷ 20) × avg daily wage
 *   6. Blanket allowance          = ₹350 flat
 *   7. Spraying / Shade allowance = ₹3.25 × flagged days each (already in weekly pay)
 *   8. Settlement total           = sum of bonus + festival + sick + leave + blanket
 *      Grand total                = wages YTD + settlement total
 *
 * Festival days: a marked festival day is paid in that week's payroll
 * (brief §5.4.6). The year end tops up only the days not yet paid, so a
 * worker gets the 13-day entitlement exactly once, never twice.
 *
 * One-off bonuses were already paid through weekly payroll, so they are
 * reported for reference only and never added to wages, the 18% base, or
 * the settlement total.
 *
 * Settlement year: OPEN CLIENT QUESTION (calendar Jan–Dec vs financial
 * Apr–Mar). Controlled by SETTLEMENT_YEAR_START_MONTH (1 = calendar, the
 * default; 4 = financial). The brief's ₹523.32 example for "2025" averages
 * Apr 2025 – Mar 2026, i.e. the financial-year reading.
 */

import { AnnualConfig } from '../models/AnnualConfig.js';
import { WagePeriod } from '../models/WagePeriod.js';
import { Attendance } from '../models/Attendance.js';
import { PayrollWeek } from '../models/PayrollWeek.js';
import { BonusPayment } from '../models/BonusPayment.js';
import { istInstantRange } from '../utils/dates.js';

const DEFAULT_CONFIG = {
  bonusPct: 0.18,
  festivalDays: 13,
  sickDays: 6,
  leaveRatio: 20,
  blanketPaise: 35000,
};

function settlementStartMonth() {
  const m = Number(process.env.SETTLEMENT_YEAR_START_MONTH ?? 1);
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : 1;
}

/**
 * Date range of settlement [year]: 1 Jan–31 Dec for a calendar year, or
 * e.g. 1 Apr [year] – 31 Mar [year+1] when the start month is 4.
 */
export function settlementYearRange(year, startMonth = settlementStartMonth()) {
  // Date-only values (UTC midnight of the IST day), like the rest of the app.
  const yearStart = new Date(Date.UTC(year, startMonth - 1, 1));
  const yearEnd = new Date(Date.UTC(year + 1, startMonth - 1, 0));
  return { yearStart, yearEnd };
}

/**
 * Annual config for [year]: that year's row, else the most recent earlier
 * year, else built-in CGA defaults. Never borrows a LATER year's rates.
 */
export async function loadConfigForYear(year) {
  const exact = await AnnualConfig.findOne({ year });
  if (exact) return exact;
  const earlier = await AnnualConfig.findOne({ year: { $lt: year } }).sort({
    year: -1,
  });
  return earlier ?? DEFAULT_CONFIG;
}

/**
 * Pure settlement math — no database access, so it is unit-testable.
 *
 * @param {object} args
 * @param {object} args.worker
 * @param {number} args.year
 * @param {object} args.config - annual config (bonusPct, festivalDays, …)
 * @param {Array<{isPresent: boolean}>} args.attendance - rows in the year
 * @param {Array<object>} args.paidWeeks - PayrollWeek rows marked paid
 * @param {Array<{amountPaise: number}>} args.bonuses - one-off bonuses in the year
 * @param {Array<{basicPaise: number, daPaise: number}>} args.periods - wage
 *   periods overlapping the year
 */
export function computeSettlement({
  worker,
  year,
  config,
  attendance,
  paidWeeks,
  bonuses,
  periods,
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Wages only. PayrollWeek.totalPaise includes that week's one-off
  // bonuses, so use basePayPaise (older rows: total minus bonus).
  const wagesPaidPaise = paidWeeks.reduce(
    (sum, w) =>
      sum + (w.basePayPaise ?? (w.totalPaise ?? 0) - (w.bonusPaise ?? 0)),
    0,
  );

  const daysWorked = attendance.filter((a) => a.isPresent).length;

  // Brief §7.5: arithmetic mean of the circular totals (Basic + DA) active
  // in the year. Plantation-wide — weightage is not part of it.
  const avgDailyWagePaise = periods.length
    ? Math.round(
        periods.reduce((s, p) => s + p.basicPaise + p.daPaise, 0) /
          periods.length,
      )
    : 0;

  const bonusPaise = Math.round(wagesPaidPaise * cfg.bonusPct);
  const festivalDaysPaidWeekly = paidWeeks.reduce(
    (sum, w) => sum + (w.festivalDays ?? 0),
    0,
  );
  const festivalDaysDue = Math.max(0, cfg.festivalDays - festivalDaysPaidWeekly);
  const festivalPayPaise = festivalDaysDue * avgDailyWagePaise;
  const sickPaise = cfg.sickDays * avgDailyWagePaise;
  const leavePaise = Math.round(
    (daysWorked / cfg.leaveRatio) * avgDailyWagePaise,
  );
  const blanketPaise = cfg.blanketPaise;

  const oneOffBonusPaise = bonuses.reduce(
    (sum, b) => sum + (b.amountPaise || 0),
    0,
  );

  const settlementTotalPaise =
    bonusPaise + festivalPayPaise + sickPaise + leavePaise + blanketPaise;

  return {
    workerId: worker._id.toString(),
    year,
    daysWorked,
    avgDailyWagePaise,
    wagesPaidPaise,
    festivalDaysPaidWeekly,
    festivalDaysDue,
    components: {
      bonusPaise,
      festivalPayPaise,
      sickPaise,
      leavePaise,
      blanketPaise,
      // Already paid in weekly payroll — reference only, not in totals.
      oneOffBonusPaise,
    },
    settlementTotalPaise,
    grandTotalPaise: wagesPaidPaise + settlementTotalPaise,
  };
}

/**
 * Build the settlement summary for one union worker for [year].
 *
 * @param {object} args
 * @param {object} args.worker
 * @param {number} args.year
 */
export async function calculateYearEndSettlement({ worker, year }) {
  const { yearStart, yearEnd } = settlementYearRange(year);

  const [config, attendance, paidWeeks, bonuses, periods] = await Promise.all([
    loadConfigForYear(year),
    Attendance.find({
      workerId: worker._id,
      workDate: { $gte: yearStart, $lte: yearEnd },
    }),
    PayrollWeek.find({
      workerId: worker._id,
      weekStart: { $gte: yearStart, $lte: yearEnd },
      paidAt: { $ne: null },
    }),
    BonusPayment.find({
      workerId: worker._id,
      paidAt: istInstantRange(yearStart, yearEnd),
    }),
    WagePeriod.find({
      plantationId: worker.plantationId,
      effectiveFrom: { $lte: yearEnd },
      effectiveTo: { $gte: yearStart },
    }),
  ]);

  return computeSettlement({
    worker,
    year,
    config: typeof config.toObject === 'function' ? config.toObject() : config,
    attendance,
    paidWeeks,
    bonuses,
    periods,
  });
}
