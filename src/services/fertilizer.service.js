import { istDateOnly, istInstantRange, todayIST } from '../utils/dates.js';

/**
 * Pure helpers for the fertilizer module (brief §5.3). No Mongoose here —
 * the controller loads the rows, these do the maths, so they unit-test
 * without a database.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '15 Oct 2026' for a date-only value. */
export function formatDayLabel(day) {
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

/**
 * A schedule entry can be marked applied on or after its IST calendar day
 * (brief §5.3.2) — never ahead of time.
 */
export function isDueForApplication(scheduledDate, now = new Date()) {
  return istDateOnly(scheduledDate).getTime() <= todayIST(now).getTime();
}

/**
 * Cut-off instant for "scheduled on or before today (IST)": every
 * scheduledDate strictly before it falls on today or earlier. Used to
 * promote `upcoming` → `due` in a single Mongo query.
 */
export function dueCutoff(now = new Date()) {
  const today = todayIST(now);
  return istInstantRange(today, today).$lt;
}

/** Season = calendar year in IST. Bounds as date-only values + Mongo range. */
export function seasonBounds(now = new Date()) {
  const year = todayIST(now).getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  return { year, start, end, instantRange: istInstantRange(start, end) };
}

/**
 * Season cost summary — brief §5.3.3.
 *
 *   spent     = Σ priced StockPurchase.totalCostPaise bought this season
 *               (manual adjustments carry price 0 and are ignored)
 *   projected = Σ per fertilizer: max(0, need − on hand) × latest ₹/kg
 *               where need = Σ totalQuantityKg of open (upcoming/due)
 *               entries scheduled on or before the season's last day
 *   total     = spent + projected
 *
 * A fertilizer that is short but has never been bought at a price can't
 * be costed; it is left out of `projected` and listed in `unpriced`.
 *
 * Quantities are summed in grams to avoid float drift; money in paise.
 *
 * @param {object} p
 * @param {Array<{fertilizerId, totalCostPaise, pricePerKgPaise, purchasedAt}>} p.purchases
 * @param {Map<string, number>|Object} p.latestPricePaise fertilizerId → ₹/kg in paise
 * @param {Array<{fertilizerId, scheduledDate, totalQuantityKg, status}>} p.schedules
 * @param {Array<{fertilizerId, quantityGrams}>} p.inventory
 * @param {Date} [p.now]
 */
export function computeSeasonCost({
  purchases = [],
  latestPricePaise = new Map(),
  schedules = [],
  inventory = [],
  now = new Date(),
}) {
  const { year, start, end } = seasonBounds(now);
  const priceOf = (id) =>
    latestPricePaise instanceof Map
      ? latestPricePaise.get(id)
      : latestPricePaise[id];

  let spentPaise = 0;
  for (const p of purchases) {
    if (!(p.pricePerKgPaise > 0) || !(p.totalCostPaise > 0)) continue;
    const day = istDateOnly(p.purchasedAt);
    if (day < start || day > end) continue;
    spentPaise += p.totalCostPaise;
  }

  const neededGrams = new Map();
  for (const s of schedules) {
    if (s.status !== 'upcoming' && s.status !== 'due') continue;
    if (istDateOnly(s.scheduledDate) > end) continue;
    const id = String(s.fertilizerId);
    const grams = Math.round(Number(s.totalQuantityKg || 0) * 1000);
    neededGrams.set(id, (neededGrams.get(id) ?? 0) + grams);
  }

  const onHandGrams = new Map();
  for (const i of inventory) {
    const id = String(i.fertilizerId);
    onHandGrams.set(id, (onHandGrams.get(id) ?? 0) + (i.quantityGrams || 0));
  }

  let projectedRemainingPaise = 0;
  const byFertilizer = [];
  const unpriced = [];
  for (const [id, need] of neededGrams) {
    const onHand = onHandGrams.get(id) ?? 0;
    const shortfall = Math.max(0, need - onHand);
    if (shortfall === 0) continue;
    const price = priceOf(id);
    const row = {
      fertilizerId: id,
      neededKg: need / 1000,
      onHandKg: onHand / 1000,
      shortfallKg: shortfall / 1000,
      pricePerKgPaise: price > 0 ? price : null,
      projectedPaise: null,
    };
    if (price > 0) {
      row.projectedPaise = Math.round((shortfall * price) / 1000);
      projectedRemainingPaise += row.projectedPaise;
    } else {
      unpriced.push(id);
    }
    byFertilizer.push(row);
  }

  return {
    season: year,
    spentPaise,
    projectedRemainingPaise,
    totalEstimatePaise: spentPaise + projectedRemainingPaise,
    unpricedCount: unpriced.length,
    unpricedFertilizerIds: unpriced,
    byFertilizer,
  };
}

/** 'Ravi Kumar' → 'RK'; 'Ravi' → 'RA'; blank → null. */
export function initialsOf(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Escape a user string for a case-insensitive exact-match RegExp. */
export function exactNameRegex(name) {
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}
