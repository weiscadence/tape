'use strict';
/**
 * pledge.js — the second half of a record: did the agent DO WHAT IT SAID IT WOULD.
 *
 * The call half answers "were they right". This half answers a question a human actually
 * asks about an agent they are about to trust with something: it told me it would handle X
 * by Friday — did it? Those are different competences and a good score on one says nothing
 * about the other. An agent can be an excellent forecaster and completely unreliable.
 *
 * WHY THIS IS NOT JUST A TODO LIST WITH SIGNATURES. Three properties, in order of how much
 * each one is doing:
 *
 *   1. SILENCE IS A ROW. A pledge whose deadline passes with no report settles as
 *      `unreported`, and unreported counts against the rate exactly as hard as a failure.
 *      Without this the whole thing inverts: the cheapest strategy is to report your wins
 *      and go quiet on the rest, which is the curated record we are supposed to be
 *      replacing. This is the same rule as `no_answer` in the window mechanism and it is
 *      here for the same reason.
 *
 *   2. THE CHAIN OVERRIDES THE CLAIM. Where a pledge is mechanically checkable — you said
 *      you would post three calls, you said you would close this position — the record is
 *      checked against itself and the check WINS over what the agent said about itself. So
 *      the first lie is caught by the system rather than by a human who never came back.
 *      A pledge that is caught this way is marked `contradicted`, permanently, and that flag
 *      is worth more than the outcome it corrects.
 *
 *   3. ADMITTING BEATS VANISHING, WITHOUT BEING FREE. `broken` and `unreported` both count
 *      against the rate. If admitting a failure cost less, "I broke it" would be the cheap
 *      way out; if it were not distinguished at all, there would be no reason to ever
 *      report a failure and everyone would go quiet. So the rate treats them the same and
 *      the RECORD keeps them apart. Same shape as `pass` vs `no_answer`.
 *
 * WHAT THIS DELIBERATELY CANNOT DO. It cannot verify a pledge about the world — "I will
 * email the client" is unfalsifiable from here and always will be. Those are accepted with
 * `check: 'none'`, settle on self-report, and are labelled as self-reported wherever they
 * are displayed. A system that quietly mixed those in with chain-checked ones would be
 * lending its own credibility to claims it never examined, which is the exact move the
 * operator-key registry exists to stop us making about caller counts.
 */

const crypto = require('crypto');
const { canonicalize } = require('./canonical');
const ed = require('./ed25519');

/**
 * Its own signature domain, separate from `tape:v1:` (calls) and `tape:v1:window:`
 * (assigned questions). A signature over one row shape must never be liftable onto another
 * — the domains are what make the three families non-interchangeable even if their
 * canonical bytes ever collided.
 */
const SIG_DOMAIN = 'tape:v1:pledge:';

const PLEDGE_TYPES = new Set([
  'pledge',         // agent: I will do this, by then
  'pledge_report',  // agent: I did / did not do it
  'pledge_settle',  // board: what the record says happened, which may disagree with the agent
]);

/**
 * The checks a pledge can be settled by WITHOUT anyone's word for it.
 *
 * Enumerated and small, exactly like the question catalog, and for the same reason: a
 * free-text predicate is a promise shaped like a rule. Every one of these is answerable
 * from rows already on this chain, so the check needs no oracle, no network, and no
 * cooperation from the agent being checked.
 *
 *   none            unfalsifiable from here. Settles on self-report, labelled as such.
 *   post_call       "I will post at least N calls before the deadline." arg: N.
 *   close_ref       "I will close this open position." arg: the open's entry_hash.
 *   answer_windows  "I will answer every question minted to me in epoch E." arg: E.
 *                   The strongest of the four, because the questions were not chosen by
 *                   the agent and going quiet on one is already a public row.
 */
const CHECKS = new Set(['none', 'post_call', 'close_ref', 'answer_windows']);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const OUTCOMES = new Set(['kept', 'broken']);
const SETTLED = new Set(['kept', 'broken', 'unreported']);
const BASES = new Set(['chain_checked', 'self_reported', 'no_report']);

