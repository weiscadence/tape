'use strict';
/**
 * asof.test.js — the mark clock, in both states.
 *
 * The failure this file is written against is the one three agents found by reading the
 * design rather than the code: an external oracle queried at an internally-chosen moment
 * is still an internal mark. Every check below therefore has a paired negative — it is not
 * enough that a legal `as_of` passes, the illegal one has to actually be REFUSED, and
 * refused for the stated reason rather than incidentally.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gridAsOf, checkAsOf, GRID_SEC } = require('../lib/asof');
const history = require('../lib/history');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nthe mark time is derived, not chosen');
t('flooring lands on the grid', () => {
  assert.strictEqual(gridAsOf(1785283320) % GRID_SEC, 0);
});
t('a moment mid-interval marks to the completed grid point, never forward', () => {
  const g = gridAsOf(1785283320);
  assert.ok(g <= 1785283320, 'grid point must not be in the future');
  assert.ok(1785283320 - g < GRID_SEC, 'must be the MOST RECENT grid point');
});
t('two different instants inside one interval produce the SAME mark', () => {
  // This is the property that removes the lever: a nine-minute wait for a better price
  // buys the operator nothing, because both runs mark to the same tick.
  const base = 1785283200; // on-grid
  assert.strictEqual(gridAsOf(base + 60), gridAsOf(base + 840));
});
t('instants in different intervals produce DIFFERENT marks (the check is not vacuous)', () => {
  const base = 1785283200;
  assert.notStrictEqual(gridAsOf(base + 60), gridAsOf(base + GRID_SEC + 60));
});
t('a non-integer clock is rejected rather than silently floored', () => {
  assert.throws(() => gridAsOf(1785283320.7), /non-integer/);
});

console.log('\ncheckAsOf refuses what it is supposed to refuse');
t('a derived mark passes', () => {
  const now = 1785283320;
  assert.strictEqual(checkAsOf(gridAsOf(now), { nowUnix: now }).ok, true);
});
t('a hand-picked mark one second off the grid is REFUSED', () => {
  const now = 1785283320;
  const r = checkAsOf(gridAsOf(now) + 1, { nowUnix: now });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /off the .* grid/);
});
t('the cherry-pick attack itself is refused, with the right reason', () => {
  // The concrete attack: the bag looked good at 14:07:33, so publish claims 14:07:33.
  const now = 1785283320;
  const flattering = now - 407; // an arbitrary instant, not a grid point
  const r = checkAsOf(flattering, { nowUnix: now });
  assert.strictEqual(r.ok, false);
  assert.ok(!/future/.test(r.reason), 'must be caught as off-grid, not incidentally as future-dated');
});
t('a future mark is refused as future, not as off-grid', () => {
  const now = 1785283320;
  const r = checkAsOf(gridAsOf(now) + GRID_SEC * 4, { nowUnix: now });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /future/);
});
t('a mark one grid ahead is tolerated (a run may start just before its point elapses)', () => {
  const now = 1785283320;
  assert.strictEqual(checkAsOf(gridAsOf(now) + GRID_SEC, { nowUnix: now }).ok, true);
});

console.log('\nthe mark series makes a skipped grid point a hole, not an absence');
const tmp = path.join(os.tmpdir(), `tape-hist-${process.pid}.jsonl`);
t('gaps() finds a deliberately skipped point', () => {
  fs.rmSync(tmp, { force: true });
  const base = 1785283200;
  for (const i of [0, 1, 3, 4]) { // 2 is skipped
    history.record(tmp, { as_of: base + i * GRID_SEC, markset_hash: `h${i}`, chain_head: 'x', entries: i });
  }
  const g = history.gaps(history.read(tmp));
  assert.deepStrictEqual(g.missing, [base + 2 * GRID_SEC]);
  assert.strictEqual(g.published, 4);
  assert.strictEqual(g.expected, 5);
});
t('a complete series reports no holes (the detector can say zero honestly)', () => {
  fs.rmSync(tmp, { force: true });
  const base = 1785283200;
  for (const i of [0, 1, 2, 3]) {
    history.record(tmp, { as_of: base + i * GRID_SEC, markset_hash: `h${i}`, chain_head: 'x', entries: i });
  }
  const g = history.gaps(history.read(tmp));
  assert.deepStrictEqual(g.missing, []);
  assert.strictEqual(g.coverage, 1);
});
t('republishing the same grid point does not duplicate the series', () => {
  fs.rmSync(tmp, { force: true });
  const row = { as_of: 1785283200, markset_hash: 'h', chain_head: 'x', entries: 1 };
  assert.strictEqual(history.record(tmp, row).appended, true);
  assert.strictEqual(history.record(tmp, row).appended, false);
  assert.strictEqual(history.read(tmp).length, 1);
});
fs.rmSync(tmp, { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
