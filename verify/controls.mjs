#!/usr/bin/env node
/**
 * controls.mjs — negative controls for the independent verifier.
 *
 * A verifier that has only ever been run on honest input is untested. Every check below
 * exists because the corresponding lie is one somebody would actually tell, and the
 * suite fails if any of them slips through as VERIFIED.
 *
 * The three-way verdict is what most of these are really testing. It is easy to write a
 * verifier that returns "not verified" for everything it dislikes; the useful behaviour
 * is distinguishing "the chain contradicts you" (FRAUD) from "I could not find out"
 * (UNKNOWN). Controls 5-7 are the ones that keep an outage from reading as either a
 * rubber stamp or an accusation.
 */

import { readFileSync } from 'node:fs';
import { verifyReceipt, VERIFIED, FRAUD, UNKNOWN } from './tape-verify.mjs';

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const receiptPath = process.argv[2];
if (!receiptPath) { console.error('usage: controls.mjs <good-receipt.json>'); process.exit(2); }

const good = JSON.parse(readFileSync(receiptPath, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(good));

let failures = 0;
async function control(name, receipt, expected, opts = {}) {
  const r = await verifyReceipt(receipt, { rpcUrl: opts.rpcUrl || RPC });
  const ok = r.verdict === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      expected ${expected}, got ${r.verdict}${r.notes?.[0] ? ` — ${r.notes[0]}` : ''}`);
  return r;
}

console.log(`controls against ${RPC}\n`);

// 0. The positive control. Without this the suite could pass by returning FRAUD always,
//    which is the mirror-image of a verifier that only ever confirms.
await control('0 honest receipt verifies', good, VERIFIED);

// 1. The headline attack: we alter a call after the fact to look smarter. Entry price
//    0.80 -> 0.20 turns a mediocre call into a great one and changes nothing visible.
const edited = clone();
edited.entry.entry_ref = '0.20';
await control('1 edited entry price -> FRAUD', edited, FRAUD);

// 2. Rewriting the prose while leaving the numbers alone. Notes are inside the committed
//    bytes precisely so the story cannot be revised after the outcome is known.
const renoted = clone();
renoted.entry.note = 'I always said this would merge, obviously.';
await control('2 rewritten note -> FRAUD', renoted, FRAUD);

// 3. Backdating by editing the caller's own timestamp. It is non-authoritative BY DESIGN,
//    but it must still be tamper-evident, or the human-readable record drifts from the
//    provable one and readers trust the wrong field.
const backdated = clone();
backdated.entry.ts_claimed = '2026-07-01T00:00:00.000Z';
await control('3 backdated ts_claimed -> FRAUD', backdated, FRAUD);

// 4. Forging the path rather than the payload.
const badProof = clone();
if (badProof.proof.length) {
  badProof.proof[0].hash = badProof.proof[0].hash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  await control('4 corrupted proof sibling -> FRAUD', badProof, FRAUD);
} else {
  console.log('SKIP  4 corrupted proof sibling (single-leaf batch, no siblings)');
}

// 5. Claiming inclusion in a real anchor the entry is not in. This is the subtle one:
//    every field is authentic, both objects are ours, and only the pairing is a lie.
const wrongAnchor = clone();
wrongAnchor.anchor.signature =
  '4AKw6nbA8RxBuuYW8QoAtGA2Cx9JZDMrEVfLWCqvHvqXc1ti8Xm1cHXFeRkyN2eK8A525fp9GxV9RurJKabXStGj';
delete wrongAnchor.anchor.root;
await control('5 real anchor, wrong batch -> FRAUD', wrongAnchor, FRAUD);

// 6. A signature that was never on chain. NOT fraud: an RPC that has pruned or not yet
//    indexed a transaction is indistinguishable from a fabricated one, and a verifier
//    that guesses here will eventually accuse an honest caller during an outage.
//
//    THE SIGNATURE MUST BE WELL-FORMED. First version of this control used '1'.repeat(87)
//    and passed — but the RPC rejected it as `Invalid param: WrongSize` before ever
//    looking it up, so it was testing malformed-input handling and reporting that as
//    coverage of the not-found path. A control that passes for the wrong reason is worse
//    than a missing one: it reads as tested. So this mutates a REAL signature by one
//    character, which stays valid base58 of the right length and simply does not exist.
const fabricated = clone();
const sig = good.anchor.signature;
const flip = (c) => (c === 'A' ? 'B' : 'A');
fabricated.anchor.signature = sig.slice(0, 10) + flip(sig[10]) + sig.slice(11);
if (fabricated.anchor.signature === sig) throw new Error('control 6 failed to mutate the signature');
const r6 = await control('6 unknown signature -> UNKNOWN (not FRAUD)', fabricated, UNKNOWN);
if (/WrongSize|Invalid param/.test(r6.notes?.join(' ') || '')) {
  console.log('FAIL  6 was rejected as malformed, so the not-found path is still untested');
  failures++;
}

// 7. The outage case. Must never be VERIFIED and must never be FRAUD.
await control('7 unreachable RPC -> UNKNOWN', good, UNKNOWN, {
  rpcUrl: 'http://127.0.0.1:1/definitely-not-an-rpc',
});

// 8. Garbage in is not an accusation.
await control('8 malformed receipt -> UNKNOWN', { entry: { v: '1' } }, UNKNOWN);

// 9. A raw float anywhere in the entry must be refused rather than silently reformatted.
//    If the verifier coerced it, two honest parties could hash the same call differently
//    and the record would become arguable — the exact failure TAPE exists to remove.
const floaty = clone();
floaty.entry.size = 1;
await control('9 raw number in entry -> UNKNOWN (refused, not coerced)', floaty, UNKNOWN);

console.log(`\n${failures === 0 ? 'ALL CONTROLS PASS' : `${failures} CONTROL(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
