/**
 * Money is stored everywhere in the system as an integer number of **paise**.
 * Never as a Number with decimals, never as rupees. MongoDB BSON numbers are
 * IEEE-754 doubles, which cannot represent every rupee.paise value exactly.
 * Use Int (default 32-bit, sufficient up to ~₹2 crore in paise) or Long for
 * very large aggregates.
 *
 * ₹578.31  →  57831
 * ₹3.25    →  325
 *
 * The wage engine (the most consequential feature in this product) lives or
 * dies by this rule. See the developer brief, §7.6.
 */

/** Format an integer paise amount as "₹X,XX,XXX.XX" using Indian grouping. */
export function formatRupees(paise, { showDecimals = true } = {}) {
  if (!Number.isInteger(paise)) {
    throw new TypeError(`paise must be an integer, got ${paise}`);
  }
  const isNegative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / 100);
  const remainder = abs % 100;
  const grouped = indianGrouping(rupees);
  const sign = isNegative ? '-' : '';
  if (!showDecimals && remainder === 0) return `${sign}₹${grouped}`;
  return `${sign}₹${grouped}.${String(remainder).padStart(2, '0')}`;
}

/** Indian numbering: 1,23,45,678 not 12,345,678. */
export function indianGrouping(n) {
  const s = String(n);
  if (s.length <= 3) return s;
  const lastThree = s.slice(-3);
  const rest = s.slice(0, -3);
  // Group rest in pairs from the right.
  const groups = [];
  for (let i = rest.length; i > 0; i -= 2) {
    groups.unshift(rest.slice(Math.max(0, i - 2), i));
  }
  return `${groups.join(',')},${lastThree}`;
}

/** Parse a user-typed rupee string into integer paise. Throws on invalid. */
export function rupeesToPaise(input) {
  const cleaned = String(input).replace(/[,₹\s]/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`Invalid rupee amount: ${input}`);
  }
  const [whole, fraction = ''] = cleaned.split('.');
  const wholeInt = parseInt(whole, 10);
  const paisePart = parseInt(fraction.padEnd(2, '0').slice(0, 2) || '0', 10);
  const sign = wholeInt < 0 ? -1 : 1;
  return sign * (Math.abs(wholeInt) * 100 + paisePart);
}
