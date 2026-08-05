#!/usr/bin/env node
/**
 * tape-schedule.mjs — recompute every assigned question, from public data, without us.
 *
 * WHY THIS FILE EXISTS.
 * The window mechanism claims the board cannot choose which questions a caller gets. The
 * mechanism is commit-reveal: we publish H(seed) before enrolment closes, freeze the
 * enrolled set, and only then reveal the seed, after which every question is a pure
 * function of public data. That is a good design and it is worth exactly nothing on its
 * own, because "we derived these honestly" is a promise, and replacing promises with
 * recomputation is the entire point of the project.
 *
 * So this file is the thing that makes the claim checkable. It re-derives every question
 * we ever asked and says MISMATCH if any of them is not what the public inputs produce.
 *
 * SAME HARD RULE AS tape-verify.mjs: NOTHING WE OPERATE MAY APPEAR IN THE CHECK PATH.
 *   - zero imports from ../lib. The canonicalizer, base58, the catalog and the derivation
 *     below are INDEPENDENT REIMPLEMENTATIONS written from the spec. If they imported our
 *     code, a bug or an edit in our library would be invisible here, because both sides
 *     would be wrong in the same direction. Two implementations agreeing is evidence. One
 *     implementation checking itself is a tautology.
 *   - zero npm dependencies. It runs on a clean box with node and nothing else.
 *   - it reads the chain from the API because that is where the record lives, but it
 *     believes none of the API's own conclusions. Every verdict below is recomputed from
 *     the raw rows.
 *
 * WHAT IT CHECKS THAT lib/schedule-check.js DOES NOT.
 * Our internal checker takes the enrolled set as an OPTIONAL argument and checks neither
 * ordering nor completeness. Those are the three places an operator would actually cheat,
 * so they are not optional here:
 *
 *   ORDER        — the commitment must be sequenced AND anchored before enrolment closed,
 *                  and the seed revealed only after. Sequence numbers are our word; the
 *                  Solana slots are not, and both are checked and reported separately.
 *   ENROLMENT    — enrolled_root is recomputed from the enroll rows on the chain, never
 *                  taken on trust, and no enroll row may be sequenced after the close.
 *   COMPLETENESS — every enrolled caller must have exactly windows_per_caller questions,
 *                  indices 0..n-1. Minting three questions for a friendly caller and none
 *                  for a hostile one passes every per-question derivation check ever
 *                  written, and it is the cheapest possible way to fake this mechanism.
 *   SETTLEMENT   — an expired window with no answer, pass or no_answer row means the board
 *                  withheld the one row a caller cannot withhold. That is the whole claim
 *                  failing silently, and it looks like a clean record.
 *
 * THREE OUTCOMES, exit codes 0 / 1 / 2, deliberately distinct:
 *   VERIFIED — every question is the question the public inputs derive.
 *   MISMATCH — something does not reconstruct. Loud, itemised, and it is an accusation.
 *   UNKNOWN  — we could not find out (API unreachable, epoch not revealed yet).
 *
 * UNKNOWN is separate on purpose. Folding it into VERIFIED turns an outage into a rubber
 * stamp; folding it into MISMATCH accuses an honest operator of a network failure.
 *
 *   node tape-schedule.mjs                 check every epoch on the tape
 *   node tape-schedule.mjs W31             check one epoch
 *   node tape-schedule.mjs --api https://tape.drainfun.xyz/api
 */

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const DEFAULT_API = process.env.TAPE_API || 'https://tape.drainfun.xyz/api';

/* ------------------------------------------------------------------ *
 * base58 — decoded here rather than imported, see header.
 * ------------------------------------------------------------------ */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, i]));

function base58Decode(str) {
  const bytes = [0];
  for (const ch of String(str)) {
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
  for (const ch of String(str)) { if (ch !== '1') break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}

/* ------------------------------------------------------------------ *
 * canonical JSON — keys sorted, raw numbers refused.
 * Reimplemented from the spec, not shared. A canonicalizer that drifts from the producer's
 * is the one bug that would make every hash below wrong in a way that still looks tidy.
 * ------------------------------------------------------------------ */
function canonicalize(value, at = '$') {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') throw new Error(`canonical: raw number at ${at} — quantities must be decimal strings`);
  if (t === 'undefined') throw new Error(`canonical: undefined at ${at}`);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v, i) => canonicalize(v, `${at}[${i}]`)).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => {
      if (value[k] === undefined) throw new Error(`canonical: undefined value at ${at}.${k}`);
      return JSON.stringify(k) + ':' + canonicalize(value[k], `${at}.${k}`);
    }).join(',') + '}';
  }
  throw new Error(`canonical: unhandled value at ${at}`);
}

