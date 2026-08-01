'use strict';
/**
 * windows.js — board-minted questions, so that silence emits a row.
 *
 * WHY THIS EXISTS. Everything else in TAPE secures the SECOND write: once a call exists,
 * it cannot be revised, reordered, backdated or quietly dropped. None of it reaches the
 * FIRST write. A caller who posts three convictions and keeps twelve in their head has a
 * record that is append-only, marked to market, non-backdated, and still a highlight reel.
 * The record is honest about every row it holds and silent about rows never minted, and
 * from outside those two states are byte-identical. Append-only constrains revision. It
 * does not constrain admission. (hermessol, Moltbook, 2026-07-28.)
 *
 * The fix is not a better log. A log is a self-maintained sequence: it numbers what
 * arrived and is clean and unbroken in both worlds. The fix is to change who mints the
 * unit. Today a caller mints a call and we record it — so the head of the sequence is
 * theirs and every downstream guarantee inherits their selection. Here WE mint a question
 * on OUR clock, and the caller's row is one of three: an answer, a pass, or a non-answer
 * that WE write when the window expires, without their cooperation.
 *
 * The general rule, worth stating because it decides every design like this:
 *
 *   A decline emits a row only if the OTHER party holds something with a clock on it.
 *
 * Under the old shape the caller held nothing, so walking away was indistinguishable from
 * never having existed. Under a window they hold an expiring obligation we minted, and its
 * lapse is written by us. The denominator is fixed before they see the question.
 *
 * THE DETAIL THAT DECIDES WHETHER IT COLLAPSES BACK. If we picked questions after seeing
 * who enrolled, we would choose who gets hard ones, and the audited party would be
 * authoring what the audit is measured against — the exact failure the whole project is
 * about, moved one step. So the schedule is committed, not asserted:
 *
 *   1. We publish H(seed) for an epoch BEFORE enrollment for that epoch closes.
 *   2. Enrollment closes; the enrolled set is hashed into `enrolled_root` and anchored.
 *   3. Only then is the seed revealed, and every question for the epoch becomes
 *      derivable BY ANYONE from public data.
 *
 * THAT ORDERING BLOCKS ONE SIDE, AND THIS FILE CLAIMED IT BLOCKED BOTH. The claim that
 * stood here — "a caller cannot grind keys because derivation mixes in enrolled_root, and
 * the seed is unknown until after that" — is true of a caller and false of us. We hold the
 * seed from the moment we commit it. While enrolment is open we can enrol one more key of
 * our own, grind it offline against a seed we already have, and take the questions we like;
 * and because `enrolled_root` feeds every derivation, that same enrolment moves everybody
 * else's questions too. Every check still passes: the seed opens its commitment, the
 * catalog hash matches, every question re-derives. Honest about the second write, authored
 * at element zero. (hermessol, Moltbook, 2026-07-30, sharpened.)
 *
 * Derivation v2 fixes it by taking the seed away from us. `enrolled_root` leaves derivation
 * entirely — it only ever defended against the attacker who could not do this anyway — and
 * the final seed becomes H(our seed ‖ a public drand round named in the commitment and
 * occurring after enrolment closes). We cannot grind because that round does not exist when
 * we commit; a caller cannot grind because our half is still secret while they enrol.
 * See lib/beacon.js for why drand and not a Solana blockhash. Epochs committed under v1
 * stay v1 forever and are re-derived under v1, because rewriting how an old question was
 * derived is the same act as choosing it.
 *
 * WHAT THIS DOES NOT CLOSE, stated here rather than discovered later: it closes selection
 * WITHIN an enrolled caller's record. It does not close selection OF enrolled callers, and
 * nothing can, because enrollment is voluntary and any obligation attached to it changes
 * who accepts. We will select for callers confident enough to take a question they did not
 * choose, which is not a random draw. So a window record is a claim about THIS CALLER and
 * never about the population of callers. That is fine for the job it has and fatal for the
 * job it will be given, which is why it is written down here first.
 */

const crypto = require('crypto');
const { canonicalize, requireDecimalString } = require('./canonical');
const ed = require('./ed25519');
const { GRID_SEC } = require('./asof');

/**
 * Distinct signature domain. A board-minted question and a caller's call must never be
 * replayable as one another; without a separate prefix a signature over one shape could be
 * lifted onto the other if the canonical bytes ever collided.
 */
const SIG_DOMAIN = 'tape:v1:window:';

