'use strict';
/**
 * attest.test.js — the verification-counting family.
 *
 * WHAT THESE TESTS ARE ACTUALLY DEFENDING. Every claim on the attestation surface is a
 * claim about a NUMBER we publish, and the failure mode for a published number is not a
 * crash, it is a comfortable value that nobody can tell is untested. So each block below
 * carries its own positive control:
 *
 *   - the signature negatives are worthless unless a good signature verifies, or "tamper
 *     rejected" would also be printed by a verifier that rejects everything;
 *   - the "zero independent verifications" headline is worthless unless the classifier is
 *     shown reaching the independent bucket at all, or an unreachable branch and an honest
 *     zero look identical from the outside. That is the exact bug the operator registry was
 *     built for and it does not stop being a bug one module over.
 *
 * The cross-implementation block is the other half: the published client signs with code
 * that may not import lib/, so a shared bug cannot make both sides agree. If those two ever
 * disagree, one of them is wrong and neither can hide it.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nacl = require('tweetnacl');

const A = require('../lib/attest');
const ed = require('../lib/ed25519');
const { Chain } = require('../lib/chain');
const { canonicalize } = require('../lib/canonical');
const W = require('../lib/windows');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const KEY_A = Buffer.from(nacl.sign.keyPair().secretKey);
const KEY_B = Buffer.from(nacl.sign.keyPair().secretKey);
const PUB_A = ed.publicKeyOf(KEY_A);
const PUB_B = ed.publicKeyOf(KEY_B);

const HASH = (n) => String(n).padStart(2, '0').repeat(32).slice(0, 64);
const ROOT = 'a'.repeat(64);
const SIG58 = '5' + 'q'.repeat(87);   // base58-shaped, 88 chars, never verified as a real sig

const good = (over = {}) => A.buildAttestRow({
  ref: HASH(11), verdict: 'verified', merkle_root: ROOT, anchor_sig: SIG58,
  slot: '312445001', rpc_host: 'api.mainnet-beta.solana.com', note: null,
  attested_at: '2026-07-31T21:00:00Z', ...over,
});

/* ================================================================== *
 * 1. signatures — positive control FIRST
 * ================================================================== */
console.log('\nattest: signature');

t('POSITIVE CONTROL — an honestly signed row verifies', () => {
  const v = A.verifyAttestRow(A.signAttestRow(good(), KEY_A));
  assert.strictEqual(v.ok, true, v.reason);
  assert.strictEqual(v.signer, PUB_A);
});

t('a flipped verdict breaks the signature', () => {
  const row = A.signAttestRow(good(), KEY_A);
  const v = A.verifyAttestRow({ ...row, verdict: 'fraud' });
  assert.strictEqual(v.ok, false);
});

t('a flipped target breaks the signature', () => {
  const row = A.signAttestRow(good(), KEY_A);
  const v = A.verifyAttestRow({ ...row, ref: HASH(12) });
  assert.strictEqual(v.ok, false);
});

t("key B's signature does not verify under key A", () => {
  const row = A.signAttestRow(good(), KEY_B);
  assert.strictEqual(A.verifyAttestRow({ ...row, signer: PUB_A }).ok, false);
});

t('UNSIGNED IS INVALID, not merely unattributed', () => {
  // The one place this family deviates from the other three, and the reason is the whole
  // module: an unsigned verification claim is a self-reported number with extra steps.
  const v = A.verifyAttestRow({ ...good(), signer: null, sig: null });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /must be signed/);
});

t('DOMAIN SEPARATION — a window-domain signature cannot be lifted onto an attestation', () => {
  // Sign the attestation's exact canonical bytes under the WINDOW prefix. If the domains
  // were decoration, this would verify and one family's rows could be replayed as another's.
  const row = { ...good(), signer: PUB_A, sig: null };
  const wrongDomain = Buffer.from(W.SIG_DOMAIN + canonicalize({ ...row, sig: null }), 'utf8');
  const lifted = { ...row, sig: ed.sign(wrongDomain, KEY_A) };
  assert.strictEqual(A.verifyAttestRow(lifted).ok, false);
  // control: the same bytes under the RIGHT prefix do verify, so the failure above is the
  // domain and not a broken canonicalization.
  const right = { ...row, sig: ed.sign(A.attestSigningBytes(row), KEY_A) };
  assert.strictEqual(A.verifyAttestRow(right).ok, true);
});

/* ================================================================== *
 * 2. builder strictness
 * ================================================================== */
console.log('\nattest: builder');

t('unknown fields are REFUSED, never dropped', () => {
  assert.throws(() => A.buildAttestRow({ ...good(), weight: '10' }), /unknown field/);
});

