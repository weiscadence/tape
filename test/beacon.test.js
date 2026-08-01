'use strict';
/**
 * beacon.test.js — derivation v2, and the attack it exists to close.
 *
 * The first block is not a test of new code. It DEMONSTRATES THE BUG in v1, against the
 * shipped v1 implementation, and it is kept green forever: v1 epochs are already on the
 * chain and must keep deriving exactly as they did. A fix whose test only exercises the
 * fixed path leaves nothing that would notice if the vulnerable path came back.
 *
 * Everything here is offline. The drand round below is a real quicknet round, pasted as a
 * fixture with its real signature, so the BLS verification being asserted is the same
 * arithmetic a stranger runs — not a stub that returns true.
 */

const assert = require('assert');
const crypto = require('crypto');
const ed = require('../lib/ed25519');
const W = require('../lib/windows');
const B = require('../lib/beacon');
const { entryHash } = require('../lib/entry');
const { checkSchedule } = require('../lib/schedule-check');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const mkKey = () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  return Buffer.concat([
    kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]);
};
const boardKey = mkKey();
const BOARD = ed.publicKeyOf(boardKey);

/** drand quicknet round 1000000. Fetched 2026-07-31 from api.drand.sh AND
 *  drand.cloudflare.com, byte-identical from both. Its signature verifies under the
 *  quicknet public key, which is what makes it a fixture rather than a claim. */
const ROUND = {
  round: 1000000,
  signature: '83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72',
  randomness: 'b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3',
};

console.log('\nTHE V1 ATTACK — the board holds the seed while enrolment is open');
// hermessol's criticism, sharpened. v1 mixes enrolled_root into every derivation, and the
// board knows the seed from the instant it commits H(seed). So the board can enrol one more
// key of its own and, by choosing WHICH key, move the enrolled_root — which moves the
// questions handed to callers who enrolled long before. Nothing about this is detectable:
// the seed opens its commitment, the catalog matches, every question re-derives.
t('v1: adding one enrolment changes an ALREADY-ENROLLED caller\'s question', () => {
  const seed = crypto.randomBytes(32).toString('hex');
  const victim = ed.publicKeyOf(mkKey());
  const before = W.deriveQuestion({
    seed, enrolled_root: W.enrolledRoot([victim]), caller_key: victim, window_index: 0, version: '1',
  });
  // The board grinds its own extra key until the victim's question lands somewhere else.
  // Six catalog entries, so this terminates almost immediately — the attack is cheap, which
  // is the point.
  let moved = null;
  for (let i = 0; i < 200 && !moved; i++) {
    const extra = ed.publicKeyOf(mkKey());
    const after = W.deriveQuestion({
      seed, enrolled_root: W.enrolledRoot([victim, extra]), caller_key: victim, window_index: 0, version: '1',
    });
    if (after.index !== before.index) moved = after;
  }
  assert.ok(moved, 'expected a late enrolment to be able to move an existing question under v1');
});

t('v2: the same late enrolment cannot move anything — enrolled_root is not an input', () => {
  const seed = crypto.randomBytes(32).toString('hex');
  const victim = ed.publicKeyOf(mkKey());
  const args = { seed, beacon_randomness: ROUND.randomness, caller_key: victim, window_index: 0, version: '2' };
  const before = W.deriveQuestion(args);
  // There is no enrolled_root to grind. Enrolling a thousand more keys is the identical call.
  for (let i = 0; i < 50; i++) {
    const after = W.deriveQuestion(args);
    assert.strictEqual(after.index, before.index);
  }
});

t('CONTROL: v2 still depends on the beacon — a different round gives a different pool draw', () => {
  const seed = crypto.randomBytes(32).toString('hex');
  const caller = ed.publicKeyOf(mkKey());
  // If this ever fails, the beacon is being accepted and then ignored, and v2 would be v1
  // with extra fields — which would pass every other test in this file.
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(W.deriveQuestion({
      seed, beacon_randomness: crypto.randomBytes(32).toString('hex'),
      caller_key: caller, window_index: 0, version: '2',
    }).index);
  }
  assert.ok(seen.size > 1, 'beacon_randomness does not reach the digest');
});