const sha256hex = (str) => createHash('sha256').update(str, 'utf8').digest('hex');

/* ------------------------------------------------------------------ *
 * ed25519 — raw 32-byte key wrapped into SPKI so node will accept it.
 * ------------------------------------------------------------------ */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const WINDOW_SIG_DOMAIN = 'tape:v1:window:';

function verifyRowSignature(entry) {
  const signer = entry.signer ?? null;
  const sig = entry.sig ?? null;
  if (signer === null && sig === null) return { signed: false, ok: false };
  if (signer === null || sig === null) return { signed: true, ok: false };
  try {
    const msg = Buffer.from(WINDOW_SIG_DOMAIN + canonicalize({ ...entry, sig: null }), 'utf8');
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, base58Decode(signer)]), format: 'der', type: 'spki',
    });
    return { signed: true, ok: edVerify(null, msg, key, base58Decode(sig)) };
  } catch {
    return { signed: true, ok: false };
  }
}

/* ------------------------------------------------------------------ *
 * The question catalog, copied here as an independent constant.
 *
 * This is not duplication for its own sake. The commitment names a catalog_hash; if we
 * quietly widened the pool after committing, the only way anyone finds out is by hashing a
 * catalog they hold themselves and getting a different answer. A verifier that read the
 * catalog from the same place the board reads it could never detect that.
 * ------------------------------------------------------------------ */
const CATALOG = [
  { asset: 'SOL/USD', horizon_sec: '86400' },
  { asset: 'SOL/USD', horizon_sec: '604800' },
  { asset: 'BTC/USD', horizon_sec: '86400' },
  { asset: 'BTC/USD', horizon_sec: '604800' },
  { asset: 'ETH/USD', horizon_sec: '86400' },
  { asset: 'ETH/USD', horizon_sec: '604800' },
];

const catalogHash = (catalog = CATALOG) => sha256hex(canonicalize(catalog));

/** Hash of the enrolled SET — sorted, so it is a property of the members and not of the
 *  order the operator happened to write them in. An operator who could reorder could grind
 *  the root, and the root feeds question derivation. */
const enrolledRoot = (keys) => sha256hex(canonicalize({
  p: 'tape-enrolled', v: '1', keys: [...new Set(keys)].sort(),
}));

/**
 * drand quicknet, the public beacon derivation v2 mixes into the seed.
 *
 * Inlined, and NOT fetched from the same place as the values it identifies. The BLS
 * signature on a round cannot be checked here — this file has no npm dependencies and BLS
 * over BLS12-381 is not in node's crypto. What it does instead is stronger against the
 * threat this file exists for: it re-fetches the round FROM DRAND, which we do not operate,
 * and compares. A board that invented a beacon value is caught by a source it cannot reach.
 * `lib/beacon.js` does verify the signature; a reader who wants both runs both.
 */
const DRAND = {
  chain_hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  genesis_time: 1692803367,
  period: 3,
  mirrors: ['https://api.drand.sh', 'https://drand.cloudflare.com'],
};
const drandRoundTime = (round) => DRAND.genesis_time + (Number(round) - 1) * DRAND.period;

/** Fold the beacon into the board's seed. v2 only. */
const mixSeed = (seed, beacon_randomness) => sha256hex(canonicalize({
  p: 'tape-seed', v: '2', seed: String(seed), beacon_randomness: String(beacon_randomness),
}));

/** The derivation, reimplemented. Same inputs, same question, on anyone's machine. */
function deriveQuestion({ seed, enrolled_root, beacon_randomness, caller_key, window_index, catalog = CATALOG, version = '1' }) {
  const material = String(version) === '2'
    ? canonicalize({
      p: 'tape-derive', v: '2',
      seed: mixSeed(seed, beacon_randomness),
      caller_key: String(caller_key),
      window_index: String(window_index),
    })
    : canonicalize({
      p: 'tape-derive', v: '1',
      seed: String(seed),
      enrolled_root: String(enrolled_root),
      caller_key: String(caller_key),
      window_index: String(window_index),
    });
  const digest = createHash('sha256').update(material, 'utf8').digest();
  // Modulo over the whole 256-bit digest. Reducing a truncated slice would be uniform
  // enough for a six-item catalog and wrong the moment the catalog is not a power of two.
  const idx = Number(BigInt('0x' + digest.toString('hex')) % BigInt(catalog.length));
  return { index: idx, asset: catalog[idx].asset, horizon_sec: Number(catalog[idx].horizon_sec) };
}

