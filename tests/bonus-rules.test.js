import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BonusRule } from '../src/models/BonusRule.js';
import { BonusPayment } from '../src/models/BonusPayment.js';
import { PayrollWeek } from '../src/models/PayrollWeek.js';
import { Worker } from '../src/models/Worker.js';
import {
  dueRuleOccurrences,
  festiveTriggerDate,
  materializeDueRuleBonuses,
  payableDate,
  tenureAnniversary,
} from '../src/services/bonus-rules.service.js';

// Bonus rules pay out lazily — brief §5.4.9. The "which occurrences are
// due" logic is pure; materializeDueRuleBonuses is tested with stubbed
// model statics (no MongoDB).

const day = (s) => new Date(`${s}T00:00:00.000Z`);

const onam = {
  _id: 'r-onam',
  name: 'Onam bonus',
  type: 'festive',
  amountPaise: 200000,
  triggerMonth: 9,
  triggerDay: 5,
  appliesTo: 'union',
  active: true,
  createdAt: new Date('2026-01-10T05:00:00.000Z'),
};

const tenYear = {
  _id: 'r-10y',
  name: '10-year bonus',
  type: 'tenure_milestone',
  amountPaise: 500000,
  triggerYears: 10,
  appliesTo: 'all',
  active: true,
  createdAt: new Date('2026-03-01T05:00:00.000Z'),
};

const union1 = { _id: 'w1', type: 'union', joinedAt: day('2016-06-20') };
const union2 = { _id: 'w2', type: 'union', joinedAt: day('2026-09-10') }; // joined after Onam
const temp1 = { _id: 'w3', type: 'temp', joinedAt: day('2010-01-01') };

