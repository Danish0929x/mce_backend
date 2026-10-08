/**
 * Festival calendar defaults — brief §5.4.6.
 *
 * Only holidays on the same date every year are preloaded. Lunar festivals
 * (Vishu, Onam, Diwali, Bakrid, …) move each year and must be entered by
 * the planter — never guessed here.
 */

/** Fixed-date Kerala / national holidays: [month (1–12), day, label]. */
export const FIXED_HOLIDAYS = [
  [1, 26, 'Republic Day'],
  [5, 1, 'May Day'],
  [8, 15, 'Independence Day'],
  [10, 2, 'Gandhi Jayanti'],
  [12, 25, 'Christmas'],
];

/**
 * Fixed holidays of [year] to preload, as { date, label } with date-only
 * dates. Days before [today] are left out: a newly marked festival adds a
 * day's wage to every unpaid week containing it, so preloading must never
 * change pay for days already behind the planter.
 */
export function fixedHolidaysFor(year, today) {
  return FIXED_HOLIDAYS.map(([m, d, label]) => ({
    date: new Date(Date.UTC(year, m - 1, d)),
    label,
  })).filter((h) => h.date >= today);
}