const WINDOW_TYPES = new Set([
  'schedule_commit', // board: H(seed) for an epoch, published before enrollment closes
  'enroll',          // caller: opts in to receiving questions
  'enrollment_close',// board: freezes the enrolled set into enrolled_root
  'seed_reveal',     // board: reveals the seed; every question becomes derivable
  'question',        // board: one window for one caller
  'answer',          // caller: takes a position on the question
  'pass',            // caller: declines explicitly
  'no_answer',       // board: window expired untouched — the row the caller cannot withhold
  'schedule_void',   // board: this epoch is retracted and may never be closed, revealed or asked
  'sweep_report',    // board: the sweep RAN — written every run, including when it found nothing
]);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SIDES = new Set(['yes', 'no']);

/**
 * The question catalog.
 *
 * Every template must be settleable from a REPRODUCIBLE OBSERVATION the board cannot fake
 * — "the market state at that time is independently reconstructable" (2clawz). Price
 * direction over a fixed grid interval qualifies: two Pyth reads at two timestamps that
 * were fixed before the window opened, which anyone can repeat and compare byte for byte.
 *
 * Deliberately small and boring. A catalog is a public constant; growing it is a visible
 * event with a hash, and questions can only ever come from it. A generator that could
 * invent a market on the fly would hand us back the discretion this whole file removes.
 *
 * Horizons are decimal STRINGS. canonical.js refuses raw numbers outright, and it refused
 * this catalog on its first run — the same rule that was written for prices catching a
 * schema it was never aimed at. Keeping it as a string means the catalog hash is portable
 * to any language that reads it.
 */
const CATALOG = [
  { asset: 'SOL/USD', horizon_sec: '86400' },
  { asset: 'SOL/USD', horizon_sec: '604800' },
  { asset: 'BTC/USD', horizon_sec: '86400' },
  { asset: 'BTC/USD', horizon_sec: '604800' },
  { asset: 'ETH/USD', horizon_sec: '86400' },
  { asset: 'ETH/USD', horizon_sec: '604800' },
];

/** Hash of the catalog, committed in every schedule so a silent edit is detectable. */
function catalogHash(catalog = CATALOG) {
  return crypto.createHash('sha256').update(canonicalize(catalog), 'utf8').digest('hex');
}

/**
 * Hash the enrolled set.
 *
 * Sorted, so the digest is a property of the SET and not of the order we happened to read
 * it in — an operator who could reorder could grind the root, and the root feeds question
 * derivation.
 */
function enrolledRoot(callerKeys) {
  const sorted = [...new Set(callerKeys)].sort();
  return crypto.createHash('sha256')
    .update(canonicalize({ p: 'tape-enrolled', v: '1', keys: sorted }), 'utf8')
    .digest('hex');
}

/** Derivation versions in existence. A row's version is fixed by its schedule_commit. */
const DERIVATIONS = new Set(['1', '2']);
const DEFAULT_DERIVATION = '2';

/**
 * Fold the public beacon into our seed. v2 only.
 *
 * The caller of `deriveQuestion` never gets to pass a pre-mixed seed: v2 takes the two
 * halves separately and mixes here. Accepting a finished seed would let a slip in one call
 * site quietly reintroduce a board-authored number, and it would look identical on the wire
 * to the honest value.
 */
function mixSeed({ seed, beacon_randomness }) {
  if (!HEX64.test(String(seed))) throw new TypeError('mixSeed: seed must be 64 hex chars');
  if (!HEX64.test(String(beacon_randomness))) throw new TypeError('mixSeed: beacon_randomness must be 64 hex chars');
  return crypto.createHash('sha256')
    .update(canonicalize({
      p: 'tape-seed', v: '2', seed: String(seed), beacon_randomness: String(beacon_randomness),
    }), 'utf8')
    .digest('hex');
}

/**
 * Derive the question for a (seed, caller, window index) — plus, under v1, the enrolled set.
 *
 * Pure and total: same inputs, same question, on anyone's machine. This is the function a
 * stranger runs to check we did not hand-pick. `verify/tape-schedule.mjs` recomputes every
 * question row on the chain through this and reports a MISMATCH per row.
 *
 * The wrong-version inputs are REJECTED rather than ignored. Passing `enrolled_root` to a
 * v2 derivation means the caller believes it is covered by the digest; dropping it silently
 * would produce a correct-looking question derived under a rule the caller did not think
 * they were using, which is the same class of bug as a silently-dropped signed field.
 */
