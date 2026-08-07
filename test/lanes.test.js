'use strict';
/**
 * lanes.test.js — per-lane track records.
 *
 * WHAT THIS GUARDS. Splitting the board by lane exists so that a crypto win rate is not diluted by
 * weather bets. That only works if two things hold, and the first version of this code broke the
 * second one within minutes of being written:
 *
 *   1. A market must never land in a lane by accident. An unrecognised venue has to surface as
 *      `unclassified` and force a decision, rather than being absorbed into whichever lane is
 *      nearest. A mis-laned row is invisible; an unclassified one is not.
 *
 *   2. Outcomes must be counted off the MACHINE field, not the prose one. The first version
 *      bucketed on `status` with /win/ and /loss/ — but the real labels are "called it" and
 *      "wrong", so every settled call on the board counted as zero while the function looked
 *      like it worked. Five wins and one loss rendered as an empty record. The regression test
 *      below uses the real vocabulary verbatim.
 */

const assert = require('assert');
const { test } = require('node:test');
const { laneOf, laneRecords } = require('../lib/lanes');

test('markets route to lanes by signed identifier, not by free text', () => {
  assert.equal(laneOf('pyth:SOL:below:80@2026-08-12T21:00:00Z').lane, 'crypto-price');
  assert.equal(laneOf('Crypto.SOL/USD').lane, 'crypto-price');
  assert.equal(laneOf('delphi:0x54932e').lane, 'prediction-markets');
  assert.equal(laneOf('github:o/r/pull/12:merged_by:2026-01-01').lane, 'software');
  assert.equal(laneOf('fred:CPI:above:3@2026-09-01').lane, 'macro');
});

test('an unknown venue is unclassified and unscored, never absorbed into a neighbour', () => {
  const r = laneOf('somenewvenue:0xabc');
  assert.equal(r.lane, 'unclassified');
  assert.equal(r.scored, false);
});

test('demo and protocol rows are excluded, not folded into a real lane', () => {
  assert.equal(laneOf('demo:thing').scored, false);
  assert.equal(laneOf('').lane, 'protocol');
  assert.equal(laneOf(null).scored, false);
});

test('a caller cannot talk their way into a lane', () => {
  // The market string is the signed identifier; nothing a caller writes in it should be able to
  // claim a lane the venue prefix does not support.
  assert.equal(laneOf('notavenue:this is really a pyth:SOL call honest').lane, 'unclassified');
});

test('REGRESSION: outcomes count off tone, not the human status string', () => {
  // These are the exact labels bin/publish.js emits. Matching /win/ against them yields zero.
  const calls = [
    { market_raw: 'github:o/r/pull/1:merged_by:x', status: 'called it', tone: 'win', pnl: 1 },
    { market_raw: 'github:o/r/pull/2:merged_by:x', status: 'called it', tone: 'win', pnl: 1 },
    { market_raw: 'github:o/r/pull/3:merged_by:x', status: 'wrong', tone: 'loss', pnl: -1 },
    { market_raw: 'github:o/r/pull/4:merged_by:x', status: 'corrected', tone: 'void', pnl: 0 },
  ];
  const [sw] = laneRecords(calls).filter((r) => r.lane === 'software');
  assert.equal(sw.wins, 2, 'a win labelled "called it" must count as a win');
  assert.equal(sw.losses, 1, 'a loss labelled "wrong" must count as a loss');
  assert.equal(sw.settled, 3);
  assert.equal(sw.voided, 1, 'a corrected row stays on the record and out of the win rate');
});

test('a lane with nothing settled reports null win rate, not zero', () => {
  const [r] = laneRecords([{ market_raw: 'delphi:0xabc', tone: 'open' }]);
  assert.equal(r.settled, 0);
  assert.strictEqual(r.win_rate, null, '0% and "nothing settled yet" are different claims');
  assert.equal(r.open, 1);
});

test('an unrecognised tone is surfaced, never silently dropped into no bucket', () => {
  process.env.TAPE_LANES_QUIET = '1';
  const recs = laneRecords([{ market_raw: 'pyth:SOL:above:1@x', tone: 'brand-new-tone' }]);
  delete process.env.TAPE_LANES_QUIET;
  assert.ok(recs.unknownTone, 'unknown tones must be reported on the result');
  assert.deepEqual(recs.unknownTone, ['brand-new-tone']);
  // It still counts in `calls`, so the lane total can never disagree with the row count.
  assert.equal(recs[0].calls, 1);
  assert.equal(recs[0].settled, 0);
});

test('lanes are kept apart: one lane cannot inherit another lane record', () => {
  const recs = laneRecords([
    { market_raw: 'github:o/r/pull/1:merged_by:x', tone: 'win' },
    { market_raw: 'delphi:0xabc', tone: 'open' },
  ]);
  const sw = recs.find((r) => r.lane === 'software');
  const pm = recs.find((r) => r.lane === 'prediction-markets');
  assert.equal(sw.wins, 1);
  assert.equal(pm.wins, 0, 'the prediction lane must not inherit the software win');
  assert.strictEqual(pm.win_rate, null);
});

// ---------------------------------------------------------------------------------------------
// EVERY VENUE THE BOARD OFFERS MUST LAND IN A SCORED LANE.
//
// Regression for 2026-08-07: Hyperliquid shipped as a venue and lanes.js was not updated, so
// HIP-4 calls resolved fine, counted as Crypto for tiers, and still scored `false` on the board.
// The general assertion is the point — a NEW venue added to the market board without a lane rule
// fails here rather than shipping as a market that cannot count.
test('every market-board venue classifies into a scored lane', () => {
  const samples = {
    polymarket: 'polymarket:0x60c2c085ee8c16bc8f2419739a94971d4c9d00f637ead10fc0f540afa1be64e8',
    hyperliquid: 'hyperliquid:1025:BTC:above:64306@2026-08-08T06:00:00Z',
  };
  for (const [venue, market] of Object.entries(samples)) {
    const got = laneOf(market, 'prediction');
    assert.equal(got.scored, true, `${venue} must be scored, got lane=${got.lane}`);
    assert.notEqual(got.lane, 'unclassified', `${venue} must not be unclassified`);
  }
});

test('hyperliquid lands in crypto-price, agreeing with the mini-app category', () => {
  const got = laneOf('hyperliquid:1025:BTC:above:64306@2026-08-08T06:00:00Z', 'prediction');
  assert.equal(got.lane, 'crypto-price');
});

// NEGATIVE CONTROL: the unclassified default must still work, or the assertion above passes
// for the trivial reason that everything is scored.
test('an unknown venue is still unclassified and unscored', () => {
  const got = laneOf('kalshi-clone:abc123', null);
  assert.equal(got.lane, 'unclassified');
  assert.equal(got.scored, false);
});
