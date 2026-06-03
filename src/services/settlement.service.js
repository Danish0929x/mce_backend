/**
 * Year-end Settlement — brief §7.4.
 *
 * Calculates the 8 annual benefit components per CGA rules. Computed on
 * demand from PayrollWeek + Attendance + BonusPayment + WagePeriod records.
 *
 * Components per CGA rules:
 *   1. Total wages paid YTD       (sum of completed weeks)
 *   2. Bonus                      = total_wages × bonus_pct
 *   3. Festival pay               = 13 × avg daily wage
 *   4. Sick allowance             = 6 × avg daily wage
 *   5. Leave with wages           = (days worked ÷ 20) × avg daily wage
 *   6. Blanket allowance          = ₹350 flat
 *   7. Spraying / Shade allowance = ₹3.25 × flagged days each (already in weekly pay)
 *   8. Settlement total           = sum of bonus + festival + sick + leave + blanket
 *      Grand total                = wages YTD + settlement total
 */

import { AnnualConfig } from '../models/AnnualConfig.js';
import { WagePeriod } from '../models/WagePeriod.js';
import { Attendance } from '../models/Attendance.js';
import { PayrollWeek } from '../models/PayrollWeek.js';
import { BonusPayment } from '../models/BonusPayment.js';
import {
  calculateUnionDailyWage,
  calculateTempDailyWage,
  tenureYearsAt,
} from './wage-engine.service.js';

/**
 * Build the settlement summary for one worker for [year].
 *
 * @param {object} args
 * @param {object} args.worker
 * @param {number} args.year
 */
export async function calculateYearEndSettlement({ worker, year }) {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const [config, attendance, paidWeeks, bonuses] = await Promise.all([
    AnnualConfig.findOne({ year }) ??
      AnnualConfig.findOne().sort({ year: -1 }),
    Attendance.find({
      workerId: worker._id,
      workDate: { $gte: yearStart, $lte: yearEnd },
    }),
    PayrollWeek.find({
      workerId: worker._id,
      weekStart: { $gte: yearStart, $lte: yearEnd },
    }),
    BonusPayment.find({
      workerId: worker._id,
      paidAt: { $gte: yearStart, $lte: yearEnd },
    }),
  ]);

  // Total wages YTD — sum the immutable PayrollWeek rows so this matches
  // what was actually paid out.
  const wagesPaidPaise = paidWeeks.reduce(
    (sum, w) => sum + (w.totalPaise || 0),
    0,
  );

  // Days worked from attendance (any presence in the year).
  const daysWorked = attendance.filter((a) => a.isPresent).length;

  // Compute avg daily wage for the year as the mean of all WagePeriod
  // totalPaise that overlap this year. Brief §7.5.
  const periods = await WagePeriod.find({
    effectiveFrom: { $lte: yearEnd },
    effectiveTo: { $gte: yearStart },
  });
  let avgDailyWagePaise = 0;
  if (worker.type === 'union' && periods.length) {
    const tenure = tenureYearsAt(worker.joinedAt, new Date(year, 11, 31));
    const weightages = await Promise.all(
      periods.map(async (p) => {
        const probeDate = new Date(
          Math.max(p.effectiveFrom.getTime(), yearStart.getTime()),
        );
        const r = calculateUnionDailyWage({
          worker,
          workDate: probeDate,
          period: p,
          config: config ?? { sprayingAllowancePaise: 325, shadeAllowancePaise: 325 },
          sprayingFlag: false,
          shadeFlag: false,
        });
        return r.totalPaise;
      }),
    );
    avgDailyWagePaise = Math.round(
      weightages.reduce((s, v) => s + v, 0) / weightages.length,
    );
    // weightage was already included via calculateUnionDailyWage above.
    // No further adjustment needed.
    void tenure; // referenced for clarity, not used past this point.
  } else if (worker.type === 'temp') {
    // For temp workers we use a simple average of paid weeks.
    avgDailyWagePaise =
      daysWorked > 0 ? Math.round(wagesPaidPaise / daysWorked) : 0;
  }

  // Year-end components — only for union workers per CGA rules.
  let bonusPaise = 0;
  let festivalPayPaise = 0;
  let sickPaise = 0;
  let leavePaise = 0;
  let blanketPaise = 0;
  if (worker.type === 'union' && config) {
    bonusPaise = Math.round(wagesPaidPaise * (config.bonusPct ?? 0.18));
    festivalPayPaise = (config.festivalDays ?? 13) * avgDailyWagePaise;
    sickPaise = (config.sickDays ?? 6) * avgDailyWagePaise;
    leavePaise = Math.round(
      (daysWorked / (config.leaveRatio ?? 20)) * avgDailyWagePaise,
    );
    blanketPaise = config.blanketPaise ?? 35000;
  }

  // Discretionary bonuses already paid out (from BonusPayment).
  const oneOffBonusPaise = bonuses.reduce(
    (sum, b) => sum + (b.amountPaise || 0),
    0,
  );

  const settlementTotalPaise =
    bonusPaise +
    festivalPayPaise +
    sickPaise +
    leavePaise +
    blanketPaise +
    oneOffBonusPaise;

  return {
    workerId: worker._id.toString(),
    year,
    daysWorked,
    avgDailyWagePaise,
    wagesPaidPaise,
    components: {
      bonusPaise,
      festivalPayPaise,
      sickPaise,
      leavePaise,
      blanketPaise,
      oneOffBonusPaise,
    },
    settlementTotalPaise,
    grandTotalPaise: wagesPaidPaise + settlementTotalPaise,
  };
}
