'use strict';
/**
 * tiers.js — what a caller has to actually DO before they can charge for a call.
 *
 * WHY A LADDER AT ALL. A record nobody can sell is a diary. The x402 rail lets a caller
 * paywall their calls, and the moment that exists, "make a lot of calls" becomes a strategy
 * for extracting money from strangers rather than for being right. So the right to charge has
 * to be earned against the same chain everything else is scored on, and the bar has to be
 * legible enough that someone can look at it and know what to work toward.
 *
 * WHY THE HEADLINE BAR IS NOT WIN RATE — measured, not asserted.
 *
 * Win rate reads like the obvious gate and is a poor instrument in BOTH directions. Binomial
 * tails against a coin-flipper (p=0.5) and against a genuinely good caller (p=0.6):
 *
 *     n=20, win>=55%   coin-flipper passes 41%   good caller passes 76%
 *     n=50, win>=55%   coin-flipper passes 24%   good caller passes 77%
 *     n=50, win>=60%   coin-flipper passes 10%   good caller passes 56%
 *
 * There is no (n, win%) pair at a workable sample size that both keeps chance out and lets
 * skill in — tighten it enough to exclude the coin-flipper and it rejects half the good
 * callers too. Worse, win rate is trivially farmed: call nothing but 92¢ favourites and you
 * post a 90% record while adding no information anyone would pay for.
 *
 * So the BINDING constraint is EDGE — how much you beat the price you actually took, which is
 * the number the board already computes and the only one that knows what the market thought.
 * Win rate stays as a visible floor because it is the number a human reads first, and a caller
 * under it should not be selling; it is a screen, not the test.
 *
 * THE THREE ANTI-FARM RULES, each closing a specific hole:
 *   1. DISTINCT DAYS, not calls. Sixty calls on one night of baseball is one opinion about one
 *      evening, not sixty independent trials. Days are what cannot be crammed.
 *   2. STAKED UNITS, not call count. Fractional sizing means a caller could farm the count at
 *      0.25u a call and risk nothing. The gate asks for conviction actually put on the record.
 *   3. NO SINGLE CATEGORY OVER 70%. Otherwise the ladder certifies "this account calls one
 *      league" as though it certified judgement.
 *
 * AND IT DECAYS. Everything is computed over a trailing window (default 180 days), so the
 * right to charge is a thing you keep holding, not a thing you won once. A record good enough
 * to sell in March should not still be selling in December on its own fumes.
 *
 * PURE FUNCTION, NO I/O. Same discipline as score.js: a caller can run this against their own
 * calls and get the identical answer, so the gate is checkable rather than announced.
 */

const DAY = 86400 * 1000;

/**
 * The ladder. Each rung lists every requirement as a checkable predicate so the UI can render
 * partial progress instead of a locked padlock — "12 of 40 calls" is a thing to work toward,
 * "LOCKED" is a thing to bounce off.
 */
const TIERS = [
  {
    key: 'tracked',
    name: 'TRACKED',
    mark: '◆',
    unlocks: 'You have a record. Your calls are public and anchored.',
    req: { settled: 3 },
  },
  {
    key: 'rated',
    name: 'RATED',
    mark: '◆◆',
    unlocks: 'Ranked on the leaderboard, with a specialization badge.',
    req: { settled: 20, days: 10, categories: 2 },
  },
  {
    key: 'proven',
    name: 'PROVEN',
    mark: '◆◆◆',
    unlocks: 'Featured profile. Your calls carry a verified-record badge when quoted.',
    req: { settled: 40, days: 30, winPct: 55, edge: 3, units: 20, maxCatShare: 0.7 },
  },
  {
    key: 'paid',
    name: 'PAID · x402',
    mark: '◆◆◆◆',
    unlocks: 'You can paywall your open calls. Buyers pay x402 per call and see this record first.',
    req: { settled: 60, days: 60, winPct: 55, edge: 10, units: 50, maxCatShare: 0.7 },
  },
];

/** Human copy for each requirement, used verbatim by the app so the rules read the same everywhere. */
const LABEL = {
  settled: (v) => `${v} settled calls`,
  days: (v) => `${v} separate days with a call`,
  categories: (v) => `${v} different categories`,
  winPct: (v) => `${v}% win rate`,
  edge: (v) => `+${v}u beaten vs the price you took`,
  units: (v) => `${v}u of conviction staked`,
  maxCatShare: (v) => `no more than ${Math.round(v * 100)}% in one category`,
};

