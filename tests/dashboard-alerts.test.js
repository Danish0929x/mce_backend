import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capAlerts,
  upcomingFestiveBonuses,
} from '../src/controllers/dashboard/dashboard.controller.js';

const day = (s) => new Date(`${s}T00:00:00.000Z`);
const festive = (name, triggerMonth, triggerDay, extra = {}) => ({
  _id: name,
  name,
  type: 'festive',
  active: true,
  amountPaise: 200000,
  triggerMonth,
  triggerDay,
  ...extra,
});

// ---------- festive bonus due within 7 days ----------

test('festive bonus 5 days out is due; 8 days out is not', () => {
  const rules = [festive('Onam', 9, 5), festive('Vishu', 4, 14)];
  assert.deepEqual(
    upcomingFestiveBonuses(rules, day('2026-08-31')).map((r) => [r.rule.name, r.daysUntil]),
    [['Onam', 5]],
  );
  assert.deepEqual(upcomingFestiveBonuses(rules, day('2026-08-28')), []);
});

test('festive bonus due today counts; yesterday does not', () => {
  const rules = [festive('Onam', 9, 5)];
  assert.equal(upcomingFestiveBonuses(rules, day('2026-09-05'))[0].daysUntil, 0);
  assert.deepEqual(upcomingFestiveBonuses(rules, day('2026-09-06')), []);
});

test('festive bonus wraps across the year end', () => {
  const rules = [festive('New Year', 1, 2)];
  assert.equal(upcomingFestiveBonuses(rules, day('2026-12-28'))[0].daysUntil, 5);
});

test('inactive, tenure and date-less rules are ignored; soonest first', () => {
  const rules = [
    festive('Later', 9, 7),
    festive('Off', 9, 3, { active: false }),
    festive('Tenure', null, null, { type: 'tenure_milestone' }),
    festive('Sooner', 9, 2),
  ];
  assert.deepEqual(
    upcomingFestiveBonuses(rules, day('2026-09-01')).map((r) => r.rule.name),
    ['Sooner', 'Later'],
  );
});

test('29 Feb rule only fires in leap years', () => {
  const rules = [festive('Leap', 2, 29)];
  assert.deepEqual(upcomingFestiveBonuses(rules, day('2027-02-25')), []);
  assert.equal(upcomingFestiveBonuses(rules, day('2028-02-25'))[0].daysUntil, 4);
});

// ---------- max 3 alerts, danger first ----------

test('capAlerts: danger before warning, order kept within severity, max 3', () => {
  const alerts = [
    { id: 'w1', severity: 'warning' },
    { id: 'd1', severity: 'danger' },
    { id: 'w2', severity: 'warning' },
    { id: 'd2', severity: 'danger' },
    { id: 'd3', severity: 'danger' },
  ];
  assert.deepEqual(capAlerts(alerts).map((a) => a.id), ['d1', 'd2', 'd3']);
  assert.deepEqual(
    capAlerts(alerts.slice(0, 3)).map((a) => a.id),
    ['d1', 'w1', 'w2'],
  );
  assert.deepEqual(capAlerts([]), []);
});
