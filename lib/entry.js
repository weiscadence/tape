'use strict';
/**
 * entry.js — the call record.
 *
 * The schema encodes T0's honesty directly. Note `ts_claimed`: it is the CALLER'S clock
 * and it is explicitly NOT authoritative. Authoritative time is the Solana slot of the
 * anchor that covers this entry's hash. Naming the field `ts_claimed` rather than `ts`
 * is deliberate — a field called `ts` invites downstream code to rank on it, and ranking
 * on a caller-supplied timestamp is the same failure as ranking on a server-supplied
 * one: whoever controls the clock controls the record.
 */

const crypto = require('crypto');
const { canonicalize, requireDecimalString } = require('./canonical');
const ed = require('./ed25519');
// Constants only — no network at require time. The chain identity a beacon-bound entry
// names has to be checkable at build time, not just at verify time.
const { QUICKNET: BEACON_CHAIN } = require('./beacon');

/**
 * Domain separator for entry signatures.
 *
 * Without it, a signature over these bytes is just a signature over some JSON, and the
 * same key signing for any other protocol could have its signature lifted and replayed
 * here. Prefixing a protocol-and-version string means a TAPE signature can only ever be
 * a TAPE signature, and a future v2 entry format cannot inherit v1's signatures.
 */
const SIG_DOMAIN = 'tape:v1:entry:';

const LANES = new Set(['memecoin', 'prediction', 'perp', 'lp', 'other']);

/**
 * `declare` — the answer to the one criticism this schema could not previously hold.
 *
 * hermessol, Moltbook, 2026-07-28: "append-only constrains revision. It does not constrain
 * ADMISSION." A caller who posts their three best convictions and keeps the other twelve
 * in their head has a profile that is fully append-only, fully marked to market, never
 * backdated — and byte-identical from the outside to a complete record. Every row is
 * honest and the profile is a highlight reel. We had secured the second write and not the
 * first.
 *
 * Nothing can prove what someone did not post; that information does not exist anywhere.
 * What a declaration changes is WHO IS MAKING THE CLAIM. Absent one, completeness is
 * something the reader assumes and we tacitly enjoy. With one, the caller has signed and
 * anchored a scope, so a single counterexample — one call of theirs, in scope, made
 * elsewhere and never posted here — contradicts something they put their key on.
 *
 * That is a strictly weaker guarantee than the rest of the tape, and it is labelled as
 * such everywhere it surfaces (`readmodel.coverageOf`). It converts an unfalsifiable
 * implication into a falsifiable statement. It does not make it provable, and any copy
 * that says otherwise is overselling it.
 */
const TYPES = new Set(['open', 'close', 'amend', 'declare']);

/**
 * A declaration's scope. Prefixed so it can never collide with a real market string, and
 * enumerated so that "what did they commit to" is decidable by machine rather than read
 * out of prose. An open-ended free-text scope would be a promise shaped like a rule.
 */
const SCOPE = /^scope:(all|lane=(memecoin|prediction|perp|lp|other)|market=\S+)$/;
const SIDES = new Set(['long', 'short', 'yes', 'no']);
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Normalize + validate a call into the exact object that gets hashed.
 * Unknown fields are REJECTED rather than ignored: silently dropping a field the caller
 * believed was part of their commitment would let them claim they said something the
 * hash does not cover.
 */
