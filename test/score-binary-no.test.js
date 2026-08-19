'use strict';
/**
 * score-binary-no.test.js — what `entry_ref` MEANS on a binary, and the 116x lie that
 * followed from getting it wrong.
 *
 * THE INCIDENT (2026-08-19). binaryPnl() computed cost as `side === 'yes' ? odds : 1 - odds`.
 * That is correct if and only if `entry_ref` is THE MARKET'S YES PRICE. It is not. Callers
 * recorded THE PRICE THEY PAID FOR THEIR OWN SIDE, and said so in the signed notes:
 *
 *     seq 691  "SpaceX CRS-35 … manifested Aug 31 (17d past cutoff), ourProb NO 0.97"
 *     seq 692  "no earnings event in window, ourProb NO 0.90"
 *     seq 690  "no signal/leak in window, ourProb NO 0.93"
 *
 * Under the old reading the scorer saw 0.97 and concluded "NO costs 0.03", paying 32.3x on a
 * bet the note itself calls a near-certainty. Three near-locks scored as longshot jackpots.
 * Board total was +55.666 where the caller-paid reading gives +0.480 — a ~116x overstatement,
 * with three rows accounting for 98.1% of the entire number.
 *
 * IT ONLY BIT `no` ROWS. For `yes`, cost == odds under BOTH readings, so every test, every
 * health check and the whole 39-case suite stayed green while the headline number was wrong by
 * two orders of magnitude. That is the entire lesson: the arithmetic was self-consistent, and
 * self-consistency is not correctness. These tests pin the SEMANTICS so the meaning of the
 * field can never drift back without a red test.
 *
 * Jiggy chose the canonical reading on 2026-08-19: entry_ref is the price you paid.
 */

const assert = require('assert');
const test = require('node:test');
const D = require('../lib/decimal');
const S = require('../lib/score');

// A stake of 1 at price p returns 1/p on a win: profit = 1/p - 1. Loss is the whole stake.
const won = (size, price) => D.sub(D.div(size, price), size);

test('spec: entry_ref is the price PAID for the caller\'s own side, not the market YES price', () => {
  // The seq 691 shape. Paying 0.97 for NO and winning is a 3.1% gain, NOT a 32x jackpot.
  const r = S.binaryPnl({ side: 'no', size: '1', odds: '0.97', outcome: 'no' });
  assert.ok(r.ok);
  assert.strictEqual(D.cmp(r.pnl, won('1', '0.97')), 0);
  // Guard the specific regression: the old code produced 1/0.03 - 1 ≈ 32.33.
  assert.ok(D.cmp(r.pnl, '1') < 0, `paying 0.97 must not pay more than 1x, got ${r.pnl}`);
});

test('a NO win and a YES win at the SAME PRICE pay identically', () => {
  // The asymmetry was the bug. Price is price; which side it names cannot change the payout.
  const no = S.binaryPnl({ side: 'no', size: '1', odds: '0.62', outcome: 'no' });
  const yes = S.binaryPnl({ side: 'yes', size: '1', odds: '0.62', outcome: 'yes' });
  assert.strictEqual(D.cmp(no.pnl, yes.pnl), 0);
});

test('YES rows are unchanged by the fix — they were always priced correctly', () => {
  // seq 321: yes @ 0.62 published +0.61290322580645161 before the change.
  const r = S.binaryPnl({ side: 'yes', size: '1', odds: '0.62', outcome: 'yes' });
  assert.strictEqual(D.cmp(r.pnl, won('1', '0.62')), 0);
});

test('a loss forfeits exactly the stake, either side, any price', () => {
  for (const [side, other] of [['no', 'yes'], ['yes', 'no']]) {
    for (const odds of ['0.03', '0.5', '0.97']) {
      const r = S.binaryPnl({ side, size: '3', odds, outcome: other });
      assert.ok(r.ok);
      assert.strictEqual(D.cmp(r.pnl, '-3'), 0, `${side} @ ${odds} losing must be -3`);
    }
  }
});

test('longshots still pay like longshots — the fix must not flatten real payouts', () => {
  // Paying 0.03 for NO and winning IS ~32x. The old code produced this number for the RIGHT
  // reason on the wrong rows; it must remain reachable when the caller genuinely paid 0.03.
  const r = S.binaryPnl({ side: 'no', size: '1', odds: '0.03', outcome: 'no' });
  assert.strictEqual(D.cmp(r.pnl, won('1', '0.03')), 0);
  assert.ok(D.cmp(r.pnl, '30') > 0);
});

test('degenerate prices are refused, not divided by — a free bet is not a call', () => {
  for (const side of ['yes', 'no']) {
    assert.strictEqual(S.binaryPnl({ side, size: '1', odds: '0', outcome: side }).ok, false);
    assert.strictEqual(S.binaryPnl({ side, size: '1', odds: '1', outcome: side }).ok, false);
  }
});

test('size scales the payout linearly on both sides', () => {
  const one = S.binaryPnl({ side: 'no', size: '1', odds: '0.8', outcome: 'no' });
  const five = S.binaryPnl({ side: 'no', size: '5', odds: '0.8', outcome: 'no' });
  assert.strictEqual(D.cmp(D.mul(one.pnl, '5'), five.pnl), 0);
});