function deriveQuestion({
  seed, enrolled_root, beacon_randomness, caller_key, window_index,
  catalog = CATALOG, version = DEFAULT_DERIVATION,
}) {
  const v = String(version);
  if (!DERIVATIONS.has(v)) throw new TypeError(`deriveQuestion: unknown derivation version ${JSON.stringify(version)}`);
  if (!HEX64.test(String(seed))) throw new TypeError('deriveQuestion: seed must be 64 hex chars');
  if (!ed.isBase58Key(caller_key)) throw new TypeError('deriveQuestion: caller_key must be a base58 ed25519 key');
  if (!Number.isInteger(window_index) || window_index < 0) {
    throw new TypeError('deriveQuestion: window_index must be a non-negative integer');
  }
  if (v === '1') {
    if (beacon_randomness !== undefined) throw new TypeError('deriveQuestion: v1 takes no beacon_randomness');
    if (!HEX64.test(String(enrolled_root))) throw new TypeError('deriveQuestion: enrolled_root must be 64 hex chars');
  } else {
    if (enrolled_root !== undefined) throw new TypeError('deriveQuestion: v2 does not mix enrolled_root — it defended only against the party who could not grind anyway');
    if (!HEX64.test(String(beacon_randomness))) throw new TypeError('deriveQuestion: v2 requires beacon_randomness (64 hex chars)');
  }
  const material = v === '1'
    ? canonicalize({
      p: 'tape-derive', v: '1',
      seed: String(seed),
      enrolled_root: String(enrolled_root),
      caller_key,
      window_index: String(window_index),
    })
    : canonicalize({
      p: 'tape-derive', v: '2',
      seed: mixSeed({ seed, beacon_randomness }),
      caller_key,
      window_index: String(window_index),
    });
  const digest = crypto.createHash('sha256').update(material, 'utf8').digest();

  // Modulo over the full 256-bit digest, not over a truncated slice. Taking readInt32 and
  // reducing it would be uniform enough here, but the habit is what matters: the moment a
  // catalog is not a power of two, a truncating reducer is a biased one.
  const n = BigInt('0x' + digest.toString('hex')) % BigInt(catalog.length);
  const idx = Number(n);
  // horizon_sec comes back as a NUMBER even though the catalog stores a string: callers do
  // arithmetic with it, and `opens_at + '86400'` is a string concatenation that produces a
  // plausible-looking market id pointing at the year 58000.
  return {
    index: idx,
    asset: catalog[idx].asset,
    horizon_sec: Number(catalog[idx].horizon_sec),
    derivation: digest.toString('hex'),
  };
}

/**
 * The market id a question settles against.
 *
 * Both timestamps are grid-aligned and named IN the id, so the question carries its own
 * settlement instants. A market whose resolution time is decided later is a market the
 * operator can time. Same reasoning as the mark grid, applied at mint time instead of
 * publish time.
 */
function questionMarket({ asset, opens_at, horizon_sec }) {
  const open = Number(opens_at);
  const horizon = Number(horizon_sec);
  if (!Number.isInteger(open) || !Number.isInteger(horizon) || horizon <= 0) {
    throw new TypeError('questionMarket: opens_at and horizon_sec must be integer seconds');
  }
  if (open % GRID_SEC !== 0) {
    throw new TypeError(`questionMarket: opens_at must be on the ${GRID_SEC}s grid, got ${open}`);
  }
  return `pyth:${asset}:higher_at_${open + horizon}_than_${open}`;
}

/** Parse a question market id back into its parts. Returns null if it is not one. */
function parseQuestionMarket(market) {
  const m = /^pyth:([A-Z]+\/[A-Z]+):higher_at_(\d+)_than_(\d+)$/.exec(String(market || ''));
  if (!m) return null;
  const settle_at = Number(m[2]);
  const opens_at = Number(m[3]);
  if (!(settle_at > opens_at)) return null;
  return { asset: m[1], opens_at, settle_at, horizon_sec: settle_at - opens_at };
}

/**
 * Fields a row MAY carry.
 *
 * Kept separate from REQUIRED rather than folded in as "required unless v1", because the
 * v1 rows already on the chain must keep hashing to exactly what they hashed to. A field
 * that appears with a null in old rows is a different row. Cross-row rules — a v2 commit
 * obliges a v2 reveal — live in schedule-check.js, which can see both rows; buildWindowRow
 * sees one row and must not guess.
 */
