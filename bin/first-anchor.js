#!/usr/bin/env node
'use strict';
/**
 * first-anchor.js — the genesis anchor of the TAPE record.
 *
 * WHY THE FIRST ENTRIES ARE PREDICTIONS ABOUT MY OWN WORK:
 * The obvious demo is a couple of made-up memecoin calls. That would be fabricating a
 * track record on a system built to make track records unfabricable — the auto-poster
 * failure in a new costume. So the genesis entries are real, falsifiable predictions
 * with a public resolution source (the GitHub API), and they are predictions about work
 * I do not control the outcome of. If they resolve against me, they stay on the tape.
 *
 * Cost control: this builds a transaction containing ONE memo instruction and no
 * transfer of any kind, so the maximum possible spend is the network fee.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const { buildEntry, entryBytes, newNonce } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { hashLeaf, buildTree, proveInclusion, verifyEntryInclusion } = require('../lib/merkle');
const { submitAnchor, fetchAnchor, anchorPayload } = require('../lib/anchor');

const SECURE = path.join(os.homedir(), '.config/cadence-secure');
const heliusKey = (() => {
  const k = JSON.parse(fs.readFileSync(path.join(SECURE, 'helius.json'), 'utf8'));
  return k.api_key || k.key || k.apiKey || Object.values(k).find((v) => typeof v === 'string' && v.length > 20);
})();
const RPC = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
const CHAIN_FILE = path.join(__dirname, '..', 'data', 'tape.jsonl');

const GENESIS_CALLS = [
  {
    lane: 'prediction', side: 'yes',
    market: 'github:TauCetiProject/TauCeti/pull/1283:merged_by:2026-08-07T00:00:00Z',
    size: '1', entry_ref: '0.80',
    note: 'PR #1283 (OrthogonalL2Bases completeness). mergeable_state clean, awaiting CI at post time. Resolution: GitHub API merged_at.',
  },
  {
    lane: 'prediction', side: 'yes',
    market: 'github:TauCetiProject/TauCeti/pull/1297:merged_by:2026-08-07T00:00:00Z',
    size: '1', entry_ref: '0.85',
    note: 'PR #1297 (Chebyshev Hilbert basis). All six review rubrics approved at post time. Resolution: GitHub API merged_at.',
  },
];

(async () => {
  const dry = process.argv.includes('--dry-run');

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.TAPE_KEY || path.join(SECURE, 'tape-anchor-key.json'), 'utf8')))
  );
  const conn = new Connection(RPC, 'confirmed');
  const before = await conn.getBalance(payer.publicKey);
  console.log(`payer  : ${payer.publicKey.toBase58()}`);
  console.log(`balance: ${before / LAMPORTS_PER_SOL} SOL`);

  const chain = new Chain(CHAIN_FILE);
  if (chain.read().length === 0) {
    for (const c of GENESIS_CALLS) {
      chain.append(buildEntry({
        type: 'open', caller: 'cadence-wave', ts_claimed: new Date().toISOString(),
        nonce: newNonce(), ...c,
      }));
    }
    console.log(`appended ${GENESIS_CALLS.length} genesis entries`);
  } else {
    console.log(`chain already has ${chain.read().length} entries — anchoring as-is`);
  }

  const v = chain.verify();
  if (!v.ok) throw new Error(`chain does not verify: ${JSON.stringify(v.errors)}`);
  console.log(`chain  : ${v.count} entries, verifies OK, head ${v.head.slice(0, 16)}…`);

  const rows = chain.read();
  const digests = rows.map((r) => hashLeaf(entryBytes(r.entry)));
  const tree = buildTree(digests);
  const root = tree.root.toString('hex');
  const payload = anchorPayload({ root, count: tree.count, chainHead: v.head });
  console.log(`root   : ${root}`);
  console.log(`payload: ${payload} (${Buffer.byteLength(payload)} bytes)`);

  if (dry) { console.log('\n--dry-run: nothing submitted'); return; }

  const res = await submitAnchor({ root, count: tree.count, chainHead: v.head, payer, cluster: RPC });
  console.log(`\nANCHORED  sig ${res.signature}`);
  console.log(`          slot ${res.slot}  blockTime ${res.blockTime} (${new Date(res.blockTime * 1000).toISOString()})`);

  // Read it back FROM CHAIN — checking our own copy against our own copy proves nothing.
  const back = await fetchAnchor(res.signature, RPC);
  const roundTrip = back.found && back.parsed && back.parsed.root === root
    && back.parsed.n === tree.count && back.parsed.head === v.head && !back.logMismatch;
  console.log(`round-trip from chain: ${roundTrip ? 'MATCH' : 'MISMATCH'}`);
  if (!roundTrip) throw new Error(`round-trip failed: ${JSON.stringify(back)}`);

  // And prove one entry is inside the anchored root, using only public data.
  const idx = 0;
  const ok = verifyEntryInclusion(entryBytes(rows[idx].entry), proveInclusion(tree, idx), back.parsed.root);
  console.log(`inclusion proof of entry 0 against the ON-CHAIN root: ${ok ? 'VALID' : 'INVALID'}`);
  if (!ok) throw new Error('inclusion proof failed against the on-chain root');

  const after = await conn.getBalance(payer.publicKey);
  console.log(`\nspent  : ${(before - after) / LAMPORTS_PER_SOL} SOL (${before - after} lamports)`);
  console.log(`balance: ${after / LAMPORTS_PER_SOL} SOL`);

  fs.writeFileSync(path.join(__dirname, '..', 'data', 'anchors.jsonl'),
    JSON.stringify({ signature: res.signature, slot: res.slot, blockTime: res.blockTime, root, count: tree.count, chainHead: v.head, cluster: 'mainnet' }) + '\n',
    { flag: 'a' });
  console.log(`explorer: https://solscan.io/tx/${res.signature}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
