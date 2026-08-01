'use strict';
/**
 * beacon.js — a randomness source neither the board nor a caller can author.
 *
 * WHY THIS EXISTS. The window mechanism committed H(seed) before enrollment closed and
 * mixed `enrolled_root` into question derivation, and the docstring in windows.js claimed
 * that ordering blocked both sides. It blocks one side. A caller cannot grind keys, because
 * the seed is secret to them until after their key is committed. THE BOARD KNOWS THE SEED
 * FROM THE MOMENT IT COMMITS IT. So the board can enrol one more key of its own, grind that
 * key offline against a seed it already holds, and pick the enrolment that hands its own
 * caller the questions it wants — and, because `enrolled_root` feeds every derivation, that
 * same late enrolment shifts everybody else's questions too. Every check passes. The seed
 * opens its commitment, the catalog hash matches, every question re-derives. The mechanism
 * is honest about the second write and the board still authors element zero.
 *
 * Dropping `enrolled_root` removes the cross-caller half of that. It does not remove the
 * half that matters: whoever knows the seed while enrolment is still open can grind their
 * own key. No ordering of a two-party protocol fixes this, because one of the two parties
 * has to generate the seed, and that party is the one being audited.
 *
 * So the seed stops being ours alone. The board commits its half before enrolment opens,
 * and the final seed mixes in a public beacon value published at a round NAMED IN THE
 * COMMITMENT and occurring after enrolment closes:
 *
 *   final_seed = H( board_seed ‖ beacon_randomness_at_round_R )
 *
 * The board cannot grind, because at commit time the beacon value for round R does not
 * exist yet. A caller cannot grind, because the board's half is still secret when they
 * enrol. Neither party can wait and see, because R is fixed in a signed, anchored row
 * before enrolment opens. The read instant is not ours: naming a future round in advance is
 * what makes this an external number rather than an oracle we read at a moment we chose.
 *
 * WHY DRAND AND NOT A SOLANA BLOCKHASH. We anchor to Solana already, so a future slot's
 * blockhash was the obvious candidate. It fails the only test that matters here — that a
 * stranger can still check it in a year. Public Solana RPC prunes block history, so
 * `getBlock` on an old slot answers "Block not available" rather than the value, and a
 * verification step that stops working after a few weeks is a verification step that will
 * be quietly dropped. drand rounds are addressable forever, mirrored independently, and —
 * the part that makes this more than an API call — each one carries a BLS signature over
 * its own round number under a fixed public key. `verifyBeacon` checks that signature
 * locally. A mirror that lies is caught by arithmetic, not by a second opinion.
 *
 * WHAT THIS STILL DOES NOT CLOSE. drand's threshold of nodes could in principle collude to
 * withhold or grind a round, and this inherits that. That is a strictly smaller trust
 * assumption than "the audited party picked the number", which is what it replaces, and it
 * is stated here rather than left for someone to find.
 */

const crypto = require('crypto');
const { bls12_381: bls } = require('@noble/curves/bls12-381');

/**
 * drand quicknet. Unchained (`bls-unchained-g1-rfc9380`), which is the property being used:
 * a round's signature covers the ROUND NUMBER ALONE, so one round verifies standalone
 * without replaying chain history. The chained default beacon would force a verifier to
 * walk every previous signature to check one value.
 *
 * These constants are the trust root and are deliberately inlined rather than fetched. A
 * public key fetched from the same endpoint that serves the value it authenticates is not
 * an authentication.
 */
const QUICKNET = {
  chain_hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  public_key: '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c'
    + '8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  genesis_time: 1692803367,
  period: 3,
  scheme: 'bls-unchained-g1-rfc9380',
};

/** RFC 9380 domain separation tag for G1 signatures. Part of the scheme, not a choice. */
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';

/**
 * Independent mirrors. Quorum is about availability, not trust — `verifyBeacon` is what
 * establishes the value is real, and it would reject a unanimous lie from all of them.
 */
const MIRRORS = [
  'https://api.drand.sh',
  'https://drand.cloudflare.com',
];

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

/** Wall-clock time of a drand round. Round 1 lands exactly on genesis. */
function roundTime(round, chain = QUICKNET) {
  if (!Number.isInteger(round) || round < 1) throw new TypeError('roundTime: round must be a positive integer');
  return chain.genesis_time + (round - 1) * chain.period;
}