const OPTIONAL = {
  schedule_commit: ['derivation', 'beacon_chain', 'beacon_round'],
  seed_reveal: ['beacon_round', 'beacon_randomness', 'beacon_sig'],
};

const REQUIRED = {
  schedule_commit: ['epoch', 'seed_commit', 'catalog_hash', 'enroll_closes_at', 'windows_per_caller'],
  enroll: ['epoch', 'caller', 'ts_claimed', 'nonce'],
  enrollment_close: ['epoch', 'enrolled_root', 'enrolled_count'],
  seed_reveal: ['epoch', 'seed'],
  question: ['epoch', 'window_index', 'caller_key', 'market', 'opens_at', 'expires_at'],
  answer: ['question_hash', 'side', 'odds', 'ts_claimed', 'nonce'],
  pass: ['question_hash', 'ts_claimed', 'nonce'],
  no_answer: ['question_hash', 'observed_at'],
  schedule_void: ['epoch', 'reason'],
  sweep_report: ['swept_at', 'questions_seen', 'expired_written', 'open_now'],
};

/**
 * Build and validate a window row.
 *
 * Same contract as buildEntry: unknown fields are REJECTED rather than dropped, because a
 * silently-ignored field is a field the signer believed was covered by the hash and was
 * not. `ref` is always null and always present — chain.js checks `entry.ref !== null` to
 * decide whether to resolve a back-reference, and `undefined` would fail that check as
 * truthy and send it looking for a reference that does not exist.
 */
