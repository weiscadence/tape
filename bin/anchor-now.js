#!/usr/bin/env node
'use strict';
/**
 * anchor-now.js — anchor the current chain state. This is the body the interval daemon
 * will call; keeping it a standalone command means the daemon adds scheduling and
 * nothing else, and the anchoring path can be exercised by hand at any time.
 *
 * An anchor is submitted even when no new calls arrived. "Nothing happened this
 * interval" is itself a statement worth committing: a gap in the anchor series would
 * otherwise be ambiguous between a quiet market and a suppressed one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const { entryBytes } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { hashLeaf, buildTree, proveInclusion, verifyEntryInclusion } = require('../lib/merkle');
const { submitAnchor, fetchAnchor } = require('../lib/anchor');
const { gateEntries } = require('../lib/resolve');

const SECURE = path.join(os.homedir(), '.config/cadence-secure');
const heliusKey = (() => {
  const k = JSON.parse(fs.readFileSync(path.join(SECURE, 'helius.json'), 'utf8'));
  return k.api_key || k.key || k.apiKey || Object.values(k).find((v) => typeof v === 'string' && v.length > 20);
})();
const RPC = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
const DATA = path.join(__dirname, '..', 'data');

async function anchorNow({ dry = false } = {}) {
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(SECURE, 'faucet-wallet.json'), 'utf8')))
  );
  const conn = new Connection(RPC, 'confirmed');
  const before = await conn.getBalance(payer.publicKey);

  const chain = new Chain(path.join(DATA, 'tape.jsonl'));
  const v = chain.verify();
  if (!v.ok) throw new Error(`refusing to anchor a chain that does not verify: ${JSON.stringify(v.errors)}`);

  const rows = chain.read();

  // THE T0.1 GATE — runs at ANCHOR time, not at post time.
  // The genesis batch was written at 20:13Z and anchored at 20:36Z, and #1297 resolved in
  // that gap. Checking only when the entry is written would not have caught it; the
  // window that matters is the one closing right now.
  //
  // Entries already amended as void are exempt: the record has already disclosed them,
  // and refusing forever would mean the tape could never be anchored again — a mistake
  // must be recordable, not fatal.
  const voided = new Set(rows.filter((r) => r.entry.type === 'amend'
    && /VOID FOR RANKING/.test(r.entry.note || '')).map((r) => r.entry.ref));
  const gateable = rows.filter((r) => !voided.has(r.entry_hash));
  const gate = await gateEntries(gateable);
  if (!gate.ok) {
    console.error('REFUSING TO ANCHOR — T0.1 violation(s):');
    gate.refusals.forEach((x) => console.error(`  seq ${x.seq}: ${x.reason}`));
    throw new Error('one or more entries were already resolved before anchoring; amend them as void or drop them');
  }
  console.log(`gate  : ${gateable.length} entries checked, none already-resolved (${voided.size} previously voided, exempt)`);
  const digests = rows.map((r) => hashLeaf(entryBytes(r.entry)));
  const tree = buildTree(digests);
  const root = tree.root.toString('hex');

  console.log(`chain : ${v.count} entries, verifies OK`);
  console.log(`root  : ${root}`);
  if (dry) { console.log('--dry-run: nothing submitted'); return null; }

  const res = await submitAnchor({ root, count: tree.count, chainHead: v.head, payer, cluster: RPC });
  console.log(`sig   : ${res.signature}`);
  console.log(`slot  : ${res.slot}   blockTime: ${res.blockTime} (${new Date(res.blockTime * 1000).toISOString()})`);

  const back = await fetchAnchor(res.signature, RPC);
  const match = back.found && back.parsed
    && back.parsed.root === root && back.parsed.n === tree.count
    && back.parsed.head === v.head && !back.logMismatch;
  console.log(`round-trip from chain: ${match ? 'MATCH' : 'MISMATCH'}`);
  if (!match) throw new Error(`round-trip failed: ${JSON.stringify(back)}`);

  // Prove the NEWEST entry is inside the anchored root — that is the one whose
  // inclusion a caller would actually dispute.
  const last = rows.length - 1;
  const ok = verifyEntryInclusion(entryBytes(rows[last].entry), proveInclusion(tree, last), back.parsed.root);
  console.log(`inclusion proof of newest entry vs ON-CHAIN root: ${ok ? 'VALID' : 'INVALID'}`);
  if (!ok) throw new Error('inclusion proof failed against the on-chain root');

  const after = await conn.getBalance(payer.publicKey);
  console.log(`spent : ${(before - after) / LAMPORTS_PER_SOL} SOL   balance: ${after / LAMPORTS_PER_SOL} SOL`);

  fs.appendFileSync(path.join(DATA, 'anchors.jsonl'), JSON.stringify({
    signature: res.signature, slot: res.slot, blockTime: res.blockTime,
    root, count: tree.count, chainHead: v.head, cluster: 'mainnet',
  }) + '\n');
  console.log(`explorer: https://solscan.io/tx/${res.signature}`);
  return res;
}

if (require.main === module) {
  anchorNow({ dry: process.argv.includes('--dry-run') })
    .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { anchorNow, RPC, DATA };
