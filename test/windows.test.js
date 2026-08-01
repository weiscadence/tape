'use strict';
/**
 * windows.test.js — board-minted questions, and the ways they could be theatre.
 *
 * The mechanism's whole value is one claim: WE did not choose which question each caller
 * got. Every positive test below is paired with the negative that would be true if we had.
 * A schedule checker that cannot say MISMATCH is a schedule checker that was never wired,
 * so the controls at the bottom deliberately construct hand-picked questions and require
 * the checker to catch each one.
 */

const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const ed = require('../lib/ed25519');
const W = require('../lib/windows');
const { entryHash, signEntry, buildEntry, newNonce } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { checkSchedule } = require('../lib/schedule-check');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const key = () => {
  const sk = crypto.randomBytes(32);
  const full = ed.publicKeyOf ? null : null;
  return sk;
};

// Real keypairs from the library, not hand-rolled bytes.
const mkKey = () => {
  const { generateKeyPairSync } = crypto;
  const kp = generateKeyPairSync('ed25519');
  const raw = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pubRaw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Buffer.concat([raw, pubRaw]); // 64-byte secret||public, the shape ed25519.js uses
};

const SEED = crypto.randomBytes(32).toString('hex');
const boardKey = mkKey();
const callerKey = mkKey();
const CALLER = ed.publicKeyOf(callerKey);
const ROOT = W.enrolledRoot([CALLER, ed.publicKeyOf(mkKey())]);

console.log('\nderivation is a pure function of public data');
t('same inputs derive the same question, twice', () => {
  const a = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: 0, version: '1' });
  const b = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: 0, version: '1' });
  assert.deepStrictEqual(a, b);
});
t('the index lands inside the catalog', () => {
  for (let i = 0; i < 50; i++) {
    const q = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: i, version: '1' });
    assert.ok(q.index >= 0 && q.index < W.CATALOG.length, `index ${q.index} out of range`);
  }
});

// Each of these is a lever someone could pull to choose an outcome. If changing an input
// left the question unchanged, that input would not actually be binding the derivation.
t('changing the SEED changes the question (the commit is load-bearing)', () => {
  const a = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: 0, version: '1' });
  const b = W.deriveQuestion({ seed: crypto.randomBytes(32).toString('hex'), enrolled_root: ROOT, caller_key: CALLER, window_index: 0, version: '1' });
  assert.notStrictEqual(a.derivation, b.derivation);
});
t('changing the ENROLLED ROOT changes the question (key-grinding is blocked)', () => {
  const a = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: 0, version: '1' });
  const b = W.deriveQuestion({ seed: SEED, enrolled_root: crypto.randomBytes(32).toString('hex'), caller_key: CALLER, window_index: 0, version: '1' });
  assert.notStrictEqual(a.derivation, b.derivation);
});
t('changing the CALLER changes the question (two callers are not handed one script)', () => {
  const other = ed.publicKeyOf(mkKey());
  const a = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: 0, version: '1' });
  const b = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: other, window_index: 0, version: '1' });
  assert.notStrictEqual(a.derivation, b.derivation);
});
t('changing the WINDOW INDEX changes the question', () => {
  const a = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: 0, version: '1' });
  const b = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: 1, version: '1' });
  assert.notStrictEqual(a.derivation, b.derivation);
});
t('the catalog is not degenerate — 200 derivations hit more than one entry', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    seen.add(W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: i, version: '1' }).index);
  }
  assert.ok(seen.size > 1, `all 200 derivations returned index ${[...seen][0]} — derivation is constant`);
});

console.log('\nthe enrolled set is a set, not a list we can reorder');
t('enrolledRoot is order-independent', () => {
  const a = ['A1', 'B2', 'C3'], b = ['C3', 'A1', 'B2'];
  assert.strictEqual(W.enrolledRoot(a), W.enrolledRoot(b));
});
t('enrolledRoot changes when membership changes (not a constant)', () => {
  assert.notStrictEqual(W.enrolledRoot(['A1', 'B2']), W.enrolledRoot(['A1', 'B2', 'C3']));
});

