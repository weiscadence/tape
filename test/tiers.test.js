'use strict';
/**
 * The ladder's job is to be un-farmable. Every test here is a route someone would actually take
 * to sell calls they have not earned the right to sell.
 */
const test = require('node:test');
const assert = require('node:assert');
const { standing, measure, TIERS } = require('../lib/tiers');

const DAY = 86400 * 1000;
const NOW = Date.parse('2026-08-07T00:00:00Z');

/** n settled calls spread one per day backwards from `now`, all winners unless told otherwise. */
function calls(n, opt = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      status: 'settled',
      // loseEvery: 3 → loses one in three, a 67% record. winEvery is the inverse and is used
      // where the point is a WEAK record; note winEvery:2 is exactly 50%, not "mostly wins".
      won: opt.loseEvery ? i % opt.loseEvery !== 0 : opt.winEvery ? i % opt.winEvery === 0 : true,
      pnl: opt.pnl == null ? 0.5 : opt.pnl,
      size: opt.size == null ? 1 : opt.size,
      category: opt.cats ? opt.cats[i % opt.cats.length] : `C${i % 4}`,
      ts: new Date(NOW - (opt.sameDay ? 0 : i * DAY)).toISOString(),
    });
  }
  return out;
}

test('a fresh caller holds nothing and is told what the first rung costs', () => {
  const s = standing([], { now: NOW });
  assert.equal(s.held, null);
  assert.equal(s.next, 'tracked');
  assert.ok(s.tiers[0].checks.every((c) => !c.ok));
});

test('open calls are worth nothing at the gate', () => {
  const open = calls(80).map((c) => ({ ...c, status: 'open' }));
  const s = standing(open, { now: NOW });
  assert.equal(s.stats.settled, 0);
  assert.equal(s.held, null, 'never-resolving positions must not rank anyone up');
});

test('FARM 1: cramming the call count into one day does not pass — days are the binding rule', () => {
  const s = standing(calls(80, { sameDay: true }), { now: NOW });
  const paid = s.tiers.find((t) => t.key === 'paid');
  assert.equal(s.stats.settled, 80);
  assert.equal(s.stats.days, 1);
  assert.equal(paid.held, false);
  assert.equal(paid.checks.find((c) => c.key === 'days').ok, false);
});

test('FARM 2: a hundred risk-free 0.25u dabbles do not buy the right to charge', () => {
  const s = standing(calls(100, { size: 0.25, pnl: 0.4 }), { now: NOW });
  const paid = s.tiers.find((t) => t.key === 'paid');
  assert.equal(s.stats.units, 25);
  assert.equal(paid.checks.find((c) => c.key === 'units').ok, false, '25u staked is under the 50u bar');
  assert.equal(paid.held, false);
});

test('FARM 3: sixty calls on one category is one opinion, not a record', () => {
  const s = standing(calls(60, { cats: ['Sports'], size: 2 }), { now: NOW });
  const paid = s.tiers.find((t) => t.key === 'paid');
  assert.equal(s.stats.maxCatShare, 1);
  assert.equal(paid.checks.find((c) => c.key === 'maxCatShare').ok, false);
});

test('FARM 4: a high win rate off 92c favourites still fails, because edge is the binding bar', () => {
  // Wins every time, but each call beat the price it took by almost nothing — exactly the
  // "call nothing but heavy favourites" strategy win-rate alone would certify.
  const s = standing(calls(70, { pnl: 0.01, size: 2, cats: ['A', 'B', 'C'] }), { now: NOW });
  const paid = s.tiers.find((t) => t.key === 'paid');
  assert.equal(s.stats.winPct, 100);
  assert.ok(s.stats.edge < 10, `edge ${s.stats.edge} should be under the +10u bar`);
  assert.equal(paid.checks.find((c) => c.key === 'edge').ok, false);
  assert.equal(paid.held, false, 'a 100% win rate must not be sufficient on its own');
});

test('a genuinely broad, sized, profitable record over enough days does unlock x402', () => {
  const s = standing(calls(70, { pnl: 0.3, size: 2, cats: ['A', 'B', 'C'], loseEvery: 3 }), { now: NOW });
  const paid = s.tiers.find((t) => t.key === 'paid');
  assert.equal(paid.held, true, JSON.stringify(paid.checks.filter((c) => !c.ok)));
  assert.equal(s.held, 'paid');
  assert.equal(s.next, null);
});

test('the record decays: the same calls a year later no longer clear the bar', () => {
  const old = calls(70, { pnl: 0.3, size: 2, cats: ['A', 'B', 'C'], loseEvery: 3 });
  const s = standing(old, { now: NOW + 365 * DAY });
  assert.equal(s.stats.settled, 0, 'nothing inside the trailing window');
  assert.notEqual(s.held, 'paid');
});

test('edge is size-weighted, so conviction counts and dabbling does not', () => {
  const big = measure(calls(10, { pnl: 0.5, size: 4 }), { now: NOW });
  const small = measure(calls(10, { pnl: 0.5, size: 1 }), { now: NOW });
  assert.equal(big.edge, small.edge * 4);
});

test('losses are counted, not quietly dropped', () => {
  const s = measure(calls(10, { winEvery: 5, pnl: -0.2 }), { now: NOW });
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 8);
  assert.ok(s.edge < 0);
});

test('every rung names every requirement in human words', () => {
  const s = standing(calls(5), { now: NOW });
  for (const t of s.tiers) {
    assert.ok(t.checks.length > 0);
    for (const c of t.checks) assert.match(c.label, /[a-z]/, 'a requirement with no words is not a to-do');
  }
  assert.equal(s.tiers.length, TIERS.length);
});
