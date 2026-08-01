#!/usr/bin/env node
/**
 * tape-attest.mjs — sign what you found, so the count of verifications is not ours to make.
 *
 * TAPE's own page would like to say "independently verified N times". That number is the
 * easiest thing on the whole site to fabricate, because until this file existed the only
 * party able to observe a verification was the party being verified. So we do not make it.
 * You do. This tool runs the independent verifier, then signs the verdict it reached with
 * YOUR key, and the board publishes your signed row verbatim. Anyone can recount from the
 * rows and check our arithmetic; if their count and ours differ, the rows are right.
 *
 *     node tape-attest.mjs keygen
 *     node tape-attest.mjs attest receipt.json --rpc https://your-rpc --submit
 *     node tape-attest.mjs audit attestation.json      # check somebody else's attestation
 *
 * BE CLEAR WHAT YOUR SIGNATURE MEANS. It says "this key claims it checked entry X and got
 * verdict V", permanently, on an append-only chain that gets anchored to Solana. It does
 * NOT prove you ran the check — verification is deterministic over public inputs, so
 * anybody can sign `verified` without looking, and no amount of cryptography fixes that.
 *
 * What it buys instead is falsifiability. The target entry and the chain are public, so
 * `audit` lets anyone re-run your check and prove you wrong. A signed, anchored, WRONG
 * `verified` is a mark against your key that you cannot edit, withdraw or re-word later.
 * That is the entire cost of lying here, and it is paid after the fact, forever.
 *
 * DISAGREE FREELY. `fraud` and `mismatch` are accepted on exactly the same terms as
 * `verified` and are surfaced FIRST on the board. If the verifier says we cheated, sign
 * that and send it. A verification channel that only carries good news is a testimonial.
 *
 * Dependencies: none. Imports only the independent verifier next to it, which itself
 * imports nothing from the TAPE library — see the header of tape-verify.mjs for why that
 * rule is load-bearing rather than tidy.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { canonicalize, verifyReceipt, VERIFIED, FRAUD, UNKNOWN, MISMATCH } from './tape-verify.mjs';

const API = process.env.TAPE_API || 'https://tape.drainfun.xyz/api';
const KEYFILE = process.env.TAPE_VERIFIER_KEY || './tape-verifier-key.json';
const SIG_DOMAIN = 'tape:v1:attest:';

/* ---- base58 (encode only; the verifier next door owns decode) ------------ */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  const b = Buffer.from(bytes);
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  // Leading zero bytes vanish in the numeric conversion and must be re-added, or two
  // different keys can encode to one string.
  for (const x of b) { if (x !== 0) break; out = '1' + out; }
  return out || '1';
}

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

function keygen() {
  if (existsSync(KEYFILE)) {
    console.error(`${KEYFILE} already exists. Refusing to overwrite it.`);
    console.error('Your attestation history hangs on this key; a new one starts from nothing.');
    process.exit(1);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
  writeFileSync(KEYFILE, JSON.stringify(Array.from(Buffer.concat([seed, pub]))));
  chmodSync(KEYFILE, 0o600);
  console.log(`key written to ${KEYFILE} (chmod 600)`);
  console.log(`your verifier id: ${b58encode(pub)}`);
  console.log('\nA SEPARATE KEY FROM YOUR CALLER KEY IS THE DEFAULT ON PURPOSE. Attesting your own');
  console.log('calls is legal here and is labelled `self_attested` wherever it appears, which is');
  console.log('worth exactly what a reference you wrote for yourself is worth.');
}

function loadKey() {
  if (!existsSync(KEYFILE)) {
    console.error(`no key at ${KEYFILE}. run: node tape-attest.mjs keygen`);
    process.exit(1);
  }
  const arr = JSON.parse(readFileSync(KEYFILE, 'utf8'));
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`${KEYFILE} is not a 64-byte key`);
  const sk = Buffer.from(arr);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, sk.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  // Derived, never read from bytes 32..64: an edited or corrupted key file must fail here
  // rather than sign under an identity it does not actually hold.
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
  return { priv, pubB58: b58encode(pub) };
}

