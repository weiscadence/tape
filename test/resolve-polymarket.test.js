'use strict';
// Polymarket binary resolver. Grammar/refusal cases return BEFORE any network call and run
// offline. The network branch is pinned to two IMMUTABLE resolved markets — a resolved
// outcome never changes, so a known conditionId is a stable canary; if Polymarket ever
// reshaped its API these would flip and tell us. Open markets are NOT used as fixtures
// because they drift (they eventually settle).
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveMarket } = require('../lib/resolve.js');

// --- offline: grammar and refusal --------------------------------------------------------
test('malformed conditionId is REFUSED, not read', async () => {
  const r = await resolveMarket('polymarket:notahex');
  assert.equal(r.supported, false);
});

test('short/long hex is REFUSED (must be exactly 0x + 64 hex)', async () => {
  assert.equal((await resolveMarket('polymarket:0xabc')).supported, false);
  assert.equal((await resolveMarket(`polymarket:0x${'a'.repeat(65)}`)).supported, false);
});

// --- live canary: immutable resolved fixtures --------------------------------------------
// "Credible FDV above $100M one day after launch?" settled NO on 2026-07-18.
const FIXTURE_NO = 'polymarket:0x0c481aa63ec629535d90cc083c6d92ebcbe7b79581faf83f46ca3624c4e4eae0';

test('resolved market yields an objective yes/no outcome with a settlement time', async () => {
  const r = await resolveMarket(FIXTURE_NO);
  assert.equal(r.supported, true, 'a readable Polymarket market must be supported');
  assert.equal(r.resolved, true, 'a settled market must read as resolved');
  assert.equal(r.outcome, 'no', 'this fixture settled NO and cannot change');
  assert.ok(r.at && !isNaN(new Date(r.at)), 'a resolved market must carry a settlement timestamp');
});

test('a non-existent condition is REFUSED (cannot-read is not open)', async () => {
  const r = await resolveMarket(`polymarket:0x${'0'.repeat(64)}`);
  assert.equal(r.supported, false, 'an unreadable market must never present as open');
});
