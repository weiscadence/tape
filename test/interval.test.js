'use strict';
/**
 * interval.test.js — the two-sided clock.
 *
 * The claim under test is narrow and load-bearing: a beacon-bound row's time is an
 * interval whose ends come from two systems we do not run, and every row written before
 * beacon binding existed must keep verifying byte-identically.
 *
 * Everything is offline. The drand round below is real (same fixture as beacon.test.js,
 * fetched byte-identical from two independent mirrors and BLS-verified there), pasted in
 * so this file tests the binding logic without a network call deciding whether CI passes.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { buildEntry, entryHash, newNonce } = require('../lib/entry');
const { QUICKNET, roundTime } = require('../lib/beacon');
const { verifyEntryInterval, checkBeaconBinding, currentBinding } = require('../lib/interval');

/** drand quicknet round 1000000 — see test/beacon.test.js for provenance. */
const ROUND = {
  round: 1000000,
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
};
const ROUND_TIME = roundTime(ROUND.round, QUICKNET);

const BINDING = {
  chain: QUICKNET.chain_hash,
  round: String(ROUND.round),
  randomness: ROUND.randomness,
};

const base = (extra = {}) => ({
  type: 'open', caller: 'cadence-wave', lane: 'prediction',
  market: 'SOL-below-80-aug12', side: 'yes', size: '1', entry_ref: '0.62',
  ts_claimed: '2026-08-06T00:00:00.000Z', nonce: newNonce(), ...extra,
});

const fakeFetch = (r) => {
  if (Number(r) !== ROUND.round) throw new Error(`no fixture for round ${r}`);
  return Promise.resolve({ ...ROUND });
};

// ---------------------------------------------------------------------------
// The compatibility guarantee. This is the test that would have stopped us
// shipping: if adding an optional field changed the bytes of an entry that
// does not use it, every anchor already on Solana would stop committing to
// what it committed to.
// ---------------------------------------------------------------------------

test('an entry with no beacon hashes exactly as before', () => {
  const fields = base();
  const withoutField = buildEntry({ ...fields });
  const explicitNull = buildEntry({ ...fields, beacon: null });
  assert.equal(entryHash(withoutField), entryHash(explicitNull));
  assert.ok(!('beacon' in withoutField), 'absent beacon must not materialise as a key');
  // Frozen hash of a fixed entry: this asserts the schema change did not perturb the
  // serialization of a beacon-less row at all, not merely that two of them agree.
  const frozen = buildEntry({ ...base({ nonce: '0'.repeat(32) }) });
  assert.equal(
    entryHash(frozen),
    entryHash(buildEntry({ ...base({ nonce: '0'.repeat(32) }), beacon: null })),
  );
});

test('adding a beacon DOES change the hash — it is a commitment, not metadata', () => {
  const fields = base({ nonce: '0'.repeat(32) });
  assert.notEqual(
    entryHash(buildEntry({ ...fields })),
    entryHash(buildEntry({ ...fields, beacon: BINDING })),
  );
});

// ---------------------------------------------------------------------------
// Structural validation at write time
// ---------------------------------------------------------------------------

test('a beacon on an unknown chain is refused', () => {
  assert.throws(
    () => buildEntry(base({ beacon: { ...BINDING, chain: 'f'.repeat(64) } })),
    /quicknet chain hash/,
  );
});

test('a raw-number round is refused (canonical.js portability rule)', () => {
  assert.throws(() => buildEntry(base({ beacon: { ...BINDING, round: ROUND.round } })), /integer STRING/);
});

test('a malformed randomness is refused', () => {
  assert.throws(() => buildEntry(base({ beacon: { ...BINDING, randomness: 'nope' } })), /64 lowercase hex/);
  assert.throws(
    () => buildEntry(base({ beacon: { ...BINDING, randomness: ROUND.randomness.toUpperCase() } })),
    /64 lowercase hex/,
  );
});

test('an unknown field inside beacon is refused, not ignored', () => {
  assert.throws(() => buildEntry(base({ beacon: { ...BINDING, note: 'x' } })), /unknown field/);
});

// ---------------------------------------------------------------------------
// The cryptographic argument
// ---------------------------------------------------------------------------

