'use strict';
/**
 * receipt-tight.test.js — the `tightest` bound is a real, independently checkable proof,
 * not a claim.
 *
 * cold-read finding #4.1 (2026-08-07): a receipt's `tightest` field named an earlier slot
 * but carried no proof, and `tape-verify.mjs` never read it at all — the verifier printed
 * "no later than" the LATEST anchor slot even when a much tighter, true bound was sitting
 * unused in the same JSON file. The default check still verifies against the latest anchor
 * (2026-08-05, Jiggy's call: the latest anchor is always fresh and verifies on any RPC,
 * pruned or not) — `tightest` is a BONUS, independently provable claim on top of that, and
 * this file is what makes it provable rather than just present.
 *
 * Same mock-RPC pattern as verifier-signature.test.js: a local server that serves whichever
 * anchor transaction the test asks for, so no real network call is needed.
 */

const assert = require('assert');
const http = require('http');
const { buildEntry, newNonce, signEntry, entryBytes } = require('../lib/entry');
const { hashLeaf, buildTree, proveInclusion } = require('../lib/merkle');
const { anchorPayload } = require('../lib/anchor');
const ed = require('../lib/ed25519');
const nacl = require('tweetnacl');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PAYER = '6QRMCBTjVyggsPrhvrhWVaPwXW7HEbsjLeuNSAMq8xTy';