console.log('\nrow validation refuses what it cannot hash honestly');
const GRID = 1785283200; // on-grid
const mkQuestion = (over = {}) => W.buildWindowRow({
  type: 'question', epoch: '2026-W31', window_index: 0, caller_key: CALLER,
  market: W.questionMarket({ asset: 'SOL/USD', opens_at: GRID, horizon_sec: 86400 }),
  opens_at: GRID, expires_at: GRID + 3600, ...over,
});
t('a well-formed question builds', () => { assert.strictEqual(mkQuestion().type, 'question'); });
t('an unknown field is REJECTED, not dropped', () => {
  assert.throws(() => mkQuestion({ bonus: 'x' }), /unknown field/);
});
t('a missing required field is refused', () => {
  assert.throws(() => W.buildWindowRow({ type: 'question', epoch: 'e' }), /required/);
});
t('an off-grid opens_at is refused by questionMarket', () => {
  assert.throws(() => W.questionMarket({ asset: 'SOL/USD', opens_at: GRID + 7, horizon_sec: 86400 }), /grid/);
});
t('a market that is not settleable is refused', () => {
  assert.throws(() => mkQuestion({ market: 'vibes:SOL/USD:probably_up' }), /not a settleable market/);
});
t('expires_at before opens_at is refused', () => {
  assert.throws(() => mkQuestion({ expires_at: GRID - 1 }), /after opens_at/);
});
t('every row carries ref:null so chain.js does not chase a phantom reference', () => {
  assert.strictEqual(mkQuestion().ref, null);
});
t('the market round-trips through the parser', () => {
  const p = W.parseQuestionMarket(mkQuestion().market);
  assert.strictEqual(p.asset, 'SOL/USD');
  assert.strictEqual(p.opens_at, GRID);
  assert.strictEqual(p.settle_at, GRID + 86400);
});

