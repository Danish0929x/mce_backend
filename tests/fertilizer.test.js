import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSeasonCost,
  dueCutoff,
  exactNameRegex,
  formatDayLabel,
  initialsOf,
  isDueForApplication,
  seasonBounds,
} from '../src/services/fertilizer.service.js';

// Fertilizer module — brief §5.3.2 (mark applied), §5.3.3 (season cost),
// §5.3.4 (applied-by initials). All pure; no MongoDB.

// 8 Oct 2026, 10:00 IST.
const NOW = new Date('2026-10-08T04:30:00.000Z');

// ---------- mark applied: IST due-day gate ----------

test('today and past IST days are due; tomorrow is not', () => {
  assert.equal(isDueForApplication(new Date('2026-10-08T00:00:00Z'), NOW), true);
  assert.equal(isDueForApplication(new Date('2026-10-01T00:00:00Z'), NOW), true);
  assert.equal(isDueForApplication(new Date('2026-10-09T00:00:00Z'), NOW), false);
});

test('IST local midnight sent as UTC (previous UTC day 18:30) is that IST day', () => {
  // 2026-10-08T18:30Z is 9 Oct 00:00 IST → not due on 8 Oct.
  assert.equal(isDueForApplication(new Date('2026-10-08T18:30:00Z'), NOW), false);
  // 2026-10-07T18:30Z is 8 Oct 00:00 IST → due.
  assert.equal(isDueForApplication(new Date('2026-10-07T18:30:00Z'), NOW), true);
});

test('late evening IST already counts as the next IST day for "today"', () => {
  // 8 Oct 23:00 UTC = 9 Oct 04:30 IST → a 9 Oct entry is due.
  const lateNight = new Date('2026-10-08T23:00:00Z');
  assert.equal(isDueForApplication(new Date('2026-10-09T00:00:00Z'), lateNight), true);
});

test('dueCutoff is the start of tomorrow in IST', () => {
  assert.equal(dueCutoff(NOW).toISOString(), '2026-10-08T18:30:00.000Z');
});

test('formatDayLabel', () => {
  assert.equal(formatDayLabel(new Date('2026-10-15T00:00:00Z')), '15 Oct 2026');
});

// ---------- season bounds ----------

test('season is the IST calendar year (New Year in IST before UTC)', () => {
  // 31 Dec 2026 20:00 UTC = 1 Jan 2027 01:30 IST.
  assert.equal(seasonBounds(new Date('2026-12-31T20:00:00Z')).year, 2027);
  const { instantRange } = seasonBounds(NOW);
  assert.equal(instantRange.$gte.toISOString(), '2025-12-31T18:30:00.000Z');
  assert.equal(instantRange.$lt.toISOString(), '2026-12-31T18:30:00.000Z');
});

// ---------- season cost ----------

const UREA = 'f-urea';
const MOP = 'f-mop';
const LIME = 'f-lime';

test('spent counts only priced purchases inside the season', () => {
  const s = computeSeasonCost({
    now: NOW,
    purchases: [
      { fertilizerId: UREA, totalCostPaise: 250000, pricePerKgPaise: 2500, purchasedAt: new Date('2026-03-01T05:00:00Z') },
      // Manual adjustment — price 0, ignored.
      { fertilizerId: UREA, totalCostPaise: 0, pricePerKgPaise: 0, purchasedAt: new Date('2026-04-01T05:00:00Z') },
      // Last season.
      { fertilizerId: MOP, totalCostPaise: 99900, pricePerKgPaise: 3000, purchasedAt: new Date('2025-12-31T17:00:00Z') },
      // 31 Dec 2025 19:00 UTC = 1 Jan 2026 IST → this season.
      { fertilizerId: MOP, totalCostPaise: 60000, pricePerKgPaise: 3000, purchasedAt: new Date('2025-12-31T19:00:00Z') },
    ],
  });
  assert.equal(s.season, 2026);
  assert.equal(s.spentPaise, 310000);
  assert.equal(s.projectedRemainingPaise, 0);
  assert.equal(s.totalEstimatePaise, 310000);
});