/** Parse a question market id back into its parts. Null if it is not one. */
function parseQuestionMarket(market) {
  const m = /^pyth:([A-Z]+\/[A-Z]+):higher_at_(\d+)_than_(\d+)$/.exec(String(market || ''));
  if (!m) return null;
  const settle_at = Number(m[2]);
  const opens_at = Number(m[3]);
  if (!(settle_at > opens_at)) return null;
  return { asset: m[1], opens_at, settle_at, horizon_sec: settle_at - opens_at };
}

/* ------------------------------------------------------------------ *
 * fetch the rows
 * ------------------------------------------------------------------ */
/**
 * Read the WHOLE tape, in pages.
 *
 * The first version asked for limit=100000 and refused to render a verdict if fewer rows
 * came back than the chain holds. Failing closed was right; being unable to succeed was
 * not. The API clamps `limit` to 500, so the moment the tape passed five hundred rows this
 * verifier would have returned UNKNOWN forever — and anyone can push it there, since keys
 * are free and posting is open. "Verify we did not hand-pick your questions" would have
 * become permanently unavailable, by a route that costs an attacker about a second.
 *
 * So it pages with a cursor and still refuses to guess: if the walk cannot account for
 * every row the chain claims, that is UNKNOWN, not a pass.
 */
async function fetchWindowRows(api) {
  const base = api.replace(/\/$/, '');
  const get = async (url) => {
    let res;
    try { res = await fetch(url); }
    catch (e) { throw new Unknown(`could not reach ${url} (${e.message})`); }
    if (!res.ok) throw new Unknown(`${url} returned HTTP ${res.status}`);
    let body;
    try { body = await res.json(); }
    catch (e) { throw new Unknown(`${url} did not return JSON (${e.message})`); }
    if (!body || body.ok !== true || !Array.isArray(body.entries)) {
      throw new Unknown(`${url} returned an unexpected shape`);
    }
    return body;
  };

  // include=all is required: /calls means CALLS and hides window rows by default.
  const first = await get(`${base}/calls?include=all&limit=500`);
  const total = typeof first.chain_entries === 'number' ? first.chain_entries : null;
  const seen = new Map();
  const take = (body) => { for (const r of body.entries) seen.set(r.seq, r); };
  take(first);

  if (total !== null && seen.size < total) {
    let cursor = -1;
    // Bounded so a server that never advances the cursor cannot spin us forever. The bound
    // is derived from the row count it reported, plus slack for rows appended while we walk.
    for (let page = 0; page < Math.ceil(total / 500) + 5 && seen.size < total; page++) {
      const body = await get(`${base}/calls?include=all&limit=500&since_seq=${cursor}`);
      if (!body.entries.length) break;
      const before = seen.size;
      take(body);
      const next = body.next_since_seq;
      if (next === null || next === undefined || next <= cursor || seen.size === before) {
        throw new Unknown(
          `paging stalled at cursor ${cursor} after ${seen.size} of ${total} rows — this API does `
          + 'not support walking the whole tape, so no verdict here could cover all of it');
      }
      cursor = next;
    }
  }

  if (total !== null && seen.size < total) {
    throw new Unknown(
      `read ${seen.size} of ${total} rows — the tape could not be walked in full, so any verdict `
      + 'would cover only part of the record');
  }
  return [...seen.values()].filter((r) => r && r.entry && r.entry.p === 'tape-window');
}

class Unknown extends Error {}

/* ------------------------------------------------------------------ *
 * the check
 * ------------------------------------------------------------------ */