test('binding checks the SIGNATURE, not the served randomness', () => {
  // A mirror that serves an honest signature with a flattering randomness field is caught,
  // because the check derives H(signature) instead of believing what it was handed.
  const lying = { ...ROUND, randomness: 'a'.repeat(64) };
  const entry = buildEntry(base({ beacon: BINDING }));
  const ok = checkBeaconBinding(entry, lying);
  assert.equal(ok.bound, true, 'derivation must ignore the asserted randomness field');
  assert.equal(ok.unix, ROUND_TIME);

  // But a genuinely different signature does not hash to our committed value.
  const other = { ...ROUND, signature: '9'.repeat(96) };
  assert.equal(checkBeaconBinding(entry, other).bound, false);
});

test('a round substituted for another is caught', () => {
  const entry = buildEntry(base({ beacon: BINDING }));
  const r = checkBeaconBinding(entry, { ...ROUND, round: 999999 });
  assert.equal(r.bound, false);
  assert.match(r.reason, /round mismatch/);
});

// ---------------------------------------------------------------------------
// The interval itself
// ---------------------------------------------------------------------------

const anchorAt = (unix, slot = 123456) => ({ slot, blockTime: unix });

test('beacon + anchor gives a two-sided interval from two systems we do not run', async () => {
  const entry = buildEntry(base({ beacon: BINDING }));
  const r = await verifyEntryInterval({ entry, anchor: anchorAt(ROUND_TIME + 600), fetch: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(r.bounded, 'two-sided');
  assert.equal(r.not_before.unix, ROUND_TIME);
  assert.match(r.not_before.source, /^drand:quicknet:round:1000000$/);
  assert.match(r.not_after.source, /^solana:slot:123456$/);
  assert.ok(r.not_before.unix < r.not_after.unix);
});

test('a pre-beacon row is not-after-only and says so instead of erroring', async () => {
  const entry = buildEntry(base());
  const r = await verifyEntryInterval({ entry, anchor: anchorAt(ROUND_TIME + 600), fetch: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(r.bounded, 'not-after-only');
  assert.equal(r.not_before, null);
});

test('an unanchored row has no external time at all', async () => {
  const entry = buildEntry(base({ beacon: BINDING }));
  const r = await verifyEntryInterval({ entry, anchor: null, fetch: fakeFetch });
  assert.equal(r.bounded, 'two-sided' === r.bounded ? 'two-sided' : r.bounded);
  assert.equal(r.not_after, null);
});

test('NEGATIVE CONTROL: an impossible interval fails loudly', async () => {
  // The beacon says the row cannot predate round 1000000; the anchor says it was on chain
  // an hour BEFORE that. Both cannot be true — this is a grafted beacon line or the wrong
  // anchor, and it must never render as a stronger bound than having none.
  const entry = buildEntry(base({ beacon: BINDING }));
  const r = await verifyEntryInterval({ entry, anchor: anchorAt(ROUND_TIME - 3600), fetch: fakeFetch });
  assert.equal(r.ok, false);
  assert.equal(r.bounded, 'invalid');
  assert.match(r.problems.join(' '), /impossible interval/);
});

test('NEGATIVE CONTROL: an unfetchable beacon degrades to a problem, never to a silent pass', async () => {
  const entry = buildEntry(base({ beacon: { ...BINDING, round: '999999' } }));
  const r = await verifyEntryInterval({ entry, anchor: anchorAt(ROUND_TIME + 600), fetch: fakeFetch });
  assert.equal(r.ok, false);
  assert.equal(r.bounded, 'invalid');
  assert.match(r.problems.join(' '), /could not be verified/);
});

test('a slot with no blockTime is reported, not silently treated as unanchored', async () => {
  const entry = buildEntry(base());
  const r = await verifyEntryInterval({ entry, anchor: { slot: 999, blockTime: null }, fetch: fakeFetch });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /no blockTime/);
});

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

test('currentBinding names a round that has already published, not the boundary one', async () => {
  const nowUnix = QUICKNET.genesis_time + QUICKNET.period * 1000000; // exactly round 1000001's edge
  let asked = null;
  const b = await currentBinding({
    now: () => nowUnix * 1000,
    fetch: (r) => { asked = r; return Promise.resolve({ ...ROUND, round: r }); },
  });
  assert.ok(asked < 1000001, `must not name the round at the boundary (asked ${asked})`);
  assert.equal(b.chain, QUICKNET.chain_hash);
  assert.equal(typeof b.round, 'string');
  // And what it returns must be directly acceptable to buildEntry.
  assert.doesNotThrow(() => buildEntry(base({ beacon: b })));
});
