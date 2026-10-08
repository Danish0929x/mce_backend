import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixedHolidaysFor } from '../src/services/festival-calendar.service.js';

const day = (s) => new Date(`${s}T00:00:00.000Z`);

test('a future year preloads all five fixed-date holidays', () => {
  const h = fixedHolidaysFor(2027, day('2026-10-08'));
  assert.deepEqual(
    h.map((x) => [x.date.toISOString().slice(0, 10), x.label]),
    [
      ['2027-01-26', 'Republic Day'],
      ['2027-05-01', 'May Day'],
      ['2027-08-15', 'Independence Day'],
      ['2027-10-02', 'Gandhi Jayanti'],
      ['2027-12-25', 'Christmas'],
    ],
  );
});

test('the current year preloads only holidays from today on', () => {
  const h = fixedHolidaysFor(2026, day('2026-10-02'));
  assert.deepEqual(h.map((x) => x.label), ['Gandhi Jayanti', 'Christmas']);
});

test('past years preload nothing', () => {
  assert.equal(fixedHolidaysFor(2025, day('2026-10-08')).length, 0);
});
