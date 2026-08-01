'use strict';
// Price-market resolver (Pyth). The network-touching branch (past-deadline settlement) is
// smoke-tested live in bin, not here — these cases exercise grammar, threshold parsing,
// the future=open rule, and refusals, all of which return BEFORE any Pyth call.
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveMarket } = require('../lib/resolve.js');

const FUTURE = '2099-01-01T00:00:00Z';

test('canonical pyth market, future deadline, is OPEN (postable, no network)', async () => {
  const r = await resolveMarket(`pyth:SOL:above:200@${FUTURE}`);
  assert.equal(r.supported, true);
  assert.equal(r.resolved, false);
});

test('demo grammar from docs is now supported (was the footgun)', async () => {
  const r = await resolveMarket('demo:SOL_above_200_by_2099-01-01');
  assert.equal(r.supported, true, 'demo markets must no longer be "no resolver"');
});

test('k suffix parses (150k → 150000)', async () => {
  const r = await resolveMarket(`pyth:BTC:above:150k@${FUTURE}`);
  assert.equal(r.supported, true);
  assert.equal(r.resolved, false);
});

test('unknown asset is REFUSED, not guessed', async () => {
  const r = await resolveMarket(`pyth:DOGE:above:1@${FUTURE}`);
  assert.equal(r.supported, false);
});

test('unparseable deadline is REFUSED', async () => {
  const r = await resolveMarket('pyth:SOL:above:100@notadate');
  assert.equal(r.supported, false);
});

test('non-price / non-github market still refused (regression)', async () => {
  const r = await resolveMarket('demo:SOL_above_200_by_2026-08-01'.replace('above', 'sideways'));
  assert.equal(r.supported, false);
});