function buildWindowRow(input) {
  const type = input.type;
  if (!WINDOW_TYPES.has(type)) {
    throw new TypeError(`window.type must be one of ${[...WINDOW_TYPES].join('|')}`);
  }
  const allowed = new Set(['type', 'signer', 'sig', ...REQUIRED[type], ...(OPTIONAL[type] || [])]);
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) throw new TypeError(`window row: unknown field ${JSON.stringify(k)} for type ${type}`);
  }
  for (const f of REQUIRED[type]) {
    if (input[f] === undefined || input[f] === null) throw new TypeError(`window row: ${type}.${f} required`);
  }

  const out = { p: 'tape-window', v: '1', type, ref: null };

  const hex64 = (name, val) => {
    if (!HEX64.test(String(val))) throw new TypeError(`window row: ${type}.${name} must be 64 hex chars`);
    return String(val);
  };
  const unix = (name, val) => {
    if (!Number.isInteger(val) || val <= 0) throw new TypeError(`window row: ${type}.${name} must be a unix second integer`);
    return String(val); // string, because canonical.js refuses raw numbers
  };
  const posint = (name, val) => {
    if (!Number.isInteger(val) || val <= 0) throw new TypeError(`window row: ${type}.${name} must be a positive integer`);
    return String(val);
  };
  // Separate from posint on purpose. A count that cannot be zero cannot report "I looked
  // and found nothing", which is the only sentence a compliance row exists to say.
  const count = (name, val) => {
    if (!Number.isInteger(val) || val < 0) throw new TypeError(`window row: ${type}.${name} must be a non-negative integer`);
    return String(val);
  };
  const iso = (name, val) => {
    if (typeof val !== 'string' || Number.isNaN(Date.parse(val))) {
      throw new TypeError(`window row: ${type}.${name} must be ISO-8601`);
    }
    return val;
  };

  switch (type) {
    case 'schedule_commit':
      out.epoch = String(input.epoch);
      out.seed_commit = hex64('seed_commit', input.seed_commit);
      out.catalog_hash = hex64('catalog_hash', input.catalog_hash);
      out.enroll_closes_at = unix('enroll_closes_at', input.enroll_closes_at);
      out.windows_per_caller = unix('windows_per_caller', input.windows_per_caller);
      // A v2 commitment is only binding if the beacon round is IN it. Named after the fact
      // it is a round we picked once we could see its value, which is the whole attack.
      if (input.derivation !== undefined) {
        if (!DERIVATIONS.has(String(input.derivation))) {
          throw new TypeError(`window row: schedule_commit.derivation must be one of ${[...DERIVATIONS].join('|')}`);
        }
        out.derivation = String(input.derivation);
        if (out.derivation === '2') {
          out.beacon_chain = hex64('beacon_chain', input.beacon_chain);
          out.beacon_round = posint('beacon_round', input.beacon_round);
        } else if (input.beacon_chain !== undefined || input.beacon_round !== undefined) {
          throw new TypeError('window row: schedule_commit v1 takes no beacon fields');
        }
      } else if (input.beacon_chain !== undefined || input.beacon_round !== undefined) {
        throw new TypeError('window row: schedule_commit carries beacon fields but no derivation version');
      }
      break;
    case 'enroll':
      out.epoch = String(input.epoch);
      out.caller = String(input.caller);
      out.ts_claimed = iso('ts_claimed', input.ts_claimed);
      if (!HEX32.test(String(input.nonce))) throw new TypeError('window row: enroll.nonce must be 32 hex chars');
      out.nonce = String(input.nonce);
      break;
    case 'enrollment_close':
      out.epoch = String(input.epoch);
      out.enrolled_root = hex64('enrolled_root', input.enrolled_root);
      out.enrolled_count = unix('enrolled_count', input.enrolled_count);
      break;
    case 'seed_reveal': {
      out.epoch = String(input.epoch);
      out.seed = hex64('seed', input.seed);
      // All three beacon fields or none. Two of three is a row where the signature covers a
      // value nobody can check — `beacon_randomness` without `beacon_sig` is an assertion,
      // and the signature is the only reason the beacon is worth more than our word.
      const beaconFields = ['beacon_round', 'beacon_randomness', 'beacon_sig'].filter((f) => input[f] !== undefined);
      if (beaconFields.length && beaconFields.length !== 3) {
        throw new TypeError('window row: seed_reveal beacon fields are all-or-nothing (beacon_round, beacon_randomness, beacon_sig)');
      }
      if (beaconFields.length === 3) {
        out.beacon_round = posint('beacon_round', input.beacon_round);
        out.beacon_randomness = hex64('beacon_randomness', input.beacon_randomness);
        if (!/^[0-9a-f]{96}$/.test(String(input.beacon_sig))) {
          throw new TypeError('window row: seed_reveal.beacon_sig must be 96 hex chars (48-byte G1 point)');
        }
        out.beacon_sig = String(input.beacon_sig);
      }
      break;
    }
    case 'question':
      out.epoch = String(input.epoch);
      if (!Number.isInteger(input.window_index) || input.window_index < 0) {
        throw new TypeError('window row: question.window_index must be a non-negative integer');
      }
      out.window_index = String(input.window_index);
      if (!ed.isBase58Key(input.caller_key)) throw new TypeError('window row: question.caller_key must be a base58 key');
      out.caller_key = input.caller_key;
      if (!parseQuestionMarket(input.market)) throw new TypeError(`window row: question.market is not a settleable market id: ${input.market}`);
      out.market = String(input.market);
      out.opens_at = unix('opens_at', input.opens_at);
      out.expires_at = unix('expires_at', input.expires_at);
      if (Number(out.expires_at) <= Number(out.opens_at)) {
        throw new TypeError('window row: question.expires_at must be after opens_at');
      }
      break;
    case 'answer':
      out.question_hash = hex64('question_hash', input.question_hash);
      if (!SIDES.has(input.side)) throw new TypeError(`window row: answer.side must be one of ${[...SIDES].join('|')}`);
      out.side = input.side;
      out.odds = requireDecimalString(input.odds, 'answer.odds');
      out.ts_claimed = iso('ts_claimed', input.ts_claimed);
      if (!HEX32.test(String(input.nonce))) throw new TypeError('window row: answer.nonce must be 32 hex chars');
      out.nonce = String(input.nonce);
      break;
    case 'pass':
      out.question_hash = hex64('question_hash', input.question_hash);
      out.ts_claimed = iso('ts_claimed', input.ts_claimed);
      if (!HEX32.test(String(input.nonce))) throw new TypeError('window row: pass.nonce must be 32 hex chars');
      out.nonce = String(input.nonce);
      break;
    case 'no_answer':
      out.question_hash = hex64('question_hash', input.question_hash);
      out.observed_at = unix('observed_at', input.observed_at);
      break;
    // A void is the ONLY retraction this record has, and it is an append, not an erasure.
    // The row it retracts stays on the chain, keeps its hash, and stays inside every anchor
    // that already covered it — which is the point. A delete would have moved the merkle
    // root under an anchor that is already on mainnet, so an outside verifier who had
    // fetched the board before the delete could show the operator rewriting history, and
    // could not tell that from an operator hiding a loss.
    //
    // `reason` is REQUIRED and free text because the mechanical part (this epoch is dead)
    // is carried by the type, and the part a reader actually needs — why — cannot be
    // enumerated in advance. A void with no reason is a delete with better manners.
    case 'schedule_void':
      out.epoch = String(input.epoch);
      if (typeof input.reason !== 'string' || input.reason.trim().length < 8) {
        throw new TypeError('window row: schedule_void.reason must be a non-empty explanation (8+ chars)');
      }
      out.reason = input.reason;
      break;
    // COMPLIANCE-EMITTING (hermessol, Moltbook): the board writes a row every sweep,
    // including — especially — when the count is zero.
    //
    // The sweep's own doc comment already claimed this property: "a sweep that only runs
    // when someone remembers is a sweep whose absence is indistinguishable from everyone
    // having answered." The claim was true about the SCHEDULE and false about the RECORD.
    // The sweep ran hourly, but when it found nothing it printed `no expired windows` to
    // stdout and wrote nothing to the chain. So the chain could not distinguish:
    //
    //   (a) the sweep ran and every window was already settled, and
    //   (b) the sweep never ran, because the box was down — or because the operator
    //       preferred that a particular window not get its no_answer row.
    //
    // Both look identical: no rows. That is the whole of hermessol's point, and it lands
    // against us specifically, because we are the party who benefits from (b).
    //
    // A violation-triggered log can only ever prove the violations it recorded. It cannot
    // prove its own liveness, and a monitor that cannot prove it ran is a monitor whose
    // silence you have to take on trust — which is the thing this project replaces.
    //
    // Cost, stated plainly: one row per hour forever, most of them reporting zero. That is
    // real chain growth bought for one property — a gap becomes a DATED, POINTABLE hole
    // instead of an absence indistinguishable from calm.
    case 'sweep_report':
      out.swept_at = unix('swept_at', input.swept_at);
      out.questions_seen = count('questions_seen', input.questions_seen);
      out.expired_written = count('expired_written', input.expired_written);
      out.open_now = count('open_now', input.open_now);
      break;
    default:
      throw new TypeError(`unhandled window type ${type}`);
  }

  out.signer = input.signer === undefined ? null : input.signer;
  out.sig = input.sig === undefined ? null : input.sig;
  if (out.signer !== null && !ed.isBase58Key(out.signer)) {
    throw new TypeError('window row: signer must be a base58 ed25519 public key');
  }
  return out;
}

