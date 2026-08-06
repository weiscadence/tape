#!/usr/bin/env node
'use strict';
/**
 * post.js — record a call on the tape.
 *
 * This is the intake surface the ZeroClaw skill exposes as the `tape_post` tool, so it
 * has to be safe to call from an agent loop where the arguments are model-generated or
 * arrive from a channel. Two consequences shape this file:
 *
 * 1. VALIDATION IS NOT ADVISORY. Everything goes through buildEntry(), which rejects
 *    unknown fields and raw floats outright. A tool that quietly coerced bad input would
 *    write a hash nobody can reproduce, and an unreproducible entry is worse than a
 *    rejected one — it looks like a record and is not.
 *
 * 2. POSTING IS NOT ANCHORING, AND THE OUTPUT SAYS SO. An entry is only worth something
 *    once a Solana slot covers it. If this printed a cheerful "recorded!" a caller would
 *    reasonably believe they were protected during the window before the next anchor,
 *    which is the exact interval in which we could still drop it.
 */

const fs = require('fs');
const path = require('path');
const { buildEntry, entryHash, newNonce, signEntry, verifyEntrySignature } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const ed = require('../lib/ed25519');
const { currentBinding } = require('../lib/interval');

// Resolved through datadir.js, not rebuilt here. This file hardcoded the path and so
// ignored TAPE_DATA — which is the precise bug datadir.js was written to end, and it
// survived here because nobody re-checked bin/ after the fix. A smoke test aimed at
// /tmp wrote a junk row into the production tape (2026-08-06) and came within one
// anchor cycle of committing it to Solana permanently. A staging write MUST NOT be able
// to reach the real record.
const { DATA_DIR: DATA } = require('../lib/datadir');

/**
 * Load a Solana-format secret key (the 64-byte JSON array `solana-keygen` writes).
 *
 * Signing is OPTIONAL and stays optional. An unsigned call is a supported T0 entry, not
 * a degraded one — requiring a key to post would push people to a surface that does not
 * demand one, and the tape's guarantee (you said it, at this slot, and never unsaid it)
 * holds either way. What signing adds is that the NAME on it is not free.
 */
function loadSigner(file) {
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw new Error(`${file}: expected a 64-byte secret key array, got ${Array.isArray(arr) ? arr.length : typeof arr}`);
  }
  return Buffer.from(arr);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = val;
  }
  return out;
}

/**
 * Fetch the not-before binding, or return null and say why.
 *
 * FAIL-OPEN, DELIBERATELY. If drand's mirrors are unreachable the correct outcome is a
 * one-sided row, not a lost call. A tape that refuses to record because an optional
 * strengthening is unavailable would have a gap exactly when infrastructure is worst —
 * and a missing call is the one failure this system cannot recover from, while a missing
 * not-before is a disclosed weaker bound the reader can see. What it must never do is
 * degrade QUIETLY, so the reason is printed on the write path.
 */
async function tryBinding(opts) {
  if (opts.no_beacon) return { beacon: null, why: 'disabled with --no_beacon' };
  try {
    return { beacon: await currentBinding(), why: null };
  } catch (e) {
    return { beacon: null, why: e.message };
  }
}

async function post(opts) {
  const { beacon, why } = await tryBinding(opts);
  if (!beacon) console.error(`NOT-BEFORE UNAVAILABLE (${why}) — posting one-sided, anchor-only.`);

  const entry = buildEntry({
    type: opts.type || 'open',
    caller: opts.caller,
    lane: opts.lane,
    market: opts.market,
    side: opts.side,
    size: String(opts.size),
    entry_ref: String(opts.entry_ref),
    // The caller's clock is recorded but explicitly not authoritative — the anchor slot
    // is. Defaulting it to our clock is fine precisely because nothing ranks on it.
    ts_claimed: opts.ts_claimed || new Date().toISOString(),
    ref: opts.ref || null,
    nonce: opts.nonce || newNonce(),
    note: opts.note || null,
    // The other end of the clock. Committing to a published drand round means this row
    // could not have been written earlier than that round; the anchor slot says it existed
    // by then. See lib/interval.js for why one number was never enough.
    beacon,
  });

  let signed = entry;
  if (opts.key) {
    signed = signEntry(entry, loadSigner(opts.key));
    // Verify our own signature before writing it. Signing and then failing to verify
    // would put an unverifiable entry on a record that cannot be edited afterwards.
    const v = verifyEntrySignature(signed);
    if (!v.ok) throw new Error(`refusing to post: our own signature did not verify (${v.reason})`);
  }

  const chain = new Chain(path.join(DATA, 'tape.jsonl'));
  const rec = chain.append(signed);
  return {
    seq: rec.seq, entry_hash: entryHash(signed), entry: signed,
    signer: signed.signer || null, beacon: signed.beacon || null,
  };
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.caller || !a.market) {
    console.error(`usage: post.js --caller <id> --lane <memecoin|prediction|perp|lp|other> \\
                 --market <string> --side <long|short|yes|no> --size <decimal-string> \\
                 --entry_ref <decimal-string> [--type open|close|amend] [--ref <hash>] [--note <text>]

Quantities MUST be decimal strings ("0.80", not 0.8) — float formatting is not portable
across languages and the hash has to be reproducible by someone else's code.`);
    process.exit(2);
  }
  post(a).then((r) => {
    console.log(`posted seq=${r.seq} entry_hash=${r.entry_hash}`);
    if (r.beacon) {
      console.log(`NOT-BEFORE bound to drand quicknet round ${r.beacon.round}`);
      console.log('  This row could not have been written before that round published.');
    } else {
      console.log('NOT-BEFORE ABSENT — this row is anchor-only (not-after), the weaker form.');
    }
    if (r.signer) {
      console.log(`SIGNED by ${r.signer}`);
      console.log('  This proves WHO posted it. It does NOT prove the trade happened —');
      console.log('  no custody was checked. That is the T1-signed / fill_verified split.');
    } else {
      console.log('UNSIGNED (T0) — the name on this call is one anyone could type.');
      console.log('  Pass --key <keypair.json> to bind it to a wallet.');
    }
    console.log('NOT YET ANCHORED — this entry carries no time guarantee until a Solana');
    console.log('slot covers it. Run tape_anchor, then tape_receipt, to get something a');
    console.log('stranger can check.');
  }).catch((e) => {
    console.error(`REJECTED: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { post };
