'use strict';
/**
 * schedule-check.js — recompute every question we ever asked, from public data.
 *
 * This is the program that makes the window mechanism worth anything. Board-minted
 * questions solve admission only if the board could not choose them; "we promise we
 * derived these" is a promise, and the entire project exists because promises are the
 * thing being replaced. So the schedule has to be RECONSTRUCTABLE rather than asserted:
 * given the chain alone, anyone re-derives every question and compares.
 *
 * It reports ALL problems rather than the first. A checker that stops at the earliest
 * failure lets a second, worse one hide behind it, and the second one is usually the
 * interesting one.
 */

const crypto = require('crypto');
const W = require('./windows');
const B = require('./beacon');

/**
 * @param rows      chain rows (or bare entries) covering one or more epochs
 * @param opts.catalog   catalog to check against (defaults to the shipped one)
 * @param opts.enrolled  caller keys believed enrolled. Either a per-epoch map
 *                       `{ '2026-W31': [key, …] }`, or a bare array meaning "these keys,
 *                       in every epoch present". When supplied, every question's caller
 *                       must be a member and the frozen enrolled_root must match.
 *
 *                       THE ARRAY FORM ONLY MAKES SENSE FOR A SINGLE EPOCH. It shipped as
 *                       the only form, and the operator CLI fed it the UNION of enrollees
 *                       across the whole chain, so from the second epoch onward every
 *                       round was reported `enrolled_root does not match` on a chain that
 *                       was entirely honest. A self-check that cries fraud at correct data
 *                       is worse than no self-check: it trains us to read MISMATCH as
 *                       noise, which is precisely the reading that would hide a real one.
 * @returns { ok, checked, epochs, problems[] }
 */