test('projected = shortfall × latest price; on-hand stock is netted per fertilizer', () => {
  const s = computeSeasonCost({
    now: NOW,
    purchases: [
      { fertilizerId: UREA, totalCostPaise: 100000, pricePerKgPaise: 2500, purchasedAt: new Date('2026-02-01T05:00:00Z') },
    ],
    latestPricePaise: new Map([[UREA, 2800], [MOP, 3150]]),
    schedules: [
      { fertilizerId: UREA, scheduledDate: new Date('2026-10-20T00:00:00Z'), totalQuantityKg: 150, status: 'upcoming' },
      { fertilizerId: UREA, scheduledDate: new Date('2026-12-15T00:00:00Z'), totalQuantityKg: 150, status: 'upcoming' },
      // Overdue but still open → still needed.
      { fertilizerId: MOP, scheduledDate: new Date('2026-09-20T00:00:00Z'), totalQuantityKg: 200.5, status: 'due' },
      // Next season — not counted.
      { fertilizerId: MOP, scheduledDate: new Date('2027-01-10T00:00:00Z'), totalQuantityKg: 500, status: 'upcoming' },
      // Done / skipped — not counted.
      { fertilizerId: UREA, scheduledDate: new Date('2026-11-01T00:00:00Z'), totalQuantityKg: 999, status: 'completed' },
      { fertilizerId: UREA, scheduledDate: new Date('2026-11-02T00:00:00Z'), totalQuantityKg: 999, status: 'skipped' },
    ],
    inventory: [
      { fertilizerId: UREA, quantityGrams: 100000 }, // 100 kg
      { fertilizerId: MOP, quantityGrams: 0 },
    ],
  });
  // Urea: need 300, have 100 → 200 kg × ₹28 = ₹5,600.
  // MOP: need 200.5, have 0 → 200.5 kg × ₹31.50 = ₹6,315.75.
  assert.equal(s.projectedRemainingPaise, 560000 + 631575);
  assert.equal(s.spentPaise, 100000);
  assert.equal(s.totalEstimatePaise, 100000 + 560000 + 631575);
  assert.equal(s.unpricedCount, 0);
  const urea = s.byFertilizer.find((r) => r.fertilizerId === UREA);
  assert.equal(urea.shortfallKg, 200);
  assert.equal(urea.projectedPaise, 560000);
});

test('enough stock on hand → nothing projected', () => {
  const s = computeSeasonCost({
    now: NOW,
    latestPricePaise: { [UREA]: 2800 },
    schedules: [
      { fertilizerId: UREA, scheduledDate: new Date('2026-10-20T00:00:00Z'), totalQuantityKg: 50, status: 'upcoming' },
    ],
    inventory: [{ fertilizerId: UREA, quantityGrams: 80000 }],
  });
  assert.equal(s.projectedRemainingPaise, 0);
  assert.equal(s.byFertilizer.length, 0);
});

test('short fertilizers never bought at a price are excluded and counted', () => {
  const s = computeSeasonCost({
    now: NOW,
    latestPricePaise: new Map([[UREA, 2000]]),
    schedules: [
      { fertilizerId: UREA, scheduledDate: new Date('2026-10-20T00:00:00Z'), totalQuantityKg: 10, status: 'upcoming' },
      { fertilizerId: LIME, scheduledDate: new Date('2026-11-20T00:00:00Z'), totalQuantityKg: 400, status: 'upcoming' },
      { fertilizerId: MOP, scheduledDate: new Date('2026-11-20T00:00:00Z'), totalQuantityKg: 5, status: 'upcoming' },
    ],
    // MOP is covered by stock, so its missing price doesn't matter.
    inventory: [{ fertilizerId: MOP, quantityGrams: 5000 }],
  });
  assert.equal(s.projectedRemainingPaise, 20000);
  assert.equal(s.unpricedCount, 1);
  assert.deepEqual(s.unpricedFertilizerIds, [LIME]);
});

// ---------- applied-by + duplicate names ----------

test('initialsOf', () => {
  assert.equal(initialsOf('Ravi Kumar'), 'RK');
  assert.equal(initialsOf('  anitha  joseph  mathew '), 'AM');
  assert.equal(initialsOf('Ravi'), 'RA');
  assert.equal(initialsOf(''), null);
  assert.equal(initialsOf(null), null);
});

test('exactNameRegex matches case-insensitively and escapes specials', () => {
  assert.ok(exactNameRegex('urea').test('Urea'));
  assert.ok(!exactNameRegex('urea').test('Urea 46%'));
  assert.ok(exactNameRegex(' NPK 20:10:10 (mix) ').test('npk 20:10:10 (mix)'));
  assert.ok(!exactNameRegex('a.b').test('axb'));
});
