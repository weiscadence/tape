'use strict';
/**
 * read.test.js — the query side, and the coverage declaration.
 *
 * Two things are under test and they fail in opposite directions:
 *
 * READS must never let a broken tape look like an empty one. Every query here can
 * honestly return nothing, which is exactly the condition under which a silent failure is
 * indistinguishable from an honest answer. So the controls corrupt a real chain and
 * require a THROW, not `entries: []`.
 *
 * DECLARE must never let a coverage commitment leak into the score. It shares the chain
 * with positions, so the controls check that it cannot be mistaken for one — by the
 * publisher, by the independent recomputer, or by a profile lookup that belongs to a
 * different key.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildEntry, signEntry } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { stateFrom, listCalls, callerProfile, callers, coverageOf, countClaimsOf } = require('../lib/readmodel');
const { buildPositions } = require('../lib/score');

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
const ed = require('../lib/ed25519');
const nonce = () => crypto.randomBytes(16).toString('hex');

const KEY_A = mkKey(), KEY_B = mkKey();
const PUB_A = ed.publicKeyOf(KEY_A), PUB_B = ed.publicKeyOf(KEY_B);

/**
 * A fixture tape built through the REAL Chain, not hand-written JSON. A fixture that
 * bypasses the writer can contain a chain the writer would have refused, and then the
 * reader is being tested against a state that cannot occur.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-read-'));
  const tapeFile = path.join(dir, 'tape.jsonl');
  const anchorFile = path.join(dir, 'anchors.jsonl');
  const chain = new Chain(tapeFile);

  const put = (key, e) => chain.append(signEntry(buildEntry({ ...e, nonce: nonce() }), key));

  // seq 0: A opens, later closed
  const a0 = put(KEY_A, { type: 'open', caller: 'alpha', lane: 'perp', market: 'Crypto.SOL/USD',
    side: 'long', size: '1', entry_ref: '150', ts_claimed: '2026-07-28T10:00:00Z' });
  // seq 1: B opens, stays open
  put(KEY_B, { type: 'open', caller: 'beta', lane: 'memecoin', market: 'Crypto.BONK/USD',
    side: 'long', size: '2', entry_ref: '0.00002', ts_claimed: '2026-07-28T10:05:00Z' });
  // seq 2: A closes seq 0
  put(KEY_A, { type: 'close', caller: 'alpha', lane: 'perp', market: 'Crypto.SOL/USD',
    side: 'long', size: '1', entry_ref: '160', ref: a0.entry_hash, ts_claimed: '2026-07-28T11:00:00Z' });
  // seq 3: A opens again — deliberately left BEYOND the anchor, so the unanchored state
  // is exercised rather than assumed.
  put(KEY_A, { type: 'open', caller: 'alpha', lane: 'perp', market: 'Crypto.SOL/USD',
    side: 'short', size: '1', entry_ref: '170', ts_claimed: '2026-07-28T12:00:00Z' });

  // One anchor covering the first three rows only.
  fs.writeFileSync(anchorFile, JSON.stringify({
    signature: 'SIGx', slot: 100, blockTime: 1785270000, root: 'r', count: 3, cluster: 'mainnet',
  }) + '\n');

  return { dir, tapeFile, anchorFile, chain, a0 };
}

const F = fixture();
const S = () => stateFrom(F.tapeFile, F.anchorFile);

console.log('\n-- reads');

t('lists every row, newest first', () => {
  const r = listCalls({}, S());
  assert.strictEqual(r.total_matching, 4);
  assert.strictEqual(r.entries[0].seq, 3);
});

t('filters by signer, and a signer with no rows returns an honest empty list', () => {
  assert.strictEqual(listCalls({ signer: PUB_B }, S()).total_matching, 1);
  assert.strictEqual(listCalls({ signer: 'nobody' }, S()).total_matching, 0);
});

t('filters by lane and type', () => {
  assert.strictEqual(listCalls({ lane: 'perp' }, S()).total_matching, 3);
  assert.strictEqual(listCalls({ type: 'close' }, S()).total_matching, 1);
});

t('open=1 excludes a position that has been closed', () => {
  const open = listCalls({ open: '1' }, S());
  const hashes = open.entries.map((e) => e.entry_hash);
  assert.strictEqual(open.total_matching, 2, 'seq 1 and seq 3 are open; seq 0 was closed');
  assert.ok(!hashes.includes(F.a0.entry_hash), 'the closed position must not appear as open');
});

t('CONTROL: an unanchored entry is never presented as anchored', () => {
  const r = listCalls({}, S());
  const last = r.entries[0];
  assert.strictEqual(last.seq, 3);
  assert.strictEqual(last.anchored, false);
  assert.strictEqual(last.anchor, null);
  assert.match(last.time_status, /NOT YET ANCHORED/);
  assert.strictEqual(r.anchored_through_seq, 2);
});

t('an anchored entry carries the EARLIEST covering anchor, not the newest', () => {
  // A second, later anchor also covers seq 0. The tightest provable bound is the point.
  const two = F.anchorFile + '.two';
  fs.writeFileSync(two,
    fs.readFileSync(F.anchorFile, 'utf8') +
    JSON.stringify({ signature: 'SIGy', slot: 999, blockTime: 1785299999, root: 'r2', count: 4, cluster: 'mainnet' }) + '\n');
  const r = listCalls({ type: 'open' }, stateFrom(F.tapeFile, two));
  const seq0 = r.entries.find((e) => e.seq === 0);
  assert.strictEqual(seq0.anchor.slot, 100, 'must report slot 100, not the looser 999');
});

t('CONTROL: a tampered chain THROWS — it must not read as an empty tape', () => {
  const bad = F.tapeFile + '.bad';
  const rows = fs.readFileSync(F.tapeFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  rows[1].entry.size = '999';                       // one field, nothing else
  fs.writeFileSync(bad, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.throws(() => stateFrom(bad, F.anchorFile), /does not verify/);
});

t('CONTROL: a chain file that does not exist is empty, not broken', () => {
  // The opposite error: refusing to distinguish "nothing here yet" from "corrupt" would
  // make a brand-new deployment indistinguishable from a compromised one.
  const empty = path.join(F.dir, 'fresh.jsonl');
  const st = stateFrom(empty, path.join(F.dir, 'no-anchors.jsonl'));
  assert.strictEqual(st.rows.length, 0);
  assert.strictEqual(st.covered, 0);
});

console.log('\n-- profiles');

t('profile is keyed on the signing key and lists every label it used', () => {
  const p = callerProfile(PUB_A, S());
  assert.strictEqual(p.known, true);
  assert.strictEqual(p.entries, 3);
  assert.strictEqual(p.anchored, 2);
  assert.strictEqual(p.pending_anchor, 1);
  assert.strictEqual(p.still_open, 1);
  assert.deepStrictEqual(p.labels_used, ['alpha']);
  assert.strictEqual(p.first_anchor_slot, 100);
});

t('an unknown key is an empty record, not an error and not a verdict', () => {
  const p = callerProfile('never-posted', S());
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.known, false);
});

t('callers are ordered by first-anchor slot — the one thing nobody can buy', () => {
  const c = callers(S());
  assert.strictEqual(c.callers.length, 2);
  assert.strictEqual(c.callers[0].signer, PUB_A);
});

console.log('\n-- declare (coverage)');

t('a profile with no declaration is UNDECLARED, and says what that means', () => {
  const p = callerProfile(PUB_A, S());
  assert.strictEqual(p.coverage.declared, false);
  assert.strictEqual(p.coverage.status, 'UNDECLARED');
  assert.match(p.coverage.means, /sample, not a record/);
});

t('a signed declaration flips the key to DECLARED with its scope', () => {
  const chain = new Chain(F.tapeFile);
  chain.append(signEntry(buildEntry({
    type: 'declare', caller: 'alpha', lane: 'perp', market: 'scope:lane=perp',
    side: 'yes', size: '0', entry_ref: '0', ts_claimed: '2026-07-28T13:00:00Z',
    note: 'every perp call I make goes here', nonce: nonce(),
  }), KEY_A));
  const p = callerProfile(PUB_A, S());
  assert.strictEqual(p.coverage.status, 'DECLARED');
  assert.strictEqual(p.coverage.scopes[0].scope, 'scope:lane=perp');
  // A declaration must not inflate the call count. Promising to keep a record is not the
  // same act as keeping one, and a counter that adds them together rewards the promise.
  assert.strictEqual(p.declarations, 1);
  assert.strictEqual(p.entries, 3, 'still three calls: two opens and a close');
  assert.match(p.coverage.means, /we cannot verify that; nobody can/);
});

t("CONTROL: one key's declaration does not cover another key", () => {
  assert.strictEqual(callerProfile(PUB_B, S()).coverage.status, 'UNDECLARED');
});

t('CONTROL: an UNSIGNED declaration confers coverage on nobody', () => {
  const chain = new Chain(F.tapeFile);
  chain.append(buildEntry({
    type: 'declare', caller: 'alpha', lane: 'perp', market: 'scope:all',
    side: 'yes', size: '0', entry_ref: '0', ts_claimed: '2026-07-28T13:30:00Z', nonce: nonce(),
  }));
  const st = S();
  // Still exactly one scope on A (the signed one), and none of it attaches to the name.
  assert.strictEqual(callerProfile(PUB_A, st).coverage.scopes.length, 1);
  assert.strictEqual(coverageOf(st.rows, null).status, 'UNDECLARED');
});

t('CONTROL: a declaration is not a position — the publisher does not score it', () => {
  const st = S();
  const built = buildPositions({ rows: st.rows, anchors: st.anchors, gate: new Map() });
  const anomalies = (built.anomalies || []).filter((a) => a.kind === 'unknown_type');
  assert.strictEqual(anomalies.length, 0, 'declare must be skipped explicitly, not filed as an anomaly');
  assert.ok(!built.positions.some((p) => String(p.market).startsWith('scope:')),
    'no scope row may become a position');
});

console.log('\n-- row families');

t('CONTROL: board-minted window rows are not counted as a caller\'s calls', () => {
  // Found live, not in a fixture: a real profile read said `entries: 3, lanes: [null,
  // 'prediction']` for an agent that had made two calls. The third row was the board's own
  // enrollment record, signed by that agent but not a call. A record system that inflates
  // someone's count with its own machinery is misreporting the thing it exists to report.
  const { buildWindowRow, signWindowRow } = require('../lib/windows');
  const chain = new Chain(F.tapeFile);
  chain.append(signWindowRow(buildWindowRow({
    type: 'enroll', epoch: '1', caller: 'alpha', ts_claimed: '2026-07-28T14:00:00Z', nonce: nonce(),
  }), KEY_A));
  const st = S();

  const p = callerProfile(PUB_A, st);
  assert.strictEqual(p.window_rows, 1, 'the window row is reported, in its own field');
  assert.ok(!p.lanes.includes(null), 'a window row must not contribute a null lane');
  assert.ok(!p.entries_list.some((e) => e.family === 'window'), 'the call list holds calls');

  const calls = listCalls({}, st);
  assert.ok(calls.entries.every((e) => e.family === 'call'), '/calls returns calls by default');
  assert.strictEqual(listCalls({ include: 'all' }, st).total_matching, calls.total_matching + 1,
    'include=all still reaches it — hidden by default is a view, unreachable would be an edit');
});

console.log('\n-- count claims (dataciv: commit to a count before resolution)');

// A's open positions in lane=perp at this point in the fixture: exactly one (seq 3;
// seq 0 was closed by seq 2). Every verdict below is measured against that one.
const declareCount = (key, open_count, extra = {}) => {
  const chain = new Chain(F.tapeFile);
  return chain.append(signEntry(buildEntry({
    type: 'declare', caller: 'alpha', lane: 'perp', market: 'scope:lane=perp',
    side: 'yes', size: '0', entry_ref: '0', ts_claimed: '2026-07-29T10:00:00Z',
    nonce: nonce(), open_count, ...extra,
  }), key));
};

t('a count matching the tape reads consistent — and says that is not complete', () => {
  declareCount(KEY_A, 1);
  const c = callerProfile(PUB_A, S()).count_claims;
  const mine = c[c.length - 1];
  assert.strictEqual(mine.verdict, 'consistent');
  assert.strictEqual(mine.claimed_open, 1);
  assert.strictEqual(mine.tape_open, 1);
  assert.match(mine.means, /consistent is NOT complete/);
});

t('POSITIVE CONTROL: claiming more open than the tape shows is a self-declared gap', () => {
  // This is the whole primitive. The caller signs that they hold four while the tape
  // carries one, and the three they did not post become an admitted, signed quantity.
  declareCount(KEY_A, 4);
  const c = callerProfile(PUB_A, S()).count_claims;
  const mine = c[c.length - 1];
  assert.strictEqual(mine.verdict, 'self_declared_gap');
  assert.strictEqual(mine.undisclosed, 3);
  assert.match(mine.means, /admitted, by them, in a signed row/);
});

t('POSITIVE CONTROL: claiming fewer than the tape shows contradicts their own rows', () => {
  declareCount(KEY_A, 0);
  const c = callerProfile(PUB_A, S()).count_claims;
  const mine = c[c.length - 1];
  assert.strictEqual(mine.verdict, 'exceeds_claim');
  assert.strictEqual(mine.undisclosed, 0, 'an over-posted tape is not an undisclosed position');
});

t('zero is a legal count — "I hold nothing open" is a real commitment', () => {
  const e = buildEntry({
    type: 'declare', caller: 'beta', lane: 'perp', market: 'scope:all', side: 'yes',
    size: '0', entry_ref: '0', ts_claimed: '2026-07-29T10:00:00Z', nonce: nonce(), open_count: 0,
  });
  assert.strictEqual(e.open_count, '0');
});

t('the count is inside the signature — a rewritten number does not verify', () => {
  const rec = declareCount(KEY_A, 2);
  const tampered = { ...rec.entry, open_count: '9' };
  assert.strictEqual(require('../lib/entry').verifyEntrySignature(tampered).ok, false);
});

t('evaluated at chain seq, NOT the caller clock — backdating changes nothing', () => {
  // If the comparison used ts_claimed, a claim stamped in 2020 would be measured against
  // an empty tape and read as a gap. Chain order is the one thing the caller cannot tune.
  declareCount(KEY_A, 1, { ts_claimed: '2020-01-01T00:00:00Z' });
  const c = callerProfile(PUB_A, S()).count_claims;
  assert.strictEqual(c[c.length - 1].verdict, 'consistent');
});

t('CONTROL: a declare with no count produces no count claim — old declares are unchanged', () => {
  const before = callerProfile(PUB_A, S()).count_claims.length;
  const chain = new Chain(F.tapeFile);
  chain.append(signEntry(buildEntry({
    type: 'declare', caller: 'alpha', lane: 'perp', market: 'scope:lane=perp', side: 'yes',
    size: '0', entry_ref: '0', ts_claimed: '2026-07-29T11:00:00Z', nonce: nonce(),
  }), KEY_A));
  assert.strictEqual(callerProfile(PUB_A, S()).count_claims.length, before);
});

t('CONTROL: an UNSIGNED count claim is attributed to nobody', () => {
  const chain = new Chain(F.tapeFile);
  chain.append(buildEntry({
    type: 'declare', caller: 'alpha', lane: 'perp', market: 'scope:lane=perp', side: 'yes',
    size: '0', entry_ref: '0', ts_claimed: '2026-07-29T12:00:00Z', nonce: nonce(), open_count: 99,
  }));
  const st = S();
  assert.ok(!callerProfile(PUB_A, st).count_claims.some((c) => c.claimed_open === 99),
    'a name is free; only a key can commit');
  assert.strictEqual(countClaimsOf(st.rows, null).length, 0);
});

t('CONTROL: a count on a real position is refused — a position is not a census', () => {
  assert.throws(() => buildEntry({
    type: 'open', caller: 'alpha', lane: 'perp', market: 'Crypto.SOL/USD', side: 'long',
    size: '1', entry_ref: '150', ts_claimed: '2026-07-29T10:00:00Z', nonce: nonce(), open_count: 3,
  }), /only meaningful on a declare/);
});

t('CONTROL: a count that is not a whole non-negative number is refused', () => {
  const base = {
    type: 'declare', caller: 'alpha', lane: 'perp', market: 'scope:all', side: 'yes',
    size: '0', entry_ref: '0', ts_claimed: '2026-07-29T10:00:00Z', nonce: nonce(),
  };
  assert.throws(() => buildEntry({ ...base, open_count: -1 }), /non-negative integer/);
  assert.throws(() => buildEntry({ ...base, open_count: 1.5 }), /non-negative integer/);
  assert.throws(() => buildEntry({ ...base, open_count: '3' }), /non-negative integer/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
