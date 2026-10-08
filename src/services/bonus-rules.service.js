/**
 * Bonus rules → BonusPayments — brief §5.4.9.
 *
 * Rules are paid out lazily (no cron): `materializeDueRuleBonuses` runs at
 * the start of the weekly payroll and bonus screens and creates any payment
 * that has fallen due since the last call. Each payment occurrence has a
 * unique `occurrenceKey`, so it is never paid twice:
 *
 *   festive           `${ruleId}:${workerId}:${year}`  — once per year
 *   tenure_milestone  `${ruleId}:${workerId}`          — once per worker
 *
 * A rule only pays occurrences on or after the day it was created — adding
 * an "Onam bonus" rule in October does not back-pay this year's Onam, and a
 * new 10-year rule does not pay workers who passed 10 years long ago.
 *
 * The payment lands in the week of the occurrence date so it joins that
 * week's payroll. If the worker's week is already paid (frozen), it moves
 * to the earliest unpaid week after it instead.
 */

import { BonusRule } from '../models/BonusRule.js';
import { BonusPayment } from '../models/BonusPayment.js';
import { PayrollWeek } from '../models/PayrollWeek.js';
import { Worker } from '../models/Worker.js';
import { addDays, istDateOnly, startOfWeekMonday, toDateKey, todayIST } from '../utils/dates.js';

const IST_NOON_OFFSET_MS = 6.5 * 60 * 60 * 1000; // 12:00 IST = 06:30 UTC

/** [rule]'s festive trigger date in [year]; day clamped to the month's end. */
export function festiveTriggerDate(rule, year) {
  const month = (rule.triggerMonth ?? 1) - 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(rule.triggerDay ?? 1, lastDay)));
}

/**
 * The day a worker completes [years] of service — the first day
 * tenureYearsAt(joinedAt, day) reaches [years] (a 29 Feb joiner's
 * anniversary is 1 Mar in non-leap years).
 */
export function tenureAnniversary(joinedAt, years) {
  const j = istDateOnly(joinedAt);
  return new Date(
    Date.UTC(j.getUTCFullYear() + years, j.getUTCMonth(), j.getUTCDate()),
  );
}

function appliesToWorker(rule, worker) {
  return rule.appliesTo === 'all' || worker.type === (rule.appliesTo ?? 'union');
}

/**
 * Pure: every rule occurrence due on or before [today] (date-only, IST).
 * Callers drop the ones already paid (by occurrenceKey).
 *
 * @param {object} args
 * @param {Array<object>} args.rules - active BonusRules
 * @param {Array<object>} args.workers - active workers
 * @param {Date} args.today
 * @returns {Array<{occurrenceKey: string, ruleId: string, workerId: string,
 *   date: Date, amountPaise: number, reason: string}>}
 */
export function dueRuleOccurrences({ rules, workers, today }) {
  const due = [];
  for (const rule of rules) {
    if (rule.active === false) continue;
    const ruleId = rule._id.toString();
    const createdOn = istDateOnly(rule.createdAt ?? today);
    const skipped = new Set(rule.skippedOccurrenceKeys ?? []);
    const push = (worker, date, occurrenceKey) => {
      if (skipped.has(occurrenceKey)) return;
      due.push({
        occurrenceKey,
        ruleId,
        workerId: worker._id.toString(),
        date,
        amountPaise: rule.amountPaise,
        reason: rule.name,
      });
    };

    if (rule.type === 'festive') {
      if (!rule.triggerMonth || !rule.triggerDay) continue;
      const year = today.getUTCFullYear();
      const date = festiveTriggerDate(rule, year);
      if (date > today || createdOn > date) continue;
      for (const w of workers) {
        if (!appliesToWorker(rule, w) || !w.joinedAt) continue;
        if (istDateOnly(w.joinedAt) > date) continue;
        push(w, date, `${ruleId}:${w._id.toString()}:${year}`);
      }
    } else if (rule.type === 'tenure_milestone') {
      if (!rule.triggerYears) continue;
      for (const w of workers) {
        if (!appliesToWorker(rule, w) || !w.joinedAt) continue;
        const date = tenureAnniversary(w.joinedAt, rule.triggerYears);
        if (date > today || date < createdOn) continue;
        push(w, date, `${ruleId}:${w._id.toString()}`);
      }
    }
  }
  return due;
}

/**
 * Pure: the day a payment due on [date] should be dated — [date] itself,
 * or the Monday of the earliest later week not in [paidWeekKeys]
 * ('YYYY-MM-DD' week starts already paid for that worker).
 */
export function payableDate(date, paidWeekKeys) {
  let week = startOfWeekMonday(date);
  if (!paidWeekKeys.has(toDateKey(week))) return date;
  do {
    week = addDays(week, 7);
  } while (paidWeekKeys.has(toDateKey(week)));
  return week;
}

/**
 * Create the BonusPayments for every rule occurrence of [plantationId] due
 * by [today] that hasn't been paid yet. Safe to call on every request and
 * concurrently (the unique occurrenceKey index rejects duplicates).
 * Returns the number of payments created.
 */
export async function materializeDueRuleBonuses(plantationId, today = todayIST()) {
  const rules = await BonusRule.find({ plantationId, active: true });
  if (!rules.length) return 0;
  const workers = await Worker.find({ plantationId, active: true });
  const due = dueRuleOccurrences({ rules, workers, today });
  if (!due.length) return 0;

  const existing = await BonusPayment.find({
    plantationId,
    occurrenceKey: { $in: due.map((d) => d.occurrenceKey) },
  }).select('occurrenceKey');
  const done = new Set(existing.map((e) => e.occurrenceKey));
  const pending = due.filter((d) => !done.has(d.occurrenceKey));
  if (!pending.length) return 0;

  const earliest = pending.reduce((m, d) => (d.date < m ? d.date : m), pending[0].date);
  const paidWeeks = await PayrollWeek.find({
    plantationId,
    workerId: { $in: [...new Set(pending.map((d) => d.workerId))] },
    weekStart: { $gte: startOfWeekMonday(earliest) },
    paidAt: { $ne: null },
  }).select('workerId weekStart');
  const paidByWorker = new Map();
  for (const w of paidWeeks) {
    const key = w.workerId.toString();
    if (!paidByWorker.has(key)) paidByWorker.set(key, new Set());
    paidByWorker.get(key).add(toDateKey(istDateOnly(w.weekStart)));
  }

  const docs = pending.map((d) => {
    const day = payableDate(d.date, paidByWorker.get(d.workerId) ?? new Set());
    return {
      plantationId,
      workerId: d.workerId,
      ruleId: d.ruleId,
      amountPaise: d.amountPaise,
      reason: d.reason,
      occurrenceKey: d.occurrenceKey,
      // An instant inside that IST day, so istInstantRange finds it.
      paidAt: new Date(day.getTime() + IST_NOON_OFFSET_MS),
    };
  });

  try {
    const created = await BonusPayment.insertMany(docs, { ordered: false });
    return created.length;
  } catch (err) {
    // Another request paid some of them first — the rest were inserted.
    if (err?.code === 11000 || err?.writeErrors?.every((e) => e.code === 11000)) {
      return err.insertedDocs?.length ?? 0;
    }
    throw err;
  }
}
