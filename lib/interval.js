'use strict';
/**
 * interval.js — a row's time as an interval, not a point.
 *
 * WHAT WAS WRONG BEFORE. TAPE bound each call with one number: the Solana slot of the
 * anchor covering it. That is a real NOT-AFTER and it is the property the whole
 * leaderboard rests on — the call provably existed by slot N, therefore before the
 * outcome. But the earliest a row could have been written was bounded by nothing except
 * our own say-so. "We wrote it when we say we wrote it" is the operator vouching for the
 * operator, which is the exact shape of claim this project exists to refuse. A record
 * with only a not-after cannot distinguish a call made early from a call written late
 * and anchored promptly.
 *
 * WHAT THIS FILE COMPUTES. When an entry commits to a drand round (see `beacon` in
 * entry.js), its time becomes
 *
 *     [ roundTime(R) , blockTime(anchor_slot) ]
 *
 * and neither endpoint is ours. The lower bound holds because round R's randomness is
 * H(sig_R) and sig_R is a threshold BLS signature over R that does not exist before round
 * R publishes — so an entry hash committing to it could not have been formed earlier. The
 * upper bound holds because the anchor is a transaction in a block we did not produce.
 *
 * WHY THE VERIFIER STILL FETCHES. The entry stores randomness, not the signature, so a
 * verifier re-fetches round R to obtain sig_R, checks it under the inlined quicknet public
 * key (`verifyBeacon`), and then checks H(sig_R) equals the committed randomness. The
 * fetch is an availability step, not a trust step: a mirror that lies fails the BLS check,
 * and a mirror that serves a different round fails the hash equality. Nothing here trusts
 * the endpoint, which is why `fetchRound` cross-checks mirrors and verifies locally.
 *
 * WHAT IT STILL DOES NOT BUY. A caller can always name an OLDER round than the moment
 * they actually wrote — that only loosens their own lower bound, so there is no incentive
 * and no attack. They cannot name a newer one. Beyond that this inherits drand's
 * assumption that a threshold of its nodes does not collude to withhold or grind rounds,
 * which is strictly weaker than "the audited party picked the number" and is stated here
 * rather than left to be discovered.
 */

const crypto = require('crypto');
const { QUICKNET, roundTime, fetchRound } = require('./beacon');

const iso = (unixSec) => new Date(unixSec * 1000).toISOString();

/**
 * Pure half: given an entry and an ALREADY-VERIFIED beacon record, decide whether the
 * entry's committed randomness really is that round's. Separated from the fetch so the
 * cryptographic argument is testable offline against a pasted real round.
 */
function checkBeaconBinding(entry, fetched) {
  const b = entry && entry.beacon;
  if (!b) return { bound: false, reason: 'entry has no beacon binding' };
  if (String(fetched.round) !== b.round) {
    return { bound: false, reason: `beacon round mismatch: entry commits to ${b.round}, got ${fetched.round}` };
  }
  // Derive rather than trust: `randomness` as served is an assertion, H(signature) is a
  // computation. If a mirror ever disagreed with its own signature this is what catches it.
  const derived = crypto.createHash('sha256')
    .update(Buffer.from(String(fetched.signature), 'hex')).digest('hex');
  if (derived !== b.randomness) {
    return { bound: false, reason: `beacon randomness mismatch: entry commits to ${b.randomness.slice(0, 16)}…, round ${b.round} hashes to ${derived.slice(0, 16)}…` };
  }
  return { bound: true, unix: roundTime(Number(b.round), QUICKNET) };
}

/**
 * Full check. `anchor` is the anchor record covering this entry — `{ slot, blockTime }` as
 * returned by anchor.js. Returns a verdict rather than throwing, because "this row is only
 * one-sided" is a normal, disclosed state for every entry written before beacon binding
 * existed, and callers must be able to render that difference instead of erroring on it.
 *
 * `bounded` is the field to branch on:
 *   'two-sided'      both ends external — the strong form
 *   'not-after-only' anchored but no beacon — every pre-2026-08-06 row, honest and weaker
 *   'none'           not anchored yet — no external time at all, do not score it
 */
async function verifyEntryInterval({ entry, anchor, fetch = fetchRound } = {}) {
  const problems = [];
  let not_before = null;
  let not_after = null;

  if (anchor && Number.isFinite(anchor.blockTime)) {
    not_after = {
      unix: anchor.blockTime,
      iso: iso(anchor.blockTime),
      source: `solana:slot:${anchor.slot}`,
    };
  } else if (anchor && anchor.slot != null) {
    // A slot with no blockTime is an ordering bound without a wall clock. Say so rather
    // than silently returning a null upper end that reads as "unanchored".
    problems.push(`anchor slot ${anchor.slot} has no blockTime — ordering is bound, wall-clock is not`);
  }

  if (entry && entry.beacon) {
    let fetched = null;
    try {
      fetched = await fetch(Number(entry.beacon.round));
    } catch (e) {
      problems.push(`beacon round ${entry.beacon.round} could not be verified: ${e.message}`);
    }
    if (fetched) {
      const chk = checkBeaconBinding(entry, fetched);
      if (!chk.bound) problems.push(chk.reason);
      else not_before = { unix: chk.unix, iso: iso(chk.unix), source: `drand:quicknet:round:${entry.beacon.round}` };
    }
  }

  // THE CONTRADICTION CHECK. An interval whose start is after its end is not a weak
  // bound, it is a broken row: either the anchor is not the one covering this entry or
  // the beacon line was grafted on afterwards. Fail it loudly instead of rendering an
  // impossible interval that a reader would take as a stronger claim than a missing one.
  if (not_before && not_after && not_before.unix > not_after.unix) {
    problems.push(
      `impossible interval: beacon not-before ${not_before.iso} is after anchor not-after ${not_after.iso}`
    );
  }

  const bounded = problems.length ? 'invalid'
    : not_before && not_after ? 'two-sided'
      : not_after ? 'not-after-only'
        : 'none';

  return { ok: problems.length === 0, bounded, not_before, not_after, problems };
}

/**
 * What to commit to when WRITING a row: the most recent round that has certainly
 * published. Picking `roundAt(now)` races the beacon — at the boundary the round exists
 * arithmetically but is not yet served by any mirror, so the row would name a value a
 * verifier cannot fetch yet. One round of slack (3s on quicknet) costs nothing on a bound
 * measured against outcomes days away, and removes a class of flaky writes.
 */
async function currentBinding({ fetch = fetchRound, now = Date.now } = {}) {
  const { roundAt } = require('./beacon');
  const round = roundAt(Math.floor(now() / 1000), QUICKNET) - 1;
  const b = await fetch(round);
  return { chain: QUICKNET.chain_hash, round: String(b.round), randomness: b.randomness };
}

module.exports = { verifyEntryInterval, checkBeaconBinding, currentBinding };