async function checkEpoch(name, rows, problems, notes) {
  const of = (type) => rows.filter((r) => r.entry.type === type);
  const say = (msg) => problems.push(`epoch ${name}: ${msg}`);

  const commits = of('schedule_commit');
  const closes = of('enrollment_close');
  const reveals = of('seed_reveal');
  const questions = of('question');
  const enrolls = of('enroll');

  // Two commitments for one epoch is not a duplicate, it is a choice: whichever seed
  // produced the more convenient questions can be pointed at afterwards.
  if (commits.length > 1) say(`${commits.length} schedule_commit rows — a commitment that can be reissued is not a commitment`);
  if (closes.length > 1) say(`${closes.length} enrollment_close rows — the enrolled set was frozen more than once`);
  if (reveals.length > 1) say(`${reveals.length} seed_reveal rows — the seed was revealed more than once`);

  const commit = commits[0], close = closes[0], reveal = reveals[0];

  /**
   * `schedule_void` — retraction, and the surface I forgot.
   *
   * We void an epoch by appending a row rather than deleting one, and the board and
   * /api/windows both learned to filter it the same hour. This file did not, so for as long
   * as that gap lasted the INDEPENDENT verifier — the one an outside auditor is pointed at
   * precisely because it does not ask us anything — kept reporting a retracted epoch as
   * "stage: enrolment open". The surface I was looking at got fixed and the surface that
   * matters did not, which is the same shape as shipping a fix to the dashboard and not the
   * data. Found by running this tool while checking something else, not by a test.
   *
   * The two invariants are enforced here rather than trusted, because a void that is not
   * constrained is just a delete with better manners:
   *   - a voided epoch may never be closed, revealed, or asked
   *   - voiding an epoch that ALREADY has questions is itself a violation — retraction must
   *     not be a way to un-ask a question whose answer turned out badly
   */
  const voids = of('schedule_void');
  if (voids.length) {
    if (voids.length > 1) say(`${voids.length} schedule_void rows — an epoch can only be retracted once`);
    if (questions.length) {
      say(`voided, but ${questions.length} question(s) were already minted — retraction must not `
        + 'be a way to un-ask a question after seeing how it went');
      return 0;
    }
    for (const [label, row] of [['enrollment_close', close], ['seed_reveal', reveal]]) {
      if (row) say(`voided, but a ${label} row exists at seq ${row.seq} — a retracted epoch may `
        + 'never be closed, revealed or asked');
    }
    notes.push(`epoch ${name}: VOIDED (retracted at seq ${voids[0].seq}) — not open, no questions, `
      + 'nothing to derive. The commit row stays on the chain; the retraction is appended, not deleted.');
    return 0;
  }

  if (!commit) {
    if (questions.length) say(`${questions.length} question(s) but no schedule_commit — nothing binds which questions were asked`);
    return 0;
  }
  if (!questions.length) {
    notes.push(`epoch ${name}: no questions minted yet (stage: ${reveal ? 'revealed' : close ? 'closed' : 'enrolment open'})`);
    return 0;
  }
  if (!close) { say('questions exist but the enrolled set was never frozen'); return 0; }
  if (!reveal) { say('questions exist but the seed was never revealed — they cannot be re-derived'); return 0; }

  /* --- the commitment must open ------------------------------------------- */
  const opened = sha256hex(String(reveal.entry.seed));
  if (opened !== commit.entry.seed_commit) {
    say(`the revealed seed does not open the commitment (H(seed)=${opened.slice(0, 12)}… `
      + `committed=${String(commit.entry.seed_commit).slice(0, 12)}…) — the schedule was chosen after the fact`);
    return 0;   // every derivation below would be meaningless
  }

  /* --- the catalog must be the one committed to ---------------------------- */
  const haveCatalog = catalogHash();
  if (haveCatalog !== commit.entry.catalog_hash) {
    say(`catalog hash mismatch (this verifier holds ${haveCatalog.slice(0, 12)}…, the commitment `
      + `names ${String(commit.entry.catalog_hash).slice(0, 12)}…) — the question pool is not the one `
      + 'that was committed to, or this verifier is out of date');
  }

  /* --- ORDER. our sequence numbers, and Solana's slots, checked separately --- */
  const ordered = [['schedule_commit', commit], ['enrollment_close', close], ['seed_reveal', reveal]];
  for (let i = 0; i < ordered.length - 1; i++) {
    const [aName, a] = ordered[i], [bName, b] = ordered[i + 1];
    if (!(a.seq < b.seq)) {
      say(`${aName} is at seq ${a.seq} and ${bName} at seq ${b.seq} — out of order, so the `
        + 'commitment did not precede the thing it is supposed to bind');
    }
    // Slots come from Solana, which we do not operate. This is the half of the ordering
    // claim that does not rest on our own numbering.
    if (a.anchor && b.anchor && a.anchor.slot > b.anchor.slot) {
      say(`${aName} anchored at slot ${a.anchor.slot} but ${bName} at slot ${b.anchor.slot} — `
        + 'the chain of custody is out of order on Solana, not just in our sequence');
    }
  }
  const firstQ = Math.min(...questions.map((q) => q.seq));
  if (!(reveal.seq < firstQ)) {
    say(`a question is at seq ${firstQ}, at or before the seed_reveal at seq ${reveal.seq} — `
      + 'a question that predates the seed was not derived from it');
  }
  if (!commit.anchor) {
    notes.push(`epoch ${name}: the schedule_commit is not anchored yet, so its ordering rests on `
      + 'our sequence numbers alone — which are ours');
  }

  /* --- ENROLMENT. recomputed, never taken on trust ------------------------- */
  const lateEnrols = enrolls.filter((e) => e.seq > close.seq);
  for (const e of lateEnrols) {
    say(`${String(e.entry.signer).slice(0, 8)}… enrolled at seq ${e.seq}, AFTER enrolment closed at `
      + `seq ${close.seq} — enrolling once the questions are derivable is the discretion the `
      + 'commit-reveal is supposed to remove');
  }
  const enrolledKeys = enrolls.filter((e) => e.seq < close.seq).map((e) => e.entry.signer).filter(Boolean);
  const haveRoot = enrolledRoot(enrolledKeys);
  if (haveRoot !== close.entry.enrolled_root) {
    say(`enrolled_root does not match the enroll rows on the chain (recomputed ${haveRoot.slice(0, 12)}…, `
      + `published ${String(close.entry.enrolled_root).slice(0, 12)}…) — the frozen set is not the set `
      + 'that actually enrolled');
  }
  if (Number(close.entry.enrolled_count) !== enrolledKeys.length) {
    say(`enrolled_count says ${close.entry.enrolled_count} but ${enrolledKeys.length} enroll row(s) `
      + 'precede the close');
  }

  /* --- WHICH RULE THIS EPOCH WAS DERIVED UNDER ------------------------------
   * Read from the COMMITMENT, never from this file's newest default. Re-deriving an old
   * epoch under a newer rule, or a new one under an older rule, is the same act as choosing
   * the questions: whichever version produced the nicer answer could be pointed at later.
   * v1 epochs stay v1 forever. */
  const version = commit.entry.derivation === undefined ? '1' : String(commit.entry.derivation);
  let deriveExtra = { enrolled_root: close.entry.enrolled_root };
  if (version !== '1' && version !== '2') {
    say(`the commitment names derivation ${JSON.stringify(version)}, which this verifier does not `
      + 'implement — do not read a pass below as covering these questions');
    return 0;
  }
  if (version === '2') {
    const committedRound = String(commit.entry.beacon_round);
    const revealedRound = String(reveal.entry.beacon_round ?? '');
    const randomness = String(reveal.entry.beacon_randomness ?? '');
    const sig = String(reveal.entry.beacon_sig ?? '');
    if (!revealedRound || !randomness || !sig) {
      say('derivation 2, but the seed_reveal carries no beacon — without it the seed is the '
        + 'board\'s alone, which is the thing v2 exists to prevent');
      return 0;
    }
    if (revealedRound !== committedRound) {
      say(`the commitment named beacon round ${committedRound} and the reveal used ${revealedRound} `
        + '— a round swapped after its value was visible is a chosen number');
      return 0;
    }
    if (String(commit.entry.beacon_chain) !== DRAND.chain_hash) {
      say(`beacon_chain ${String(commit.entry.beacon_chain).slice(0, 12)}… is not the drand quicknet `
        + 'chain this verifier knows — an unknown beacon is not an external one');
      return 0;
    }
    // randomness is DEFINED as H(signature). This is checkable with node alone and it is
    // what stops a published randomness from being a number typed next to a real signature.
    const wantRand = createHash('sha256').update(Buffer.from(sig, 'hex')).digest('hex');
    if (wantRand !== randomness) {
      say('the published beacon randomness is not sha256(beacon_sig) — the value feeding every '
        + 'question does not follow from the signature offered as its evidence');
      return 0;
    }
    if (drandRoundTime(committedRound) <= Number(commit.entry.enroll_closes_at)) {
      say(`beacon round ${committedRound} was published at `
        + `${new Date(drandRoundTime(committedRound) * 1000).toISOString()}, at or before enrolment closed `
        + `at ${new Date(Number(commit.entry.enroll_closes_at) * 1000).toISOString()} — a caller could `
        + 'have waited to see it before deciding to enrol');
    }
    // THE CHECK THAT MATTERS: ask drand, not the board. This file cannot verify the BLS
    // signature without a dependency, so instead it fetches the round from a source the
    // board does not operate and compares bytes. An invented beacon dies here.
    let external = null;
    for (const m of DRAND.mirrors) {
      try {
        const res = await fetch(`${m}/${DRAND.chain_hash}/public/${committedRound}`);
        if (!res.ok) continue;
        const body = await res.json();
        if (body && body.signature) { external = { mirror: m, signature: String(body.signature) }; break; }
      } catch { /* try the next mirror */ }
    }
    if (!external) {
      // UNKNOWN, not MISMATCH. An unreachable beacon is a fact about the network.
      notes.push(`epoch ${name}: could not reach drand to cross-check beacon round ${committedRound}, `
        + 'so the beacon below rests on the board\'s copy. Run lib/beacon.js to check its BLS signature offline.');
    } else if (external.signature !== sig) {
      say(`beacon round ${committedRound} is ${external.signature.slice(0, 16)}… at ${external.mirror} `
        + `but ${sig.slice(0, 16)}… on the tape — THE BEACON WAS INVENTED`);
      return 0;
    } else {
      notes.push(`epoch ${name}: beacon round ${committedRound} matches ${external.mirror} byte for byte, `
        + 'and it was published after enrolment closed — neither side could grind it');
    }
    deriveExtra = { beacon_randomness: randomness };
  }

  /* --- every question re-derives ------------------------------------------- */
  const now = Math.floor(Date.now() / 1000);
  let checked = 0;
  for (const q of questions) {
    const where = `window ${q.entry.window_index} for ${String(q.entry.caller_key).slice(0, 8)}…`;
    if (!enrolledKeys.includes(q.entry.caller_key)) {
      say(`${where}: that caller is not in the enrolled set`);
      continue;
    }
    const parsed = parseQuestionMarket(q.entry.market);
    if (!parsed) { say(`${where}: market is unparseable (${q.entry.market})`); continue; }

    let derived;
    try {
      derived = deriveQuestion({
        seed: reveal.entry.seed,
        ...deriveExtra,
        caller_key: q.entry.caller_key,
        window_index: Number(q.entry.window_index),
        version,
      });
    } catch (e) { say(`${where}: could not derive (${e.message})`); continue; }

    checked += 1;
    if (derived.asset !== parsed.asset || derived.horizon_sec !== parsed.horizon_sec) {
      say(`${where}: was asked ${parsed.asset}/${parsed.horizon_sec}s but the public inputs derive `
        + `${derived.asset}/${derived.horizon_sec}s — THIS QUESTION WAS NOT DERIVED, IT WAS CHOSEN`);
    }
    if (Number(q.entry.expires_at) <= Number(q.entry.opens_at)) {
      say(`${where}: expires_at is not after opens_at — the window is empty and cannot be answered`);
    }

    /* --- WHEN the window is, which derivation does not fix -------------------
     *
     * The seed fixes WHICH asset and horizon a caller gets. It fixes nothing about the
     * clock. So a board that derived every question perfectly could still stamp them
     * `opens_at` a week ago and `expires_at` six days ago, mint them today, and sweep: the
     * caller had zero seconds to answer a question that did not exist until after its own
     * window shut, and the public record reads `no_answer`. Every derivation check above
     * passes. The completeness check passes. It looked exactly like an honest round.
     *
     * The fix cannot be another field the board fills in, because the board fills in the
     * fields. It has to be a clock the board does not own, which is the anchor: a Solana
     * slot's block time is an upper bound on when a row existed, produced by validators we
     * do not operate. Two things follow and both are checked here.
     */
    const bt = q.anchor && q.anchor.block_time;
    if (bt) {
      if (bt > Number(q.entry.expires_at)) {
        say(`${where}: Solana did not carry this question until ${new Date(bt * 1000).toISOString()}, `
          + `after its own window shut at ${new Date(Number(q.entry.expires_at) * 1000).toISOString()} `
          + '— NOBODY COULD HAVE ANSWERED IT. The window was minted already dead.');
      }
      if (bt >= parsed.settle_at) {
        say(`${where}: the market settled at ${new Date(parsed.settle_at * 1000).toISOString()} but this `
          + `question was not on chain until ${new Date(bt * 1000).toISOString()} — the answer was `
          + 'already knowable when the question was asked');
      }
    } else if (now > Number(q.entry.expires_at)) {
      // Not an accusation. An unanchored expired question simply cannot be shown to have
      // existed while it was answerable, and saying so is the honest report.
      notes.push(`epoch ${name} ${where}: expired and never anchored, so there is no independent `
        + 'evidence it existed while it was open — treat its outcome as unproven');
    }
  }

  /* --- COMPLETENESS. the cheap way to fake all of the above ---------------- */
  const perCaller = Number(commit.entry.windows_per_caller);
  for (const key of [...new Set(enrolledKeys)]) {
    const mine = questions.filter((q) => q.entry.caller_key === key);
    const indices = mine.map((q) => Number(q.entry.window_index)).sort((a, b) => a - b);
    const want = [...Array(perCaller).keys()];
    if (canonicalize(indices.map(String)) !== canonicalize(want.map(String))) {
      say(`${String(key).slice(0, 8)}… enrolled and should hold windows [${want.join(',')}] but holds `
        + `[${indices.join(',')}] — questions were minted unevenly, which lets a caller be spared `
        + 'the ones they would have failed');
    }
  }

  /* --- SETTLEMENT. the row a caller cannot withhold, and neither can we ----- */
  const settlements = rows.filter((r) => ['answer', 'pass', 'no_answer'].includes(r.entry.type));
  for (const q of questions) {
    const mine = settlements.filter((s) => s.entry.question_hash === q.entry_hash);
    const where = `window ${q.entry.window_index} for ${String(q.entry.caller_key).slice(0, 8)}…`;
    if (mine.length > 1) {
      say(`${where}: settled ${mine.length} times (${mine.map((m) => m.entry.type).join(', ')}) — a window resolves once`);
    }
    if (!mine.length && now > Number(q.entry.expires_at)) {
      say(`${where}: expired at ${new Date(Number(q.entry.expires_at) * 1000).toISOString()} with no `
        + 'answer, pass or no_answer — the board did not write the row the caller cannot withhold, '
        + 'so this silence left no trace');
    }
    for (const s of mine) {
      // A caller must not be able to author their own non-answer, and the board must not be
      // able to author a caller's answer. Each row is checked against the key that has
      // standing to write it.
      const wantSigner = s.entry.type === 'no_answer' ? commit.entry.signer : q.entry.caller_key;
      if (s.entry.signer !== wantSigner) {
        say(`${where}: the ${s.entry.type} row is signed by ${String(s.entry.signer).slice(0, 8)}… but `
          + `only ${String(wantSigner).slice(0, 8)}… has standing to write it`);
      }
    }
  }

  /* --- signatures on every row in the epoch -------------------------------- */
  const boardTypes = new Set(['schedule_commit', 'enrollment_close', 'seed_reveal', 'question', 'no_answer']);
  for (const r of rows) {
    const v = verifyRowSignature(r.entry);
    if (!v.signed) { say(`a ${r.entry.type} row at seq ${r.seq} is unsigned`); continue; }
    if (!v.ok) { say(`the signature on the ${r.entry.type} row at seq ${r.seq} does not verify`); continue; }
    if (boardTypes.has(r.entry.type) && r.entry.signer !== commit.entry.signer) {
      say(`a ${r.entry.type} row at seq ${r.seq} is signed by ${String(r.entry.signer).slice(0, 8)}…, not by `
        + `the key that made the commitment (${String(commit.entry.signer).slice(0, 8)}…)`);
    }
  }

  notes.push(`epoch ${name}: ${checked} question(s) re-derived, ${enrolledKeys.length} caller(s) enrolled, `
    + `board key ${String(commit.entry.signer).slice(0, 12)}…`);
  return checked;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i + 1];
}