function buildEntry(input) {
  const allowed = new Set([
    'type', 'caller', 'lane', 'market', 'side', 'size',
    'entry_ref', 'ts_claimed', 'ref', 'nonce', 'note', 'signer', 'sig',
    'open_count', 'beacon',
  ]);
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) throw new TypeError(`entry: unknown field ${JSON.stringify(k)}`);
  }

  const type = input.type;
  if (!TYPES.has(type)) throw new TypeError(`entry.type must be one of ${[...TYPES].join('|')}`);

  const caller = input.caller;
  if (typeof caller !== 'string' || !caller.length) throw new TypeError('entry.caller required');

  const lane = input.lane;
  if (!LANES.has(lane)) throw new TypeError(`entry.lane must be one of ${[...LANES].join('|')}`);

  const market = input.market;
  if (typeof market !== 'string' || !market.length) throw new TypeError('entry.market required');

  const side = input.side;
  if (!SIDES.has(side)) throw new TypeError(`entry.side must be one of ${[...SIDES].join('|')}`);

  const size = requireDecimalString(input.size, 'entry.size');
  const entry_ref = requireDecimalString(input.entry_ref, 'entry.entry_ref');

  const ts_claimed = input.ts_claimed;
  if (typeof ts_claimed !== 'string' || Number.isNaN(Date.parse(ts_claimed))) {
    throw new TypeError('entry.ts_claimed must be an ISO-8601 string (caller clock, NOT authoritative)');
  }

  // `close` and `amend` must point at the entry they act on, by hash. Without this an
  // exit is a free-floating claim and could be re-pointed later at a better entry.
  const ref = input.ref === undefined ? null : input.ref;
  if (type === 'open' || type === 'declare') {
    if (ref !== null) throw new TypeError(`entry.ref must be null for a ${type}`);
  } else if (!(typeof ref === 'string' && HEX64.test(ref))) {
    throw new TypeError(`entry.ref must be the 64-hex hash of the entry being ${type}d`);
  }

  // The nonce makes two otherwise-identical calls distinct entries. Without it, posting
  // the same call twice would collide to one hash and one of them would vanish from the
  // record — a silent delete, which is the one thing this system must not permit.
  const nonce = input.nonce;
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) {
    throw new TypeError('entry.nonce must be 32 hex chars (use newNonce())');
  }

  const note = input.note === undefined ? null : input.note;
  if (note !== null && typeof note !== 'string') throw new TypeError('entry.note must be a string or null');

  // A declaration is not a position and must be incapable of becoming one.
  //
  // The shape stays identical to every other entry — same fields, same canonicalization,
  // same hash — because two independent verifiers reimplement that canonicalization and a
  // per-type object shape would give them two chances to disagree. So instead of dropping
  // the position fields, we PIN them to values that cannot score: size "0" and entry_ref
  // "0". If some future scorer forgets to skip declarations, the worst it can do is add a
  // zero-size position at a zero reference, which is arithmetically inert. A schema that
  // fails safe when downstream code is wrong beats one that relies on downstream code
  // being right.
  if (type === 'declare') {
    if (!SCOPE.test(market)) {
      throw new TypeError('declare: entry.market must be a scope — scope:all, scope:lane=<lane>, or scope:market=<id>');
    }
    if (side !== 'yes') throw new TypeError('declare: entry.side must be "yes" (a declaration has no side)');
    if (size !== '0' || entry_ref !== '0') {
      throw new TypeError('declare: entry.size and entry.entry_ref must both be "0" — a declaration is not a position');
    }
  } else if (SCOPE.test(market)) {
    // The reverse guard. A `scope:` string on a real position would let a caller mint a
    // thing that reads as a commitment in any UI that matches on the market prefix.
    throw new TypeError('entry.market may not start with "scope:" unless entry.type is "declare"');
  }

  // Identity. `signer` is a wallet public key; `sig` is its signature over this entry.
  // They travel together or not at all: a signer without a signature is a claim to be
  // someone, which is exactly what a free-text `caller` already was.
  const signer = input.signer === undefined ? null : input.signer;
  const sig = input.sig === undefined ? null : input.sig;
  if (signer !== null && !ed.isBase58Key(signer)) {
    throw new TypeError('entry.signer must be a base58 ed25519 public key (32 bytes)');
  }
  if (sig !== null) {
    if (signer === null) throw new TypeError('entry.sig without entry.signer — a signature must say whose it is');
    let raw;
    try { raw = ed.b58decode(sig); } catch { raw = null; }
    if (!raw || raw.length !== 64) throw new TypeError('entry.sig must be a base58 ed25519 signature (64 bytes)');
  }
  if (signer !== null && sig === null && input.sig !== undefined) {
    throw new TypeError('entry.signer with an explicitly null sig — sign it or drop the signer');
  }

  // `open_count` — dataciv, Moltbook 824f38c8: "a coverage claim primitive, where the
  // caller commits to a count before resolution, making incompleteness falsifiable even
  // if not provable." Their concrete form: a declared "I have N open positions" posted
  // before any of them resolve, so omission has a detectable signature.
  //
  // WHY THIS IS STRICTLY STRONGER THAN THE SCOPE ALONE. A scope declaration is qualitative
  // — "I post every perp call" — and falsifying it requires an OUTSIDE observer to find a
  // call the caller made elsewhere and never posted here. That is real, and it is also
  // work nobody may ever do. A count is quantitative and self-falsifying: "I hold 5 open"
  // against a tape showing 2 is a contradiction visible from the tape alone, needing no
  // external evidence and no cooperation from anyone.
  //
  // OPTIONAL, deliberately. Requiring it would make every existing declare invalid and
  // would force a number out of callers who can honestly commit to a scope but cannot
  // count reliably. A declare without a count keeps exactly the meaning it always had.
  //
  // Zero is legal and meaningful: "I hold nothing open right now" is a real commitment,
  // and it is the one a caller quietly sitting on undisclosed positions cannot make.
  let open_count;
  if (input.open_count !== undefined && input.open_count !== null) {
    if (type !== 'declare') {
      throw new TypeError('entry.open_count is only meaningful on a declare — a position is not a census');
    }
    if (!Number.isInteger(input.open_count) || input.open_count < 0) {
      throw new TypeError('declare: entry.open_count must be a non-negative integer');
    }
    open_count = String(input.open_count); // string, because canonical.js refuses raw numbers
  }

  // `beacon` — the NOT-BEFORE half of the clock. (reticuli, Colony ea7fe6ed, 2026-08-05,
  // from building Touchstone; they bind drand not-before against a Bitcoin not-after.)
  //
  // THE HOLE THIS FILLS. Until now TAPE bound time with exactly one number: the Solana
  // slot of the anchor covering this entry. That is a genuine NOT-AFTER — the row provably
  // existed by slot N, therefore before the outcome it calls. It says nothing about the
  // other side. Nothing stopped us from writing a row, sitting on it, and anchoring it
  // later; the earliest bound was our own commit, which is us vouching for us. Every
  // remaining "trust the operator" in this system lived in that gap.
  //
  // WHY A BEACON CLOSES IT. drand quicknet's round R randomness is H(sig_R), and sig_R is
  // a BLS threshold signature over R that does not exist until round R is published. An
  // entry whose hash commits to round R's randomness therefore CANNOT have been
  // constructed before roundTime(R). The bound is arithmetic, not testimony: a verifier
  // checks sig_R against an inlined public key offline (lib/beacon.js `verifyBeacon`) and
  // needs nothing from us. Combined with the anchor slot, a row's time stops being a point
  // we assert and becomes an interval [roundTime(R), anchor_block_time] fenced by two
  // systems we do not run.
  //
  // WHY SOLANA AND NOT BITCOIN FOR THE OTHER SIDE. Touchstone anchors checkpoints to
  // Bitcoin via OpenTimestamps. We keep Solana: it is where the anchor already is, the
  // slot is a finer clock than a Bitcoin block, and confirmation is seconds rather than an
  // hour — which matters because the not-after has to land before an outcome resolves to
  // be worth anything. The trade is Bitcoin's deeper reorg cost, and it is named in the
  // threat model rather than papered over. The not-before is where we had nothing, so
  // that is the half being added.
  //
  // OPTIONAL AND FOLDED IN ONLY WHEN PRESENT — the part that makes this safe to ship.
  // Every entry already written stays byte-identical, so its hash, its signature, and the
  // anchors that commit to it all still verify. A required field would have invalidated
  // the entire existing tape to gain a property on future rows only. Absent beacon means
  // exactly what it always meant: not-after only, one-sided.
  let beacon;
  if (input.beacon !== undefined && input.beacon !== null) {
    const b = input.beacon;
    if (typeof b !== 'object' || Array.isArray(b) || Object.getPrototypeOf(b) !== Object.prototype) {
      throw new TypeError('entry.beacon must be a plain object {chain, round, randomness}');
    }
    const extra = Object.keys(b).filter((k) => !['chain', 'round', 'randomness'].includes(k));
    if (extra.length) throw new TypeError(`entry.beacon: unknown field ${JSON.stringify(extra[0])}`);

    // The chain hash is checked against the one this build knows rather than accepted as
    // given. A row naming a beacon chain we cannot verify has an unverifiable not-before,
    // which is worse than no not-before: it looks like a bound and is not one.
    if (b.chain !== BEACON_CHAIN.chain_hash) {
      throw new TypeError(`entry.beacon.chain must be the drand quicknet chain hash ${BEACON_CHAIN.chain_hash}`);
    }
    // Round is a STRING for the same reason `v` and `open_count` are: canonical.js
    // refuses raw numbers, and a round number crossing a language boundary as a float is
    // the exact portability bug that rule exists to prevent.
    if (typeof b.round !== 'string' || !/^[1-9][0-9]*$/.test(b.round)) {
      throw new TypeError('entry.beacon.round must be a positive integer STRING (canonical.js refuses raw numbers)');
    }
    if (typeof b.randomness !== 'string' || !HEX64.test(b.randomness)) {
      throw new TypeError('entry.beacon.randomness must be 64 lowercase hex chars');
    }
    beacon = { chain: b.chain, randomness: b.randomness, round: b.round };
  }

  // Version is a STRING because canonical.js refuses raw numbers outright. That rule was
  // written for prices and caught its own schema on the first test run — worth keeping as
  // the reason this field looks odd.
  return {
    v: '1', type, caller, lane, market, side, size, entry_ref, ts_claimed, ref, nonce, note, signer, sig,
    ...(open_count === undefined ? {} : { open_count }),
    ...(beacon === undefined ? {} : { beacon }),
  };
}

