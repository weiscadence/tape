#!/usr/bin/env node
'use strict';
/**
 * windows.js (cli) — drive the board-minted question mechanism.
 *
 * Order is not a convenience here, it is the whole guarantee. `commit` must land, and be
 * anchored, before `close`; `close` before `reveal`; `reveal` before `ask`. Each step
 * refuses to run out of order rather than warning about it, because a schedule assembled
 * in the wrong order is exactly the schedule we are claiming we cannot produce.
 *
 *   commit  <epoch> [--windows N] [--open-hours H]
 *                                   publish H(seed); enrollment opens for H hours (default 48)
 *   enroll  <epoch> --key <file>    a caller opts in (signed by the caller)
 *   close   <epoch>                 freeze the enrolled set into enrolled_root
 *   void    <epoch> --reason "…"    retract an epoch by APPENDING; it can never be closed,
 *                                   revealed or asked afterwards. never delete a row.
 *   reveal  <epoch>                 publish the seed; questions become derivable
 *   ask     <epoch>                 mint every derived question as a row
 *   sweep                           write no_answer for every expired open window
 *   check                           recompute the whole schedule from the chain
 *   show    <epoch>                 human-readable state
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Chain } = require('../lib/chain');
const { entryHash, newNonce } = require('../lib/entry');
const ed = require('../lib/ed25519');
const W = require('../lib/windows');
const B = require('../lib/beacon');
const { checkSchedule } = require('../lib/schedule-check');
const { GRID_SEC, gridAsOf } = require('../lib/asof');

const DATA = path.join(__dirname, '..', 'data');
// Overridable so a full epoch can be rehearsed end to end against a throwaway chain
// before it is run against the real one. Rehearsing on the live tape is not a rehearsal.
const CHAIN = process.env.TAPE_CHAIN || path.join(DATA, 'tape.jsonl');
const SECURE = path.join(os.homedir(), '.config/cadence-secure');
const BOARD_KEY = process.env.TAPE_BOARD_KEY || path.join(SECURE, 'tape-board-key.json');
/** Seeds live outside the chain until reveal. A seed on disk next to the commitment is
 *  fine; a seed in the repo would be a commitment anyone could open early, which is not a
 *  commitment. */
const SEEDS = process.env.TAPE_SEED_FILE || path.join(SECURE, 'tape-window-seeds.json');

const die = (msg) => { console.error(msg); process.exit(1); };

function boardKey() {
  try { return Buffer.from(JSON.parse(fs.readFileSync(BOARD_KEY, 'utf8'))); }
  catch (e) { die(`no board key at ${BOARD_KEY} (${e.message}); run: node bin/windows.js keygen`); }
}

const readSeeds = () => { try { return JSON.parse(fs.readFileSync(SEEDS, 'utf8')); } catch { return {}; } };
const writeSeeds = (o) => {
  fs.mkdirSync(path.dirname(SEEDS), { recursive: true });
  fs.writeFileSync(SEEDS, JSON.stringify(o, null, 2), { mode: 0o600 });
};

const chain = () => new Chain(CHAIN);
const rows = () => chain().read();
const windowRows = () => rows().filter((r) => W.isWindowRow(r.entry));
const ofEpoch = (epoch, type) =>
  windowRows().filter((r) => r.entry.type === type && r.entry.epoch === epoch);

function appendSigned(row) {
  const signed = W.signWindowRow(row, boardKey());
  const rec = chain().append(signed);
  console.log(`  seq ${rec.seq}  ${row.type}  ${rec.entry_hash.slice(0, 12)}…`);
  return rec;
}

function cmdKeygen() {
  if (fs.existsSync(BOARD_KEY)) die(`refusing to overwrite ${BOARD_KEY} — a new board key orphans every row the old one signed`);
  const kp = crypto.generateKeyPairSync('ed25519');
  const sk = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pk = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const full = Buffer.concat([sk, pk]);
  fs.mkdirSync(path.dirname(BOARD_KEY), { recursive: true });
  fs.writeFileSync(BOARD_KEY, JSON.stringify([...full]), { mode: 0o600 });
  console.log(`board key written to ${BOARD_KEY}\npublic: ${ed.publicKeyOf(full)}`);
}