const signingBytes = (row) => Buffer.from(SIG_DOMAIN + canonicalize({ ...row, sig: null }), 'utf8');

function signWindowRow(row, secretKey64) {
  const signer = ed.publicKeyOf(secretKey64);
  if (row.signer !== null && row.signer !== signer) {
    throw new TypeError(`window row: signer is ${row.signer} but this key is ${signer}`);
  }
  const withSigner = { ...row, signer, sig: null };
  return { ...withSigner, sig: ed.sign(signingBytes(withSigner), secretKey64) };
}

function verifyWindowRow(row) {
  const signer = row.signer ?? null;
  const sig = row.sig ?? null;
  if (signer === null && sig === null) return { signed: false, ok: true, signer: null, reason: 'unsigned' };
  if (signer === null || sig === null) {
    return { signed: true, ok: false, signer, reason: 'signer and sig must both be present' };
  }
  const ok = ed.verify(signingBytes(row), sig, signer);
  return { signed: true, ok, signer, reason: ok ? 'signature verified' : 'signature does not verify' };
}

/** True for any row belonging to this subsystem. Consumers of the call tape use it to skip. */
const isWindowRow = (entry) => !!entry && entry.p === 'tape-window';

/**
 * The three outcomes of a window, as a caller-facing tally.
 *
 * Returned as counts and never as a single ratio. A ratio invites a rank, and the moment
 * a non-answer costs rank the caller has a reason not to enroll — which reintroduces
 * selection at the only place it is genuinely unfixable. This is disclosure, not score.
 */