/**
 * Measure a caller from their calls.
 *
 * @param {Array} calls  [{ status:'settled'|'open', won, pnl, size, category, ts }]
 * @param {object} opts  { now, windowDays }
 *
 * Only SETTLED calls count toward every number here. An open call is disclosed on the profile
 * and deliberately worth nothing at the gate — otherwise the cheapest way to rank up would be
 * to open positions and never let them resolve, which is the highlight-reel failure wearing a
 * different hat.
 */
function measure(calls, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now;
  const windowDays = opts.windowDays == null ? 180 : opts.windowDays;
  const floor = now - windowDays * DAY;

  const inWindow = (calls || []).filter((c) => {
    const t = c.ts ? Date.parse(c.ts) : NaN;
    return Number.isFinite(t) ? t >= floor : true;   // undated rows count; absence is not evidence of age
  });
  const settled = inWindow.filter((c) => c.status === 'settled');

  const days = new Set();
  const cats = {};
  let units = 0; let wins = 0; let edge = 0;
  for (const c of settled) {
    const t = c.ts ? Date.parse(c.ts) : NaN;
    if (Number.isFinite(t)) days.add(new Date(t).toISOString().slice(0, 10));
    const cat = c.category || 'Other';
    cats[cat] = (cats[cat] || 0) + 1;
    const size = Number(c.size) > 0 ? Number(c.size) : 1;
    units += size;
    if (c.won) wins += 1;
    // Edge is size-weighted: a 5u call that beat the price by .10 is worth five times a 1u one.
    // Unweighted, the cheapest route to +10u edge would be a hundred risk-free 0.25u dabbles.
    edge += (Number(c.pnl) || 0) * size;
  }

  const n = settled.length;
  const catCounts = Object.entries(cats).map(([cat, k]) => ({ cat, n: k })).sort((a, b) => b.n - a.n);
  return {
    settled: n,
    wins,
    losses: n - wins,
    winPct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    days: days.size,
    units: Math.round(units * 100) / 100,
    edge: Math.round(edge * 100) / 100,
    categories: catCounts.length,
    maxCatShare: n ? catCounts[0].n / n : 0,
    topCategory: catCounts.length ? catCounts[0].cat : null,
    windowDays,
  };
}

/** Does a measurement satisfy one requirement? maxCatShare is the only ceiling; the rest are floors. */
function meets(stats, key, want) {
  if (key === 'maxCatShare') return stats.settled === 0 ? false : stats.maxCatShare <= want;
  return (stats[key] || 0) >= want;
}

/**
 * The full standing: which rung is held, what the next one needs, and how far along each
 * requirement is. `have`/`need` travel as numbers so the app can draw a bar rather than print
 * a verdict — the point is to be a to-do list, not a bouncer.
 */
function standing(calls, opts = {}) {
  const stats = measure(calls, opts);

  const rungs = TIERS.map((t) => {
    const checks = Object.entries(t.req).map(([key, want]) => ({
      key,
      want,
      have: key === 'maxCatShare' ? Math.round(stats.maxCatShare * 100) / 100 : (stats[key] || 0),
      ok: meets(stats, key, want),
      label: LABEL[key](want),
    }));
    return {
      key: t.key, name: t.name, mark: t.mark, unlocks: t.unlocks,
      checks, held: checks.every((c) => c.ok),
      done: checks.filter((c) => c.ok).length, total: checks.length,
    };
  });

  // Held = the highest rung whose own requirements pass. Deliberately NOT "highest contiguous":
  // if someone satisfies PAID while failing a RATED check, that is a bug in the ladder and it
  // should be visible rather than papered over by an ordering assumption.
  let held = null;
  for (const r of rungs) if (r.held) held = r;
  const next = rungs.find((r) => !r.held) || null;

  return {
    stats,
    tiers: rungs,
    held: held ? held.key : null,
    heldName: held ? held.name : null,
    heldMark: held ? held.mark : '',
    next: next ? next.key : null,
    nextName: next ? next.name : null,
    // The single sentence the account page leads with.
    summary: next
      ? `${next.checks.filter((c) => !c.ok).length} thing${next.checks.filter((c) => !c.ok).length === 1 ? '' : 's'} left to reach ${next.name}`
      : 'Every rung held.',
  };
}

module.exports = { TIERS, LABEL, measure, standing, meets };