console.log('\nsignatures, and the replay that domain separation exists to stop');
t('sign/verify round-trips', () => {
  const signed = W.signWindowRow(mkQuestion(), boardKey);
  assert.ok(W.verifyWindowRow(signed).ok);
});
t('a tampered field breaks the signature', () => {
  const signed = W.signWindowRow(mkQuestion(), boardKey);
  const tampered = { ...signed, epoch: '2026-W32' };
  assert.strictEqual(W.verifyWindowRow(tampered).ok, false);
});
t('a CALL signature cannot be lifted onto a window row', () => {
  // Different domain prefix, so even identical canonical bodies produce different
  // signing bytes. Without this a board-minted question and a caller's call would be
  // interchangeable to anyone holding one signature.
  const call = signEntry(buildEntry({
    type: 'open', caller: 'x', lane: 'prediction', market: 'github:a/b/pull/1:merged_by:2030-01-01T00:00:00Z',
    side: 'yes', size: '1', entry_ref: '0.5', ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), callerKey);
  const row = mkQuestion();
  const forged = { ...row, signer: call.signer, sig: call.sig };
  assert.strictEqual(W.verifyWindowRow(forged).ok, false);
});
t('an unsigned row reads as unsigned, not as failed', () => {
  const v = W.verifyWindowRow(mkQuestion());
  assert.strictEqual(v.signed, false);
  assert.strictEqual(v.ok, true);
});

console.log('\nthe tally: three outcomes, first responder wins');
const q1 = W.signWindowRow(mkQuestion({ window_index: 0 }), boardKey);
const q2 = W.signWindowRow(mkQuestion({ window_index: 1 }), boardKey);
const q3 = W.signWindowRow(mkQuestion({ window_index: 2 }), boardKey);
const h = (r) => entryHash(r);
const rows = [
  { entry_hash: h(q1), entry: q1 },
  { entry_hash: h(q2), entry: q2 },
  { entry_hash: h(q3), entry: q3 },
  { entry_hash: 'x1', entry: W.buildWindowRow({ type: 'answer', question_hash: h(q1), side: 'yes', odds: '0.6', ts_claimed: new Date().toISOString(), nonce: 'a'.repeat(32) }) },
  { entry_hash: 'x2', entry: W.buildWindowRow({ type: 'pass', question_hash: h(q2), ts_claimed: new Date().toISOString(), nonce: 'b'.repeat(32) }) },
  { entry_hash: 'x3', entry: W.buildWindowRow({ type: 'no_answer', question_hash: h(q3), observed_at: GRID + 4000 }) },
];
t('answer, pass and no_answer are counted separately', () => {
  const tal = W.tallyWindows(rows).get(CALLER);
  assert.deepStrictEqual(tal, { asked: 3, answered: 1, passed: 1, no_answer: 1, open: 0 });
});
t('a late answer cannot overwrite a recorded non-answer', () => {
  const late = { entry_hash: 'x4', entry: W.buildWindowRow({ type: 'answer', question_hash: h(q3), side: 'no', odds: '0.9', ts_claimed: new Date().toISOString(), nonce: 'c'.repeat(32) }) };
  const tal = W.tallyWindows([...rows, late]).get(CALLER);
  assert.strictEqual(tal.no_answer, 1, 'the non-answer must stand');
  assert.strictEqual(tal.answered, 1, 'the late answer must not be counted');
});
t('an unanswered, unexpired question reads as open — not as a pass', () => {
  const tal = W.tallyWindows(rows.slice(0, 3)).get(CALLER);
  assert.strictEqual(tal.open, 3);
  assert.strictEqual(tal.no_answer, 0, 'an open window must never be silently scored as a decline');
});

console.log('\nwindow rows do not contaminate the call tape');
t('isWindowRow separates the two families', () => {
  const call = buildEntry({
    type: 'open', caller: 'x', lane: 'prediction', market: 'github:a/b/pull/1:merged_by:2030-01-01T00:00:00Z',
    side: 'yes', size: '1', entry_ref: '0.5', ts_claimed: new Date().toISOString(), nonce: newNonce(),
  });
  assert.strictEqual(W.isWindowRow(call), false);
  assert.strictEqual(W.isWindowRow(mkQuestion()), true);
});
t('a window row appends to a real chain and the chain still verifies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-win-'));
  const file = path.join(dir, 'tape.jsonl');
  const chain = new Chain(file);
  chain.append(buildEntry({
    type: 'open', caller: 'x', lane: 'prediction', market: 'github:a/b/pull/1:merged_by:2030-01-01T00:00:00Z',
    side: 'yes', size: '1', entry_ref: '0.5', ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }));
  chain.append(W.signWindowRow(mkQuestion(), boardKey));
  const v = chain.verify();
  assert.ok(v.ok, 'mixed chain must verify');
  assert.strictEqual(v.count, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\nNEGATIVE CONTROLS — the checker must accuse us');
const epochRows = () => {
  const commit = W.signWindowRow(W.buildWindowRow({
    type: 'schedule_commit', epoch: '2026-W31',
    seed_commit: crypto.createHash('sha256').update(SEED, 'utf8').digest('hex'),
    catalog_hash: W.catalogHash(), enroll_closes_at: GRID - 3600, windows_per_caller: 3,
  }), boardKey);
  const close = W.signWindowRow(W.buildWindowRow({
    type: 'enrollment_close', epoch: '2026-W31', enrolled_root: ROOT, enrolled_count: 2,
  }), boardKey);
  const reveal = W.signWindowRow(W.buildWindowRow({ type: 'seed_reveal', epoch: '2026-W31', seed: SEED }), boardKey);
  const qs = [0, 1, 2].map((i) => {
    const d = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: CALLER, window_index: i, version: '1' });
    return W.signWindowRow(W.buildWindowRow({
      type: 'question', epoch: '2026-W31', window_index: i, caller_key: CALLER,
      market: W.questionMarket({ asset: d.asset, opens_at: GRID, horizon_sec: d.horizon_sec }),
      opens_at: GRID, expires_at: GRID + 3600,
    }), boardKey);
  });
  return [commit, close, reveal, ...qs].map((e) => ({ entry_hash: entryHash(e), entry: e }));
};

