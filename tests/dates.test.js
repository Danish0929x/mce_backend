import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  istDateOnly,
  todayIST,
  startOfWeekMonday,
  istInstantRange,
  daysBetween,
  zDateKey,
  zDateOnly,
} from '../src/utils/dates.js';
import { tenureYearsAt } from '../src/services/wage-engine.service.js';

const day = (s) => new Date(`${s}T00:00:00.000Z`);

// ---------- IST calendar day ----------

test('istDateOnly: YYYY-MM-DD is taken literally', () => {
  assert.deepEqual(istDateOnly('2026-04-15'), day('2026-04-15'));
});

test('istDateOnly: UTC-midnight and IST-midnight timestamps both map to the same day', () => {
  // Flutter DateTime.utc(y, m, d) convention
  assert.deepEqual(istDateOnly('2026-04-15T00:00:00.000Z'), day('2026-04-15'));
  // Local IST midnight sent via .toUtc() — the old joinedAt / scheduledDate shape
  assert.deepEqual(istDateOnly('2026-04-14T18:30:00.000Z'), day('2026-04-15'));
});

test('istDateOnly: day boundary is 18:30 UTC', () => {
  assert.deepEqual(istDateOnly('2026-04-15T18:29:59.999Z'), day('2026-04-15'));
  assert.deepEqual(istDateOnly('2026-04-15T18:30:00.000Z'), day('2026-04-16'));
});

test('istDateOnly is idempotent', () => {
  const d = istDateOnly('2026-04-14T18:30:00.000Z');
  assert.deepEqual(istDateOnly(d), d);
});

test('todayIST: 1:30 AM IST is already the next day (UTC still shows yesterday)', () => {
  // 10 Sep 2026 20:00 UTC = 11 Sep 2026 01:30 IST
  assert.deepEqual(todayIST(new Date('2026-09-10T20:00:00Z')), day('2026-09-11'));
});

// ---------- weeks ----------

test('startOfWeekMonday: early Monday morning IST belongs to that Monday', () => {
  // Mon 14 Sep 2026 01:00 IST = Sun 13 Sep 19:30 UTC
  const mondayEarly = new Date('2026-09-13T19:30:00Z');
  assert.deepEqual(startOfWeekMonday(mondayEarly), day('2026-09-14'));
});

test('startOfWeekMonday: Sunday belongs to the week that started the Monday before', () => {
  assert.deepEqual(startOfWeekMonday(day('2026-09-20')), day('2026-09-14'));
  assert.deepEqual(startOfWeekMonday(day('2026-09-14')), day('2026-09-14'));
});

test('istInstantRange: covers IST days, i.e. 18:30 UTC the day before to 18:30 UTC', () => {
  const r = istInstantRange(day('2026-09-14'), day('2026-09-20'));
  assert.deepEqual(r.$gte, new Date('2026-09-13T18:30:00.000Z'));
  assert.deepEqual(r.$lt, new Date('2026-09-20T18:30:00.000Z'));
});

test('daysBetween: whole calendar days', () => {
  assert.equal(daysBetween(day('2026-09-10'), day('2026-09-30')), 20);
  assert.equal(daysBetween(day('2026-09-10'), day('2026-09-10')), 0);
});

// ---------- validation ----------

test('zDateKey: YYYY-MM-DD, plus the UTC-anchored timestamps older app builds send', () => {
  assert.deepEqual(zDateKey.parse('2026-07-01'), day('2026-07-01'));
  assert.deepEqual(zDateKey.parse('2026-07-01T00:00:00.000Z'), day('2026-07-01'));
  // End-of-day "to" value must stay on 30 Sep, not roll into 1 Oct IST.
  assert.deepEqual(zDateKey.parse('2026-09-30T23:59:59.999Z'), day('2026-09-30'));
  assert.throws(() => zDateKey.parse('not a date'));
});

test('zDateOnly: rejects garbage', () => {
  assert.throws(() => zDateOnly.parse('not a date'));
});

// ---------- tenure with IST dates ----------

test('tenure: joinedAt stored as IST midnight still anniversaries on the right day', () => {
  // Joined 15 Apr 2008, stored by the old app as 14 Apr 18:30 UTC.
  const joined = new Date('2008-04-14T18:30:00.000Z');
  assert.equal(tenureYearsAt(joined, day('2026-04-14')), 17);
  assert.equal(tenureYearsAt(joined, day('2026-04-15')), 18);
});
