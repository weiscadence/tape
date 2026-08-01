'use strict';
/**
 * spine.test.js — every guard exercised in BOTH states.
 *
 * A tamper detector that has never seen tampering is not a detector, it is a decoration
 * that returns "ok". So each protection below has a matching NEGATIVE control that must
 * FAIL. Tests named `known-gap:` assert a limitation we accept and have documented —
 * they exist so the gap cannot quietly close or quietly widen without a test changing.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { canonicalize } = require('../lib/canonical');
const { buildEntry, entryHash, entryBytes, newNonce } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { hashLeaf, hashNode, buildTree, proveInclusion, verifyInclusion, verifyEntryInclusion } = require('../lib/merkle');
const { anchorPayload } = require('../lib/anchor');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const call = (over = {}) => buildEntry({
  type: 'open', caller: 'cadence-wave', lane: 'memecoin',
  market: 'So11111111111111111111111111111111111111112', side: 'long',
  size: '100.00', entry_ref: '0.00042', ts_claimed: '2026-07-28T20:30:00Z',
  nonce: newNonce(), ...over,
});

console.log('\ncanonical serialization');
t('key order does not change the bytes', () => {
  assert.strictEqual(canonicalize({ b: '2', a: '1' }), canonicalize({ a: '1', b: '2' }));
});
t('nested key order does not change the bytes', () => {
  assert.strictEqual(canonicalize({ x: { q: '1', p: '2' } }), canonicalize({ x: { p: '2', q: '1' } }));
});
t('NEGATIVE: a raw number is rejected', () => {
  assert.ok(throws(() => canonicalize({ size: 100.5 })), 'expected a throw on a raw number');
});
t('NEGATIVE: an explicit undefined value is rejected, not silently dropped', () => {
  assert.ok(throws(() => canonicalize({ a: '1', b: undefined })));
});

console.log('\nentry');
t('unknown fields are rejected', () => {
  assert.ok(throws(() => call({ sneaky: 'x' })));
});
t('a raw-number size is rejected', () => {
  assert.ok(throws(() => call({ size: 100 })));
});
t('two identical calls with different nonces are DIFFERENT entries (no silent dedup)', () => {
  const a = call({ nonce: 'a'.repeat(32) });
  const b = call({ nonce: 'b'.repeat(32) });
  assert.notStrictEqual(entryHash(a), entryHash(b));
});
t('the same entry hashes identically twice (determinism)', () => {
  const e = call({ nonce: 'c'.repeat(32) });
  assert.strictEqual(entryHash(e), entryHash(JSON.parse(JSON.stringify(e))));
});
t('an open may not carry a ref; a close must', () => {
  assert.ok(throws(() => call({ ref: 'f'.repeat(64) })), 'open with ref should throw');
  assert.ok(throws(() => call({ type: 'close', ref: null })), 'close without ref should throw');
});

console.log('\nmerkle');
const leaves = Array.from({ length: 7 }, (_, i) => hashLeaf(`leaf-${i}`));
const tree = buildTree(leaves);
t('every leaf proves inclusion against the root (odd leaf count)', () => {
  for (let i = 0; i < leaves.length; i++) {
    assert.ok(verifyInclusion(leaves[i], proveInclusion(tree, i), tree.root.toString('hex')),
      `leaf ${i} failed to prove`);
  }
});
t('NEGATIVE: a leaf that was never in the batch does not prove', () => {
  const outsider = hashLeaf('never-submitted');
  assert.ok(!verifyInclusion(outsider, proveInclusion(tree, 3), tree.root.toString('hex')));
});
t('NEGATIVE: leaf A\'s proof does not validate leaf B', () => {
  assert.ok(!verifyInclusion(leaves[2], proveInclusion(tree, 5), tree.root.toString('hex')));
});
t('NEGATIVE: second preimage — no PAYLOAD can be smuggled in via an internal node', () => {
  const internal = hashNode(leaves[0], leaves[1]); // a real internal node of this tree
  const proofForPair = proveInclusion(tree, 0).slice(1);

  // The digest-level primitive DOES accept this, because a Merkle path from an internal
  // node necessarily recomputes the root. That is not the vulnerability; the
  // vulnerability would be a real payload landing on that digest.
  assert.ok(verifyInclusion(internal, proofForPair, tree.root.toString('hex')),
    'sanity: the raw path should recompute the root');

  // The safe API hashes the leaf itself with the 0x00 domain tag, so no payload — not
  // even the raw bytes of the internal digest — can occupy that position.
  assert.ok(!verifyEntryInclusion(internal, proofForPair, tree.root.toString('hex')),
    'a payload was accepted in an internal-node position');
  assert.ok(!verifyEntryInclusion('leaf-0', proofForPair, tree.root.toString('hex')));
});
t('NEGATIVE: different leaf sets do not collide to one root (odd-node duplication)', () => {
  // The classic CVE-2012-2459 shape: [a,b,c] vs [a,b,c,c]. Duplicating the odd tail
  // would make these identical. Promotion + committed leaf count must keep them apart.
  const a = buildTree([hashLeaf('a'), hashLeaf('b'), hashLeaf('c')]);
  const b = buildTree([hashLeaf('a'), hashLeaf('b'), hashLeaf('c'), hashLeaf('c')]);
  const distinct = a.root.toString('hex') !== b.root.toString('hex') || a.count !== b.count;
  assert.ok(distinct, 'two different leaf sets produced the same commitment');
  assert.notStrictEqual(
    anchorPayload({ root: a.root.toString('hex'), count: a.count, chainHead: 'x' }),
    anchorPayload({ root: b.root.toString('hex'), count: b.count, chainHead: 'x' }),
  );
});
t('an empty interval still commits to a fixed, distinct root', () => {
  const e = buildTree([]);
  assert.strictEqual(e.count, 0);
  assert.notStrictEqual(e.root.toString('hex'), tree.root.toString('hex'));
});

console.log('\nchain');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-'));
const file = path.join(tmp, 'chain.jsonl');
const chain = new Chain(file);
const openRec = chain.append(call({ nonce: '1'.repeat(32) }));
chain.append(call({ nonce: '2'.repeat(32), market: 'BONK' }));
const closeRec = chain.append(call({
  type: 'close', ref: openRec.entry_hash, nonce: '3'.repeat(32), entry_ref: '0.00061',
}));

t('a clean chain verifies', () => {
  const v = chain.verify();
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.strictEqual(v.count, 3);
});
t('a close must reference an entry that already exists', () => {
  assert.ok(throws(() => chain.append(call({ type: 'close', ref: 'd'.repeat(64), nonce: '4'.repeat(32) }))));
});
t('NEGATIVE: editing an entry field breaks verification', () => {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  rows[0].entry.entry_ref = '0.00001'; // improve the entry price after the fact
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const v = new Chain(file).verify();
  assert.ok(!v.ok, 'tampered entry verified as clean');
  assert.ok(v.errors.some((e) => /entry_hash does not match/.test(e.error)), JSON.stringify(v.errors));
  rows[0].entry.entry_ref = '0.00042'; // restore
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.ok(new Chain(file).verify().ok, 'restore failed — test is not self-cleaning');
});
t('NEGATIVE: reordering two records breaks verification', () => {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const swapped = [rows[1], rows[0], rows[2]];
  const f2 = path.join(tmp, 'swapped.jsonl');
  fs.writeFileSync(f2, swapped.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.ok(!new Chain(f2).verify().ok, 'reordered chain verified as clean');
});
t('known-gap: TRUNCATING the tail still verifies — this is why the anchor exists', () => {
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const f3 = path.join(tmp, 'truncated.jsonl');
  fs.writeFileSync(f3, rows.slice(0, 2).map((r) => JSON.stringify(r)).join('\n') + '\n');
  const v = new Chain(f3).verify();
  // If this ever starts FAILING, the local chain gained a tail anchor and this comment
  // is stale. If it keeps passing, the Solana anchor is doing load-bearing work and the
  // README must keep saying so.
  assert.ok(v.ok, 'expected a truncated prefix to still be a valid chain');
  assert.strictEqual(v.count, 2);
});

console.log('\nanchor payload');
t('the committed payload is deterministic and carries root, count and head', () => {
  const p = anchorPayload({ root: 'ab'.repeat(32), count: 7, chainHead: 'cd'.repeat(32) });
  assert.strictEqual(p, anchorPayload({ root: 'ab'.repeat(32), count: 7, chainHead: 'cd'.repeat(32) }));
  const o = JSON.parse(p);
  assert.strictEqual(o.p, 'tape'); assert.strictEqual(o.v, 1);
  assert.strictEqual(o.n, 7); assert.strictEqual(o.root, 'ab'.repeat(32));
});
t('the memo payload fits comfortably in one Solana memo', () => {
  const p = anchorPayload({ root: 'ab'.repeat(32), count: 999999, chainHead: 'cd'.repeat(32) });
  assert.ok(Buffer.byteLength(p, 'utf8') < 300, `payload ${Buffer.byteLength(p)} bytes`);
});

console.log('\nend-to-end');
t('a chain entry proves inclusion in its interval root', () => {
  const rows = new Chain(file).read();
  const digests = rows.map((r) => hashLeaf(entryBytes(r.entry)));
  const tr = buildTree(digests);
  const idx = rows.findIndex((r) => r.entry_hash === closeRec.entry_hash);
  assert.ok(verifyInclusion(digests[idx], proveInclusion(tr, idx), tr.root.toString('hex')));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