/**
 * The bytes a signature covers: the entry with `sig` blanked, under the domain prefix.
 *
 * Blanking rather than omitting matters. If `sig` were simply left out of the signed
 * object, then an unsigned entry and a signed one would produce the same signing bytes,
 * and a signature captured from anywhere could be pasted onto a matching unsigned entry.
 * With `sig: null` present, the shape being signed is unambiguous.
 */
const signingBytes = (entry) =>
  Buffer.from(SIG_DOMAIN + canonicalize({ ...entry, sig: null }), 'utf8');

/** Attach a signature. Returns a NEW entry; the input is untouched. */
function signEntry(entry, secretKey64) {
  const signer = ed.publicKeyOf(secretKey64);
  if (entry.signer !== null && entry.signer !== signer) {
    throw new TypeError(`entry.signer is ${entry.signer} but this key is ${signer}`);
  }
  const withSigner = { ...entry, signer, sig: null };
  return { ...withSigner, sig: ed.sign(signingBytes(withSigner), secretKey64) };
}

/**
 * Check an entry's signature.
 * Returns { signed, ok, signer, reason }. `signed:false` is NOT a failure — most of the
 * tape is unsigned T0 and that is a supported, disclosed state. What must never happen
 * is `signed:true, ok:false` being treated as either of the other two.
 */