/** hostname only — see lib/attest.js: verifier RPC URLs routinely carry API keys. */
function rpcHost(url) {
  try { return new URL(url).hostname; } catch { return 'unparseable'; }
}

const VERDICT_WORD = {
  [VERIFIED]: 'verified', [FRAUD]: 'fraud', [UNKNOWN]: 'unknown', [MISMATCH]: 'mismatch',
};

/**
 * Build the row. Field set and rules are duplicated from lib/attest.js ON PURPOSE — this
 * file may not import the TAPE library, so the two are independent implementations of one
 * published shape, and the server rejecting a row this builds is a real disagreement worth
 * hearing about rather than a shared bug agreeing with itself.
 */
function buildRow({ target, result, rpcUrl, note, anchorSig }) {
  const verdict = VERDICT_WORD[result.verdict];
  if (!verdict) throw new Error(`unmapped verdict ${JSON.stringify(result.verdict)}`);
  const row = {
    p: 'tape-attest',
    v: '1',
    type: 'attest',
    ref: target,
    verdict,
    merkle_root: result.computedRoot ?? null,
    // The anchor transaction the verdict was read from. Taken from the receipt rather than
    // the verifier's return value because a verdict of `unknown` never got as far as
    // fetching one, and it is still the transaction this attestation is ABOUT — naming it
    // is what lets a later auditor look at the same place we did.
    anchor_sig: anchorSig ?? null,
    slot: result.slot === undefined || result.slot === null ? null : String(result.slot),
    rpc_host: rpcHost(rpcUrl),
    note: note ?? null,
    attested_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    signer: null,
    sig: null,
  };
  return row;
}

function sign(row, key) {
  const withSigner = { ...row, signer: key.pubB58, sig: null };
  const bytes = Buffer.from(SIG_DOMAIN + canonicalize(withSigner), 'utf8');
  return { ...withSigner, sig: b58encode(edSign(null, bytes, key.priv)) };
}