t('an honest epoch passes the schedule checker (the check is not vacuously red)', () => {
  const r = checkSchedule(epochRows());
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.checked, 3, 'must actually have checked the three questions');
});
t('CONTROL: a hand-picked question is caught', () => {
  const rows = epochRows();
  const q = rows[3].entry;
  // Swap in a different catalog entry while leaving every signature-adjacent field intact.
  const other = W.CATALOG.find((c) => c.asset !== W.parseQuestionMarket(q.market).asset);
  const forged = W.signWindowRow(W.buildWindowRow({
    type: 'question', epoch: q.epoch, window_index: Number(q.window_index), caller_key: q.caller_key,
    market: W.questionMarket({ asset: other.asset, opens_at: GRID, horizon_sec: other.horizon_sec }),
    opens_at: GRID, expires_at: GRID + 3600,
  }), boardKey);
  rows[3] = { entry_hash: entryHash(forged), entry: forged };
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false, 'a hand-picked question must be caught');
  assert.match(r.problems.join(' '), /does not match the derived question/);
});
t('CONTROL: a seed that does not open the commitment is caught', () => {
  const rows = epochRows();
  const bad = W.signWindowRow(W.buildWindowRow({
    type: 'seed_reveal', epoch: '2026-W31', seed: crypto.randomBytes(32).toString('hex'),
  }), boardKey);
  rows[2] = { entry_hash: entryHash(bad), entry: bad };
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /does not open the commitment/);
});
t('CONTROL: a question for a caller who never enrolled is caught', () => {
  const rows = epochRows();
  const stranger = ed.publicKeyOf(mkKey());
  const d = W.deriveQuestion({ seed: SEED, enrolled_root: ROOT, caller_key: stranger, window_index: 0, version: '1' });
  const q = W.signWindowRow(W.buildWindowRow({
    type: 'question', epoch: '2026-W31', window_index: 0, caller_key: stranger,
    market: W.questionMarket({ asset: d.asset, opens_at: GRID, horizon_sec: d.horizon_sec }),
    opens_at: GRID, expires_at: GRID + 3600,
  }), boardKey);
  rows.push({ entry_hash: entryHash(q), entry: q });
  const r = checkSchedule(rows, { enrolled: [CALLER] });
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /not in the enrolled set/);
});
t('CONTROL: a catalog edited after the commit is caught', () => {
  const rows = epochRows();
  const r = checkSchedule(rows, { catalog: [...W.CATALOG, { asset: 'SOL/USD', horizon_sec: '3600' }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /catalog hash mismatch/i);
});
t('CONTROL: a malformed catalog returns a verdict, it does not crash the checker', () => {
  const r = checkSchedule(epochRows(), { catalog: [{ asset: 'SOL/USD', horizon_sec: 60 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /not hashable/);
});
t('CONTROL: questions revealed with no commitment at all are caught', () => {
  const rows = epochRows().slice(1); // drop the schedule_commit
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /no schedule_commit/);
});

console.log('\nMULTI-EPOCH — the enrolled set is epoch-scoped');
// REGRESSION. `opts.enrolled` was an array applied to every epoch, and the operator CLI
// handed it the union of enrollees across the whole chain. One epoch: fine. Two epochs
// with different callers: every round reported `enrolled_root does not match` on a chain
// that was completely honest, so the only self-check an operator runs was permanently red.
const epochWith = (epoch, callerKey) => {
  const caller = ed.publicKeyOf(callerKey);
  const root = W.enrolledRoot([caller]);
  const seed = crypto.randomBytes(32).toString('hex');
  const rows = [
    W.buildWindowRow({
      type: 'schedule_commit', epoch,
      seed_commit: crypto.createHash('sha256').update(seed, 'utf8').digest('hex'),
      catalog_hash: W.catalogHash(), enroll_closes_at: GRID - 3600, windows_per_caller: 1,
    }),
    W.buildWindowRow({ type: 'enrollment_close', epoch, enrolled_root: root, enrolled_count: 1 }),
    W.buildWindowRow({ type: 'seed_reveal', epoch, seed }),
  ];
  const d = W.deriveQuestion({ seed, enrolled_root: root, caller_key: caller, window_index: 0, version: '1' });
  rows.push(W.buildWindowRow({
    type: 'question', epoch, window_index: 0, caller_key: caller,
    market: W.questionMarket({ asset: d.asset, opens_at: GRID, horizon_sec: d.horizon_sec }),
    opens_at: GRID, expires_at: GRID + 3600,
  }));
  return { caller, rows: rows.map((r) => W.signWindowRow(r, boardKey)) };
};

const epA = epochWith('2026-W40', mkKey());
const epB = epochWith('2026-W41', mkKey());
const twoEpochs = [...epA.rows, ...epB.rows].map((e) => ({ entry_hash: entryHash(e), entry: e }));

t('two epochs with different enrollees pass when the map form is used', () => {
  const r = checkSchedule(twoEpochs, {
    enrolled: { '2026-W40': [epA.caller], '2026-W41': [epB.caller] },
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
  assert.strictEqual(r.checked, 2);
});
t('the pooled union that caused the false MISMATCH is still rejected', () => {
  // Not a regression to paper over: this input really is wrong for both epochs, and the
  // checker is right to say so. The fix was at the call site, which must not pool.
  const r = checkSchedule(twoEpochs, { enrolled: [epA.caller, epB.caller] });
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /enrolled_root does not match/);
});
t('an epoch absent from the map is derivation-checked but not enrolment-checked', () => {
  const r = checkSchedule(twoEpochs, { enrolled: { '2026-W40': [epA.caller] } });
  assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
});
t('CONTROL: a wrong key in the map is still caught', () => {
  const r = checkSchedule(twoEpochs, {
    enrolled: { '2026-W40': [epB.caller], '2026-W41': [epB.caller] },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /2026-W40/);
});

console.log('\nINTEGRITY BOARD — a no_answer is never neutral');
// colonist-one's attack (Colony, 2026-07-30): enrol a thousand keys, answer nothing. Every
// window is accounted for, the schedule verifier finds no MISMATCH, and each record is
// COMPLETE. Published as bare counts, that set is indistinguishable from a good one.
const mkBoardRows = (spec) => {
  // spec: { callerKey: ['answer'|'pass'|'no_answer'|'open', …] }
  const rows = [];
  for (const [caller, outcomes] of spec) {
    rows.push(W.signWindowRow(W.buildWindowRow({
      type: 'enroll', epoch: '2026-W50', caller: caller.slice(0, 8),
      ts_claimed: new Date().toISOString(), nonce: newNonce(),
    }), callerKeys.get(caller)));
    outcomes.forEach((outcome, i) => {
      const q = W.signWindowRow(W.buildWindowRow({
        type: 'question', epoch: '2026-W50', window_index: i, caller_key: caller,
        market: W.questionMarket({ asset: 'SOL/USD', opens_at: GRID, horizon_sec: '3600' }),
        opens_at: GRID, expires_at: GRID + 3600,
      }), boardKey);
      const qh = entryHash(q);
      rows.push({ entry_hash: qh, entry: q });
      if (outcome === 'open') return;
      const resp = outcome === 'no_answer'
        ? W.signWindowRow(W.buildWindowRow({ type: 'no_answer', question_hash: qh, observed_at: GRID + 7200 }), boardKey)
        : W.signWindowRow(W.buildWindowRow(outcome === 'answer'
          ? { type: 'answer', question_hash: qh, side: 'yes', odds: '0.60', ts_claimed: new Date().toISOString(), nonce: newNonce() }
          : { type: 'pass', question_hash: qh, ts_claimed: new Date().toISOString(), nonce: newNonce() }),
        callerKeys.get(caller));
      rows.push({ entry_hash: entryHash(resp), entry: resp });
    });
  }
  return rows;
};
const callerKeys = new Map();
const mkCaller = () => { const k = mkKey(); const p = ed.publicKeyOf(k); callerKeys.set(p, k); return p; };
const SYBIL = mkCaller();
const HONEST = mkCaller();
const BURSTY = mkCaller();
const FRESH = mkCaller();
const boardRows = mkBoardRows([
  [SYBIL, ['no_answer', 'no_answer', 'no_answer']],
  [HONEST, ['answer', 'answer', 'answer']],
  [BURSTY, ['answer', 'no_answer', 'pass']],
  [FRESH, ['open', 'open']],
]);
const byKey = (k) => W.integrityBoard(boardRows).find((c) => c.signer === k);

t('the sybil record — complete, verifiable, and worth zero — scores 0', () => {
  const s = byKey(SYBIL);
  assert.strictEqual(s.asked, 3);
  assert.strictEqual(s.answered_rate, 0, 'answering nothing must not be neutral or absent');
  assert.match(s.basis, /0 answered of 3 settled/);
});
t('answering everything scores 1', () => {
  assert.strictEqual(byKey(HONEST).answered_rate, 1);
});
t('an explicit pass counts against the rate but stays distinguishable from silence', () => {
  const b = byKey(BURSTY);
  assert.strictEqual(b.settled, 3);
  assert.strictEqual(b.answered_rate, 0.3333);
  assert.strictEqual(b.passed, 1, 'a signed pass must not be collapsed into no_answer');
  assert.strictEqual(b.no_answer, 1);
});
t('an untested key reads as undefined, NEVER as perfect', () => {
  const f = byKey(FRESH);
  assert.strictEqual(f.settled, 0);
  assert.strictEqual(f.answered_rate, null, 'null, not 1 — nothing has settled');
  assert.match(f.basis, /not perfect/);
});
t('open windows are excluded from the denominator, not counted as declines', () => {
  assert.strictEqual(byKey(FRESH).open, 2);
  assert.strictEqual(byKey(HONEST).open, 0);
});
t('the board is ordered by first enrolment, not by rate', () => {
  const order = W.integrityBoard(boardRows).map((c) => c.signer);
  assert.deepStrictEqual(order, [SYBIL, HONEST, BURSTY, FRESH],
    'sorting by rate would turn disclosure into a leaderboard');
});

console.log('\nROUND LABELS — never reused');
const { nextEpoch } = require('../bin/window-drive.js');
t('epoch labels increment and roll over the year', () => {
  assert.strictEqual(nextEpoch('2026-W31'), '2026-W32');
  assert.strictEqual(nextEpoch('2026-W53'), '2027-W01');
  assert.strictEqual(nextEpoch('2026-W09'), '2026-W10');
});
t('an unparseable label falls back to the clock rather than colliding', () => {
  assert.match(nextEpoch('nonsense'), /^\d{4}-W\d{2}$/);
});


console.log('\nVOID — a retraction that cannot become a delete');
// Written after the operator DELETED a bogus row from the live chain instead of correcting
// it, while an anchor had already committed that row to Solana. Void is the append-only
// correction that should have existed. Its entire risk is that it degenerates into a
// polite delete, so every test below is aimed at that, not at the happy path.
const voidEpoch = (epoch, extra = []) => {
  const seed = crypto.randomBytes(32).toString('hex');
  const rows = [
    W.buildWindowRow({
      type: 'schedule_commit', epoch,
      seed_commit: crypto.createHash('sha256').update(seed, 'utf8').digest('hex'),
      catalog_hash: W.catalogHash(), enroll_closes_at: GRID + 3600, windows_per_caller: 1,
    }),
    ...extra,
    W.buildWindowRow({ type: 'schedule_void', epoch, reason: 'committed with a bogus epoch label during a test' }),
  ];
  return rows.map((r) => W.signWindowRow(r, boardKey)).map((e) => ({ entry_hash: entryHash(e), entry: e }));
};

t('a clean void passes the checker', () => {
  const r = checkSchedule(voidEpoch('2026-W90'));
  assert.strictEqual(r.ok, true, r.problems.join('; '));
});

// POSITIVE CONTROL for the test above: the checker must be capable of failing a void at
// all. Without this, "a clean void passes" is satisfied by a checker that never looks.
t('CONTROL — voiding an epoch that already has questions is a MISMATCH', () => {
  const callerKey = mkKey();
  const caller = ed.publicKeyOf(callerKey);
  const rows = voidEpoch('2026-W91', [
    W.buildWindowRow({
      type: 'question', epoch: '2026-W91', window_index: 0, caller_key: caller,
      market: W.questionMarket({ asset: 'SOL/USD', opens_at: GRID, horizon_sec: '86400' }),
      opens_at: GRID, expires_at: GRID + 3600,
    }),
  ]);
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false, 'a void over a live question is unasking a question we can already answer');
  assert.match(r.problems.join(' '), /delete with better manners/);
});

t('CONTROL — a voided epoch that was still closed and revealed is a MISMATCH', () => {
  const seed = crypto.randomBytes(32).toString('hex');
  const rows = voidEpoch('2026-W92', [
    W.buildWindowRow({ type: 'enrollment_close', epoch: '2026-W92', enrolled_root: W.enrolledRoot(['x']), enrolled_count: 1 }),
    W.buildWindowRow({ type: 'seed_reveal', epoch: '2026-W92', seed }),
  ]);
  const r = checkSchedule(rows);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems.join(' '), /enrollment_close, seed_reveal/);
});

// The reason this is checked separately: a voided epoch normally carries NOTHING to
// re-derive, and the checker's main loop skips epochs with no questions. An implementation
// that put the void rules inside that loop would wave through every void ever written,
// including the ones covering something up, and still report SCHEDULE OK.
t('a void is inspected even though a voided epoch has nothing to re-derive', () => {
  const r = checkSchedule(voidEpoch('2026-W93'));
  assert.strictEqual(r.checked, 0, 'nothing to re-derive — which is exactly why it could have been skipped');
  assert.strictEqual(r.ok, true);
});

t('a void with no real reason is refused at construction', () => {
  assert.throws(() => W.buildWindowRow({ type: 'schedule_void', epoch: 'e', reason: 'oops' }),
    /explanation/, 'a void with no reason is a delete with better manners');
  assert.throws(() => W.buildWindowRow({ type: 'schedule_void', epoch: 'e' }), /required/);
});

t('a void carries no extra fields — nothing can ride along unsigned-for', () => {
  assert.throws(() => W.buildWindowRow({
    type: 'schedule_void', epoch: 'e', reason: 'a good enough reason', replaces: 'deadbeef',
  }), /unknown field/);
});

t('repeated voids are idempotent, not an error', () => {
  const rows = voidEpoch('2026-W94');
  const again = W.signWindowRow(W.buildWindowRow({
    type: 'schedule_void', epoch: '2026-W94', reason: 'said the same thing twice',
  }), boardKey);
  rows.push({ entry_hash: entryHash(again), entry: again });
  assert.strictEqual(checkSchedule(rows).ok, true, 'a second void cannot make an epoch deader');
});


// ── Compliance-emitting sweep rows (hermessol) ───────────────────────────────
// The property under test is not "the sweep works". It is that a stranger reading only
// the chain can tell a quiet hour from an hour nobody looked. Every positive below is
// paired with the chain that would exist if we had skipped a sweep.

const sweepRow = (sweptAt, written = 0) => {
  const r = W.signWindowRow(W.buildWindowRow({
    type: 'sweep_report', swept_at: sweptAt,
    questions_seen: 7, expired_written: written, open_now: 2,
  }), boardKey);
  return { entry_hash: entryHash(r), entry: r };
};
const T0 = 1767225600; // fixed, so these tests do not depend on when they run

t('a sweep that found NOTHING still produces a row — zero is a reportable count', () => {
  const r = W.buildWindowRow({
    type: 'sweep_report', swept_at: T0, questions_seen: 0, expired_written: 0, open_now: 0,
  });
  assert.strictEqual(r.expired_written, '0');
  assert.strictEqual(r.questions_seen, '0');
});

t('the row is signed and verifies — it is testimony, not a log line', () => {
  const r = sweepRow(T0).entry;
  assert.strictEqual(W.verifyWindowRow(r).ok, true);
  const tampered = { ...r, expired_written: '99' };
  assert.strictEqual(W.verifyWindowRow(tampered).ok, false, 'a rewritten count must not verify');
});

t('nothing can ride along inside a sweep_report unsigned-for', () => {
  assert.throws(() => W.buildWindowRow({
    type: 'sweep_report', swept_at: T0, questions_seen: 1, expired_written: 0, open_now: 0,
    note: 'all fine here',
  }), /unknown field/);
});

t('an hourly chain with no missed sweep reports zero gaps', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(sweepRow(T0 + i * 3600));
  const c = W.sweepCoverage(rows, { interval_sec: 3600, now: T0 + 5 * 3600 });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.gaps.length, 0);
  assert.strictEqual(c.reports, 6);
});

t('POSITIVE CONTROL: drop one sweep and the checker names the hole', () => {
  // Same chain as above with the 3rd sweep removed. If this does not fire, the clean
  // result above is a checker that cannot say MISMATCH — i.e. no evidence at all.
  const rows = [];
  for (let i = 0; i < 6; i++) if (i !== 3) rows.push(sweepRow(T0 + i * 3600));
  const c = W.sweepCoverage(rows, { interval_sec: 3600, now: T0 + 5 * 3600 });
  assert.strictEqual(c.ok, false, 'a skipped sweep must be visible');
  assert.strictEqual(c.gaps.length, 1);
  assert.strictEqual(c.gaps[0].missed, 1);
  assert.match(c.gaps[0].from, /^2026-/);
});

t('a board that stopped sweeping entirely is caught by the trailing gap', () => {
  const rows = [sweepRow(T0), sweepRow(T0 + 3600)];
  const c = W.sweepCoverage(rows, { interval_sec: 3600, now: T0 + 3600 + 86400 });
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.gaps[c.gaps.length - 1].to, 'now');
  assert.strictEqual(c.gaps[c.gaps.length - 1].missed, 23);
});

t('NEGATIVE CONTROL: with no `now`, no trailing gap is invented', () => {
  // A verifier run at an unknown time must not manufacture an accusation out of its own
  // clock. Same chain as the test above, minus the caller asserting what time it is.
  const rows = [sweepRow(T0), sweepRow(T0 + 3600)];
  const c = W.sweepCoverage(rows, { interval_sec: 3600 });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.gaps.length, 0);
});

t('NEGATIVE CONTROL: a chain predating the feature is unproven, not guilty', () => {
  // Every sweep before this shipped emitted nothing. Reporting that stretch as a gap
  // would be an accusation manufactured by a deploy date.
  const c = W.sweepCoverage([], { interval_sec: 3600, now: T0 });
  assert.strictEqual(c.covered, false);
  assert.strictEqual(c.ok, true, 'unproven is not the same verdict as violated');
  assert.match(c.basis, /unproven/);
});

t('coverage starts at the first report, so the pre-feature stretch is not a gap', () => {
  const rows = [sweepRow(T0 + 86400 * 30), sweepRow(T0 + 86400 * 30 + 3600)];
  const c = W.sweepCoverage(rows, { interval_sec: 3600 });
  assert.strictEqual(c.ok, true, '30 days before the first report must not count against us');
  assert.match(c.basis, /not from the first question/);
});

t('sweep_report does not disturb the schedule checker', () => {
  const rows = voidEpoch('2026-W95');
  rows.push(sweepRow(T0));
  assert.strictEqual(checkSchedule(rows).ok, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