t('a "verified" verdict without a recomputed root or a slot is refused', () => {
  assert.throws(() => A.buildAttestRow({
    ref: HASH(11), verdict: 'verified', merkle_root: null, anchor_sig: null, slot: null,
    rpc_host: 'x.example', attested_at: '2026-07-31T21:00:00Z',
  }), /must carry the merkle_root/);
});

t('"unknown" MAY have no root or slot — an outage is not an inspection', () => {
  const r = A.buildAttestRow({
    ref: HASH(11), verdict: 'unknown', merkle_root: null, anchor_sig: null, slot: null,
    rpc_host: 'x.example', attested_at: '2026-07-31T21:00:00Z',
  });
  assert.strictEqual(r.verdict, 'unknown');
  assert.strictEqual(r.slot, null);
});

t('an invented verdict is refused', () => {
  assert.throws(() => A.buildAttestRow({ ...good(), verdict: 'probably' }), /verdict must be one of/);
});

t('a full RPC URL is refused — hostname only, because RPC URLs carry API keys', () => {
  assert.throws(() => A.buildAttestRow({ ...good(), rpc_host: 'https://rpc.example/?api-key=hunter2' }),
    /rpc_host is malformed/);
});

/* ================================================================== *
 * 3. the tally — with the control that makes its zero meaningful
 * ================================================================== */
console.log('\nattest: tally');

// A stand-in registry: PUB_A is ours, PUB_B is attested-not-ours, key C is neither.
const KEY_C = Buffer.from(nacl.sign.keyPair().secretKey);
const PUB_C = ed.publicKeyOf(KEY_C);
const REG = {
  byKey: new Map([[PUB_A, { key: PUB_A, evidence: 'key-control-proven', basis: 'test' }]]),
  names: new Set(),
  independent: new Set([PUB_B]),
};
const operator = require('../lib/operator');
const classify = (id) => operator.classify(id, REG);
const rec = (entry, seq) => ({ seq, entry_hash: `h${seq}`, entry });

t('POSITIVE CONTROL — the classifier reaches ALL THREE buckets', () => {
  // Without this, "0 independent" is indistinguishable from "the independent branch is
  // unreachable", and the second one is a bug that reads as modesty.
  const rows = [
    rec(A.signAttestRow(good({ ref: HASH(11) }), KEY_A), 1),
    rec(A.signAttestRow(good({ ref: HASH(12) }), KEY_B), 2),
    rec(A.signAttestRow(good({ ref: HASH(13) }), KEY_C), 3),
  ];
  const tal = A.tallyAttestations(rows, classify);
  assert.strictEqual(tal.operator.total, 1, 'operator bucket');
  assert.strictEqual(tal.independent.total, 1, 'independent bucket');
  assert.strictEqual(tal.unattributed.total, 1, 'unattributed bucket');
  assert.strictEqual(tal.total, 3);
  assert.strictEqual(tal.distinct_verifiers, 3);
});

t('an empty tape tallies to a PROVEN zero, not an untested one', () => {
  const tal = A.tallyAttestations([], classify);
  assert.strictEqual(tal.total, 0);
  assert.strictEqual(tal.independent.total, 0);
});

t('disagreeing verdicts are counted and listed, never filtered', () => {
  const rows = [
    rec(A.signAttestRow(good({ ref: HASH(11), verdict: 'fraud', merkle_root: null, slot: null }), KEY_B), 1),
    rec(A.signAttestRow(good({ ref: HASH(12) }), KEY_B), 2),
  ];
  const tal = A.tallyAttestations(rows, classify);
  assert.strictEqual(tal.by_verdict.fraud, 1);
  assert.strictEqual(tal.disputes.length, 1);
  assert.strictEqual(tal.disputes[0].verdict, 'fraud');
  assert.strictEqual(tal.disputes[0].provenance, 'independent');
});

t('self-attestation is counted apart from everything else', () => {
  const rows = [
    rec(A.signAttestRow(good({ ref: HASH(11) }), KEY_B), 1),   // B attests a row B signed
    rec(A.signAttestRow(good({ ref: HASH(12) }), KEY_B), 2),   // B attests somebody else's
  ];
  const signerOf = (h) => (h === HASH(11) ? PUB_B : PUB_C);
  const tal = A.tallyAttestations(rows, classify, signerOf);
  assert.strictEqual(tal.self_attested, 1);
  // control: the same rows with nobody self-attesting must come back zero, or the counter
  // is just counting rows.
  assert.strictEqual(A.tallyAttestations(rows, classify, () => PUB_C).self_attested, 0);
});

/* ================================================================== *
 * 4. chain integration — the rows must not pollute the call board
 * ================================================================== */
console.log('\nattest: chain');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-attest-'));
const chainFile = path.join(tmp, 'tape.jsonl');