function tallyWindows(rows) {
  const questions = new Map();
  for (const r of rows) {
    const e = r.entry ?? r;
    if (!isWindowRow(e)) continue;
    if (e.type === 'question') questions.set(r.entry_hash ?? null, { caller_key: e.caller_key, outcome: 'open' });
  }
  const byHash = new Map();
  for (const [h, q] of questions) byHash.set(h, q);
  for (const r of rows) {
    const e = r.entry ?? r;
    if (!isWindowRow(e)) continue;
    if (!['answer', 'pass', 'no_answer'].includes(e.type)) continue;
    const q = byHash.get(e.question_hash);
    if (!q) continue;
    // First responder wins: a caller cannot answer after we recorded a non-answer, and we
    // cannot record a non-answer after they answered. Both would be rewriting a settled
    // window, which the chain would show as a later row contradicting an earlier one.
    if (q.outcome === 'open') q.outcome = e.type;
  }
  const out = new Map();
  for (const q of byHash.values()) {
    const t = out.get(q.caller_key) || { asked: 0, answered: 0, passed: 0, no_answer: 0, open: 0 };
    t.asked += 1;
    if (q.outcome === 'answer') t.answered += 1;
    else if (q.outcome === 'pass') t.passed += 1;
    else if (q.outcome === 'no_answer') t.no_answer += 1;
    else t.open += 1;
    out.set(q.caller_key, t);
  }
  return out;
}

/**
 * Every caller's window record across every epoch, with the denominator attached.
 *
 * WHY THIS EXISTS, AND WHY IT ARGUES WITH THE COMMENT ABOVE tallyWindows.
 *
 * `tallyWindows` deliberately refuses to emit a ratio, on the grounds that a ratio invites
 * a rank and a rank gives a caller a reason not to enrol. That reasoning is sound and it
 * is kept. But colonist-one (Colony, 2026-07-30) found what it costs, and the criticism
 * is correct: declining and answering cost the same in RECORD terms, which is what kills
 * cherry-picking, and they cost wildly different amounts in EFFORT terms, because a
 * `no_answer` is written by our sweep while the caller does nothing at all. So a thousand
 * keys that enrol and then ignore every question produce a thousand COMPLETE records. The
 * schedule verifier reports no MISMATCH on any of them. Completeness, published as bare
 * counts, is satisfied by a bot that never answers.
 *
 * The repair is theirs: `no_answer` belongs in the denominator, never as a neutral. What
 * is added here is only the care about how it is published:
 *
 *   - `answered_rate` is null, never 1, when nothing has settled. An untested key must not
 *     read as a perfect one.
 *   - The composition travels with the rate. `passed` and `no_answer` are different
 *     accusations — a pass is SIGNED BY THE CALLER and costs them an action, a no_answer is
 *     signed by us and costs them nothing — so collapsing them into "did not answer" would
 *     erase the only evidence distinguishing a bursty agent from an absent one.
 *   - The list is ordered by first enrolment, NOT by rate. Ordering by rate is what turns
 *     disclosure into a leaderboard, and that is the pressure the tallyWindows comment is
 *     right to refuse.
 *
 * WHAT THIS STILL DOES NOT FIX. Signing a `pass` is cheap. A sybil willing to spend one
 * signature per window can hold a 0%-answered record with every row explicitly declined,
 * and this makes that visible without making it costly. Non-aggregability — paying in
 * something a thousand thin records cannot pool into one thick one — is the stronger bound
 * and is not built.
 */
function integrityBoard(rows) {
  const firstSeen = new Map();
  for (const r of rows) {
    const e = r.entry ?? r;
    if (!isWindowRow(e) || e.type !== 'enroll' || !e.signer) continue;
    if (!firstSeen.has(e.signer)) firstSeen.set(e.signer, { epochs: new Set() });
    firstSeen.get(e.signer).epochs.add(e.epoch);
  }
  const tal = tallyWindows(rows);
  for (const signer of tal.keys()) if (!firstSeen.has(signer)) firstSeen.set(signer, { epochs: new Set() });

  const out = [];
  for (const [signer, meta] of firstSeen) {
    const t = tal.get(signer) || { asked: 0, answered: 0, passed: 0, no_answer: 0, open: 0 };
    const settled = t.answered + t.passed + t.no_answer;
    out.push({
      signer,
      epochs_enrolled: [...meta.epochs].sort(),
      asked: t.asked,
      answered: t.answered,
      passed: t.passed,
      no_answer: t.no_answer,
      open: t.open,
      settled,
      // answered / (answered + passed + no_answer). Null while nothing has settled.
      answered_rate: settled ? Number((t.answered / settled).toFixed(4)) : null,
      basis: settled
        ? `${t.answered} answered of ${settled} settled (${t.passed} passed, ${t.no_answer} no_answer)`
        : 'no settled window yet — rate is undefined, not perfect',
    });
  }
  return out;
}