async function submit(row) {
  const res = await fetch(`${API}/attest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'tape-attest/1' },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ *
 * attest — run the verifier, sign what it found
 * ------------------------------------------------------------------ */
async function cmdAttest(args) {
  const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const FLAGS = new Set(['--rpc', '--note', '--expect']);
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { if (FLAGS.has(args[i])) i++; continue; }
    if (file === null) file = args[i];
  }
  if (!file) { console.error('usage: tape-attest.mjs attest <receipt.json> [--rpc URL] [--note "..."] [--submit]'); return 2; }

  const rpcUrl = valueOf('--rpc') ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  let receipt;
  try { receipt = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`could not read receipt: ${e.message}`); return 2; }
  if (receipt && !receipt.entry && receipt.receipt) receipt = receipt.receipt;

  const result = await verifyReceipt(receipt, { rpcUrl, expect: valueOf('--expect') });
  const target = result.entryHash;
  if (!target) {
    console.error(`UNKNOWN — the receipt could not even be hashed, so there is nothing to attest to.`);
    for (const n of result.notes ?? []) console.error(`  ${n}`);
    return 2;
  }

  const key = loadKey();
  const row = sign(buildRow({
    target, result, rpcUrl, note: valueOf('--note'),
    anchorSig: typeof receipt.anchor?.signature === 'string' ? receipt.anchor.signature : null,
  }), key);

  console.log(JSON.stringify(row, null, 2));
  console.error(`\nverdict ${row.verdict} on entry ${target.slice(0, 12)}… signed by ${key.pubB58}`);
  if (row.verdict !== 'verified') {
    console.error('THIS ATTESTATION DISAGREES WITH THE BOARD. Send it. It is accepted on the same');
    console.error('terms as a passing one, and it is shown before them.');
  }

  if (args.includes('--submit')) {
    const { status, body } = await submit(row);
    console.error(`\nPOST ${API}/attest -> ${status} ${JSON.stringify(body)}`);
    // The row is already signed and printed. A refused submission loses nothing: keep the
    // JSON, publish it anywhere, and the signature still checks — the board is a convenient
    // venue for these rows, not the authority over them.
    if (status >= 300) {
      console.error('rejected. keep the JSON above: your signature does not need our server to be true.');
      return 1;
    }
  } else {
    console.error(`\nnot submitted. add --submit to POST it to ${API}/attest`);
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * audit — the half that makes an attestation worth signing
 * ------------------------------------------------------------------ */
async function cmdAudit(args) {
  const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const FLAGS = new Set(['--rpc', '--receipt']);
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { if (FLAGS.has(args[i])) i++; continue; }
    if (file === null) file = args[i];
  }
  if (!file) {
    console.error('usage: tape-attest.mjs audit <attestation.json> --receipt <receipt.json> [--rpc URL]');
    console.error('  the receipt is the row the attestation is ABOUT; fetch it from any source you like.');
    return 2;
  }
  const rpcUrl = valueOf('--rpc') ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

  let att; try { att = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { console.error(`could not read attestation: ${e.message}`); return 2; }
  if (att && att.entry) att = att.entry;   // accept a chain record as well as a bare row

  const receiptFile = valueOf('--receipt');
  if (!receiptFile) { console.error('audit needs --receipt <receipt.json> for the entry being attested'); return 2; }
  let receipt; try { receipt = JSON.parse(readFileSync(receiptFile, 'utf8')); }
  catch (e) { console.error(`could not read receipt: ${e.message}`); return 2; }
  if (receipt && !receipt.entry && receipt.receipt) receipt = receipt.receipt;

  const mine = await verifyReceipt(receipt, { rpcUrl });
  if (mine.entryHash !== att.ref) {
    console.log(`WRONG TARGET — this attestation is about ${String(att.ref).slice(0, 12)}… but the`);
    console.log(`receipt you gave me hashes to ${String(mine.entryHash).slice(0, 12)}…. Not comparable.`);
    return 2;
  }
  const theirs = att.verdict;
  const ours = VERDICT_WORD[mine.verdict];
  if (theirs === ours) {
    console.log(`AGREE — ${att.signer} signed "${theirs}" and an independent re-run says "${ours}".`);
    return 0;
  }
  console.log(`DISAGREE — ${att.signer} signed "${theirs}"; an independent re-run says "${ours}".`);
  console.log('');
  console.log('One of the two is wrong and the attestation is the one that is signed, dated and');
  console.log('anchored. If your re-run is right, that key carries a permanent false verdict.');
  console.log('Before concluding that: a verdict of "unknown" on either side usually means an RPC');
  console.log('was unreachable, not that anybody lied. Re-run against a different --rpc first.');
  for (const n of mine.notes ?? []) console.log(`  ${n}`);
  return 1;
}

async function main(argv) {
  const [cmd, ...args] = argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`tape-attest.mjs — sign the verdict you reached, so the verification count is not ours to make.

  keygen                                     make a verifier key (stays on your machine)
  attest <receipt.json> [--submit]           verify, then sign the verdict
        [--rpc URL] [--note "..."] [--expect call|window|pledge]
  audit <attestation.json> --receipt <r>     re-run somebody else's attestation

Your signature says WHO reached a verdict, not that they did the work. What makes it cost
something is that anyone can run \`audit\` and prove a wrong \`verified\` — permanently,
against a key that cannot revise it afterwards.

Disagreeing verdicts (fraud, mismatch) are accepted on the same terms as passing ones and
are shown first. Key: ${KEYFILE}   Board: ${API}`);
    return 0;
  }
  if (cmd === 'keygen') { keygen(); return 0; }
  if (cmd === 'attest') return cmdAttest(args);
  if (cmd === 'audit') return cmdAudit(args);
  console.error(`unknown command ${JSON.stringify(cmd)} — try: help`);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((c) => { process.exitCode = c; });
}

export { buildRow, sign, b58encode, SIG_DOMAIN };
