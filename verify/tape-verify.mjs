#!/usr/bin/env node
/**
 * tape-verify.mjs — the independent verifier.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * This file is the entire claim of TAPE. Everything else in the repo is a hash chain we
 * operate, and a record whose operator is also the only one who can check it proves
 * nothing at all. So this file has exactly one hard requirement:
 *
 *     NOTHING WE OPERATE MAY APPEAR IN THE VERIFICATION PATH.
 *
 * Concretely that means:
 *   - zero imports from ../lib. The canonicalizer, the Merkle walk and the base58 decoder
 *     below are INDEPENDENT REIMPLEMENTATIONS, not shared code. If they were shared, a bug
 *     (or an edit) in our library would be invisible to the check, because both sides
 *     would be wrong in the same direction. Two implementations that agree is evidence.
 *     One implementation checking itself is a tautology.
 *   - zero npm dependencies. `node tape-verify.mjs receipt.json` on a clean box, no
 *     install step, nothing fetched from us. A verifier that needs our package registry
 *     entry is a verifier we can revoke.
 *   - zero calls to any TAPE host. The only network call is to a public Solana RPC that
 *     the VERIFIER chooses (--rpc, or SOLANA_RPC_URL). We do not get to pick the source
 *     of truth for our own audit.
 *
 * It must also be able to say we cheated. A verifier that can only return "verified" is
 * a logo. So FRAUD is a first-class outcome and it is loud.
 *
 * THREE OUTCOMES, DELIBERATELY DISTINCT (exit codes 0 / 1 / 2):
 *   VERIFIED — this exact entry was committed under the root that is on chain at that slot.
 *   FRAUD    — the chain says something different from what the receipt claims.
 *   UNKNOWN  — we could not find out (RPC down, tx not indexed yet, malformed receipt).
 *
 * UNKNOWN existing separately is not fussiness. Collapsing it into either neighbour is the
 * classic silent-zero bug: fold it into VERIFIED and an outage becomes a rubber stamp;
 * fold it into FRAUD and an RPC hiccup accuses an honest caller. An unreachable chain is
 * an absence of evidence and must print as one.
 */

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const DEFAULT_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/* ------------------------------------------------------------------ *
 * base58 — decoded here rather than imported, see header.
 * Solana returns legacy instruction data base58-encoded.
 * ------------------------------------------------------------------ */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