/** A local RPC that serves ONE anchor tx per known signature, 404s (empty result) otherwise. */
function mockChain(anchorsBySignature) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { method, params } = JSON.parse(body);
      let result = null;
      if (method === 'getTransaction') {
        const sig = params[0];
        const a = anchorsBySignature.get(sig);
        if (a) {
          const memo = anchorPayload({ root: a.root, count: a.count, chainHead: a.head });
          result = {
            slot: a.slot, blockTime: a.blockTime,
            transaction: {
              message: {
                accountKeys: [PAYER, MEMO],
                instructions: [{ programIdIndex: 1, data: ed.b58encode(Buffer.from(memo, 'utf8')), accounts: [] }],
              },
            },
            meta: { err: null, logMessages: [] },
          };
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const A = Buffer.from(nacl.sign.keyPair().secretKey);
const mkCall = (n) => buildEntry({
  type: 'open', caller: 'victim', lane: 'prediction', market: `demo:${n}`, side: 'yes',
  size: '1', entry_ref: '0.5', ts_claimed: '2026-07-28T20:00:00Z', nonce: newNonce(),
});

/**
 * Two anchors covering the same entry, exactly like receipt.js's earliest/latest split:
 * the entry is leaf 0 in a small early batch, then re-committed in a bigger later batch
 * that also includes a second entry. Two DIFFERENT roots, two DIFFERENT proofs for the
 * same leaf, which is the whole reason `tightest` needs its own proof.
 */
async function twoAnchorReceipt() {
  const entry = signEntry(mkCall('a'), A);
  const entry2 = signEntry(mkCall('b'), A);
  const entry3 = signEntry(mkCall('c'), A);
  const leaf0 = hashLeaf(entryBytes(entry));
  const leaf1 = hashLeaf(entryBytes(entry2));
  const leaf2 = hashLeaf(entryBytes(entry3));

  // Early batch already has TWO leaves (so the inclusion proof has a real sibling to
  // corrupt in the negative test below) — a one-leaf tree's proof is empty and its root
  // is just the leaf digest, which would make that test vacuous.
  const earlyTree = buildTree([leaf0, leaf1]);
  const earlyProof = proveInclusion(earlyTree, 0);
  const earlyRoot = earlyTree.root.toString('hex');
  const earlySig = 'E'.repeat(87);

  const lateTree = buildTree([leaf0, leaf1, leaf2]);
  const lateProof = proveInclusion(lateTree, 0);
  const lateRoot = lateTree.root.toString('hex');
  const lateSig = 'L'.repeat(87);

  const anchorsBySignature = new Map([
    [earlySig, { root: earlyRoot, count: 2, head: 'h'.repeat(64), slot: 1000, blockTime: 1000 }],
    [lateSig, { root: lateRoot, count: 3, head: 'h'.repeat(64), slot: 2000, blockTime: 2000 }],
  ]);
  const { server, url } = await mockChain(anchorsBySignature);

  const receipt = {
    entry,
    proof: lateProof.map((p) => ({ side: p.side, hash: p.hash.toString('hex') })),
    anchor: { signature: lateSig, root: lateRoot, slot: 2000 },
    tightest: { slot: 1000, signature: earlySig, root: earlyRoot,
      proof: earlyProof.map((p) => ({ side: p.side, hash: p.hash.toString('hex') })) },
  };
  return { receipt, url, close: () => server.close(), earlySig, earlyRoot };
}

async function main() {
  const { verifyReceipt, checkTightest } = await import('../verify/tape-verify.mjs');

  console.log('\nreceipt tight bound: independently checkable, not just claimed');

  await t('POSITIVE: a genuine tightest proof CONFIRMS against its own anchor tx', async () => {
    const { receipt, url, close } = await twoAnchorReceipt();
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'VERIFIED');
    assert.ok(r.tight, 'result must carry a tight field when receipt.tightest is present');
    assert.strictEqual(r.tight.confirmed, true, JSON.stringify(r.tight));
    assert.strictEqual(r.tight.slot, 1000);
    assert.ok(r.tight.slot < r.slot, 'the tight bound must be strictly earlier than the default bound');
  });

  await t('no tightest field on the receipt -> tight is null, verdict unaffected', async () => {
    const { receipt, url, close } = await twoAnchorReceipt();
    delete receipt.tightest;
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'VERIFIED');
    assert.strictEqual(r.tight, null);
  });

  await t('tightest present but no proof -> reported unconfirmed, primary verdict still VERIFIED', async () => {
    const { receipt, url, close } = await twoAnchorReceipt();
    receipt.tightest = { slot: 1000, signature: receipt.tightest.signature }; // old bare shape, no proof
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'VERIFIED', 'a bad tight claim must never sink the primary verdict');
    assert.strictEqual(r.tight.confirmed, false);
    assert.match(r.tight.note, /no proof/);
  });

  await t('NEGATIVE: a tightest proof that does not reconstruct its claimed root is caught, not trusted', async () => {
    const { receipt, url, close } = await twoAnchorReceipt();
    // Corrupt one sibling hash so the proof no longer walks to receipt.tightest.root.
    receipt.tightest.proof = receipt.tightest.proof.map((s) => ({ ...s, hash: '0'.repeat(64) }));
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'VERIFIED', 'a broken tight proof must not sink the primary verdict either');
    assert.strictEqual(r.tight.confirmed, false);
    assert.match(r.tight.note, /does not reconstruct/);
  });

  await t('NEGATIVE: chain root disagrees with the claimed tightest.root -> unconfirmed, not silently trusted', async () => {
    const { receipt, url, close } = await twoAnchorReceipt();
    receipt.tightest.root = '1'.repeat(64) === receipt.tightest.root ? '2'.repeat(64) : '1'.repeat(64);
    // Proof was built for the ORIGINAL root; forging both root and proof consistently would
    // just be the positive-control case again, so this exercises the on-chain cross-check
    // via checkTightest directly against the real (unmodified) proof/root pairing mismatch.
    const bad = { ...receipt, tightest: { ...receipt.tightest } };
    const tight = await checkTightest(bad, url);
    close();
    assert.strictEqual(tight.confirmed, false);
  });

  await t('tight-anchor tx not found on this RPC (pruned) -> unconfirmed, never FRAUD', async () => {
    const { receipt, url, close } = await twoAnchorReceipt();
    receipt.tightest.signature = 'X'.repeat(87); // not in the mock's known-signature map
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'VERIFIED');
    assert.strictEqual(r.tight.confirmed, false);
    assert.match(r.tight.note, /not found|pruned/);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main();