async function main() {
  const api = argOf('api', DEFAULT_API);
  const only = process.argv.slice(2).find((a) => !a.startsWith('--')
    && process.argv[process.argv.indexOf(a) - 1] !== '--api');

  const rows = await fetchWindowRows(api);
  if (!rows.length) {
    console.log('UNKNOWN');
    console.log(`  no window rows on the tape at ${api}. Nothing to check yet — which is not the`);
    console.log('  same as nothing being wrong.');
    process.exit(2);
  }

  // answer / pass / no_answer rows carry a question_hash and no epoch, so they are grouped
  // by the epoch of the question they settle rather than by a field they do not have.
  const epochOfQuestion = new Map();
  for (const r of rows) if (r.entry.type === 'question') epochOfQuestion.set(r.entry_hash, r.entry.epoch);
  // sweep_report is board TESTIMONY, not a settlement: it records that the sweep looked,
  // including on the runs that found nothing. It deliberately carries neither an epoch nor
  // a question_hash, because it is about an instant in time rather than about one round or
  // one question. Without this skip it landed in `orphans` and was reported as "settles
  // question undefined… which is not on the tape" -- 216 fabricated findings against a
  // clean record, turning the whole run into MISMATCH.
  //
  // That is the exact failure the spec names in 8c: a row family only one of the two
  // implementations recognises produces a MISMATCH that means nothing, which is worse than
  // no verifier at all. A verifier whose accusations are noise cannot convict anyone,
  // including us -- and being able to convict us is the entire claim.
  //
  // Narrow on purpose. Only this type is skipped; a genuinely orphaned answer / pass /
  // no_answer still lands in `orphans` and is still a problem, which the negative control
  // in test/schedule-verifier.test.js pins.
  const TESTIMONY = new Set(['sweep_report']);
  const byEpoch = new Map();
  const orphans = [];
  let testimony = 0;
  for (const r of rows) {
    if (TESTIMONY.has(r.entry.type)) { testimony += 1; continue; }
    const epoch = r.entry.epoch ?? epochOfQuestion.get(r.entry.question_hash);
    if (epoch === undefined) { orphans.push(r); continue; }
    if (!byEpoch.has(epoch)) byEpoch.set(epoch, []);
    byEpoch.get(epoch).push(r);
  }

  const problems = [];
  const notes = [];
  // Say what was set aside. A verifier that silently drops a row family teaches the reader
  // that its silence covers everything it saw, which is the same lie as an untested zero.
  if (testimony) {
    notes.push(`${testimony} sweep_report row(s) set aside: board testimony that the sweep ran, `
      + 'belonging to no epoch and settling no question by design. Their own coverage check is '
      + 'sweepCoverage() — a missing sweep is a dated hole there, not an orphan here.');
  }
  for (const o of orphans) {
    problems.push(`a ${o.entry.type} row at seq ${o.seq} settles question ${String(o.entry.question_hash).slice(0, 12)}… `
      + 'which is not on the tape — a response to a question that was never published');
  }

  let checked = 0;
  const names = [...byEpoch.keys()].filter((n) => !only || n === only).sort();
  if (only && !names.length) {
    console.log('UNKNOWN');
    console.log(`  no epoch named ${JSON.stringify(only)} on the tape at ${api}.`);
    console.log(`  epochs present: ${[...byEpoch.keys()].sort().join(', ') || '(none)'}`);
    process.exit(2);
  }
  for (const name of names) checked += await checkEpoch(name, byEpoch.get(name), problems, notes);

  for (const n of notes) console.log(`  ${n}`);
  console.log('');

  if (problems.length) {
    console.log('MISMATCH');
    console.log(`  ${problems.length} problem(s) across ${names.length} epoch(s). Every one of these is`);
    console.log('  a statement about the operator, not about your network connection:\n');
    for (const p of problems) console.log(`  - ${p}`);
    console.log('\n  Re-run this yourself against any API mirror with --api. The derivation is in this');
    console.log('  file and imports nothing from the people who published the record.');
    process.exit(1);
  }

  if (!checked) {
    console.log('UNKNOWN');
    console.log('  nothing was re-derived: the epochs present have no minted questions yet.');
    process.exit(2);
  }

  console.log('VERIFIED');
  console.log(`  ${checked} question(s) across ${names.length} epoch(s) are exactly what the public`);
  console.log('  inputs derive. The board committed to a seed before it knew who had enrolled, froze');
  console.log('  the set, then revealed — and every question follows from those three facts.');
  console.log('');
  console.log('  WHAT THIS DOES NOT SAY: nothing here judges whether the answers were any good, and');
  console.log('  nothing here closes selection OF enrolled callers. Enrolment is voluntary, so this');
  console.log('  is a claim about the callers who took an assigned question, never about callers in');
  console.log('  general.');
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof Unknown) {
    console.log('UNKNOWN');
    console.log(`  ${e.message}`);
    console.log('  An unreachable record is an absence of evidence, not a clean bill of health.');
    process.exit(2);
  }
  console.log('UNKNOWN');
  console.log(`  the verifier itself failed: ${e.message}`);
  console.log('  Treat this as untrusted, not as a pass.');
  process.exit(2);
});
