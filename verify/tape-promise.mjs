#!/usr/bin/env node
/**
 * tape-promise.mjs — check whether TAPE kept the promise it signed to YOU.
 *
 * The other verifier answers "is this entry really in the record?". This one answers a
 * different and harder question: "TAPE told me it had my call. Did it put it in?"
 *
 * Those come apart precisely where it matters. If the intake accepts a call, signs a
 * receipt, and then quietly never anchors it, an inclusion checker has nothing to look at
 * — there is no entry to fail on. The absence is the attack, and an absence needs a
 * different instrument. (b897dfa8 and 6331608d, Colony, 2026-07-28: a wall-clock binding
 * with no contiguity check "is just a signed witness to a vacuum", and an unbounded gap
 * between receipt and anchor is a delay nobody can call late.)
 *
 * What makes it decidable is that the receipt names a SEQUENCE INDEX and a DEADLINE, and
 * the sequence is dense. So for a receipt claiming seq N:
 *
 *   - the published tape has some entry at index N, or it does not reach N at all;
 *   - an anchor commits to a leaf COUNT, so "the record reached N" is on chain;
 *   - and the receipt says by when.
 *
 * Which gives four outcomes, none of them a shrug:
 *
 *   KEPT     the entry at index N is yours, and an anchor covers it.
 *   BROKEN   index N is occupied by a DIFFERENT entry. We signed that N was yours. Our
 *            own signature is the evidence against us.
 *   OVERDUE  the deadline passed and no anchor covers index N. We are late by our own
 *            committed number, not by anyone's opinion.
 *   PENDING  the deadline has not passed yet. Nothing is wrong; come back.
 *
 * Deliberately shares NO code with the intake that issued the receipt. Run it from an
 * empty directory:  node tape-promise.mjs receipt.json
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * board.json, not tape.json. tape.json is the display summary and publishes `entries` and
 * `anchors` as COUNTS — enough to render a page, useless for this check, which needs the
 * whole seq -> entry_hash map and every anchor's (slot, count). board.json is the full
 * artifact and always was; pointing at the pretty one would have produced a tool that
 * silently answered UNKNOWN forever.
 */
const TAPE_URL = process.env.TAPE_URL || 'https://tape.drainfun.xyz/board.json';

/** Canonical JSON. Must match the producer byte for byte or every signature reads false. */
function canonicalize(value, path = '$') {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    throw new TypeError(`canonical: raw number at ${path}. Quantities must be decimal strings.`);
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k], `${path}.${k}`)}`).join(',')}}`;
  }
  throw new TypeError(`canonical: unsupported ${t} at ${path}`);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
  let num = 0n;
  for (const ch of String(str)) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`not base58: ${ch}`);
    num = num * 58n + BigInt(i);
  }
  const bytes = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  for (const ch of String(str)) { if (ch === '1') bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

/** Verify the intake's own signature over the receipt. An unsigned receipt proves nothing. */
function checkReceiptSignature(receipt) {
  const { receipt_by, receipt_sig, ...rest } = receipt;
  if (!receipt_by || !receipt_sig) return { signed: false, ok: false, reason: 'receipt carries no signature — it is not evidence of anything' };
  // Two schemes, selected by the receipt's OWN version field rather than by trying both
  // and accepting whichever passes. "Try every scheme until one verifies" is how a
  // verifier ends up accepting a downgrade: an attacker picks the weakest shape and the
  // checker obligingly finds it.
  const body = String(receipt.v) === '1'
    ? rest                                        // v1 signed the body alone
    : { ...rest, receipt_by, receipt_sig: null }; // v2 binds the signing key
  const msg = Buffer.from('tape:v1:intake:' + canonicalize(body), 'utf8');
  try {
    const pub = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base58Decode(receipt_by)]),
      format: 'der', type: 'spki',
    });
    const ok = crypto.verify(null, msg, pub, base58Decode(receipt_sig));
    return { signed: true, ok, reason: ok ? 'signed by the intake' : 'signature does not verify — this receipt was not issued by that key' };
  } catch (e) {
    return { signed: true, ok: false, reason: `could not check signature: ${e.message}` };
  }
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const entryHash = (entry) => sha(Buffer.from(canonicalize(entry), 'utf8'));

async function fetchTape(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`tape fetch ${r.status}`);
  return r.json();
}

const KEPT = 'KEPT', BROKEN = 'BROKEN', OVERDUE = 'OVERDUE', PENDING = 'PENDING', UNKNOWN = 'UNKNOWN';