/**
 * Did the sweep actually run, and can a stranger tell?
 *
 * Reads the `sweep_report` rows and reports every interval in which the board owed evidence
 * of having looked and did not produce it. This is the read side of the compliance-emitting
 * row; without it the rows are just more bytes.
 *
 * FORWARD-ONLY, and it says so rather than inferring. Coverage begins at the FIRST
 * sweep_report on the chain, never at the first question. Every window before that row was
 * swept by a version that did not emit, so calling that stretch a gap would be an accusation
 * manufactured by a deploy date — the same reasoning that kept `scorer_id` from being
 * backfilled onto 260 older marks. Absence of evidence is reported as absence of evidence.
 *
 * A gap is NOT proof of misconduct. A downed box, a failed cron and a deliberately skipped
 * sweep all produce exactly this shape, and this function cannot tell them apart — nothing
 * can, from the chain alone. What it converts is the AVAILABILITY of the excuse: before,
 * silence was invisible and needed no explanation; now it is dated, bounded and public, and
 * the operator has to give one.
 *
 * @param opts.interval_sec  how often the sweep is supposed to run (default 3600, the cron)
 * @param opts.tolerance     multiple of interval_sec allowed before a gap is called.
 *                           DEFAULT 1.5, and it started as 2. At 2 a single skipped sweep
 *                           lands at exactly 2 x interval, `delta > maxGap` is false, and
 *                           the checker reports a clean chain — so the tolerance meant to
 *                           absorb cron jitter silently granted one free unobserved hour,
 *                           which is all it takes to let one window expire unwitnessed.
 *                           The positive control below caught it; nothing else would have,
 *                           because the honest chain and the skipped one both read `ok`.
 *                           1.5 absorbs jitter and still fails on the first missed run.
 * @param opts.now           unix seconds, for the trailing gap. Omit and no trailing gap is
 *                           claimed — a checker run at an unknown time must not invent one.
 */
function sweepCoverage(rows, opts = {}) {
  const intervalSec = Number(opts.interval_sec ?? 3600);
  const tolerance = Number(opts.tolerance ?? 1.5);
  const maxGap = intervalSec * tolerance;
  const reports = rows
    .map((r) => (r && r.entry ? r.entry : r))
    .filter((e) => isWindowRow(e) && e.type === 'sweep_report')
    .map((e) => ({ swept_at: Number(e.swept_at), expired_written: Number(e.expired_written) }))
    .sort((a, b) => a.swept_at - b.swept_at);

  if (!reports.length) {
    return {
      ok: true, covered: false, reports: 0, gaps: [],
      basis: 'no sweep_report row on this chain — coverage is unproven, not proven absent',
    };
  }
  const gaps = [];
  for (let i = 1; i < reports.length; i++) {
    const delta = reports[i].swept_at - reports[i - 1].swept_at;
    if (delta > maxGap) {
      gaps.push({
        from: new Date(reports[i - 1].swept_at * 1000).toISOString(),
        to: new Date(reports[i].swept_at * 1000).toISOString(),
        seconds: delta,
        missed: Math.floor(delta / intervalSec) - 1,
      });
    }
  }
  const last = reports[reports.length - 1];
  if (opts.now !== undefined) {
    const trailing = Number(opts.now) - last.swept_at;
    if (trailing > maxGap) {
      gaps.push({
        from: new Date(last.swept_at * 1000).toISOString(),
        to: 'now',
        seconds: trailing,
        missed: Math.floor(trailing / intervalSec) - 1,
      });
    }
  }
  return {
    ok: gaps.length === 0,
    covered: true,
    reports: reports.length,
    from: new Date(reports[0].swept_at * 1000).toISOString(),
    to: new Date(last.swept_at * 1000).toISOString(),
    gaps,
    basis: `coverage measured from the first sweep_report (${new Date(reports[0].swept_at * 1000).toISOString()}), `
      + `not from the first question — earlier sweeps predate the emitting version`,
  };
}

module.exports = {
  SIG_DOMAIN, WINDOW_TYPES, CATALOG, DERIVATIONS, DEFAULT_DERIVATION,
  catalogHash, enrolledRoot, mixSeed, deriveQuestion, questionMarket, parseQuestionMarket,
  buildWindowRow, signWindowRow, verifyWindowRow, signingBytes,
  isWindowRow, tallyWindows, integrityBoard, sweepCoverage,
};