function base58Decode(str) {
  const bytes = [0];
  for (const ch of str) {
    const val = B58_MAP.get(ch);
    if (val === undefined) throw new Error(`base58: invalid character ${JSON.stringify(ch)}`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's are leading zero bytes by definition of the encoding.
  for (const ch of str) { if (ch !== '1') break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}

/* ------------------------------------------------------------------ *
 * canonical form — independent reimplementation of ../lib/canonical.js.
 * Same rules, written from the spec rather than copied: keys sorted, no
 * whitespace, and RAW NUMBERS REJECTED (float formatting is not portable
 * across languages, so a number in the committed bytes means two honest
 * parties can disagree about what was said).
 * ------------------------------------------------------------------ */
function canonicalize(value, path = '$') {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    throw new Error(`canonical: raw number at ${path} — quantities must be decimal strings`);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => {
      if (value[k] === undefined) throw new Error(`canonical: undefined value at ${path}.${k}`);
      return JSON.stringify(k) + ':' + canonicalize(value[k], `${path}.${k}`);
    });
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonical: unsupported type ${t} at ${path}`);
}

/* ------------------------------------------------------------------ *
 * Merkle — independent reimplementation. Domain separation (0x00 leaf,
 * 0x01 node) is what stops an internal node being replayed in a leaf
 * position, so this verifier hashes the ENTRY, never accepts a digest.
 * ------------------------------------------------------------------ */
/**
 * Who SIGNED the call (distinct from who ANCHORED the batch).
 *
 * The anchor signer is us — we pay the fee. That says nothing about who made the call.
 * A signed entry carries its own key, and the signature is inside the entry hash, so the
 * inclusion proof already covers it. Surfacing it here turns "this entry existed at slot
 * N" into "THIS PERSON said it, and it existed at slot N", which is the claim a reader
 * actually cares about.
 *
 * Three states, never collapsed: unsigned (a supported T0 call, the name is free),
 * signed-and-valid, and signed-but-broken. The third must never render as the first.
 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * TWO signing domains, and getting this wrong made the verifier call honest rows FRAUD.
 *
 * Call rows are domain-separated with `tape:v1:entry:`. Window rows — the assigned-question
 * mechanism: schedule_commit, enroll, seed_reveal, question, answer, pass, no_answer — use
 * `tape:v1:window:`, because a signature over a call must not be replayable as a signature
 * over a window. This file implemented only the first one, so every one of the six window
 * row types verified against the wrong bytes and came back
 * `signature does not verify over these bytes`, which this verifier reports as FRAUD.
 *
 * That is the worst possible direction for this bug to point. The receipt tells its holder
 * to run exactly this tool, and it told anyone who enrolled in a round that the board had
 * forged their rows. The mechanism whose entire pitch is "do not trust us, check it" shipped
 * a checker that accused us of fraud on 100% of its output, and it was found by a canary
 * doing a random draw, not by the many times we ran it by hand on a call row.
 */
const SIG_DOMAIN = 'tape:v1:entry:';
const WINDOW_SIG_DOMAIN = 'tape:v1:window:';
const PLEDGE_SIG_DOMAIN = 'tape:v1:pledge:';

/**
 * THREE families, and knowing the domain was never enough.
 *
 * hermessol, Moltbook `e4fa8407`, 2026-07-30, predicting the bug below before it was found:
 * "A verifier that implements both domains will pass every genuine row — and it will also
 * pass a correctly-signed WINDOW row presented in an ENTRY slot, unless something explicitly
 * rejects the mismatch. That version fails silently, on a subset, and every check you own
 * stays green through it."
 *
 * He was right, and the demonstration needed no forgery at all. `GET /tape/api/entry/33` is a
 * published receipt for a window `pass` row — a caller DECLINING an assigned question — and
 * this file printed VERIFIED, exit 0, "called by 5wqA5… (signature verified — this key said
 * it)". The signature check was correct the whole time; it picked `tape:v1:window:` from
 * `entry.p` and the bytes genuinely verified. What was missing is that a verdict never said
 * WHAT it had verified, so "I declined" and "I called it" rendered identically. That is worse
 * than the replay he described, because there is no attacker: it is the default output of the
 * tool our own receipts instruct the holder to run.
 *
 * Two structural rules come out of it, and neither is about cryptography:
 *
 *   1. A verdict must name the family and type it verified. VERIFIED alone is a sentence with
 *      no subject.
 *   2. An UNRECOGNISED protocol tag must be UNKNOWN, never the call domain. The old code fell
 *      through to `tape:v1:entry:` for anything that was not `tape-window` — so `tape-pledge`,
 *      which exists in lib/pledge.js and signs under its own domain, would have been reported
 *      as FRAUD by the public verifier the moment anybody made a pledge. Same bug as the one
 *      that already called every window row a forgery, caught this time before it shipped.
 *      Defaulting is how a future row family silently becomes "a call".
 */
const FAMILIES = {
  call:   { domain: SIG_DOMAIN,        noun: 'call',            tag: null },
  window: { domain: WINDOW_SIG_DOMAIN, noun: 'assigned-question window row', tag: 'tape-window' },
  pledge: { domain: PLEDGE_SIG_DOMAIN, noun: 'pledge row',      tag: 'tape-pledge' },
};

/** Window row types that a reader must never mistake for a position taken. */
const NOT_A_POSITION = new Set(['pass', 'no_answer', 'enroll', 'schedule_commit',
  'enrollment_close', 'seed_reveal', 'question', 'schedule_void']);

function classify(entry) {
  const p = entry?.p ?? null;
  if (p === null) return { family: 'call', ...FAMILIES.call };
  for (const [family, spec] of Object.entries(FAMILIES)) {
    if (spec.tag !== null && spec.tag === p) return { family, ...spec };
  }
  return { family: null, domain: null, noun: null, unknownTag: p };
}

function checkEntrySignature(entry) {
  const signer = entry.signer ?? null;
  const sig = entry.sig ?? null;
  const cls = classify(entry);
  if (cls.family === null) {
    // `family: null` EXPLICITLY. It was omitted here once, so `sigState.family` came back
    // undefined, the `=== null` guard downstream never fired, and an unsigned row with an
    // invented protocol tag sailed through to VERIFIED. A missing key and a null are the same
    // thing to a reader and different things to `===`.
    return { signed: signer !== null, ok: false, signer, family: null, domain: null, noun: null,
      unknownTag: cls.unknownTag,
      reason: `unrecognised protocol tag "${cls.unknownTag}" — this verifier will not guess a `
        + 'signing domain for a row family it does not know, because guessing is how a new '
        + 'row family silently gets reported as a call' };
  }
  if (signer === null && sig === null) return { signed: false, ok: true, signer: null, ...cls };
  if (signer === null || sig === null) return { signed: true, ok: false, signer, ...cls, reason: 'signer and sig must both be present' };
  try {
    const sigRaw = base58Decode(sig);
    const pubRaw = base58Decode(signer);
    if (sigRaw.length !== 64 || pubRaw.length !== 32) return { signed: true, ok: false, signer, ...cls, reason: 'malformed key or signature' };
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pubRaw]), format: 'der', type: 'spki' });
    const body = canonicalize({ ...entry, sig: null });
    const ok = edVerify(null, Buffer.from(cls.domain + body, 'utf8'), key, sigRaw);
    if (ok) return { signed: true, ok, signer, ...cls, reason: null };
    // Name the domain in the failure. "Does not verify" with no further detail is what let
    // a domain mismatch look identical to a forgery for as long as it did. Probe EVERY other
    // known domain, not just the one other one this file used to know about.
    for (const [family, spec] of Object.entries(FAMILIES)) {
      if (spec.domain === cls.domain) continue;
      if (edVerify(null, Buffer.from(spec.domain + body, 'utf8'), key, sigRaw)) {
        return { signed: true, ok: false, signer, ...cls,
          reason: `signature verifies under the ${spec.domain} domain (${family}) but this row `
            + `declares ${cls.domain} (${cls.family}) — domain separation exists to stop exactly `
            + 'this replay, so it is rejected' };
      }
    }
    return { signed: true, ok: false, signer, ...cls,
      reason: `signature does not verify over these bytes (domain ${cls.domain})` };
  } catch (e) {
    return { signed: true, ok: false, signer, ...cls, reason: `signature unreadable: ${e.message}` };
  }
}

const sha256 = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest();
const hashLeaf = (buf) => sha256(Buffer.from([0x00]), buf);
const hashNode = (l, r) => sha256(Buffer.from([0x01]), l, r);

function rootFromProof(entryBytes, proof) {
  let acc = hashLeaf(entryBytes);
  for (const step of proof) {
    if (step.side !== 'left' && step.side !== 'right') {
      throw new Error(`proof: bad side ${JSON.stringify(step.side)}`);
    }
    if (typeof step.hash !== 'string' || !/^[0-9a-f]{64}$/.test(step.hash)) {
      throw new Error('proof: each step needs a 64-hex sibling hash');
    }
    const sib = Buffer.from(step.hash, 'hex');
    acc = step.side === 'left' ? hashNode(sib, acc) : hashNode(acc, sib);
  }
  return acc.toString('hex');
}

/* ------------------------------------------------------------------ *
 * chain read
 * ------------------------------------------------------------------ */
async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Pull the anchor memo out of a transaction.
 *
 * PARSED FROM INSTRUCTION DATA, NOT FROM LOGS. Validator logs are capped and get
 * truncated on busy transactions, and a truncated log is indistinguishable from "there
 * was no memo here" — a silent failure that would land precisely on the anchors under
 * the most load. Instruction data is part of consensus and is never truncated.
 */
async function fetchAnchor(rpcUrl, signature) {
  const tx = await rpc(rpcUrl, 'getTransaction', [
    signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' },
  ]);
  if (!tx) return { found: false };

  const keys = tx.transaction?.message?.accountKeys || [];
  const instrs = tx.transaction?.message?.instructions || [];
  let memo = null;
  for (const ix of instrs) {
    if (keys[ix.programIdIndex] !== MEMO_PROGRAM_ID) continue;
    memo = base58Decode(ix.data).toString('utf8');
    break;
  }

  let parsed = null;
  try { parsed = memo ? JSON.parse(memo) : null; } catch { parsed = null; }

  return {
    found: true,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    signer: keys[0] ?? null,
    memo,
    parsed,
  };
}

/* ------------------------------------------------------------------ *
 * the check
 * ------------------------------------------------------------------ */
const VERIFIED = 'VERIFIED', FRAUD = 'FRAUD', UNKNOWN = 'UNKNOWN', MISMATCH = 'MISMATCH';

/**
 * MISMATCH is deliberately NOT folded into FRAUD, and deliberately not into VERIFIED.
 *
 * A window row presented where a call was expected is not a forgery — every byte of it is
 * honest, and calling its signer a fraud would be its own kind of lie. But it is not the
 * thing the reader asked about either, and that is the whole finding. It gets its own verdict
 * and its own exit code so that neither neighbour can absorb it, for the same reason UNKNOWN
 * is not allowed to collapse into VERIFIED.
 */
export async function verifyReceipt(receipt, { rpcUrl = DEFAULT_RPC, expect = null } = {}) {
  const notes = [];

  // Shape problems are UNKNOWN, not FRAUD: a receipt we cannot parse is a receipt we did
  // not check. Calling it fraud would let a mangled copy-paste smear an honest caller.
  for (const f of ['entry', 'proof', 'anchor']) {
    if (receipt?.[f] === undefined) return { verdict: UNKNOWN, notes: [`receipt missing "${f}"`] };
  }
  if (!Array.isArray(receipt.proof)) return { verdict: UNKNOWN, notes: ['receipt.proof must be an array'] };
  const signature = receipt.anchor?.signature;
  if (typeof signature !== 'string' || !signature.length) {
    return { verdict: UNKNOWN, notes: ['receipt.anchor.signature missing'] };
  }

  let entryBytes, entryHash, computedRoot;
  try {
    entryBytes = Buffer.from(canonicalize(receipt.entry), 'utf8');
    entryHash = createHash('sha256').update(entryBytes).digest('hex');
    computedRoot = rootFromProof(entryBytes, receipt.proof);
  } catch (e) {
    return { verdict: UNKNOWN, notes: [`could not canonicalize/walk: ${e.message}`] };
  }

  let anchor;
  try {
    anchor = await fetchAnchor(rpcUrl, signature);
  } catch (e) {
    // The chain being unreachable says nothing about the claim. Never a pass, never an
    // accusation.
    return { verdict: UNKNOWN, entryHash, computedRoot, notes: [`chain unreachable: ${e.message}`] };
  }

  if (!anchor.found) {
    return {
      verdict: UNKNOWN, entryHash, computedRoot,
      notes: [
        `transaction ${signature} not found on this RPC.`,
        'Could be an unindexed/pruned node or a fabricated signature — those are different',
        'things and this verifier will not guess. Retry against an archive RPC.',
      ],
    };
  }

  if (!anchor.parsed || anchor.parsed.p !== 'tape') {
    return {
      verdict: FRAUD, entryHash, computedRoot, anchor,
      notes: ['the referenced transaction carries no TAPE anchor memo'],
    };
  }

  const onChainRoot = anchor.parsed.root;
  const onChainCount = anchor.parsed.n;

  if (computedRoot !== onChainRoot) {
    return {
      verdict: FRAUD, entryHash, computedRoot, anchor,
      notes: [
        'THE CHAIN DISAGREES WITH THIS RECEIPT.',
        `on-chain root : ${onChainRoot}`,
        `recomputed    : ${computedRoot}`,
        'Either the entry was altered after anchoring, or the proof does not belong to it.',
      ],
    };
  }

  // The receipt may also assert a root. It is checked LAST and only as a courtesy: the
  // chain has already decided. A receipt agreeing with itself is worth nothing.
  if (receipt.anchor.root && receipt.anchor.root !== onChainRoot) {
    notes.push(`note: receipt claimed root ${receipt.anchor.root}, chain says ${onChainRoot} — chain wins`);
  }
  if (typeof receipt.anchor.slot === 'number' && receipt.anchor.slot !== anchor.slot) {
    notes.push(`note: receipt claimed slot ${receipt.anchor.slot}, chain says ${anchor.slot} — chain wins`);
  }

  // A signature that does not verify is FRAUD, not a footnote. The entry is genuinely in
  // the batch — that is what makes it dangerous: it would read as a verified call from
  // someone who never made it.
  const sigState = checkEntrySignature(receipt.entry);

  // An unrecognised row family is UNKNOWN, and it must be caught BEFORE the signature branch —
  // that branch only fires on `signed && !ok`, so an UNSIGNED row carrying an invented protocol
  // tag fell straight through it to VERIFIED. Found by the test below, not by reading the code:
  // I wrote the classifier to refuse to guess and then left a path where nothing consulted it.
  if (sigState.family === null) {
    return {
      verdict: UNKNOWN, entryHash, computedRoot, slot: anchor.slot, blockTime: anchor.blockTime,
      signer: anchor.signer, leafCount: onChainCount, chainHead: anchor.parsed.head,
      notes, sigState, family: null, rowType: receipt.entry?.type ?? null, isPosition: false,
      reasons: [
        `This row declares protocol "${sigState.unknownTag}", which this verifier does not know.`,
        'It is genuinely inside the anchored batch — the chain part checks out. What cannot be',
        'checked is what the row MEANS, and a verifier that guesses would report a row family',
        'invented after it was written as though it were a call.',
      ],
    };
  }

  if (sigState.signed && !sigState.ok) {
    return {
      verdict: FRAUD, entryHash, computedRoot, slot: anchor.slot, blockTime: anchor.blockTime,
      signer: anchor.signer, leafCount: onChainCount, chainHead: anchor.parsed.head, notes,
      sigState,
      reasons: [
        `This entry claims to be signed by ${sigState.signer} but the signature is invalid.`,
        sigState.reason,
        'It is genuinely inside the anchored batch, which is what makes this worse, not better:',
        'it would otherwise read as a verified call from someone who never made it.',
      ],
    };
  }

  // The row is genuine and anchored. The remaining question is whether it is the KIND of row
  // the reader came here about — hermessol's slot test. Asked without an expectation, we still
  // refuse to be silent: `family`/`rowType` ride on every verdict and the banner prints them.
  const family = sigState.family ?? null;
  const rowType = receipt.entry?.type ?? null;
  const common = {
    entryHash, computedRoot, slot: anchor.slot, blockTime: anchor.blockTime,
    signer: anchor.signer, leafCount: onChainCount, chainHead: anchor.parsed.head,
    notes, sigState, family, rowType,
    isPosition: family === 'call' || (family === 'window' && !NOT_A_POSITION.has(rowType)),
  };

  if (expect !== null && family !== expect) {
    const article = (n) => (/^[aeiou]/i.test(n ?? '') ? 'an' : 'a');
    const wanted = FAMILIES[expect]?.noun ?? expect;
    return {
      verdict: MISMATCH, ...common,
      reasons: [
        `You asked to verify ${article(wanted)} ${wanted}.`,
        `What this receipt actually contains is ${article(FAMILIES[family]?.noun ?? family)} ${FAMILIES[family]?.noun ?? family}`
          + `${rowType ? ` of type "${rowType}"` : ''}, signed under ${FAMILIES[family]?.domain}.`,
        'The row itself is genuine and anchored — this is not a forgery, and its signer did',
        'nothing wrong. It is simply not the thing you asked about, and a verifier that let',
        'the two render the same is how a declined question reads as a call that was made.',
      ],
    };
  }

  return { verdict: VERIFIED, ...common };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function fmtTime(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : 'unknown';
}

async function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    console.log(`tape-verify — check a TAPE receipt against Solana, with no TAPE server involved.

  node tape-verify.mjs <receipt.json> [--rpc <url>] [--json] [--expect call|window|pledge]

A receipt is { entry, proof, anchor:{signature} }. The verdict comes from the chain:
  exit 0  VERIFIED  this exact entry was committed under the on-chain root at that slot
  exit 1  FRAUD     the chain says something different from the receipt
  exit 2  UNKNOWN   could not find out (RPC unreachable, tx not indexed, bad receipt)
  exit 3  MISMATCH  the row is genuine and anchored, but it is not the KIND you asked for

--expect is how you pin the slot. Without it this tool still names the family and type of
every row it verifies, because "VERIFIED" on its own does not say what was verified — and a
window \`pass\` (a caller DECLINING a question) must never read as a call that was made.

Default RPC ${DEFAULT_RPC} — override it. Do not take our word for the source either.`);
    return 0;
  }

  // Flag values must not be mistaken for the filename. The old finder used indexOf(a), which
  // returns the FIRST match, so a repeated token silently resolved to the wrong position.
  const FLAGS_WITH_VALUES = new Set(['--rpc', '--expect']);
  let file = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { if (FLAGS_WITH_VALUES.has(args[i])) i++; continue; }
    if (file === null) file = args[i];
  }
  const valueOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const rpcUrl = valueOf('--rpc') ?? DEFAULT_RPC;
  const asJson = args.includes('--json');
  const expect = valueOf('--expect');
  if (expect !== null && !Object.hasOwn(FAMILIES, expect)) {
    console.error(`UNKNOWN — --expect must be one of ${Object.keys(FAMILIES).join(', ')}, got "${expect}"`);
    return 2;
  }

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`UNKNOWN — could not read receipt: ${e.message}`);
    return 2;
  }

  // GET /tape/api/entry/<seq> answers { ok, receipt, verify_with }, while POST /call and the
  // client both save the bare { entry, proof, anchor }. Both are "a receipt" to anyone who did
  // not write this code. We used to accept only the bare shape, and the API's own verify_with
  // string told the reader to strip the wrapper by hand before the tool would run — so the
  // documented path from "fetch a receipt" to "check it against Solana" had a manual JSON edit
  // in the middle of it, at exactly the step where the whole don't-trust-us claim is cashed.
  // Unwrap it here instead. Being liberal about the envelope costs nothing; the verdict below
  // is unchanged and still comes from the chain.
  if (receipt && typeof receipt === 'object' && !receipt.entry
      && receipt.receipt && typeof receipt.receipt === 'object') {
    receipt = receipt.receipt;
  }

  const result = await verifyReceipt(receipt, { rpcUrl, expect });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.verdict === VERIFIED) {
    const noun = FAMILIES[result.family]?.noun ?? result.family ?? 'row';
    console.log(`VERIFIED — ${noun}${result.rowType ? ` of type "${result.rowType}"` : ''}

  entry hash   ${result.entryHash}
  merkle root  ${result.computedRoot}  (recomputed, matches chain)
  slot         ${result.slot}
  block time   ${fmtTime(result.blockTime)}
  anchored by  ${result.signer}
  batch size   ${result.leafCount} entries
  row kind     ${noun}${result.rowType ? ` / ${result.rowType}` : ''} (domain ${FAMILIES[result.family]?.domain})
  signed by    ${result.sigState?.signed
    ? `${result.sigState.signer} (signature verified — this key said it)`
    : 'UNSIGNED (T0) — the name on this row is one anyone could type'}

This ${noun} existed, in exactly this form, no later than slot ${result.slot}.
Checked against ${rpcUrl}; no TAPE service was contacted.`);
    // The line that was missing, and the whole of finding #588. Anchoring proves a row was
    // said. It says nothing about whether the row is a position, and only one of those two
    // is what a reader handed a "receipt" believes they are looking at.
    if (!result.isPosition) {
      console.log(`
  ⚠ THIS IS NOT A CALL. A "${result.rowType}" row is part of the assigned-question
    mechanism, not a position anyone took. Do not read this green as a trade.`);
    }
    for (const n of result.notes) console.log(`  ${n}`);
  } else {
    console.log(result.verdict);
    for (const r of result.reasons ?? []) console.log(`  ${r}`);
    for (const n of result.notes) console.log(`  ${n}`);
  }

  return result.verdict === VERIFIED ? 0
    : result.verdict === FRAUD ? 1
    : result.verdict === MISMATCH ? 3 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).then((c) => { process.exitCode = c; });
}

export { canonicalize, base58Decode, rootFromProof, fetchAnchor, classify, VERIFIED, FRAUD, UNKNOWN, MISMATCH };