const REQUIRED = {
  pledge: ['text', 'due_at', 'check', 'ts_claimed', 'nonce'],
  pledge_report: ['pledge_hash', 'outcome', 'ts_claimed', 'nonce'],
  pledge_settle: ['pledge_hash', 'outcome', 'basis', 'contradicted', 'observed_at'],
};

/**
 * `check_arg` is optional rather than required-with-a-placeholder.
 *
 * A required field carrying '-' for the `none` case would be a field the signer believes is
 * covered and a reader has to know to ignore. Cross-field validation ("a post_call pledge
 * must carry one") lives in the builder below, which can see both fields at once — the same
 * split schedule_commit uses for its beacon fields.
 */
const OPTIONAL = { pledge: ['check_arg'], pledge_report: ['note'] };

const isPledgeRow = (entry) => !!entry && entry.p === 'tape-pledge';

/**
 * Build and validate a pledge-family row.
 *
 * Unknown fields are REJECTED, never dropped: a silently-ignored field is a field the signer
 * believed the signature covered and it did not. `ref` is always present and null so
 * chain.js's back-reference check behaves identically across all three row families.
 */
function buildPledgeRow(input) {
  const type = input.type;
  if (!PLEDGE_TYPES.has(type)) {
    throw new TypeError(`pledge.type must be one of ${[...PLEDGE_TYPES].join('|')}`);
  }
  const allowed = new Set(['type', 'signer', 'sig', ...REQUIRED[type], ...(OPTIONAL[type] || [])]);
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) throw new TypeError(`pledge row: unknown field ${JSON.stringify(k)} for type ${type}`);
  }
  for (const f of REQUIRED[type]) {
    if (input[f] === undefined || input[f] === null) throw new TypeError(`pledge row: ${type}.${f} required`);
  }

  const out = { p: 'tape-pledge', v: '1', type, ref: null };

  const unix = (name, val) => {
    if (!Number.isInteger(val) || val <= 0) throw new TypeError(`pledge row: ${type}.${name} must be a unix second integer`);
    return String(val); // string, because canonical.js refuses raw numbers
  };
  const iso = (name, val) => {
    if (typeof val !== 'string' || Number.isNaN(Date.parse(val))) {
      throw new TypeError(`pledge row: ${type}.${name} must be ISO-8601`);
    }
    return val;
  };
  const nonce = (val) => {
    if (!HEX32.test(String(val))) throw new TypeError(`pledge row: ${type}.nonce must be 32 hex chars`);
    return String(val);
  };

  switch (type) {
    case 'pledge': {
      // Long enough to be a commitment somebody could be held to. "done" is not a pledge,
      // and a record full of one-word pledges is a rate with nothing behind it.
      if (typeof input.text !== 'string' || input.text.trim().length < 12) {
        throw new TypeError('pledge row: pledge.text must say what you will actually do (12+ chars)');
      }
      if (input.text.length > 280) throw new TypeError('pledge row: pledge.text must be under 280 chars');
      out.text = input.text;
      out.due_at = unix('due_at', input.due_at);
      if (!CHECKS.has(String(input.check))) {
        throw new TypeError(`pledge row: pledge.check must be one of ${[...CHECKS].join('|')}`);
      }
      out.check = String(input.check);
      if (out.check === 'none') {
        if (input.check_arg !== undefined) throw new TypeError('pledge row: check "none" takes no check_arg');
      } else {
        if (typeof input.check_arg !== 'string' || !input.check_arg.length) {
          throw new TypeError(`pledge row: check ${out.check} requires a check_arg`);
        }
        if (out.check === 'post_call' && !/^[1-9][0-9]*$/.test(input.check_arg)) {
          throw new TypeError('pledge row: post_call check_arg must be a positive integer as a string');
        }
        if (out.check === 'close_ref' && !HEX64.test(input.check_arg)) {
          throw new TypeError('pledge row: close_ref check_arg must be the 64-hex entry_hash of the open');
        }
        out.check_arg = input.check_arg;
      }
      out.ts_claimed = iso('ts_claimed', input.ts_claimed);
      out.nonce = nonce(input.nonce);
      break;
    }
    case 'pledge_report': {
      out.pledge_hash = String(input.pledge_hash);
      if (!HEX64.test(out.pledge_hash)) throw new TypeError('pledge row: pledge_report.pledge_hash must be 64 hex chars');
      if (!OUTCOMES.has(String(input.outcome))) {
        throw new TypeError('pledge row: pledge_report.outcome must be kept|broken — "unreported" is not something you can claim about yourself');
      }
      out.outcome = String(input.outcome);
      if (input.note !== undefined) {
        if (typeof input.note !== 'string' || input.note.length > 280) {
          throw new TypeError('pledge row: pledge_report.note must be a string under 280 chars');
        }
        out.note = input.note;
      }
      out.ts_claimed = iso('ts_claimed', input.ts_claimed);
      out.nonce = nonce(input.nonce);
      break;
    }
    case 'pledge_settle': {
      out.pledge_hash = String(input.pledge_hash);
      if (!HEX64.test(out.pledge_hash)) throw new TypeError('pledge row: pledge_settle.pledge_hash must be 64 hex chars');
      if (!SETTLED.has(String(input.outcome))) {
        throw new TypeError(`pledge row: pledge_settle.outcome must be one of ${[...SETTLED].join('|')}`);
      }
      out.outcome = String(input.outcome);
      if (!BASES.has(String(input.basis))) {
        throw new TypeError(`pledge row: pledge_settle.basis must be one of ${[...BASES].join('|')}`);
      }
      out.basis = String(input.basis);
      if (typeof input.contradicted !== 'boolean') {
        throw new TypeError('pledge row: pledge_settle.contradicted must be a boolean — the whole point of the flag is that it is never absent');
      }
      out.contradicted = input.contradicted;
      out.observed_at = unix('observed_at', input.observed_at);
      break;
    }
    default:
      throw new TypeError(`unhandled pledge type ${type}`);
  }

  out.signer = input.signer === undefined ? null : input.signer;
  out.sig = input.sig === undefined ? null : input.sig;
  if (out.signer !== null && !ed.isBase58Key(out.signer)) {
    throw new TypeError('pledge row: signer must be a base58 ed25519 public key');
  }
  return out;
}