/** Default enrollment window, in hours. NOT a taste call.
 *
 * This was one grid point — fifteen minutes — and that shipped. Epoch 2026-W33 was
 * committed and announced on two venues while its door was already shut, because the
 * announcement took longer to write than the window stayed open. Every stranger who
 * followed that post would have been handed `enrollment for 2026-W33 closed at …`, which
 * reads as a system that does not work rather than as a deadline they missed.
 *
 * The deadline still has to be DERIVED rather than chosen, or the board can shorten a
 * window once it sees who is enrolling. So it stays snapped to the grid; the only thing
 * that changed is how many grid points wide it is, and that number is published in the
 * commitment before anybody enrolls. */
const DEFAULT_OPEN_HOURS = 48;

/**
 * How long after enrolment shuts the beacon round lands. One grid point.
 *
 * Not zero. A round whose publication time equals the close instant is a round a caller
 * could plausibly have seen while the door was still open, and "plausibly" is the whole
 * argument here. Derived from the grid rather than picked, for the same reason the close
 * itself is: any number we are free to nudge is a number we can be accused of nudging.
 */
const BEACON_LAG_SEC = GRID_SEC;

function cmdCommit(epoch, windows, openHours, derivation) {
  if (ofEpoch(epoch, 'schedule_commit').length) die(`epoch ${epoch} is already committed — reissuing a commitment is choosing a seed`);
  if (!Number.isFinite(openHours) || openHours <= 0) die(`--open-hours must be a positive number, got ${openHours}`);
  if (!W.DERIVATIONS.has(String(derivation))) die(`--derivation must be one of ${[...W.DERIVATIONS].join('|')}`);
  const span = Math.ceil((openHours * 3600) / GRID_SEC) * GRID_SEC;
  const seeds = readSeeds();
  const seed = crypto.randomBytes(32).toString('hex');
  seeds[epoch] = seed;
  writeSeeds(seeds);
  const seed_commit = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
  const closesAt = gridAsOf() + span;
  const extra = {};
  if (String(derivation) === '2') {
    extra.derivation = '2';
    extra.beacon_chain = B.QUICKNET.chain_hash;
    // Computed from the DEADLINE, not from now. A round offset from when we happened to run
    // this command is a round we chose.
    extra.beacon_round = B.roundAt(closesAt + BEACON_LAG_SEC);
  }
  console.log(`epoch ${epoch}: committing H(seed)=${seed_commit.slice(0, 16)}… (derivation v${derivation})`);
  appendSigned(W.buildWindowRow({
    type: 'schedule_commit', epoch,
    seed_commit, catalog_hash: W.catalogHash(),
    // Enrollment closes on a grid point so the deadline is derived rather than chosen.
    enroll_closes_at: closesAt,
    windows_per_caller: windows,
    ...extra,
  }));
  console.log(`  enrollment is OPEN until ${new Date(closesAt * 1000).toISOString()} `
    + `(${(span / 3600).toFixed(2)}h). the seed stays secret until after it closes.`);
  if (extra.beacon_round) {
    console.log(`  beacon: drand quicknet round ${extra.beacon_round}, published `
      + `${new Date(B.roundTime(extra.beacon_round) * 1000).toISOString()} — it does not exist yet, `
      + 'which is why we cannot grind against it.');
  }
}

function cmdEnroll(epoch, keyFile, name) {
  const commit = ofEpoch(epoch, 'schedule_commit')[0];
  if (!commit) die(`epoch ${epoch} has no schedule_commit — nothing to enroll in`);
  if (ofEpoch(epoch, 'enrollment_close').length) die(`enrollment for ${epoch} is closed`);
  let sk;
  try { sk = Buffer.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))); }
  catch (e) { die(`could not read caller key ${keyFile}: ${e.message}`); }
  const pub = ed.publicKeyOf(sk);
  if (ofEpoch(epoch, 'enroll').some((r) => r.entry.signer === pub)) die(`${pub} is already enrolled in ${epoch}`);
  const row = W.signWindowRow(W.buildWindowRow({
    type: 'enroll', epoch, caller: name || pub.slice(0, 8),
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), sk);
  const rec = chain().append(row);
  console.log(`enrolled ${pub} in ${epoch} at seq ${rec.seq}`);
}

