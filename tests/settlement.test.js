import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnnualConfig } from '../src/models/AnnualConfig.js';
import {
  computeSettlement,
  loadConfigForYear,
  settlementYearRange,
} from '../src/services/settlement.service.js';

// Year-end settlement — brief §7.4 / §7.5. computeSettlement is pure, so
// these run without MongoDB.

const day = (s) => new Date(`${s}T00:00:00.000Z`);

const worker = {
  _id: 'w1',
  plantationId: 'p1',
  type: 'union',
  joinedAt: day('2008-04-15'), // 17–18 yrs → has weightage, must not affect the average
};

// Seeded CGA circulars Apr 2025 – Mar 2026 (Basic + DA).
const FY_2025_PERIODS = [
  { basicPaise: 37821, daPaise: 14175 }, // ₹519.96
  { basicPaise: 37821, daPaise: 14217 }, // ₹520.38
  { basicPaise: 37821, daPaise: 14497 }, // ₹523.18
  { basicPaise: 37821, daPaise: 15155 }, // ₹529.76
];

const CONFIG = {
  bonusPct: 0.18,
  festivalDays: 13,
  sickDays: 6,
  leaveRatio: 20,
  blanketPaise: 35000,
};

function presentDays(n) {
  return Array.from({ length: n }, () => ({ isPresent: true }));
}

test('average daily wage matches the brief example: ₹523.32', () => {
  const s = computeSettlement({
    worker,
    year: 2025,
    config: CONFIG,
    attendance: [],
    paidWeeks: [],
    bonuses: [],
    periods: FY_2025_PERIODS,
  });
  // (519.96 + 520.38 + 523.18 + 529.76) / 4 — circular totals only, no
  // per-worker weightage.
  assert.equal(s.avgDailyWagePaise, 52332);
});

test('one-off bonuses are not counted in wages, the 18% base, or the settlement', () => {
  const s = computeSettlement({
    worker,
    year: 2025,
    config: CONFIG,
    attendance: presentDays(200),
    // Week paid with a ₹500 bonus frozen into it.
    paidWeeks: [{ basePayPaise: 300000, bonusPaise: 50000, totalPaise: 350000 }],
    bonuses: [{ amountPaise: 50000 }],
    periods: FY_2025_PERIODS,
  });

  assert.equal(s.wagesPaidPaise, 300000);
  assert.equal(s.components.bonusPaise, 54000); // 18% of ₹3,000, not ₹3,500
  assert.equal(s.components.oneOffBonusPaise, 50000); // reported for reference
  assert.equal(s.components.festivalPayPaise, 13 * 52332);
  assert.equal(s.components.sickPaise, 6 * 52332);
  assert.equal(s.components.leavePaise, 523320); // 200 / 20 × ₹523.32
  assert.equal(s.components.blanketPaise, 35000);
  assert.equal(
    s.settlementTotalPaise,
    54000 + 13 * 52332 + 6 * 52332 + 523320 + 35000,
  );
  assert.equal(s.grandTotalPaise, 300000 + s.settlementTotalPaise);
});

test('older paid weeks without basePayPaise subtract the bonus from the total', () => {
  const s = computeSettlement({
    worker,
    year: 2025,
    config: CONFIG,
    attendance: [],
    paidWeeks: [
      { totalPaise: 350000, bonusPaise: 50000 },
      { totalPaise: 200000 }, // no bonus recorded at all
    ],
    bonuses: [],
    periods: FY_2025_PERIODS,
  });
  assert.equal(s.wagesPaidPaise, 500000);
});

test('no circulars in the year → average is ₹0 rather than NaN', () => {
  const s = computeSettlement({
    worker,
    year: 2025,
    config: CONFIG,
    attendance: presentDays(10),
    paidWeeks: [],
    bonuses: [],
    periods: [],
  });
  assert.equal(s.avgDailyWagePaise, 0);
  assert.equal(s.components.leavePaise, 0);
});

test('settlement year range: calendar and financial', () => {
  assert.deepEqual(settlementYearRange(2025, 1), {
    yearStart: day('2025-01-01'),
    yearEnd: day('2025-12-31'),
  });
  assert.deepEqual(settlementYearRange(2025, 4), {
    yearStart: day('2025-04-01'),
    yearEnd: day('2026-03-31'),
  });
});

test('config for a year with no row uses an earlier year, never a later one', async () => {
  const rows = { 2024: { year: 2024, bonusPct: 0.125 }, 2026: { year: 2026, bonusPct: 0.18 } };
  const original = AnnualConfig.findOne;
  AnnualConfig.findOne = (q) => {
    let result = null;
    if (typeof q.year === 'number') result = rows[q.year] ?? null;
    else if (q.year?.$lt) {
      const years = Object.keys(rows).map(Number).filter((y) => y < q.year.$lt);
      result = years.length ? rows[Math.max(...years)] : null;
    }
    const p = Promise.resolve(result);
    p.sort = () => Promise.resolve(result);
    return p;
  };
  try {
    assert.equal((await loadConfigForYear(2025)).bonusPct, 0.125);
    assert.equal((await loadConfigForYear(2026)).bonusPct, 0.18);
    // Nothing on or before 2023 → built-in defaults.
    assert.equal((await loadConfigForYear(2023)).bonusPct, 0.18);
  } finally {
    AnnualConfig.findOne = original;
  }
});

test('festival days already paid weekly are not paid again at year end', () => {
  const s = computeSettlement({
    worker,
    year: 2025,
    config: CONFIG,
    attendance: [],
    // 10 festival days paid inside weekly payroll across the year.
    paidWeeks: [
      { basePayPaise: 100000, festivalDays: 4 },
      { basePayPaise: 100000, festivalDays: 6 },
    ],
    bonuses: [],
    periods: FY_2025_PERIODS,
  });
  assert.equal(s.festivalDaysPaidWeekly, 10);
  assert.equal(s.festivalDaysDue, 3);
  assert.equal(s.components.festivalPayPaise, 3 * 52332);
});

test('more festival days paid weekly than the entitlement → no negative top-up', () => {
  const s = computeSettlement({
    worker,
    year: 2025,
    config: CONFIG,
    attendance: [],
    paidWeeks: [{ basePayPaise: 100000, festivalDays: 14 }],
    bonuses: [],
    periods: FY_2025_PERIODS,
  });
  assert.equal(s.components.festivalPayPaise, 0);
});
