#!/usr/bin/env node
'use strict';
/**
 * receipt.js — export a self-contained receipt for one entry.
 *
 * This is the producer side of the split: this file (ours) emits, and
 * verify/tape-verify.mjs (which imports nothing of ours and calls nothing of ours)
 * checks. The receipt is the entire handoff. Once a caller holds one, they never need
 * this repo, this box, or us again — that is the point, and it is why the receipt
 * carries the full entry rather than a lookup id. An id would make the record queryable
 * only through whoever holds the database.
 *
 * WHICH ANCHOR (changed 2026-08-05, Jiggy's call): verify against the LATEST covering
 * anchor, and carry the EARLIEST as `tightest`. Anchors are cumulative, so any anchor
 * after an entry contains it. The earliest gives the tightest "no later than" bound — but
 * it is also the one most likely to be PRUNED off cheap public RPC nodes (publicnode drops
 * history after ~2 days), which made honest old receipts read "can't tell" for a verifier
 * on a free node. The newest anchor is always fresh, so it verifies on ANY node, green or
 * red, never amber. We keep the tight bound as a claim (`tightest`) that anyone with an
 * archival node can still confirm — nothing is lost, the default check just always completes.
 */

const fs = require('fs');
const path = require('path');

const { entryBytes } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { hashLeaf, buildTree, proveInclusion, verifyEntryInclusion } = require('../lib/merkle');

const { DATA_DIR: DATA } = require('../lib/datadir');

function loadAnchors() {
  return fs.readFileSync(path.join(DATA, 'anchors.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => a.slot - b.slot);
}

function buildReceipt(selector) {
  const chain = new Chain(path.join(DATA, 'tape.jsonl'));
  const v = chain.verify();
  if (!v.ok) throw new Error(`local chain does not verify: ${JSON.stringify(v.errors)}`);
  const rows = chain.read();

  const anchors = loadAnchors();

  // "latest" means the newest entry THAT AN ANCHOR ALREADY COVERS, not simply the last
  // row. The obvious reading picks up an entry posted seconds ago that no anchor has
  // reached yet, so the automated pipeline would fail on a perfectly healthy tape and
  // the failure would look like a verification problem rather than a timing one.
  const covered = anchors.length ? Math.max(...anchors.map((a) => a.count)) : 0;
  const idx = selector === 'latest'
    ? covered - 1
    : /^[0-9]+$/.test(String(selector))
      ? Number(selector)
      : rows.findIndex((r) => r.entry_hash === selector);

  if (selector === 'latest' && idx < 0) {
    throw new Error('no entry is anchored yet, so there is nothing to make a receipt for');
  }
  if (idx < 0 || idx >= rows.length) throw new Error(`no entry for selector ${selector}`);
  const row = rows[idx];

  const covering = anchors.filter((a) => a.count > idx);
  const anchor = covering[covering.length - 1];   // LATEST: always fresh, verifies on any node
  const earliest = covering[0];                    // tightest provable bound, may be pruned
  if (!anchor) {
    throw new Error(
      `entry ${idx} (${row.entry_hash}) is not covered by any anchor yet. ` +
      `An unanchored entry has no receipt BY DESIGN — until it is on chain there is ` +
      `nothing to check it against, and emitting a receipt would imply otherwise.`
    );
  }

  // The tree must be rebuilt over exactly the entries that were in the batch at anchor
  // time — the first `anchor.count` rows — or the proof will not reconstruct that root.
  const tree = buildTree(rows.slice(0, anchor.count).map((r) => hashLeaf(entryBytes(r.entry))));
  const proof = proveInclusion(tree, idx);

  // Refuse to hand out a receipt we cannot verify ourselves. A broken receipt would fail
  // in the recipient's verifier and read as OUR fraud, which is exactly the accusation
  // this system is built to make unfalsifiable in both directions.
  if (!verifyEntryInclusion(entryBytes(row.entry), proof, anchor.root)) {
    throw new Error(`refusing to emit: proof for entry ${idx} does not reconstruct anchor root ${anchor.root}`);
  }

  return {
    _: 'TAPE receipt. Verify with: node tape-verify.mjs <this-file> — no TAPE service required.',
    entry: row.entry,
    proof,
    anchor: {
      signature: anchor.signature,
      // root/slot are a CONVENIENCE COPY and the verifier treats them as untrusted; it
      // re-reads both from the chain and says so out loud when they disagree.
      root: anchor.root,
      slot: anchor.slot,
      cluster: anchor.cluster,
      explorer: `https://solscan.io/tx/${anchor.signature}`,
    },
    // The tightest provable "no later than", carried as a claim. The default check verifies
    // against `anchor` (latest) and always completes; a verifier who wants this tighter bound
    // can confirm `tightest.signature` on an archival node. Same entry, earlier commitment.
    tightest: earliest && earliest.signature !== anchor.signature
      ? { slot: earliest.slot, signature: earliest.signature }
      : null,
    entry_hash: row.entry_hash,
    seq: row.seq,
  };
}

if (require.main === module) {
  const sel = process.argv[2];
  if (sel === undefined) {
    console.error('usage: receipt.js <seq|entry_hash|latest> [--out <path>]');
    process.exit(2);
  }
  const outIdx = process.argv.indexOf('--out');
  // Default path exists so the SOP's verify step has a fixed artifact to point at
  // without threading state between steps.
  const out = outIdx >= 0 ? process.argv[outIdx + 1] : '/tmp/tape-latest-receipt.json';
  try {
    const receipt = JSON.stringify(buildReceipt(sel), null, 2) + '\n';
    fs.writeFileSync(out, receipt);
    process.stdout.write(receipt);
    console.error(`receipt written to ${out}`);
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { buildReceipt, loadAnchors };