console.log('\nVERSION CONFUSION — the wrong-shaped input is refused, never ignored');
t('v2 refuses an enrolled_root instead of dropping it', () => {
  assert.throws(() => W.deriveQuestion({
    seed: 'a'.repeat(64), enrolled_root: 'b'.repeat(64), beacon_randomness: ROUND.randomness,
    caller_key: ed.publicKeyOf(mkKey()), window_index: 0, version: '2',
  }), /does not mix enrolled_root/);
});
t('v1 refuses a beacon it would not hash', () => {
  assert.throws(() => W.deriveQuestion({
    seed: 'a'.repeat(64), enrolled_root: 'b'.repeat(64), beacon_randomness: ROUND.randomness,
    caller_key: ed.publicKeyOf(mkKey()), window_index: 0, version: '1',
  }), /v1 takes no beacon_randomness/);
});
t('an unknown derivation version is refused rather than defaulted', () => {
  assert.throws(() => W.deriveQuestion({
    seed: 'a'.repeat(64), caller_key: ed.publicKeyOf(mkKey()), window_index: 0, version: '3',
  }), /unknown derivation version/);
});
t('mixSeed changes if EITHER half changes', () => {
  const a = W.mixSeed({ seed: 'a'.repeat(64), beacon_randomness: ROUND.randomness });
  assert.notStrictEqual(a, W.mixSeed({ seed: 'c'.repeat(64), beacon_randomness: ROUND.randomness }));
  assert.notStrictEqual(a, W.mixSeed({ seed: 'a'.repeat(64), beacon_randomness: 'd'.repeat(64) }));
  assert.strictEqual(a, W.mixSeed({ seed: 'a'.repeat(64), beacon_randomness: ROUND.randomness }));
});

console.log('\nBEACON VERIFICATION — real BLS, not a shape check');
t('a real quicknet round verifies under the chain public key', () => {
  const v = B.verifyBeacon(ROUND);
  assert.strictEqual(v.ok, true, v.reason);
});
t('CONTROL: one flipped hex char in the signature fails', () => {
  const bad = { ...ROUND, signature: (ROUND.signature[0] === 'a' ? 'b' : 'a') + ROUND.signature.slice(1) };
  // randomness is H(signature), so recompute it — otherwise this would be caught by the
  // cheap check and never reach the BLS verification we are trying to exercise.
  bad.randomness = crypto.createHash('sha256').update(Buffer.from(bad.signature, 'hex')).digest('hex');
  const v = B.verifyBeacon(bad);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /does not verify|did not parse/);
});
t('CONTROL: the right signature under the wrong round number fails', () => {
  const v = B.verifyBeacon({ ...ROUND, round: ROUND.round + 1 });
  assert.strictEqual(v.ok, false);
});
t('CONTROL: randomness that is not H(signature) fails', () => {
  const v = B.verifyBeacon({ ...ROUND, randomness: 'e'.repeat(64) });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /not sha256/);
});
t('verifyBeacon returns a verdict on garbage rather than throwing', () => {
  for (const junk of [null, undefined, {}, { round: -1 }, { round: 1, signature: 'zz' }]) {
    assert.strictEqual(B.verifyBeacon(junk).ok, false);
  }
});
t('roundAt is the first round at or after a time, and roundTime inverts it', () => {
  const g = B.QUICKNET.genesis_time;
  assert.strictEqual(B.roundAt(g), 1);
  assert.strictEqual(B.roundTime(1), g);
  const r = B.roundAt(g + 100);
  assert.ok(B.roundTime(r) >= g + 100, 'round lands before the requested time');
  assert.ok(B.roundTime(r) - B.QUICKNET.period < g + 100, 'round is later than necessary');
});

console.log('\nSCHEDULE CHECK — a v2 epoch, and the four ways to fake one');
const GRID = Math.floor(B.roundTime(ROUND.round) / 900) * 900; // a grid point near the round
const CLOSES = B.roundTime(ROUND.round) - 900; // enrolment shut BEFORE the round: honest order

function v2Epoch(over = {}) {
  const epoch = '2026-W50';
  const caller = ed.publicKeyOf(mkKey());
  const seed = crypto.randomBytes(32).toString('hex');
  const commit = W.buildWindowRow({
    type: 'schedule_commit', epoch,
    seed_commit: crypto.createHash('sha256').update(seed, 'utf8').digest('hex'),
    catalog_hash: W.catalogHash(),
    enroll_closes_at: over.enroll_closes_at || CLOSES,
    windows_per_caller: 1,
    derivation: '2',
    beacon_chain: over.beacon_chain || B.QUICKNET.chain_hash,
    beacon_round: over.commit_round || ROUND.round,
  });
  const close = W.buildWindowRow({
    type: 'enrollment_close', epoch, enrolled_root: W.enrolledRoot([caller]), enrolled_count: 1,
  });
  const reveal = W.buildWindowRow({
    type: 'seed_reveal', epoch, seed,
    beacon_round: over.reveal_round || ROUND.round,
    beacon_randomness: over.randomness || ROUND.randomness,
    beacon_sig: over.signature || ROUND.signature,
  });
  const d = W.deriveQuestion({
    seed, beacon_randomness: ROUND.randomness, caller_key: caller, window_index: 0, version: '2',
  });
  const q = W.buildWindowRow({
    type: 'question', epoch, window_index: 0, caller_key: caller,
    market: W.questionMarket({ asset: d.asset, opens_at: GRID, horizon_sec: d.horizon_sec }),
    opens_at: GRID, expires_at: GRID + 3600,
  });
  return [commit, close, reveal, q]
    .map((r) => W.signWindowRow(r, boardKey))
    .map((e) => ({ entry_hash: entryHash(e), entry: e }));
}

