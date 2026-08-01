'use strict';
/**
 * decimal.js — exact arithmetic for money.
 *
 * WHY THIS EXISTS: canonical.js refuses raw numbers because float formatting is not
 * portable across languages. That rule is worthless if the scorer then loads those
 * decimal strings into IEEE doubles to do the maths — the hashes would agree and the
 * numbers would not, which is worse than either failing alone. So every quantity stays
 * a decimal string end to end, and the arithmetic happens in BigInt.
 *
 * THE ONE PLACE EXACTNESS ENDS, DECLARED: division. A ratio like 1/3 has no finite
 * decimal form, so `div` rounds to DIV_SCALE places, half away from zero. That is a
 * choice, not an accident, and it is stated here because an undeclared rounding mode is
 * how two "identical" implementations produce different leaderboards. Anyone
 * reimplementing this needs exactly three facts: base 10, 18 places, half away from zero.
 *
 * Addition, subtraction and multiplication are exact and never round.
 */

const { DECIMAL_RE } = require('./canonical');

/** Places kept by `div`. Chosen to exceed any price precision we will meet (Pyth: 8). */
const DIV_SCALE = 18;

/** decimal string -> { n: BigInt mantissa, scale: int }, value = n / 10^scale. */
function parse(s, field = 'decimal') {
  if (typeof s !== 'string' || !DECIMAL_RE.test(s)) {
    throw new TypeError(`${field} must be a decimal string (got ${JSON.stringify(s)})`);
  }
  const neg = s.startsWith('-');
  const [w, f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(w + f);
  return { n: neg ? -n : n, scale: f.length };
}

/**
 * { n, scale } -> decimal string matching DECIMAL_RE.
 * Trailing fractional zeros are trimmed so that "1.50" and "1.5" cannot become two
 * different strings for one value — a distinction that would survive into a hash.
 */
function format(n, scale) {
  const neg = n < 0n;
  let d = (neg ? -n : n).toString();
  if (scale > 0) {
    if (d.length <= scale) d = '0'.repeat(scale - d.length + 1) + d;
    const whole = d.slice(0, d.length - scale);
    const frac = d.slice(d.length - scale).replace(/0+$/, '');
    d = frac ? `${whole}.${frac}` : whole;
  }
  d = d.replace(/^0+(?=\d)/, '');
  // -0 is a real value in floats and a nonsense one in a ledger. Collapse it.
  return neg && !/^0(\.0*)?$/.test(d) ? `-${d}` : d;
}

function align(a, b) {
  const A = parse(a), B = parse(b);
  const scale = Math.max(A.scale, B.scale);
  return {
    an: A.n * 10n ** BigInt(scale - A.scale),
    bn: B.n * 10n ** BigInt(scale - B.scale),
    scale,
  };
}

const add = (a, b) => { const { an, bn, scale } = align(a, b); return format(an + bn, scale); };
const sub = (a, b) => { const { an, bn, scale } = align(a, b); return format(an - bn, scale); };

function mul(a, b) {
  const A = parse(a), B = parse(b);
  return format(A.n * B.n, A.scale + B.scale);
}

/** a / b, rounded half away from zero at DIV_SCALE places. Throws on divide-by-zero. */
function div(a, b) {
  const A = parse(a), B = parse(b);
  if (B.n === 0n) throw new RangeError(`decimal: division by zero (${a} / ${b})`);
  const shift = DIV_SCALE + B.scale - A.scale;
  let num = A.n;
  let den = B.n;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  const negative = (num < 0n) !== (den < 0n);
  const an = num < 0n ? -num : num;
  const ad = den < 0n ? -den : den;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n; // half away from zero
  return format(negative ? -q : q, DIV_SCALE);
}

/** -1, 0, 1. */
function cmp(a, b) {
  const { an, bn } = align(a, b);
  return an < bn ? -1 : an > bn ? 1 : 0;
}

const neg = (a) => { const A = parse(a); return format(-A.n, A.scale); };
const isZero = (a) => parse(a).n === 0n;
const sum = (xs) => xs.reduce((acc, x) => add(acc, x), '0');

/**
 * Round to `places` for DISPLAY ONLY, half away from zero.
 * Never feed the output of this back into a computation: rounding early is how a
 * leaderboard's total stops equalling the sum of its rows.
 */
function round(a, places) {
  const A = parse(a);
  if (A.scale <= places) return format(A.n, A.scale);
  const drop = 10n ** BigInt(A.scale - places);
  const negv = A.n < 0n;
  const abs = negv ? -A.n : A.n;
  let q = abs / drop;
  if ((abs % drop) * 2n >= drop) q += 1n;
  return format(negv ? -q : q, places);
}

/**
 * Signed display string.
 *
 * The interesting clause is the middle one. The first real board printed a benchmark of
 * `-0.002073835500977007` as `0`, because two decimal places is what money looks like —
 * and a genuine number had become a zero at the last possible moment, in the one layer
 * nobody tests. That is the same failure the scorer refuses upstream (missing mark scored
 * as flat), wearing the costume of a formatting choice. So: a non-zero quantity never
 * prints as zero, at any precision.
 */
function formatMoney(v, places = 2) {
  if (v === null || v === undefined) return '—';
  const positive = cmp(v, '0') >= 0;
  let s = round(v, places);
  if (cmp(v, '0') !== 0 && cmp(s, '0') === 0) {
    s = round(v, 8);
    if (cmp(s, '0') === 0) return positive ? '+<1e-8' : '-<1e-8';
  }
  return (positive ? '+' : '') + s;
}

module.exports = { add, sub, mul, div, cmp, neg, isZero, sum, round, format, formatMoney, parse, DIV_SCALE };
