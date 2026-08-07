'use strict';
/**
 * The plain reading must be readable AND must not claim more than the bytes support. Both halves
 * are load-bearing: the first is why it exists, the second is why it is allowed to exist.
 */
const test = require('node:test');
const assert = require('node:assert');
const { plainReceipt } = require('../lib/receipt-plain');

const MARKET = 'polymarket:0xa5144d487f22937f5bc46c655ab3cf1063edebefef327fa08ffeed421e60688f';

const receipt = (entry, anchored = true) => ({
  seq: 386,
  entry: { type: 'open', lane: 'prediction', market: MARKET, side: 'yes', entry_ref: '0.8200', size: '1', ts_claimed: '2026-08-07T02:17:43.000Z', caller: 'jiggyjigsters', ...entry },
  proof: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  anchor: anchored ? { slot: 437717816, root: 'r', cluster: 'mainnet', signature: 'sig', explorer: 'https://solscan.io/tx/sig' } : null,
});

const TITLES = { [MARKET]: { title: 'Chicago White Sox vs. Boston Red Sox', fetched_at: '2026-08-07T04:00:00.000Z' } };

test('the headline is the question, not the condition id', () => {
  const p = plainReceipt(receipt(), { titles: TITLES });
  assert.equal(p.headline, 'Chicago White Sox vs. Boston Red Sox');
  assert.equal(p.questionLookedUp, true);
  assert.ok(!/0xa5144d/.test(p.headline));
});

test('with no cached question it shows the signed string rather than guessing one', () => {
  const p = plainReceipt(receipt(), { titles: {} });
  assert.equal(p.headline, MARKET);
  assert.equal(p.questionLookedUp, false, 'must not claim a lookup it did not do');
});

test('the claim is one sentence a person can read, with side, price and size', () => {
  const p = plainReceipt(receipt(), { titles: TITLES });
  assert.match(p.claim, /jiggyjigsters/);
  assert.match(p.claim, /YES/);
  assert.match(p.claim, /82¢/);
  assert.ok(!/entry_ref|0\.8200/.test(p.claim), 'no raw field names in the human line');
});

test('an unsigned mini-app row does NOT claim an ed25519 signature', () => {
  const p = plainReceipt(receipt({}), { titles: TITLES });   // no `signer`
  const first = p.proves[0];
  assert.match(first.t, /not key-signed/i);
  assert.ok(!/signature stops matching/.test(first.plain),
    'describing a signature that does not exist is the failure this test exists for');
  assert.match(first.plain, /no wallet signature|unsigned/i);
});

test('a key-signed row does claim the signature, so the tiers stay distinguishable', () => {
  const p = plainReceipt(receipt({ signer: '2hsSKcSzE7KNhDRFMLHetWx3P6qyrVBJAXyMpHFK2Mcu' }), { titles: TITLES });
  assert.match(p.proves[0].t, /Only they could have written it/);
  assert.match(p.proves[0].plain, /signature stops matching/);
});

test('it always says what it does not prove', () => {
  const p = plainReceipt(receipt(), { titles: TITLES });
  assert.match(p.notProves, /does not prove the call was right/);
});

test('an unanchored row says it is waiting, not that it is time-stamped', () => {
  const p = plainReceipt(receipt({}, false), { titles: TITLES });
  assert.equal(p.anchored, false);
  assert.ok(!/Slots only move forward/.test(p.proves[2].plain));
  assert.match(p.proves[2].plain, /Not anchored yet/);
});

test('the stake line states the condition for a win without predicting one', () => {
  const p = plainReceipt(receipt(), { titles: TITLES });
  assert.match(p.stake, /resolve YES/);
  assert.match(p.stake, /82¢/);
  assert.ok(!/will win|likely|should/.test(p.stake), 'the receipt has no opinion about the outcome');
});
