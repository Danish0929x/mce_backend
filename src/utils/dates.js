import { z } from 'zod';

/**
 * Calendar-date helpers. The whole app runs on IST (Asia/Kolkata, UTC+5:30,
 * no DST) regardless of server or device timezone — brief §10.6.
 *
 * Convention: a date-only value (work date, joined date, festival date, week
 * start) is stored as **UTC midnight of its IST calendar day**, so reading
 * getUTCFullYear / getUTCMonth / getUTCDate gives back the IST day.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * IST calendar day of [value], as UTC midnight.
 *
 * - 'YYYY-MM-DD' strings are taken literally.
 * - Anything else is treated as an instant and converted to its IST day.
 *   Handles both client conventions seen in the wild: UTC midnight of the day
 *   ("2026-04-15T00:00:00Z") and IST local midnight sent as UTC
 *   ("2026-04-14T18:30:00Z") — both map to 15 Apr.
 *
 * Idempotent: passing a value already in the convention returns the same day.
 * Returns an Invalid Date for unparseable input.
 */
export function istDateOnly(value) {
  if (typeof value === 'string') {
    const m = DATE_ONLY_RE.exec(value);
    if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return new Date(NaN);
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()),
  );
}

/** Today's IST calendar day, as UTC midnight. */
export function todayIST(now = new Date()) {
  return istDateOnly(now);
}

/** Current calendar year in IST. */
export function currentYearIST(now = new Date()) {
  return todayIST(now).getUTCFullYear();
}

/** [date] shifted by [days] calendar days. */
export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Last millisecond of a date-only value's day — for inclusive range ends. */
export function endOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Monday of the week containing the date-only value [date]. */
export function startOfWeekMonday(date) {
  const d = istDateOnly(date);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return addDays(d, -daysSinceMonday);
}

/**
 * Mongo range for timestamps (e.g. BonusPayment.paidAt) that fall on the IST
 * calendar days [from, to] inclusive. Unlike date-only fields, timestamps
 * are real instants, so the IST day starts at 18:30 UTC the day before.
 */
export function istInstantRange(from, to) {
  const start = istDateOnly(from).getTime() - IST_OFFSET_MS;
  const end = addDays(istDateOnly(to), 1).getTime() - IST_OFFSET_MS;
  return { $gte: new Date(start), $lt: new Date(end) };
}

/** Whole calendar days from [from] to [to] (both date-only). */
export function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/** 'YYYY-MM-DD' of a date-only value. */
export function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Zod field for date-only input. Accepts 'YYYY-MM-DD' or any timestamp, and
 * normalizes to the IST calendar day.
 */
export const zDateOnly = z
  .union([z.string(), z.date()])
  .transform((v, ctx) => {
    const d = istDateOnly(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
      return z.NEVER;
    }
    return d;
  });

/**
 * Wage period bounds. Accepts 'YYYY-MM-DD', or — from older app builds — a
 * UTC-anchored timestamp ("2026-07-01T00:00:00Z" / "2026-09-30T23:59:59.999Z"),
 * read as its UTC calendar day. Reading those as IST would push an
 * end-of-day value onto the next day.
 */
export const zDateKey = z
  .union([z.string(), z.date()])
  .transform((v, ctx) => {
    if (typeof v === 'string' && DATE_ONLY_RE.test(v)) return istDateOnly(v);
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
      return z.NEVER;
    }
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  });