/**
 * The first round at or after `unixSec`.
 *
 * Used to turn "after enrolment closes, plus a margin" into a number that goes in the
 * commitment. It must be computed from the deadline, never from `now` — a round picked
 * relative to when we happened to run the command is a round we chose.
 */
function roundAt(unixSec, chain = QUICKNET) {
  if (!Number.isInteger(unixSec)) throw new TypeError('roundAt: unixSec must be an integer');
  const delta = unixSec - chain.genesis_time;
  if (delta < 0) return 1;
  return Math.ceil(delta / chain.period) + 1;
}

/**
 * Check a beacon value against the chain public key.
 *
 * Total: returns a verdict for any input rather than throwing, because this is the function
 * a stranger runs on data we handed them, and a crash on hostile input reads as a broken
 * tool rather than a broken record.
 */
function verifyBeacon(b, chain = QUICKNET) {
  const round = Number(b && b.round);
  if (!Number.isInteger(round) || round < 1) return { ok: false, reason: 'round must be a positive integer' };
  const sig = String((b && b.signature) || '');
  const rand = String((b && b.randomness) || '');
  if (!HEX(96).test(sig)) return { ok: false, reason: 'signature must be 96 hex chars (48-byte G1 point)' };
  if (!HEX(64).test(rand)) return { ok: false, reason: 'randomness must be 64 hex chars' };

  // randomness is definitionally H(signature). Checking it means a mirror cannot hand back a
  // real signature next to a randomness value of its choosing, which is the field everything
  // downstream actually consumes.
  const want = crypto.createHash('sha256').update(Buffer.from(sig, 'hex')).digest('hex');
  if (want !== rand) return { ok: false, reason: 'randomness is not sha256(signature)' };

  const msgBuf = Buffer.alloc(8);
  msgBuf.writeBigUInt64BE(BigInt(round));
  const msg = crypto.createHash('sha256').update(msgBuf).digest();
  let ok;
  try { ok = bls.verifyShortSignature(sig, msg, chain.public_key, { DST }); }
  catch (e) { return { ok: false, reason: `signature did not parse (${e.message})` }; }
  if (!ok) return { ok: false, reason: 'BLS signature does not verify under the chain public key' };
  return { ok: true, reason: 'BLS signature verifies', round, randomness: rand, signature: sig };
}

async function getJSON(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/**
 * Fetch one round, from more than one mirror, and verify it locally.
 *
 * Disagreement between mirrors is reported rather than resolved by majority. Two mirrors
 * returning different signatures for the same round is not a value to average, it is a fact
 * about the beacon that should stop the epoch.
 */
async function fetchRound(round, opts = {}) {
  const chain = opts.chain || QUICKNET;
  const mirrors = opts.mirrors || MIRRORS;
  const timeoutMs = opts.timeoutMs || 12000;
  const got = [];
  const errors = [];
  for (const m of mirrors) {
    const url = `${m}/${chain.chain_hash}/public/${round}`;
    try { got.push({ mirror: m, body: await getJSON(url, timeoutMs) }); }
    catch (e) { errors.push(`${m}: ${e.message}`); }
  }
  if (!got.length) throw new Error(`beacon round ${round} unavailable from every mirror (${errors.join('; ')})`);

  const sigs = new Set(got.map((g) => String(g.body && g.body.signature)));
  if (sigs.size > 1) {
    throw new Error(`beacon round ${round}: mirrors disagree (${got.map((g) => `${g.mirror}=${String(g.body.signature).slice(0, 16)}…`).join(', ')})`);
  }
  const body = got[0].body;
  const value = {
    round: Number(body.round),
    signature: String(body.signature),
    // Cloudflare omits `randomness`; it is defined as H(signature), so derive rather than
    // require it. Deriving also means the field we store is one we computed, not one a
    // mirror asserted.
    randomness: crypto.createHash('sha256').update(Buffer.from(String(body.signature), 'hex')).digest('hex'),
  };
  if (value.round !== round) throw new Error(`beacon: asked for round ${round}, got ${value.round}`);
  const v = verifyBeacon(value, chain);
  if (!v.ok) throw new Error(`beacon round ${round} failed verification: ${v.reason}`);
  return { ...value, mirrors: got.map((g) => g.mirror), errors };
}

module.exports = { QUICKNET, DST, MIRRORS, roundTime, roundAt, verifyBeacon, fetchRound };