function cmdClose(epoch) {
  if (ofEpoch(epoch, 'schedule_void').length) die(`epoch ${epoch} is void — a voided epoch can never be closed, revealed or asked`);
  if (ofEpoch(epoch, 'enrollment_close').length) die(`epoch ${epoch} enrollment already closed`);
  const commit = ofEpoch(epoch, 'schedule_commit')[0];
  if (!commit) die(`epoch ${epoch} has no schedule_commit`);
  const keys = ofEpoch(epoch, 'enroll').map((r) => r.entry.signer).filter(Boolean);
  if (!keys.length) die(`epoch ${epoch} has no enrolled callers`);
  console.log(`epoch ${epoch}: freezing ${keys.length} enrolled caller(s)`);
  appendSigned(W.buildWindowRow({
    type: 'enrollment_close', epoch,
    enrolled_root: W.enrolledRoot(keys), enrolled_count: keys.length,
  }));
}

/**
 * Retract an epoch by appending, never by deleting.
 *
 * Written after the operator (me) deleted a bogus row instead of correcting it, and an
 * anchor had already swept that row onto mainnet — so for 55 minutes there was a permanent
 * Solana transaction committing to a chain state the board no longer published. That is
 * indistinguishable, from outside, from an operator hiding a loss. The delete was reachable
 * because the chain was small enough to feel fixable; this command exists so the fix that
 * is always correct is also the one that is easiest to reach.
 *
 * Refuses on the same conditions the checker refuses on, so the CLI can never write a row
 * that `windows check` will immediately call a MISMATCH.
 */
function cmdVoid(epoch, reason) {
  const commit = ofEpoch(epoch, 'schedule_commit')[0];
  if (!commit) die(`epoch ${epoch} has no schedule_commit — there is nothing to void`);
  if (ofEpoch(epoch, 'schedule_void').length) die(`epoch ${epoch} is already void`);
  if (!reason || String(reason).trim().length < 8) die('--reason required: a void with no reason is a delete with better manners');
  const asked = ofEpoch(epoch, 'question').length;
  if (asked) {
    die(`epoch ${epoch} already has ${asked} question(s) — voiding now would unask a question `
      + 'whose answer we can already see. settle it instead.');
  }
  if (ofEpoch(epoch, 'enrollment_close').length) die(`epoch ${epoch} enrollment is already closed — void before the set is frozen, not after`);
  if (ofEpoch(epoch, 'seed_reveal').length) die(`epoch ${epoch} seed is already public`);
  const enrolled = ofEpoch(epoch, 'enroll').length;
  console.log(`epoch ${epoch}: voiding (${enrolled} enrolment(s) affected)`);
  appendSigned(W.buildWindowRow({ type: 'schedule_void', epoch, reason: String(reason) }));
  console.log('  the commit row stays on the chain and inside every anchor that already covered it.');
  console.log('  what changed is that this epoch can never be closed, revealed or asked.');
}