/** Bytes a pledge signature covers: domain prefix + canonical row minus signer/sig. */
function pledgeSigningBytes(row) {
  const { signer, sig, ...rest } = row;
  return Buffer.from(SIG_DOMAIN + canonicalize(rest), 'utf8');
}

function signPledgeRow(row, secretKey) {
  const signer = ed.publicKeyOf(secretKey);
  const withSigner = { ...row, signer, sig: null };
  const sig = ed.sign(pledgeSigningBytes(withSigner), secretKey);
  return { ...withSigner, sig };
}

/**
 * Verify a pledge row's signature.
 *
 * Returns the VERDICT OBJECT `{signed, ok, signer, reason}`, not a boolean, because that is
 * what chain.js consumes: it does `if (sigCheck.signed && !sigCheck.ok) throw`. This
 * returned a plain boolean for its first draft, which meant `sigCheck.signed` was
 * `undefined`, the check was skipped entirely, and the chain would have accepted a FORGED
 * pledge row without complaint. A signature check that silently does not run is worse than
 * no signature check, because everything downstream is written as though it ran. The test
 * `a forged pledge row is refused by the chain` is the one that has to stay green.
 */
function verifyPledgeRow(row) {
  const signer = row.signer ?? null;
  const sig = row.sig ?? null;
  if (signer === null && sig === null) return { signed: false, ok: true, signer: null, reason: 'unsigned' };
  if (signer === null || sig === null) {
    return { signed: true, ok: false, signer, reason: 'pledge: signer and sig must both be present' };
  }
  let ok = false;
  try { ok = ed.verify(pledgeSigningBytes(row), sig, signer); } catch { ok = false; }
  return { signed: true, ok, signer, reason: ok ? 'signature verified' : 'pledge signature does not verify' };
}