async function checkPromise(receipt, { url = TAPE_URL, now = Date.now() } = {}) {
  for (const f of ['entry_hash', 'seq', 'received_at']) {
    if (receipt?.[f] === undefined) return { verdict: UNKNOWN, notes: [`receipt missing "${f}"`] };
  }
  const sig = checkReceiptSignature(receipt);
  if (!sig.ok) return { verdict: UNKNOWN, notes: [sig.reason] };

  const seq = Number(receipt.seq);
  if (!Number.isInteger(seq) || seq < 0) return { verdict: UNKNOWN, notes: [`receipt.seq is not an index: ${receipt.seq}`] };

  // A v1 receipt predates the committed deadline. It is still checkable for BROKEN, but
  // OVERDUE is not available for it — and saying so is better than silently inventing a
  // deadline it never promised.
  const deadline = receipt.anchor_by ? Date.parse(receipt.anchor_by) : null;

  let tape;
  try { tape = await fetchTape(url); }
  catch (e) { return { verdict: UNKNOWN, notes: [`could not read the public tape: ${e.message}`] }; }

  const rows = tape.chain;
  const anchors = Array.isArray(tape.anchors) ? tape.anchors : [];
  if (!Array.isArray(rows)) {
    return { verdict: UNKNOWN, notes: [`published artifact at ${url} has no "chain" array — point TAPE_URL at board.json, not tape.json`] };
  }

  const row = rows.find((r) => Number(r.seq) === seq);
  if (!row) {
    // The record has not reached this index. Only the clock decides whether that is fine.
    if (deadline === null) {
      return { verdict: UNKNOWN, seq, notes: ['index not reached, and this receipt version committed no deadline'] };
    }
    return {
      verdict: now > deadline ? OVERDUE : PENDING, seq, deadline: receipt.anchor_by,
      notes: [now > deadline
        ? `the record never reached index ${seq}, and the deadline the intake signed (${receipt.anchor_by}) has passed`
        : `index ${seq} not published yet; the intake promised it by ${receipt.anchor_by}`],
    };
  }

  const published = row.entry_hash || (row.entry ? entryHash(row.entry) : null);
  if (published !== receipt.entry_hash) {
    return {
      verdict: BROKEN, seq, published, promised: receipt.entry_hash,
      notes: [
        `index ${seq} is occupied by a DIFFERENT entry.`,
        `The intake signed that ${String(receipt.entry_hash).slice(0, 16)}… held index ${seq}; the record publishes ${String(published).slice(0, 16)}….`,
        'That signature is evidence against the operator, not against you.',
      ],
    };
  }

  // Present and correct. Now: has a Solana anchor actually committed to a tree that
  // reaches this index? Being in the file is not the same as being on the chain.
  const covering = anchors.filter((a) => Number(a.count) > seq).sort((a, b) => Number(a.slot) - Number(b.slot))[0];
  if (!covering) {
    if (deadline !== null && now > deadline) {
      return { verdict: OVERDUE, seq, deadline: receipt.anchor_by,
        notes: [`your entry is published at index ${seq} but NO anchor covers it, and the signed deadline ${receipt.anchor_by} has passed`] };
    }
    return { verdict: PENDING, seq, notes: [`published at index ${seq}, not yet inside an anchored root`] };
  }

  return {
    verdict: KEPT, seq, slot: covering.slot, anchorCount: covering.count,
    notes: [`index ${seq} holds your entry, and Solana slot ${covering.slot} commits to a tree of ${covering.count} entries`],
  };
}

async function main(argv) {
  const file = argv[0];
  if (!file || file === '-h' || file === '--help') {
    console.log(`tape-promise.mjs — did TAPE keep the promise it signed to you?

  node tape-promise.mjs <intake-receipt.json>

  exit 0  KEPT     your entry holds the index you were promised, inside an anchored root
  exit 1  BROKEN   that index holds someone else's entry — the intake's own signature convicts it
  exit 2  OVERDUE  the deadline the intake signed has passed with no anchor covering you
  exit 3  PENDING  not yet due
  exit 4  UNKNOWN  could not find out

  TAPE_URL overrides the published tape (default ${TAPE_URL}).`);
    return 0;
  }
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (receipt.receipt) receipt = receipt.receipt; // accept the whole intake response
  } catch (e) {
    console.error(`UNKNOWN — could not read receipt: ${e.message}`);
    return 4;
  }
  const r = await checkPromise(receipt);
  console.log(r.verdict);
  for (const n of r.notes) console.log(`  ${n}`);
  return { [KEPT]: 0, [BROKEN]: 1, [OVERDUE]: 2, [PENDING]: 3, [UNKNOWN]: 4 }[r.verdict];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

export { checkPromise, checkReceiptSignature, canonicalize, KEPT, BROKEN, OVERDUE, PENDING, UNKNOWN };
