#!/usr/bin/env node
/**
 * tape-history.mjs — does TODAY'S tape still reproduce EVERY root we ever published?
 *
 * WHY THIS EXISTS. Specie, Colony, 2026-07-29:
 *
 *   "If the verifier accepts the count without validating the continuity of the sequence
 *    against the previous root, we aren't just looking at a missing check; we're looking
 *    at a potential state desync where the anchor can be decoupled from the actual leaf
 *    density. Does the current commitment structure allow for a valid proof of a subset
 *    that bypasses the global seq increment?"
 *
 * The answer was: every check we had was POINTWISE. `tape-verify.mjs` proves one entry sat
 * under one root. `tape-promise.mjs` proves one promised index was kept. Both are correct
 * and neither of them looks at the sequence OF ANCHORS. So nothing in the system compared
 * anchor N to anchor N+1, and nothing forced the leaf set to keep growing by inclusion.
 *
 * That gap is real and this closes it. Anchors are cumulative by construction: anchor N
 * commits a root over the first `count_N` entries of the chain, in order. So a tape that
 * has never been rewritten must reproduce EVERY historical root from its own current
 * contents. If entry 7 was deleted, reordered, or edited after anchor N covered it, then
 * rebuilding the first `count_N` leaves today yields a different root — and root_N is on
 * Solana, where we cannot reach it.
 *
 * WHAT A FAILURE MEANS. Not "a bug". The published tape is not the tape that was anchored.
 * That is the one accusation this whole system exists to make checkable, so it prints loud
 * and exits non-zero.
 *
 * WHAT THIS DOES NOT PROVE. It compares a tape against roots. Run with `--rpc` and it
 * fetches those roots FROM SOLANA, which is the version that means something — anything
 * else is checking our anchor file against our tape file, both of which are ours. It also
 * cannot see an entry that was accepted and never anchored at all; that is a different
 * attack with a different instrument (`tape-promise.mjs`, which reads the signed deadline).
 *
 * Independent by the same rules as tape-verify.mjs: no imports from ../lib, no npm
 * dependencies, and the only network call is to an RPC the caller chooses.
 *
 *   node tape-history.mjs <tape.jsonl> <anchors.jsonl>            # local roots
 *   node tape-history.mjs <tape.jsonl> <anchors.jsonl> --rpc      # roots read from Solana
 *
 * exit 0 = every root reproduces · 1 = REWRITTEN · 2 = could not determine
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/* -- canonical bytes: reimplemented, never imported (see header) ----------- */
function canonicalize(value, path = '$') {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') throw new Error(`raw number at ${path}: quantities must be strings`);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  if (t === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k], `${path}.${k}`)).join(',') + '}';
  }
  throw new Error(`unserialisable ${t} at ${path}`);
}

const sha256 = (...b) => createHash('sha256').update(Buffer.concat(b)).digest();
const hashLeaf = (buf) => sha256(Buffer.from([0x00]), buf);
const hashNode = (l, r) => sha256(Buffer.from([0x01]), l, r);

/**
 * Merkle root over leaves.
 *
 * ODD TAIL IS PROMOTED, NOT DUPLICATED. The first draft of this file duplicated it — the
 * conventional shortcut — and reported REWRITTEN on 23 of 26 honest roots. A verifier
 * whose default failure is a false accusation is worse than no verifier, so: an unpaired
 * node moves up unchanged. Duplication also admits the classic second-preimage trick where
 * a tree of n leaves and one of n+1 share a root.
 */
function rootOf(leaves) {
  if (leaves.length === 0) return sha256(Buffer.from('tape:empty:v1', 'utf8')).toString('hex');
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashNode(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0].toString('hex');
}

const entryBytes = (entry) => Buffer.from(canonicalize(entry), 'utf8');

/* -- chain shape ----------------------------------------------------------- */
const GENESIS = '0'.repeat(64);
// The link commits (prev, seq, entry_hash) through the SAME canonicalizer as everything
// else, not by concatenating bytes. Guessing at this was the other half of the first
// draft's false accusation.
const linkHash = (prev, seq, entryHashHex) =>
  createHash('sha256').update(canonicalize({ prev, seq: String(seq), entry: entryHashHex }), 'utf8').digest('hex');

function readJsonl(file) {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/* -- roots from Solana ----------------------------------------------------- */
async function rootFromChain(signature) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }),
  });
  const j = await res.json();
  const tx = j.result;
  if (!tx) return null;
  const ins = (tx.transaction?.message?.instructions || [])
    .find((i) => i.programId === MEMO_PROGRAM_ID || i.program === 'spl-memo');
  if (!ins) return null;
  const memo = typeof ins.parsed === 'string' ? ins.parsed : (ins.parsed?.info?.memo ?? null);
  if (!memo) return null;
  try {
    const p = JSON.parse(memo);
    // The on-chain field is `n`, not `count`. Guessing it produced `count: NaN`, which
    // compared unequal to every honest anchor and printed REWRITTEN 26 times on a clean
    // tape. Reading a field name wrong and reading a rewritten tape look identical from
    // the outside, which is exactly why a verifier has to be run against a known-good
    // input before its accusations are worth anything.
    const n = p.n ?? p.count;
    if (p.root === undefined || n === undefined) return null;
    return { root: p.root, count: Number(n), head: p.head ?? null, slot: tx.slot };
  } catch { return null; }
}