/* ─────────────────────────────────────────────────────── settlement */

const entryOf = (r) => (r && r.entry ? r.entry : r);

/**
 * Answer a chain-checkable pledge from the chain alone.
 *
 * Returns 'kept' | 'broken', or null when the pledge is not mechanically checkable. Only
 * rows signed by the PLEDGER count, and only rows whose claimed time falls inside the
 * pledge window — otherwise an agent could satisfy a pledge with work it had already
 * published before making it, which is a pledge about the past.
 */
function chainVerdict(pledge, pledgeHash, rows) {
  if (pledge.check === 'none') return null;
  const who = pledge.signer;
  const from = Date.parse(pledge.ts_claimed) / 1000;
  const to = Number(pledge.due_at);
  // A CALL row is identified by exclusion, not by a `p` field — call entries predate the
  // protocol tag and carry none, so `e.p === 'tape'` matches nothing and every chain check
  // would have returned `broken` for work that was actually done. Caught by the positive
  // half of these tests, which is why each check has one.
  const W = require('./windows');
  // Required lazily, like windows above: attest.js is a peer family and a top-level require
  // here would close a cycle. Excluded for the same reason as the other two — an agent that
  // pledged to post three CALLS has not discharged it by attesting three verifications.
  const { isAttestRow } = require('./attest');
  const isCall = (e) => !W.isWindowRow(e) && !isPledgeRow(e) && !isAttestRow(e);
  const mine = rows.map(entryOf).filter((e) => e && e.signer === who);
  const inWindow = (iso) => {
    const t = Date.parse(iso) / 1000;
    return Number.isFinite(t) && t >= from && t <= to;
  };

  switch (pledge.check) {
    case 'post_call': {
      const n = mine.filter((e) => isCall(e) && e.type === 'open' && inWindow(e.ts_claimed)).length;
      return n >= Number(pledge.check_arg) ? 'kept' : 'broken';
    }
    case 'close_ref': {
      // `ref`, not `entry_ref`. A call's `entry_ref` is the entry PRICE as a decimal
      // string; `ref` is the hash of the open being closed. Matching the wrong one would
      // have made close_ref unsatisfiable in practice while still looking implemented.
      const closed = mine.some((e) => isCall(e) && e.type === 'close'
        && e.ref === pledge.check_arg && inWindow(e.ts_claimed));
      return closed ? 'kept' : 'broken';
    }
    case 'answer_windows': {
      // Questions minted to this agent in the named epoch. A pledge to answer questions
      // that were never asked is vacuously kept, which would be a free point — so an epoch
      // with no questions for this agent is BROKEN rather than kept. You cannot earn
      // reliability by promising something the board never gave you a chance to fail.
      const qs = rows.filter((r) => {
        const e = entryOf(r);
        return e && W.isWindowRow(e) && e.type === 'question'
          && e.epoch === pledge.check_arg && e.caller_key === who;
      });
      if (!qs.length) return 'broken';
      const hashes = new Set(qs.map((r) => r.entry_hash));
      const answered = new Set(mine
        .filter((e) => W.isWindowRow(e) && (e.type === 'answer' || e.type === 'pass')
          && hashes.has(e.question_hash) && inWindow(e.ts_claimed))
        .map((e) => e.question_hash));
      return answered.size === hashes.size ? 'kept' : 'broken';
    }
    default:
      return null;
  }
}

/**
 * What every due-but-unsettled pledge should settle as, right now.
 *
 * Pure: it computes and returns, it does not append. The caller writes the rows, so this
 * can be run by anyone auditing us to check that the settlements we published are the ones
 * the rules produce. A settler that could only be run by the operator would be a rule only
 * the operator can check.
 */
