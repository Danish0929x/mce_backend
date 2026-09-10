import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WagePeriod } from '../src/models/WagePeriod.js';
import { AnnualConfig } from '../src/models/AnnualConfig.js';
import { calculateWeeklyPayroll } from '../src/services/wage-engine.service.js';

// calculateWeeklyPayroll reads WagePeriod + AnnualConfig. Stub both so the
// test runs without MongoDB: Apr–Jun 2026 is on file, Jul–Sep 2026 is not.

const APR_JUN_2026 = {
  label: 'Apr–Jun 2026',
  effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
  effectiveTo: new Date('2026-06-30T23:59:59.999Z'),
  basicPaise: 42121,
  daPaise: 15155,
};

const originals = {};

before(() => {
  originals.activeOn = WagePeriod.activeOn;
  originals.findOne = AnnualConfig.findOne;
  WagePeriod.activeOn = async (plantationId, date) =>
    plantationId === 'p1' &&
    date >= APR_JUN_2026.effectiveFrom &&
    date <= APR_JUN_2026.effectiveTo
      ? APR_JUN_2026
      : null;
  AnnualConfig.findOne = () => {
    const q = Promise.resolve(null);
    q.sort = () => Promise.resolve(null); // → built-in ₹3.25 allowances
    return q;
  };
});

after(() => {
  WagePeriod.activeOn = originals.activeOn;
  AnnualConfig.findOne = originals.findOne;
});

const day = (s) => new Date(`${s}T00:00:00.000Z`);

const unionWorker = {
  _id: 'w1',
  plantationId: 'p1',
  type: 'union',
  joinedAt: day('2008-04-15'), // 18 yrs in 2026 → ₹2.30 weightage
};

function present(dateStr, extra = {}) {
  return { workDate: day(dateStr), isPresent: true, hoursWorked: 8, ...extra };
}

test('week fully inside a circular: pays every day, no missing days', async () => {
  // Mon 13 Apr – Sun 19 Apr 2026
  const r = await calculateWeeklyPayroll({
    worker: unionWorker,
    attendance: [present('2026-04-15', { sprayingFlag: true }), present('2026-04-16')],
    weekStart: day('2026-04-13'),
    festivalDatesInWeek: [],
  });
  assert.equal(r.missingPeriodDays, 0);
  // 57831 (canonical, with spraying) + 57506 (no allowance)
  assert.equal(r.totalPaise, 57831 + 57506);
});

test('week crossing into a period with no circular: flags the uncovered worked days', async () => {
  // Mon 29 Jun – Sun 5 Jul 2026. Circular ends 30 Jun; nothing after.
  const r = await calculateWeeklyPayroll({
    worker: unionWorker,
    attendance: [present('2026-06-30'), present('2026-07-01'), present('2026-07-02')],
    weekStart: day('2026-06-29'),
    festivalDatesInWeek: [],
  });
  assert.equal(r.daysPresent, 3);
  assert.equal(r.missingPeriodDays, 2); // 1 and 2 Jul
  assert.equal(r.totalPaise, 57506); // only 30 Jun is paid
});

test('festival day with no circular counts as missing too', async () => {
  const r = await calculateWeeklyPayroll({
    worker: unionWorker,
    attendance: [],
    weekStart: day('2026-07-06'),
    festivalDatesInWeek: [{ date: day('2026-07-08'), label: 'Test festival' }],
  });
  assert.equal(r.missingPeriodDays, 1);
  assert.equal(r.totalPaise, 0);
});

test('absent days with no circular are not flagged (nothing is owed)', async () => {
  const r = await calculateWeeklyPayroll({
    worker: unionWorker,
    attendance: [],
    weekStart: day('2026-07-06'),
    festivalDatesInWeek: [],
  });
  assert.equal(r.missingPeriodDays, 0);
});

test("uses only the worker's own estate's circulars", async () => {
  // Same dates as the first test, but an estate with no circulars on file.
  const r = await calculateWeeklyPayroll({
    worker: { ...unionWorker, plantationId: 'other-estate' },
    attendance: [present('2026-04-15')],
    weekStart: day('2026-04-13'),
    festivalDatesInWeek: [],
  });
  assert.equal(r.missingPeriodDays, 1);
  assert.equal(r.totalPaise, 0);
});

test('temp workers are never flagged — they do not use circulars', async () => {
  const r = await calculateWeeklyPayroll({
    worker: { ...unionWorker, type: 'temp', tempPayType: 'daily', tempRatePaise: 50000 },
    attendance: [present('2026-07-01')],
    weekStart: day('2026-06-29'),
    festivalDatesInWeek: [],
  });
  assert.equal(r.missingPeriodDays, 0);
  assert.equal(r.totalPaise, 50000);
});
