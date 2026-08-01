'use strict';
/**
 * verifier-signature.test.js — prove the receipt verifier's FRAUD-on-bad-signature
 * branch is live code.
 *
 * WHY THIS NEEDED A MOCK CHAIN: every attempt to test that branch against the real tape
 * was caught earlier, by the Merkle root, because our own chain.js refuses to write an
 * entry whose signature does not verify. So the branch could have been dead and every
 * control would still have printed FRAUD — the "passes for the wrong reason" failure.
 *
 * The state it defends against is a HOSTILE OPERATOR'S tape: someone else runs TAPE,
 * anchors an entry carrying a forged signature, and hands you a receipt. Their root
 * matches their chain perfectly, so the inclusion proof passes. The signature is the only
 * thing left standing between you and a "verified" call from someone who never made it.
 *
 * So: a local RPC that serves a genuinely consistent anchor over a forged entry.
 */

const assert = require('assert');
const http = require('http');
const { canonicalize } = require('../lib/canonical');
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

/** A local RPC that serves ONE anchor transaction, consistent with whatever root we pass. */
function mockChain(root, count, head, blockTime = 1785270000, slot = 999999999) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { method } = JSON.parse(body);
      let result = null;
      if (method === 'getTransaction') {
        const memo = anchorPayload({ root, count, chainHead: head });
        // encoding:'json' — accountKeys are flat strings and instructions reference the
        // program by INDEX. (The first mock used the jsonParsed shape and the positive
        // control failed, which is the entire reason a positive control is here: without
        // it, all four negative controls would have "passed" against a broken mock.)
        result = {
          slot, blockTime,
          transaction: {
            message: {
              accountKeys: [PAYER, MEMO],
              instructions: [{ programIdIndex: 1, data: ed.b58encode(Buffer.from(memo, 'utf8')), accounts: [] }],
            },
          },
          meta: { err: null, logMessages: [] },
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

const A = Buffer.from(nacl.sign.keyPair().secretKey);
const B = Buffer.from(nacl.sign.keyPair().secretKey);
const mkCall = () => buildEntry({
  type: 'open', caller: 'victim', lane: 'prediction', market: 'demo:x', side: 'yes',
  size: '1', entry_ref: '0.5', ts_claimed: '2026-07-28T20:00:00Z', nonce: newNonce(),
});

/** Build a self-consistent receipt for `entry`, anchored on the mock chain. */
async function receiptFor(entry) {
  const leaves = [hashLeaf(entryBytes(entry))];
  const tree = buildTree(leaves);
  const root = tree.root.toString('hex');
  const { server, url } = await mockChain(root, 1, 'h'.repeat(64));
  const receipt = {
    entry,
    proof: proveInclusion(tree, 0).map((p) => ({ side: p.side, hash: p.hash.toString('hex') })),
    anchor: { signature: '5'.repeat(87), root, slot: 999999999 },
  };
  return { receipt, url, close: () => server.close() };
}

async function main() {
  const { verifyReceipt } = await import('../verify/tape-verify.mjs');

  console.log('\nreceipt verifier: the signature branch, isolated');

  await t('POSITIVE CONTROL: a correctly signed entry in a consistent batch VERIFIES', async () => {
    const { receipt, url, close } = await receiptFor(signEntry(mkCall(), A));
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'VERIFIED', JSON.stringify(r.reasons || r));
    assert.strictEqual(r.sigState.signed, true);
    assert.strictEqual(r.sigState.ok, true);
  });

  await t('an UNSIGNED entry verifies and is reported as unsigned, not as signed', async () => {
    const { receipt, url, close } = await receiptFor(mkCall());
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'VERIFIED');
    assert.strictEqual(r.sigState.signed, false);
  });

  await t('NEGATIVE CONTROL: a forged signature in a CONSISTENT batch is FRAUD', async () => {
    // The whole point: the inclusion proof passes, the root matches the chain, and the
    // only thing wrong is that this key never signed these bytes.
    const signed = signEntry(mkCall(), A);
    const forged = { ...signed, signer: ed.publicKeyOf(B) };
    const { receipt, url, close } = await receiptFor(forged);
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'FRAUD', 'a forged attribution inside a valid batch must be FRAUD');
    assert.match(r.reasons.join(' '), /signature is invalid/);
    assert.strictEqual(r.sigState.ok, false);
  });

  await t('NEGATIVE CONTROL: a stripped signature in a consistent batch is FRAUD, not "unsigned"', async () => {
    const signed = signEntry(mkCall(), A);
    const { receipt, url, close } = await receiptFor({ ...signed, sig: null });
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'FRAUD');
    assert.match(r.reasons.join(' '), /signer and sig must both be present/);
  });

  await t('NEGATIVE CONTROL: a signature over DIFFERENT content is FRAUD', async () => {
    const signed = signEntry(mkCall(), A);
    const other = signEntry(mkCall(), A);
    const { receipt, url, close } = await receiptFor({ ...signed, sig: other.sig });
    const r = await verifyReceipt(receipt, { rpcUrl: url });
    close();
    assert.strictEqual(r.verdict, 'FRAUD');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main();