/* -- main ------------------------------------------------------------------ */
const [tapeFile, anchorFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const useRpc = process.argv.includes('--rpc');
if (!tapeFile || !anchorFile) {
  console.error('usage: tape-history.mjs <tape.jsonl> <anchors.jsonl> [--rpc]');
  process.exit(2);
}

let rows, anchors;
try {
  rows = readJsonl(tapeFile);
  anchors = readJsonl(anchorFile).sort((a, b) => a.slot - b.slot);
} catch (e) {
  console.log(`CANNOT DETERMINE: ${e.message}`);
  process.exit(2);
}

console.log(`tape: ${rows.length} entries · anchors: ${anchors.length}${useRpc ? ' · roots read FROM SOLANA' : ' · roots read from the local anchor file'}`);
if (!useRpc) {
  console.log('NOTE: without --rpc this compares our tape against our anchor file — both ours.');
  console.log('      The version that means something is: tape-history.mjs ... --rpc');
}

// Chain shape first. A root can only be meaningful over a dense, linked sequence; if seq
// is not the index, "the first N entries" does not name a well-defined set.
const shape = [];
let prev = GENESIS;
rows.forEach((r, i) => {
  if (r.seq !== i) shape.push(`seq ${i}: stored seq is ${r.seq} — the sequence is not dense`);
  if (r.prev !== prev) shape.push(`seq ${i}: prev does not match the previous link`);
  const eHash = createHash('sha256').update(entryBytes(r.entry)).digest('hex');
  if (eHash !== r.entry_hash) shape.push(`seq ${i}: entry_hash does not match the entry content`);
  if (linkHash(r.prev, r.seq, r.entry_hash) !== r.link) shape.push(`seq ${i}: link hash does not match`);
  prev = r.link;
});

const leaves = rows.map((r) => hashLeaf(entryBytes(r.entry)));

let rewritten = 0, unknown = 0, ok = 0;
for (const a of anchors) {
  let claimed = { root: a.root, count: a.count };
  if (useRpc) {
    const onChain = await rootFromChain(a.signature);
    if (!onChain || !onChain.root) {
      console.log(`  ?  slot ${a.slot}  could not read the memo from chain — NOT evidence either way`);
      unknown++;
      continue;
    }
    if (onChain.root !== a.root || onChain.count !== a.count) {
      console.log(`  ✗  slot ${a.slot}  THE ANCHOR FILE DISAGREES WITH SOLANA`);
      console.log(`       on chain: root ${onChain.root} count ${onChain.count}`);
      console.log(`       local   : root ${a.root} count ${a.count}`);
      rewritten++;
      continue;
    }
    claimed = onChain;
  }

  if (claimed.count > rows.length) {
    // The committed leaf count exceeds what the tape now holds: entries that were anchored
    // are no longer published. This is the subset attack seen from the other side.
    console.log(`  ✗  slot ${a.slot}  committed ${claimed.count} leaves, the tape now holds ${rows.length}`);
    console.log('       ENTRIES THAT WERE ANCHORED ARE MISSING FROM THE PUBLISHED TAPE.');
    rewritten++;
    continue;
  }
  const rebuilt = rootOf(leaves.slice(0, claimed.count));
  if (rebuilt === claimed.root) { ok++; continue; }
  console.log(`  ✗  slot ${a.slot}  root does NOT reproduce from the first ${claimed.count} entries`);
  console.log(`       committed: ${claimed.root}`);
  console.log(`       rebuilt  : ${rebuilt}`);
  rewritten++;
}

console.log('');
if (shape.length) {
  console.log('CHAIN SHAPE BROKEN:');
  for (const s of shape.slice(0, 20)) console.log(`  - ${s}`);
}

if (rewritten > 0 || shape.length > 0) {
  console.log(`REWRITTEN — ${rewritten} of ${anchors.length} published roots do not reproduce from this tape.`);
  console.log('The tape being served is not the tape that was anchored. Every anchored root is on');
  console.log('Solana; whoever published this file cannot reach them.');
  process.exit(1);
}
if (unknown > 0 && ok === 0) {
  console.log(`CANNOT DETERMINE — ${unknown} anchors unreadable, none confirmed.`);
  process.exit(2);
}
console.log(`CONTINUOUS — all ${ok} readable roots reproduce from this tape, in order, with no gaps.`);
console.log('Every anchor commits the first N entries; each rebuilt from the tape as it stands now.');
if (unknown) console.log(`(${unknown} anchors could not be read; they are neither confirmed nor refuted.)`);
process.exit(0);