async function cmdReveal(epoch) {
  if (ofEpoch(epoch, 'schedule_void').length) die(`epoch ${epoch} is void — a voided epoch can never be closed, revealed or asked`);
  if (!ofEpoch(epoch, 'enrollment_close').length) die(`epoch ${epoch}: close enrollment before revealing — a seed revealed while enrolment is open lets a caller decide whether to join after seeing their questions`);
  if (ofEpoch(epoch, 'seed_reveal').length) die(`epoch ${epoch} seed already revealed`);
  const seed = readSeeds()[epoch];
  if (!seed) die(`no stored seed for ${epoch}`);
  const commit = ofEpoch(epoch, 'schedule_commit')[0];
  const extra = {};
  if (commit && String(commit.entry.derivation) === '2') {
    const round = Number(commit.entry.beacon_round);
    const due = B.roundTime(round);
    const now = Math.floor(Date.now() / 1000);
    // Refused rather than retried. A reveal that waits in a loop is a reveal whose timing we
    // control; the operator should come back after the round exists, and the failure should
    // be visible in a log rather than absorbed.
    if (due > now) {
      die(`epoch ${epoch}: beacon round ${round} is not published until `
        + `${new Date(due * 1000).toISOString()} (${Math.ceil((due - now) / 60)} min away). `
        + 'Revealing before the beacon exists would mean deriving from our seed alone.');
    }
    console.log(`epoch ${epoch}: fetching drand round ${round}…`);
    let b;
    try { b = await B.fetchRound(round, { chain: B.QUICKNET }); }
    catch (e) { die(`epoch ${epoch}: ${e.message}`); }
    console.log(`  round ${b.round} verified: randomness ${b.randomness.slice(0, 16)}… (mirrors: ${b.mirrors.join(', ')})`);
    extra.beacon_round = b.round;
    extra.beacon_randomness = b.randomness;
    extra.beacon_sig = b.signature;
  }
  console.log(`epoch ${epoch}: revealing seed`);
  appendSigned(W.buildWindowRow({ type: 'seed_reveal', epoch, seed, ...extra }));
}

function cmdAsk(epoch, ttlSec) {
  if (ofEpoch(epoch, 'schedule_void').length) die(`epoch ${epoch} is void — a voided epoch can never be closed, revealed or asked`);
  const close = ofEpoch(epoch, 'enrollment_close')[0];
  const reveal = ofEpoch(epoch, 'seed_reveal')[0];
  const commit = ofEpoch(epoch, 'schedule_commit')[0];
  if (!commit || !close || !reveal) die(`epoch ${epoch}: need commit + close + reveal before asking`);
  const version = commit.entry.derivation === undefined ? '1' : String(commit.entry.derivation);
  const deriveExtra = version === '1'
    ? { enrolled_root: close.entry.enrolled_root }
    : { beacon_randomness: reveal.entry.beacon_randomness };
  if (version === '2' && !deriveExtra.beacon_randomness) {
    die(`epoch ${epoch}: derivation 2 but the seed_reveal carries no beacon value`);
  }
  const perCaller = Number(commit.entry.windows_per_caller);
  const already = new Set(ofEpoch(epoch, 'question').map((r) => `${r.entry.caller_key}#${r.entry.window_index}`));
  const opens = gridAsOf();
  let n = 0;
  for (const r of ofEpoch(epoch, 'enroll')) {
    const callerKey = r.entry.signer;
    if (!callerKey) continue;
    for (let i = 0; i < perCaller; i++) {
      if (already.has(`${callerKey}#${i}`)) continue;
      const d = W.deriveQuestion({
        seed: reveal.entry.seed, ...deriveExtra,
        caller_key: callerKey, window_index: i, version,
      });
      const market = W.questionMarket({ asset: d.asset, opens_at: opens, horizon_sec: d.horizon_sec });
      // The seed fixes WHICH question. It fixes nothing about WHEN, and nothing else did
      // either: a window could be stamped into the past and minted after it had already
      // shut, so the caller got a no_answer for a question that never existed while it was
      // answerable. Every derivation check still passed, because every derivation was
      // honest. Refused here so our own tooling cannot do it by accident; a board that
      // bypassed this tool is caught by verify/tape-schedule.mjs, which compares the
      // question's Solana anchor time against its own expiry and does not take our word
      // for anything.
      const nowSec = Math.floor(Date.now() / 1000);
      if (opens + ttlSec <= nowSec) {
        die(`refusing to mint window ${i} for ${callerKey.slice(0, 8)}…: it would expire at `
          + `${new Date((opens + ttlSec) * 1000).toISOString()}, which has already passed. `
          + 'A window nobody could answer is not a question.');
      }
      if (opens + d.horizon_sec <= nowSec) {
        die(`refusing to mint window ${i} for ${callerKey.slice(0, 8)}…: ${market} already settled. `
          + 'Asking a question whose answer is known is the cheapest way to fake this whole mechanism.');
      }
      appendSigned(W.buildWindowRow({
        type: 'question', epoch, window_index: i, caller_key: callerKey,
        market,
        opens_at: opens, expires_at: opens + ttlSec,
      }));
      n++;
    }
  }
  console.log(`${n} question(s) minted for ${epoch}`);
}

