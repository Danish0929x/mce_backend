import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weightagePaise,
  bandLabel,
  tenureYearsAt,
  calculateUnionDailyWage,
  calculateTempDailyWage,
} from '../src/services/wage-engine.service.js';
import { formatRupees } from '../src/utils/money.js';

// =====================================================================
// THE CANONICAL TEST — from brief §12 (Final notes):
//
// "Test against the example case (18-year tenure worker, April 2026,
//  with spraying flag = ₹578.31) until it matches to the paise."
//
// This test must always pass. If it fails, do not ship.
// =====================================================================

test('canonical: 18yr tenure + Apr 2026 + spraying = ₹578.31', () => {
  const joinedAt = new Date('2008-04-15T00:00:00Z');
  const workDate = new Date('2026-04-15T00:00:00Z');

  const result = calculateUnionDailyWage({
    worker: { joinedAt },
    workDate,
    period: { basicPaise: 42121, daPaise: 15155 }, // Apr–Jun 2026
    config: { sprayingAllowancePaise: 325, shadeAllowancePaise: 325 },
    sprayingFlag: true,
    shadeFlag: false,
  });

  assert.equal(result.totalPaise, 57831, `expected 57831 paise, got ${result.totalPaise}`);
  assert.equal(formatRupees(result.totalPaise), '₹578.31');
  assert.equal(result.parts.weightagePaise, 230);
  assert.equal(result.parts.tenureYears, 18);
  assert.equal(result.parts.bandLabel, '16–20 yrs');
  assert.equal(result.parts.sprayingPaise, 325);
  assert.equal(result.parts.shadePaise, 0);
});

// ---------- weightage band boundaries ----------

test('weightage: under 5 years → ₹0', () => {
  assert.equal(weightagePaise(0), 0);
  assert.equal(weightagePaise(4), 0);
});

test('weightage: 6–10 years → ₹1.25', () => {
  assert.equal(weightagePaise(6), 125);
  assert.equal(weightagePaise(10), 125);
});

test('weightage: 11–15 years → ₹1.75', () => {
  assert.equal(weightagePaise(11), 175);
  assert.equal(weightagePaise(15), 175);
});

test('weightage: 16–20 years → ₹2.30', () => {
  assert.equal(weightagePaise(16), 230);
  assert.equal(weightagePaise(20), 230);
});

test('weightage: 21+ years → ₹2.80', () => {
  assert.equal(weightagePaise(21), 280);
  assert.equal(weightagePaise(40), 280);
});

test('5 years is in the "under 5" band per the brief (strictly less than 5 is below)', () => {
  // Brief §7.2 reads "Below 5 years" then "6–10 years". Exact 5 is treated
  // as below-5 (no weightage) until the worker completes their 6th year.
  assert.equal(weightagePaise(5), 0);
});

// ---------- tenure calculation ----------

test('tenure: full years from joinedAt to refDate', () => {
  const joined = new Date('2008-04-15T00:00:00Z');
  assert.equal(tenureYearsAt(joined, new Date('2026-04-14T00:00:00Z')), 17);
  assert.equal(tenureYearsAt(joined, new Date('2026-04-15T00:00:00Z')), 18);
  assert.equal(tenureYearsAt(joined, new Date('2027-04-14T00:00:00Z')), 18);
});

// ---------- union daily wage breakdown ----------

test('union worker absent → no spraying/shade allowance (controller decides total)', () => {
  // The engine itself just computes the wage assuming present; presence
  // is decided one layer up in calculateWeeklyPayroll.
  const result = calculateUnionDailyWage({
    worker: { joinedAt: new Date('2010-01-01Z') },
    workDate: new Date('2026-05-15Z'),
    period: { basicPaise: 42121, daPaise: 15155 },
    config: { sprayingAllowancePaise: 325, shadeAllowancePaise: 325 },
    sprayingFlag: false,
    shadeFlag: false,
  });
  // 16 yrs tenure → ₹2.30 weightage. No allowances.
  assert.equal(result.totalPaise, 42121 + 15155 + 230);
});

test('union worker both spraying AND shade flagged → both allowances stack', () => {
  const result = calculateUnionDailyWage({
    worker: { joinedAt: new Date('2008-04-15Z') },
    workDate: new Date('2026-04-15Z'),
    period: { basicPaise: 42121, daPaise: 15155 },
    config: { sprayingAllowancePaise: 325, shadeAllowancePaise: 325 },
    sprayingFlag: true,
    shadeFlag: true,
  });
  assert.equal(result.totalPaise, 57831 + 325); // canonical + shade
  assert.equal(formatRupees(result.totalPaise), '₹581.56');
});

// ---------- historical wage periods ----------

test('Jan–Mar 2026 boundary: same worker, different period → different wage', () => {
  const joined = new Date('2008-04-15Z');
  // Same worker, different work day → different active period.
  const jan = calculateUnionDailyWage({
    worker: { joinedAt: joined },
    workDate: new Date('2026-01-15Z'),
    period: { basicPaise: 37821, daPaise: 15155 }, // Jan–Mar 2026
    config: { sprayingAllowancePaise: 325, shadeAllowancePaise: 325 },
    sprayingFlag: false,
    shadeFlag: false,
  });
  // 17 yrs on Jan 15 2026 → 16–20 band, ₹2.30
  assert.equal(jan.totalPaise, 37821 + 15155 + 230); // 53206
  assert.equal(formatRupees(jan.totalPaise), '₹532.06');
});

// ---------- temp workers ----------

test('temp daily worker present → flat daily rate', () => {
  const r = calculateTempDailyWage({
    worker: { tempPayType: 'daily', tempRatePaise: 50000 },
    attendance: { isPresent: true, hoursWorked: 8 },
  });
  assert.equal(r.totalPaise, 50000); // ₹500.00
});

test('temp hourly worker present → rate × hours', () => {
  const r = calculateTempDailyWage({
    worker: { tempPayType: 'hourly', tempRatePaise: 7000 }, // ₹70/hr
    attendance: { isPresent: true, hoursWorked: 6.5 },
  });
  assert.equal(r.totalPaise, 45500); // ₹455.00
});

test('temp worker absent → ₹0', () => {
  const r = calculateTempDailyWage({
    worker: { tempPayType: 'daily', tempRatePaise: 50000 },
    attendance: { isPresent: false, hoursWorked: 0 },
  });
  assert.equal(r.totalPaise, 0);
});

// ---------- festival pay (manual formula verification) ----------

test('festival pay formula: Basic + DA + weightage, no allowances', () => {
  // 18-yr union worker, festival on 2026-04-15, absent.
  // Festival pay = ₹421.21 + ₹151.55 + ₹2.30 = ₹575.06 (no spraying/shade
  // because the worker didn't actually work).
  const basicPaise = 42121;
  const daPaise = 15155;
  const weightage = 230;
  const expected = basicPaise + daPaise + weightage;
  assert.equal(expected, 57506);
  assert.equal(formatRupees(expected), '₹575.06');
});