function verifyEntrySignature(entry) {
  // ABSENT and NULL both mean unsigned. Entries written before signing existed carry
  // neither field, and they must keep verifying — rewriting them to add `signer: null`
  // would change their hashes and orphan every anchor that already commits to them.
  // The first version of this compared against `null` only, so `undefined` fell through
  // to verifying a signature that was not there, and the whole live tape read as forged.
  const signer = entry.signer ?? null;
  const sig = entry.sig ?? null;
  if (signer === null && sig === null) {
    return { signed: false, ok: true, signer: null, reason: 'unsigned (T0)' };
  }
  if (signer === null || sig === null) {
    return { signed: true, ok: false, signer, reason: 'signer and sig must both be present' };
  }
  const ok = ed.verify(signingBytes(entry), sig, signer);
  return { signed: true, ok, signer,
    reason: ok ? 'signature verified' : 'signature does not verify for this signer over these bytes' };
}

/**
 * Ranking identity. Signed and unsigned callers are NEVER merged, even when the display
 * name is identical — that is the two-column rule from the Sybil section applied to
 * identity: a name anyone can type must not inherit the standing of a key only one
 * person holds. The namespace prefix makes the distinction impossible to lose in a join.
 */
const identityOf = (entry) => (entry.signer ? `key:${entry.signer}` : `name:${entry.caller}`);

const newNonce = () => crypto.randomBytes(16).toString('hex');

/** The committed bytes for an entry. This is what the leaf digest is taken over. */
const entryBytes = (entry) => Buffer.from(canonicalize(entry), 'utf8');

/** Content hash of an entry (independent of its position in the chain). */
const entryHash = (entry) => crypto.createHash('sha256').update(entryBytes(entry)).digest('hex');

module.exports = {
  buildEntry, entryHash, entryBytes, newNonce,
  signEntry, verifyEntrySignature, signingBytes, identityOf,
  LANES, TYPES, SIDES, HEX64, SIG_DOMAIN,
};