/**
 * A caller responds. Both shapes are signed by the CALLER, never by us — the board mints
 * the question, the caller mints the response, and neither can produce the other's row.
 */
function cmdRespond(kind, questionHash, keyFile, opts) {
  let sk;
  try { sk = Buffer.from(JSON.parse(fs.readFileSync(keyFile, 'utf8'))); }
  catch (e) { die(`could not read key ${keyFile}: ${e.message}`); }
  const pub = ed.publicKeyOf(sk);
  const q = windowRows().find((r) => r.entry.type === 'question' && r.entry_hash === questionHash);
  if (!q) die(`no question with hash ${questionHash}`);
  if (q.entry.caller_key !== pub) die(`question ${questionHash.slice(0, 12)}… was asked of ${q.entry.caller_key}, not ${pub}`);

  // Refusing a late response is not politeness, it is the same rule as the tally: a window
  // that has closed cannot be reopened by whoever moves second.
  const now = Math.floor(Date.now() / 1000);
  if (now > Number(q.entry.expires_at)) die(`window closed at ${new Date(Number(q.entry.expires_at) * 1000).toISOString()} — too late`);
  const settled = windowRows().find((r) => ['answer', 'pass', 'no_answer'].includes(r.entry.type) && r.entry.question_hash === questionHash);
  if (settled) die(`window already settled as ${settled.entry.type}`);

  const base = { type: kind, question_hash: questionHash, ts_claimed: new Date().toISOString(), nonce: newNonce() };
  if (kind === 'answer') { base.side = opts.side; base.odds = opts.odds; }
  const rec = chain().append(W.signWindowRow(W.buildWindowRow(base), sk));
  console.log(`${kind} recorded at seq ${rec.seq}`);
}

/**
 * Write a no_answer row for every question whose window has closed untouched.
 *
 * This is the only row in TAPE written about a caller without their participation, and it
 * is the entire point: it is what makes a decline cost the same as an answer to produce.
 * It runs unconditionally on a timer for the same reason anchoring does — a sweep that
 * only runs when someone remembers is a sweep whose absence is indistinguishable from
 * everyone having answered.
 */
function cmdSweep(nowUnix) {
  const all = windowRows();
  const settled = new Set();
  for (const r of all) {
    if (['answer', 'pass', 'no_answer'].includes(r.entry.type)) settled.add(r.entry.question_hash);
  }
  let n = 0;
  let seen = 0;
  let openNow = 0;
  for (const r of all) {
    if (r.entry.type !== 'question') continue;
    seen++;
    if (settled.has(r.entry_hash)) continue;
    if (Number(r.entry.expires_at) > nowUnix) { openNow++; continue; }
    appendSigned(W.buildWindowRow({
      type: 'no_answer', question_hash: r.entry_hash, observed_at: nowUnix,
    }));
    n++;
  }
  // UNCONDITIONAL, and outside the loop on purpose. Emitting only when `n` was non-zero
  // would reproduce the exact bug this row exists to remove: the record would still be
  // violation-triggered, and a quiet hour would still be indistinguishable from a sweep
  // that never happened. The row is evidence the sweep LOOKED, not evidence it found.
  // swept_at has one-second resolution, so two sweeps inside the same second over unchanged
  // state build a byte-identical row and the chain's replay refusal rejects the second one.
  // That refusal is right and stays: it is what stops a signed row being lifted and reposted.
  // But it is not a sweep failure — the evidence row for this second is already on the chain —
  // and letting it throw took the whole driver down with rc=1 before it did its phase work.
  // Narrow on purpose: only this exact duplicate, only for sweep_report, and it says so.
  try {
    appendSigned(W.buildWindowRow({
      type: 'sweep_report',
      swept_at: nowUnix,
      questions_seen: seen,
      expired_written: n,
      open_now: openNow,
    }));
  } catch (err) {
    if (!/is already at seq/.test(err.message)) throw err;
    console.log(`  sweep_report for ${nowUnix} already on chain — same second, unchanged state`);
  }
  console.log(n ? `${n} window(s) expired unanswered` : 'no expired windows');
  console.log(`sweep_report written: ${seen} question(s) seen, ${n} written, ${openNow} still open`);
  return n;
}