function pendingSettlements(rows, nowUnix) {
  const settled = new Set(rows.map(entryOf)
    .filter((e) => e && isPledgeRow(e) && e.type === 'pledge_settle')
    .map((e) => e.pledge_hash));

  const out = [];
  for (const r of rows) {
    const e = entryOf(r);
    if (!e || !isPledgeRow(e) || e.type !== 'pledge') continue;
    if (settled.has(r.entry_hash)) continue;
    if (Number(e.due_at) > nowUnix) continue; // not due yet; nothing is wrong

    // Only a report the agent filed BEFORE its own deadline counts. A report filed after
    // the fact is a claim made with the answer already visible, which is the thing the
    // deadline exists to prevent.
    const report = rows.map(entryOf).find((x) => x && isPledgeRow(x) && x.type === 'pledge_report'
      && x.pledge_hash === r.entry_hash && x.signer === e.signer
      && Date.parse(x.ts_claimed) / 1000 <= Number(e.due_at));

    const verdict = chainVerdict(e, r.entry_hash, rows);
    let outcome, basis, contradicted = false;
    if (verdict !== null) {
      outcome = verdict;
      basis = 'chain_checked';
      contradicted = !!report && report.outcome !== verdict;
    } else if (report) {
      outcome = report.outcome;
      basis = 'self_reported';
    } else {
      outcome = 'unreported';
      basis = 'no_report';
    }
    out.push({ pledge_hash: r.entry_hash, outcome, basis, contradicted, observed_at: nowUnix });
  }
  return out;
}

/**
 * The reliability record, per signer.
 *
 * `rate` is null for an agent with nothing settled — NEVER 1. An untested agent reading as
 * perfect is the single most flattering bug this file could have, and the window mechanism
 * already shipped that bug once.
 *
 * The denominator includes `unreported`. That is the whole design: going quiet is a result,
 * not an absence.
 */
function keptRecord(rows) {
  const byPledge = new Map();
  for (const r of rows) {
    const e = entryOf(r);
    if (e && isPledgeRow(e) && e.type === 'pledge') byPledge.set(r.entry_hash, e);
  }
  const acc = new Map();
  const of = (signer) => {
    if (!acc.has(signer)) {
      acc.set(signer, { signer, made: 0, kept: 0, broken: 0, unreported: 0, open: 0, contradicted: 0 });
    }
    return acc.get(signer);
  };
  for (const [, e] of byPledge) if (e.signer) of(e.signer).made++;

  const seen = new Set();
  for (const r of rows) {
    const e = entryOf(r);
    if (!e || !isPledgeRow(e) || e.type !== 'pledge_settle') continue;
    if (seen.has(e.pledge_hash)) continue; // first settlement binds; a re-settle is not a do-over
    const p = byPledge.get(e.pledge_hash);
    if (!p || !p.signer) continue;
    seen.add(e.pledge_hash);
    const a = of(p.signer);
    a[e.outcome]++;
    if (e.contradicted) a.contradicted++;
  }

  for (const a of acc.values()) {
    a.open = a.made - (a.kept + a.broken + a.unreported);
    const settled = a.kept + a.broken + a.unreported;
    a.settled = settled;
    a.rate = settled ? a.kept / settled : null;
    a.basis = settled
      ? `${a.kept} kept of ${settled} settled — ${a.unreported} went quiet, which counts as a miss`
      : 'nothing has settled yet. this is undefined, not perfect.';
  }
  return [...acc.values()].sort((x, y) => y.made - x.made || x.signer.localeCompare(y.signer));
}

module.exports = {
  SIG_DOMAIN, PLEDGE_TYPES, CHECKS, REQUIRED, OPTIONAL,
  isPledgeRow, buildPledgeRow, pledgeSigningBytes, signPledgeRow, verifyPledgeRow,
  chainVerdict, pendingSettlements, keptRecord,
};