test('festive rule: due once its date has passed, for matching workers who had joined', () => {
  const due = dueRuleOccurrences({
    rules: [onam],
    workers: [union1, union2, temp1],
    today: day('2026-10-08'),
  });
  assert.deepEqual(
    due.map((d) => d.occurrenceKey),
    ['r-onam:w1:2026'],
  );
  assert.equal(due[0].date.toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(due[0].amountPaise, 200000);
  assert.equal(due[0].reason, 'Onam bonus');
});

test('festive rule: not due before the trigger date', () => {
  const due = dueRuleOccurrences({
    rules: [onam],
    workers: [union1],
    today: day('2026-09-04'),
  });
  assert.equal(due.length, 0);
});

test('festive rule: is due on the trigger day itself', () => {
  const due = dueRuleOccurrences({
    rules: [onam],
    workers: [union1],
    today: day('2026-09-05'),
  });
  assert.equal(due.length, 1);
});

test('festive rule created after this year\'s date does not back-pay it', () => {
  const late = { ...onam, createdAt: new Date('2026-09-06T05:00:00.000Z') };
  const due = dueRuleOccurrences({
    rules: [late],
    workers: [union1],
    today: day('2026-10-08'),
  });
  assert.equal(due.length, 0);
});

test('festive rule created on the trigger day (IST) still pays', () => {
  // 20:00 IST on 5 Sep = 14:30 UTC.
  const sameDay = { ...onam, createdAt: new Date('2026-09-05T14:30:00.000Z') };
  const due = dueRuleOccurrences({
    rules: [sameDay],
    workers: [union1],
    today: day('2026-10-08'),
  });
  assert.equal(due.length, 1);
});

test('appliesTo all includes temp workers', () => {
  const due = dueRuleOccurrences({
    rules: [{ ...onam, appliesTo: 'all' }],
    workers: [union1, temp1],
    today: day('2026-10-08'),
  });
  assert.deepEqual(due.map((d) => d.workerId), ['w1', 'w3']);
});

test('tenure rule: pays anniversaries reached since the rule was created', () => {
  const w10 = { _id: 'w10', type: 'union', joinedAt: day('2016-06-20') }; // 10 yrs on 20 Jun 2026
  const wOld = { _id: 'w11', type: 'union', joinedAt: day('2015-06-20') }; // 10 yrs in 2025, before the rule
  const wSoon = { _id: 'w12', type: 'union', joinedAt: day('2016-12-01') }; // not yet
  const due = dueRuleOccurrences({
    rules: [tenYear],
    workers: [w10, wOld, wSoon],
    today: day('2026-10-08'),
  });
  assert.deepEqual(due.map((d) => d.occurrenceKey), ['r-10y:w10']);
  assert.equal(due[0].date.toISOString(), '2026-06-20T00:00:00.000Z');
});

test('skipped occurrences (payment deleted by the planter) are not due again', () => {
  const due = dueRuleOccurrences({
    rules: [{ ...onam, skippedOccurrenceKeys: ['r-onam:w1:2026'] }],
    workers: [union1],
    today: day('2026-10-08'),
  });
  assert.equal(due.length, 0);
});

test('inactive rules never pay', () => {
  const due = dueRuleOccurrences({
    rules: [{ ...onam, active: false }],
    workers: [union1],
    today: day('2026-10-08'),
  });
  assert.equal(due.length, 0);
});

test('festiveTriggerDate clamps to the end of short months', () => {
  const feb29 = { triggerMonth: 2, triggerDay: 29 };
  assert.equal(festiveTriggerDate(feb29, 2027).toISOString(), '2027-02-28T00:00:00.000Z');
  assert.equal(festiveTriggerDate(feb29, 2028).toISOString(), '2028-02-29T00:00:00.000Z');
});

test('tenureAnniversary of a 29 Feb joiner is 1 Mar in non-leap years', () => {
  assert.equal(
    tenureAnniversary(day('2020-02-29'), 1).toISOString(),
    '2021-03-01T00:00:00.000Z',
  );
  // IST-midnight joinedAt (18:30 UTC the day before) reads as the IST day.
  assert.equal(
    tenureAnniversary(new Date('2016-06-19T18:30:00.000Z'), 10).toISOString(),
    '2026-06-20T00:00:00.000Z',
  );
});

test('payableDate keeps the date when its week is unpaid', () => {
  const d = day('2026-09-05'); // Sat, week of Mon 31 Aug
  assert.equal(payableDate(d, new Set()), d);
});

test('payableDate moves to the earliest unpaid week after a paid one', () => {
  const d = day('2026-09-05');
  const paid = new Set(['2026-08-31', '2026-09-07']);
  assert.equal(payableDate(d, paid).toISOString(), '2026-09-14T00:00:00.000Z');
});

// ---------- materializeDueRuleBonuses (stubbed models) ----------

const originals = {};
let inserted;
let existingKeys;
let paidWeeks;

function query(result) {
  const q = Promise.resolve(result);
  q.select = () => Promise.resolve(result);
  return q;
}

before(() => {
  originals.ruleFind = BonusRule.find;
  originals.workerFind = Worker.find;
  originals.paymentFind = BonusPayment.find;
  originals.insertMany = BonusPayment.insertMany;
  originals.payrollFind = PayrollWeek.find;
  BonusRule.find = () => query([onam]);
  Worker.find = () => query([union1, union2]);
  BonusPayment.find = (filter) =>
    query(
      filter.occurrenceKey.$in
        .filter((k) => existingKeys.includes(k))
        .map((occurrenceKey) => ({ occurrenceKey })),
    );
  BonusPayment.insertMany = async (docs) => {
    inserted.push(...docs);
    return docs;
  };
  PayrollWeek.find = () => query(paidWeeks);
});

after(() => {
  BonusRule.find = originals.ruleFind;
  Worker.find = originals.workerFind;
  BonusPayment.find = originals.paymentFind;
  BonusPayment.insertMany = originals.insertMany;
  PayrollWeek.find = originals.payrollFind;
});

test('materialize: creates the due payment dated inside the trigger day (IST)', async () => {
  inserted = [];
  existingKeys = [];
  paidWeeks = [];
  const n = await materializeDueRuleBonuses('p1', day('2026-10-08'));
  assert.equal(n, 1);
  assert.equal(inserted[0].occurrenceKey, 'r-onam:w1:2026');
  assert.equal(inserted[0].ruleId, 'r-onam');
  assert.equal(inserted[0].amountPaise, 200000);
  assert.equal(inserted[0].reason, 'Onam bonus');
  // 12:00 IST on 5 Sep.
  assert.equal(inserted[0].paidAt.toISOString(), '2026-09-05T06:30:00.000Z');
});

test('materialize: already-paid occurrences are not paid twice', async () => {
  inserted = [];
  existingKeys = ['r-onam:w1:2026'];
  paidWeeks = [];
  const n = await materializeDueRuleBonuses('p1', day('2026-10-08'));
  assert.equal(n, 0);
  assert.equal(inserted.length, 0);
});

test('materialize: a paid week pushes the bonus into the next unpaid week', async () => {
  inserted = [];
  existingKeys = [];
  paidWeeks = [{ workerId: 'w1', weekStart: day('2026-08-31') }];
  await materializeDueRuleBonuses('p1', day('2026-10-08'));
  assert.equal(inserted[0].paidAt.toISOString(), '2026-09-07T06:30:00.000Z');
});