function cmdCheck() {
  // Per epoch, never pooled. The enrolled set is what enrolled_root commits to, and that
  // root is epoch-scoped; a union across epochs matches no epoch once there are two.
  const enrolled = {};
  for (const r of windowRows()) {
    if (r.entry.type !== 'enroll' || !r.entry.signer) continue;
    (enrolled[r.entry.epoch] ||= []).push(r.entry.signer);
  }
  for (const k of Object.keys(enrolled)) enrolled[k] = [...new Set(enrolled[k])];
  const r = checkSchedule(rows(), Object.keys(enrolled).length ? { enrolled } : {});
  if (r.ok) {
    console.log(`SCHEDULE OK — ${r.checked} question(s) re-derived and matched across epoch(s) ${r.epochs.join(', ') || '(none)'}`);
    return 0;
  }
  console.error(`SCHEDULE MISMATCH — ${r.problems.length} problem(s):`);
  for (const p of r.problems) console.error(`  - ${p}`);
  return 1;
}

function cmdShow(epoch) {
  const tal = W.tallyWindows(rows());
  console.log(`epoch ${epoch}`);
  for (const type of ['schedule_commit', 'enroll', 'enrollment_close', 'seed_reveal', 'question']) {
    console.log(`  ${type.padEnd(18)} ${ofEpoch(epoch, type).length}`);
  }
  console.log('\n  caller                                        asked ans pass no-ans open');
  for (const [k, t] of tal) {
    console.log(`  ${k.padEnd(46)} ${String(t.asked).padStart(5)} ${String(t.answered).padStart(3)} ${String(t.passed).padStart(4)} ${String(t.no_answer).padStart(6)} ${String(t.open).padStart(4)}`);
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name, dflt) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? dflt : rest[i + 1];
  };
  switch (cmd) {
    case 'keygen': return cmdKeygen(), 0;
    case 'commit': return cmdCommit(rest[0] || die('epoch required'), Number(flag('windows', 3)),
      Number(flag('open-hours', DEFAULT_OPEN_HOURS)), flag('derivation', W.DEFAULT_DERIVATION)), 0;
    case 'enroll': return cmdEnroll(rest[0], flag('key', null) || die('--key required'), flag('name', null)), 0;
    case 'close': return cmdClose(rest[0] || die('epoch required')), 0;
    case 'void': return cmdVoid(rest[0] || die('epoch required'), flag('reason', null)), 0;
    case 'reveal': return await cmdReveal(rest[0] || die('epoch required')), 0;
    case 'ask': return cmdAsk(rest[0] || die('epoch required'), Number(flag('ttl', 86400))), 0;
    case 'answer': return cmdRespond('answer', rest[0], flag('key', null) || die('--key required'),
      { side: flag('side', null) || die('--side yes|no required'), odds: flag('odds', null) || die('--odds required') }), 0;
    case 'pass': return cmdRespond('pass', rest[0], flag('key', null) || die('--key required'), {}), 0;
    case 'sweep': return cmdSweep(Math.floor(Date.now() / 1000)), 0;
    case 'check': return cmdCheck();
    case 'show': return cmdShow(rest[0] || die('epoch required')), 0;
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).join('\n').replace(/^ \* ?/gm, ''));
      return 0;
  }
}

if (require.main === module) {
  // An unhandled rejection here would exit 0 with a stack trace, which a cron wrapper reads
  // as success. The beacon fetch made this reachable, so it is handled rather than assumed.
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.stack || e.message); process.exit(1); });
}
module.exports = { cmdSweep, cmdCheck };