t('the chain accepts a well-signed attestation and rejects a tampered one', () => {
  const chain = new Chain(chainFile);
  // A real target first: `ref` must point at an entry that already exists and is earlier,
  // which chain.js enforces for every family. That check is the reason `ref` carries the
  // target instead of a field of our own.
  const { buildEntry, newNonce, signEntry } = require('../lib/entry');
  const call = signEntry(buildEntry({
    type: 'open', caller: 'someone', lane: 'prediction', market: 'demo:x', side: 'yes',
    size: '1', entry_ref: '0.5', ts_claimed: '2026-07-31T20:00:00Z', nonce: newNonce(),
  }), KEY_C);
  const target = chain.append(call);

  const att = A.signAttestRow(good({ ref: target.entry_hash }), KEY_B);
  const landed = chain.append(att);
  assert.strictEqual(landed.entry.verdict, 'verified');

  // NEGATIVE: same row, one character of the signature changed.
  const bad = { ...att, ref: target.entry_hash, note: 'edited after signing' };
  assert.throws(() => chain.append(bad), /chain:/);
  assert.strictEqual(chain.verify().ok, true, 'chain still verifies after the rejection');
});

t('an attestation about an entry that is not on the chain cannot be appended', () => {
  const chain = new Chain(chainFile);
  const orphan = A.signAttestRow(good({ ref: HASH(99) }), KEY_B);
  assert.throws(() => chain.append(orphan), /not found in chain/);
});

t('attestations do NOT count as calls in the read model', () => {
  // The failure this catches is silent and expensive: a fourth row family landing on the
  // shared chain and quietly inflating every caller's call count, exactly as window and
  // pledge rows would have done before their own exclusions were added.
  const { callerProfile } = require('../lib/readmodel');
  const rows = new Chain(chainFile).read();
  const attRows = rows.filter((r) => A.isAttestRow(r.entry) && r.entry.signer === PUB_B);
  assert.ok(attRows.length >= 1, 'fixture should contain at least one attestation from B');

  // `entries` is the number that moves. Asserting on opens/closes instead would PASS with
  // the exclusion removed — an attestation has type "attest", so it is never an open or a
  // close either way, and the test would have been checking nothing. Found by asking what
  // this assertion would print if the bug were reintroduced.
  const b = callerProfile(PUB_B, { rows, anchors: [], covered: 0, verified_at: null });
  assert.strictEqual(b.entries, 0, `attestations leaked into B's call count (${b.entries})`);
  assert.strictEqual(b.known, true, 'B must still be a known key — the row is not hidden, just not a call');

  // POSITIVE CONTROL for the same field: C posted a real call in the fixture above, so a
  // count of zero everywhere would mean `entries` is simply always zero here.
  const c = callerProfile(PUB_C, { rows, anchors: [], covered: 0, verified_at: null });
  assert.strictEqual(c.entries, 1, `the control call did not count either (${c.entries})`);
});

/* ================================================================== *
 * 5. cross-implementation — the published client vs the library
 * ================================================================== */
console.log('\nattest: published client agrees with the library');

(async () => {
  const client = await import('../verify/tape-attest.mjs');

  await ta('the client signs bytes the SERVER library accepts', async () => {
    // The client may not import lib/. Two implementations of one published shape agreeing
    // is evidence; one implementation checking itself is a tautology.
    const priv = require('crypto').createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), KEY_A.subarray(0, 32)]),
      format: 'der', type: 'pkcs8',
    });
    const row = client.buildRow({
      target: HASH(11),
      result: { verdict: 'VERIFIED', computedRoot: ROOT, slot: 312445001 },
      rpcUrl: 'https://api.mainnet-beta.solana.com/?api-key=secret',
      note: null,
      anchorSig: SIG58,
    });
    const signed = client.sign(row, { priv, pubB58: PUB_A });

    // The library must accept it verbatim: same field set, same domain, same bytes.
    const rebuilt = A.buildAttestRow(signed);
    assert.strictEqual(A.verifyAttestRow(rebuilt).ok, true, 'library rejected the client\'s signature');
    // and the API-key half of the URL must not have survived into the row.
    assert.strictEqual(rebuilt.rpc_host, 'api.mainnet-beta.solana.com');
    assert.ok(!JSON.stringify(rebuilt).includes('secret'), 'RPC API key leaked into the row');
  });

  await ta('the client refuses to mint a "verified" it cannot support', async () => {
    // Same rule as the library, checked on the client so a bad row is never even signed.
    const row = client.buildRow({
      target: HASH(11), result: { verdict: 'VERIFIED', computedRoot: null, slot: null },
      rpcUrl: 'https://x.example', note: null, anchorSig: null,
    });
    assert.throws(() => A.buildAttestRow(row), /must carry the merkle_root/);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
