'use strict';
// Hyperliquid HIP-4 venue. No network here: the parsing/filter branches all return before
// any request, and each case below is a route someone could otherwise take to a call TAPE
// can never close.
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveMarket } = require('../lib/resolve.js');
const hl = require('../lib/hyperliquid.js');

const FUTURE = '2099-01-01T00:00:00Z';

// ---- description parsing ------------------------------------------------------------------

test('parses a real HIP-4 priceBinary description', () => {
  const d = hl.parseDescription('class:priceBinary|underlying:BTC|expiry:20260807-0600|targetPrice:64869|period:1d');
  assert.equal(d.class, 'priceBinary');
  assert.equal(d.underlying, 'BTC');
  assert.equal(d.expiry, '20260807-0600');
  assert.equal(d.targetPrice, '64869');
});

test('a garbage description yields an empty object, never a throw', () => {
  // A shape change at the venue must drop the row, not blow up inside the filter and read
  // to a user as "Hyperliquid has no markets".
  assert.doesNotThrow(() => hl.parseDescription(null));
  assert.deepEqual(hl.parseDescription('other'), {});
});

test('expiry parses to an ISO instant, and refuses anything else', () => {
  assert.equal(hl.parseExpiry('20260807-0600'), '2026-08-07T06:00:00Z');
  assert.equal(hl.parseExpiry('2026-08-07'), null);
  assert.equal(hl.parseExpiry(''), null);
  assert.equal(hl.parseExpiry('99999999-9999'), null);
});

test('yes price reads side 0 and refuses a missing/NaN mid', () => {
  assert.equal(hl.yesPriceFrom({ '#10190': '0.42' }, 1019), 0.42);
  assert.equal(hl.yesPriceFrom({}, 1019), null);
  assert.equal(hl.yesPriceFrom({ '#10190': 'n/a' }, 1019), null);
});

// ---- resolver grammar ---------------------------------------------------------------------

test('a well-formed hyperliquid market with a future expiry is OPEN, not unsupported', async () => {
  const r = await resolveMarket(`hyperliquid:1019:SOL:above:74.202@${FUTURE}`);
  assert.equal(r.supported, true, 'the picker must only offer what the scorer can close');
  assert.equal(r.resolved, false);
});

test('the outcome id is provenance only — it does not change what settles', async () => {
  // Two different slots carrying the same question must resolve identically. This is the
  // property that makes slot RECYCLING safe: settlement reads the asset/threshold/expiry.
  const a = await resolveMarket(`hyperliquid:1019:SOL:above:74.202@${FUTURE}`);
  const b = await resolveMarket(`hyperliquid:4242:SOL:above:74.202@${FUTURE}`);
  assert.deepEqual({ s: a.supported, r: a.resolved }, { s: b.supported, r: b.resolved });
});

test('an id WITHOUT the question is refused, not silently resolved', async () => {
  // `hyperliquid:1019` alone is a dangling pointer: the slot is reused after settlement, so
  // it would mean a different contract tomorrow. It must never parse.
  const r = await resolveMarket('hyperliquid:1019');
  assert.equal(r.supported, false);
  assert.match(r.detail, /no resolver/);
});

test('an asset with no registered price feed is refused, never guessed', async () => {
  // HYPE markets are LISTED by the venue. Offering one would put a call on the record that
  // nothing can settle.
  const r = await resolveMarket(`hyperliquid:1020:HYPE:above:56.443@${FUTURE}`);
  assert.equal(r.supported, false);
  assert.match(r.detail, /no Pyth feed/);
});

test('HYPE is not in the settleable set the picker filters on', () => {
  assert.equal(hl.SETTLEABLE.has('HYPE'), false);
  for (const a of ['BTC', 'ETH', 'SOL']) assert.equal(hl.SETTLEABLE.has(a), true);
});

test('an unparseable expiry is refused rather than coerced to a date', async () => {
  const r = await resolveMarket('hyperliquid:1019:SOL:above:74.202@not-a-date');
  assert.equal(r.supported, false);
  assert.match(r.detail, /unparseable deadline/);
});

test('the price band matches the Polymarket picker — no dead markets on either tab', () => {
  assert.equal(hl.MIN_PRICE, 0.08);
  assert.equal(hl.MAX_PRICE, 0.92);
});

// ---- the write-path validator ---------------------------------------------------------------

test('the mini-app callable grammars accept both venues and reject invented ids', () => {
  // Mirrors bin/miniapp.js. Kept as an explicit list on purpose: a permissive "any prefix"
  // regex is the one change here that could put an unresolvable row on an append-only record.
  const CALLABLE = [
    /^polymarket:0x[0-9a-fA-F]{64}$/,
    /^hyperliquid:\d+:[A-Z]{2,6}:(above|below):[0-9]+(\.[0-9]+)?@\S+$/,
  ];
  const ok = (m) => CALLABLE.some((re) => re.test(m));

  assert.equal(ok('polymarket:0x' + 'a'.repeat(64)), true);
  assert.equal(ok(`hyperliquid:1019:SOL:above:74.202@${FUTURE}`), true);

  assert.equal(ok('hyperliquid:1019'), false, 'bare slot id is a dangling pointer');
  assert.equal(ok('hyperliquid:SOL:above:1@' + FUTURE), false, 'missing outcome id');
  assert.equal(ok(`hyperliquid:1019:sol:above:74@${FUTURE}`), false, 'lowercase asset');
  assert.equal(ok('hyperliquid:1019:SOL:sideways:74@' + FUTURE), false, 'invented direction');
  assert.equal(ok('kalshi:PRES-2028'), false, 'a venue with no resolver is not callable');
  assert.equal(ok('polymarket:0xdeadbeef'), false, 'short condition id');
});