function checkSchedule(rows, opts = {}) {
  const catalog = opts.catalog || W.CATALOG;
  const problems = [];
  const enrolledFor = (name) => {
    if (!opts.enrolled) return null;
    if (Array.isArray(opts.enrolled)) return opts.enrolled;
    return Object.prototype.hasOwnProperty.call(opts.enrolled, name) ? opts.enrolled[name] : null;
  };
  const entries = rows.map((r) => (r && r.entry ? r.entry : r)).filter((e) => W.isWindowRow(e));

  const byEpoch = new Map();
  const ep = (name) => {
    if (!byEpoch.has(name)) byEpoch.set(name, { commit: null, close: null, reveal: null, questions: [] });
    return byEpoch.get(name);
  };

  for (const e of entries) {
    switch (e.type) {
      case 'schedule_commit': {
        const slot = ep(e.epoch);
        // Two commitments for one epoch is not a duplicate, it is a choice: whichever seed
        // produced the nicer questions could be pointed at afterwards.
        if (slot.commit) problems.push(`epoch ${e.epoch}: more than one schedule_commit — the commitment is not binding if it can be reissued`);
        else slot.commit = e;
        break;
      }
      case 'enrollment_close': {
        const slot = ep(e.epoch);
        if (slot.close) problems.push(`epoch ${e.epoch}: more than one enrollment_close`);
        else slot.close = e;
        break;
      }
      case 'seed_reveal': {
        const slot = ep(e.epoch);
        if (slot.reveal) problems.push(`epoch ${e.epoch}: more than one seed_reveal`);
        else slot.reveal = e;
        break;
      }
      case 'question':
        ep(e.epoch).questions.push(e);
        break;
      case 'schedule_void': {
        const slot = ep(e.epoch);
        // Repeated voids are harmless — the epoch is already dead and a second row cannot
        // make it deader. Only the first is kept so the reported reason is stable.
        if (!slot.void) slot.void = e;
        break;
      }
      default:
        break;
    }
  }

  let checked = 0;

  // Voids are checked BEFORE the "no questions, nothing to re-derive" shortcut below,
  // because the whole risk of a retraction is that it becomes a quiet delete. A voided
  // epoch normally has nothing to re-derive, so a checker that skipped empty epochs would
  // wave every void through without looking at it, including the ones that are covering
  // something up. The three rules:
  //
  //   1. A voided epoch may never be closed, revealed or asked. If it were, "void" would
  //      just be an operator note next to a round that ran anyway.
  //   2. Voiding an epoch that ALREADY HAS QUESTIONS is a MISMATCH, not a cleanup. Once
  //      questions exist, callers are owed a settlement; retracting at that point is
  //      unasking a question whose answer is already known to us. This is the rule that
  //      stops void from being a delete with better manners.
  //   3. Ordering matters and is checked by rule 2 alone: the chain is append-only and
  //      seq-ordered, so "already has questions" and "asked after the void" are the same
  //      set of rows from a verifier's side, and both are refused.
  for (const [name, slot] of byEpoch) {
    if (!slot.void) continue;
    const after = [];
    if (slot.close) after.push('enrollment_close');
    if (slot.reveal) after.push('seed_reveal');
    if (slot.questions.length) after.push(`${slot.questions.length} question(s)`);
    if (after.length) {
      problems.push(
        `epoch ${name}: voided, but the chain also carries ${after.join(', ')} — a voided epoch `
        + 'must never be closed, revealed or asked, or the void is a delete with better manners');
    }
  }

  for (const [name, slot] of byEpoch) {
    if (slot.void) continue; // already reported above if it carried anything
    if (!slot.questions.length) continue;

    if (!slot.commit) {
      problems.push(`epoch ${name}: ${slot.questions.length} question(s) but no schedule_commit — nothing binds which questions were asked`);
      continue;
    }
    if (!slot.reveal) {
      problems.push(`epoch ${name}: no seed_reveal yet — questions cannot be re-derived until the seed is public`);
      continue;
    }
    if (!slot.close) {
      problems.push(`epoch ${name}: no enrollment_close — the enrolled set was never frozen`);
      continue;
    }

    const opened = crypto.createHash('sha256').update(String(slot.reveal.seed), 'utf8').digest('hex');
    if (opened !== slot.commit.seed_commit) {
      problems.push(
        `epoch ${name}: revealed seed does not open the commitment `
        + `(H(seed)=${opened.slice(0, 12)}… committed=${String(slot.commit.seed_commit).slice(0, 12)}…) `
        + '— the schedule was chosen after the fact');
      continue;
    }

    // A checker must return a verdict on hostile input, never an exception. A crash and a
    // clean pass are equally useless to someone trying to find out whether we cheated,
    // and a crash is the one that looks like the tool is broken rather than the record.
    let wantCatalog;
    try { wantCatalog = W.catalogHash(catalog); }
    catch (e) {
      problems.push(`epoch ${name}: supplied catalog is not hashable (${e.message}) — cannot check the question pool`);
      wantCatalog = null;
    }
    if (wantCatalog !== null && wantCatalog !== slot.commit.catalog_hash) {
      problems.push(
        `epoch ${name}: catalog hash mismatch (have ${wantCatalog.slice(0, 12)}… `
        + `committed ${String(slot.commit.catalog_hash).slice(0, 12)}…) — the question pool changed after the commitment`);
    }

    const want = enrolledFor(name);
    if (want) {
      const wantRoot = W.enrolledRoot(want);
      if (wantRoot !== slot.close.enrolled_root) {
        problems.push(`epoch ${name}: enrolled_root does not match the supplied enrolled set`);
      }
    }

    // Which rule this epoch was derived under is a property of its COMMITMENT, never of the
    // checker's default. Reading the version from anywhere else — a flag, the newest code —
    // is how a chain gets re-derived under a rule it did not commit to, which is
    // indistinguishable from choosing the questions after the fact.
    const version = slot.commit.derivation === undefined ? '1' : String(slot.commit.derivation);
    if (!W.DERIVATIONS.has(version)) {
      problems.push(`epoch ${name}: schedule_commit names derivation ${JSON.stringify(version)}, which this checker does not implement`);
      continue;
    }

    let deriveExtra = {};
    if (version === '1') {
      deriveExtra = { enrolled_root: slot.close.enrolled_root };
    } else {
      // v2: the beacon has to be present, has to be the round that was NAMED, and has to
      // carry a signature that verifies. Any one of those missing turns the external number
      // back into a number we typed.
      if (!slot.reveal.beacon_randomness || !slot.reveal.beacon_sig || !slot.reveal.beacon_round) {
        problems.push(`epoch ${name}: derivation 2 but the seed_reveal carries no beacon value — the seed is ours alone again`);
        continue;
      }
      if (String(slot.reveal.beacon_round) !== String(slot.commit.beacon_round)) {
        problems.push(
          `epoch ${name}: beacon round ${slot.reveal.beacon_round} was revealed but round `
          + `${slot.commit.beacon_round} was committed — the round was chosen after it was visible`);
        continue;
      }
      if (String(slot.commit.beacon_chain) !== B.QUICKNET.chain_hash) {
        problems.push(`epoch ${name}: beacon_chain ${String(slot.commit.beacon_chain).slice(0, 12)}… is not the drand chain this checker knows`);
        continue;
      }
      const bv = B.verifyBeacon({
        round: Number(slot.reveal.beacon_round),
        signature: slot.reveal.beacon_sig,
        randomness: slot.reveal.beacon_randomness,
      });
      if (!bv.ok) {
        problems.push(`epoch ${name}: beacon round ${slot.reveal.beacon_round} does not verify (${bv.reason})`);
        continue;
      }
      // The round must fall AFTER enrolment shut. A round already public while callers
      // could still enrol is a round they could have waited to see.
      if (B.roundTime(Number(slot.commit.beacon_round)) <= Number(slot.commit.enroll_closes_at)) {
        problems.push(
          `epoch ${name}: beacon round ${slot.commit.beacon_round} was public at `
          + `${new Date(B.roundTime(Number(slot.commit.beacon_round)) * 1000).toISOString()}, at or before enrolment closed at `
          + `${new Date(Number(slot.commit.enroll_closes_at) * 1000).toISOString()} — it could be waited for`);
      }
      deriveExtra = { beacon_randomness: slot.reveal.beacon_randomness };
    }

    for (const q of slot.questions) {
      if (want && !want.includes(q.caller_key)) {
        problems.push(`epoch ${name} window ${q.window_index}: caller ${q.caller_key.slice(0, 8)}… is not in the enrolled set`);
      }

      const parsed = W.parseQuestionMarket(q.market);
      if (!parsed) {
        problems.push(`epoch ${name} window ${q.window_index}: market is unparseable (${q.market})`);
        continue;
      }

      let derived;
      try {
        derived = W.deriveQuestion({
          seed: slot.reveal.seed,
          ...deriveExtra,
          caller_key: q.caller_key,
          window_index: Number(q.window_index),
          catalog,
          version,
        });
      } catch (e) {
        problems.push(`epoch ${name} window ${q.window_index}: could not derive (${e.message})`);
        continue;
      }

      checked += 1;
      if (derived.asset !== parsed.asset || derived.horizon_sec !== parsed.horizon_sec) {
        problems.push(
          `epoch ${name} window ${q.window_index} for ${q.caller_key.slice(0, 8)}…: `
          + `asked ${parsed.asset}/${parsed.horizon_sec}s but derivation says ${derived.asset}/${derived.horizon_sec}s `
          + '— the question does not match the derived question');
      }
    }
  }

  return { ok: problems.length === 0, checked, epochs: [...byEpoch.keys()], problems };
}

module.exports = { checkSchedule };
