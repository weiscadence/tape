'use strict';
/**
 * market-board.test.js — the list of markets we OFFER must be a list of markets that can COUNT.
 *
 * WHY THIS EXISTS. The board is now the first thing an agent reads (`GET /api/markets`, and the
 * MCP `tape_markets` tool tells them to read it before posting). That makes every row on it an
 * implicit promise: post here and it will work. A row that cannot be signed, cannot be laned,
 * cannot be resolved, or is already decided converts that promise into a permanent unscoreable
 * entry — and writes are irreversible, so there is no cleanup afterwards.
 *
 * The offering path and the accepting path are written in different files by different rules, and
 * nothing forced them to agree until this file did.
 */

const test = require('node:test');
const assert = require('node:assert');

const board = require('../lib/market-board');
const { laneOf } = require('../lib/lanes');
const { SETTLEABLE } = require('../lib/hyperliquid');

/** The write path's grammar, built the way bin/miniapp.js builds it. */
const ASSETS = [...SETTLEABLE].join('|');
const CALLABLE = [
  /^polymarket:0x[0-9a-fA-F]{64}$/,
  new RegExp(`^hyperliquid:\\d+:(?:${ASSETS}):(?:above|below):[0-9]+(?:\\.[0-9]+)?@\\S+$`),
];
const signable = (m) => CALLABLE.some((re) => re.test(m));

/**
 * A synthetic board. The real one needs the network, and a test that only passes when
 * Polymarket is up is a test that gets muted the first time Polymarket is down.
 */
function seed(rows) {
  board.commitVenue('polymarket', rows.filter((r) => r.venue === 'polymarket'));
  board.commitVenue('hyperliquid', rows.filter((r) => r.venue === 'hyperliquid'));
}

const FUTURE = new Date(Date.now() + 7 * 86400e3).toISOString();
const PAST = new Date(Date.now() - 7 * 86400e3).toISOString();
const GOOD_PM = {
  venue: 'polymarket',
  market: 'polymarket:0x' + 'a'.repeat(64),
  q: 'Something not yet knowable?', yes: 0.4, vol24: 100000, ends: FUTURE,
};
const GOOD_HL = {
  venue: 'hyperliquid',
  market: 'hyperliquid:1025:BTC:above:64306@2099-01-01T06:00:00Z',
  q: 'BTC at or above $64306', yes: 0.54, vol24: null, ends: '2099-01-01T06:00:00Z',
};

test('every offered market is signable by the write path', () => {
  seed([GOOD_PM, GOOD_HL]);
  for (const m of board.snapshot().data) {
    assert.ok(signable(m.market), `write path would refuse an offered market: ${m.market}`);
  }
});

test('every offered market lands in a lane that is actually scored', () => {
  seed([GOOD_PM, GOOD_HL]);
  for (const m of board.snapshot().data) {
    const lane = laneOf(m.market, 'prediction');
    assert.equal(lane.scored, true, `${m.market} offered but lane=${lane.lane} is not scored`);
  }
});

test('every offered market is still in the future', () => {
  seed([GOOD_PM, GOOD_HL]);
  const now = Date.now();
  for (const m of board.snapshot().data) {
    if (!m.ends) continue;
    assert.ok(Date.parse(m.ends) > now, `offered a market past its end date: ${m.q} (${m.ends})`);
  }
});

/**
 * NEGATIVE CONTROLS. Each assertion above is only worth anything if it can fail. The expired
 * case in particular shipped live: "US x Iran Effective Ceasefire by July 31?" sat on the board
 * for a week at 81¢, flagged active by Polymarket, with its outcome already public.
 */
test('CONTROL: an expired market would be caught', () => {
  seed([{ ...GOOD_PM, q: 'Ceasefire by July 31?', ends: PAST }]);
  const now = Date.now();
  const bad = board.snapshot().data.filter((m) => m.ends && Date.parse(m.ends) <= now);
  assert.equal(bad.length, 1, 'the expiry assertion does not discriminate');
});

test('CONTROL: an unsignable market id would be caught', () => {
  seed([{ ...GOOD_PM, market: 'polymarket:not-a-condition-id' }]);
  const bad = board.snapshot().data.filter((m) => !signable(m.market));
  assert.equal(bad.length, 1, 'the grammar assertion does not discriminate');
});

test('CONTROL: a market in an unscored lane would be caught', () => {
  seed([{ ...GOOD_PM, venue: 'polymarket', market: 'somenewvenue:abc123' }]);
  const bad = board.snapshot().data.filter((m) => !laneOf(m.market, 'prediction').scored);
  assert.equal(bad.length, 1, 'the lane assertion does not discriminate');
});

test('a venue failing keeps the other venue\'s rows — one API blip is not an empty board', () => {
  seed([GOOD_PM, GOOD_HL]);
  board.commitVenue('polymarket', []); // Polymarket goes dark
  const left = board.snapshot().data;
  assert.equal(left.length, 1, 'the surviving venue lost its rows too');
  assert.equal(left[0].venue, 'hyperliquid');
});

test('an empty venue carries a counted reason, so it never reads as a broken fetch', () => {
  seed([GOOD_HL]);
  board.commitVenue('polymarket', [], '0 callable · 3 past their end date');
  assert.match(board.snapshot().venues.polymarket.note, /past their end date/);
});