t('an honest v2 epoch passes and reports its question checked', () => {
  const r = checkSchedule(v2Epoch());
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.checked, 1);
});
t('CONTROL: revealing a DIFFERENT round than the one committed is caught', () => {
  const rows = v2Epoch();
  // Reveal round 999999 while the commitment named 1000000: the board waited, saw two
  // candidate values, and published the flattering one.
  const rev = rows.find((r) => r.entry.type === 'seed_reveal');
  rev.entry.beacon_round = String(ROUND.round - 1);
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /was chosen after it was visible/);
});
t('CONTROL: a forged beacon randomness is caught by the signature, not by trust', () => {
  const rows = v2Epoch();
  rows.find((r) => r.entry.type === 'seed_reveal').entry.beacon_randomness = 'f'.repeat(64);
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /does not verify/);
});
t('CONTROL: a v2 reveal with no beacon at all is caught', () => {
  const rows = v2Epoch();
  const rev = rows.find((r) => r.entry.type === 'seed_reveal').entry;
  delete rev.beacon_round; delete rev.beacon_randomness; delete rev.beacon_sig;
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /carries no beacon value/);
});
t('CONTROL: a round already public while enrolment was open is caught', () => {
  // The ordering IS the guarantee. A round whose value existed before the door shut is a
  // round a caller could have waited to see, and every other check would still pass.
  const r = checkSchedule(v2Epoch({ enroll_closes_at: B.roundTime(ROUND.round) + 900 }));
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /could be waited for/);
});
t('CONTROL: a beacon chain we do not know is refused rather than assumed', () => {
  const r = checkSchedule(v2Epoch({ beacon_chain: 'a'.repeat(64) }));
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /not the drand chain/);
});

console.log('\nROW SHAPE — half a beacon is worse than none');
t('seed_reveal refuses two of three beacon fields', () => {
  assert.throws(() => W.buildWindowRow({
    type: 'seed_reveal', epoch: 'e', seed: 'a'.repeat(64),
    beacon_round: 1, beacon_randomness: ROUND.randomness,
  }), /all-or-nothing/);
});
t('a v2 commit without a beacon round is refused', () => {
  assert.throws(() => W.buildWindowRow({
    type: 'schedule_commit', epoch: 'e', seed_commit: 'a'.repeat(64), catalog_hash: 'b'.repeat(64),
    enroll_closes_at: GRID, windows_per_caller: 1, derivation: '2', beacon_chain: B.QUICKNET.chain_hash,
  }), /beacon_round/);
});
t('a v1 commit carrying beacon fields is refused', () => {
  assert.throws(() => W.buildWindowRow({
    type: 'schedule_commit', epoch: 'e', seed_commit: 'a'.repeat(64), catalog_hash: 'b'.repeat(64),
    enroll_closes_at: GRID, windows_per_caller: 1, derivation: '1', beacon_round: 5,
  }), /v1 takes no beacon fields/);
});
t('beacon fields without a derivation version are refused', () => {
  assert.throws(() => W.buildWindowRow({
    type: 'schedule_commit', epoch: 'e', seed_commit: 'a'.repeat(64), catalog_hash: 'b'.repeat(64),
    enroll_closes_at: GRID, windows_per_caller: 1, beacon_round: 5,
  }), /no derivation version/);
});
t('an existing v1 commit row still hashes to what it hashed to before', () => {
  // The optional fields must not appear as nulls on rows that never had them, or every v1
  // row on the live chain changes hash and the whole chain breaks.
  const row = W.buildWindowRow({
    type: 'schedule_commit', epoch: '2026-W31', seed_commit: 'a'.repeat(64),
    catalog_hash: 'b'.repeat(64), enroll_closes_at: 1753750800, windows_per_caller: 2,
  });
  assert.ok(!('derivation' in row), 'derivation leaked into a v1 row');
  assert.ok(!('beacon_round' in row), 'beacon_round leaked into a v1 row');
  assert.ok(!('beacon_chain' in row), 'beacon_chain leaked into a v1 row');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
