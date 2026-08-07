#!/usr/bin/env node
'use strict';
/**
 * TAPE health canary — the EXECUTABLE version of what went wrong 2026-07-30.
 *
 * WHY THIS EXISTS. The anchor daemon died and nothing noticed. Intake kept ACCEPTING
 * entries while none of them were being anchored, so the tape silently accumulated rows
 * with no time guarantee — and an unanchored entry is unrankable forever. Every existing
 * check stayed green through it: the site was up, the process list looked fine (the daemon
 * was not in it, but nothing was watching for that), and the feed served 200. The outage
 * was found by hand, by accident, ~20 minutes in.
 *
 * A note saying "check the anchors" is a wish. This is the check.
 *
 * WHAT IT ASSERTS (each one is a way tonight failed):
 *   1. unanchored_entries stays at 0 beyond a grace window   (daemon dead / not landing txs)
 *   2. the newest anchor is not stale                        (daemon alive but wedged)
 *   3. the supervised process is actually online             (pm2 tape-zc entry missing/stopped)
 *   4. the daemon's own state file says healthy              (RPC exhausted, tick failing)
 *   5. the payer has runway LEFT                             (wallet about to run dry)
 *
 * Assertion 5 is the odd one out: 1-4 are detectors and 5 is a PREDICTOR. The others tell
 * us anchoring has already stopped; this one tells us it is going to. That distinction
 * matters here more than usual, because the payer running dry is the only failure mode with
 * a knowable date, and the project's central published claim is "the tape is still being
 * anchored right now" — a claim readers are explicitly invited to check for themselves with
 * `node bin/anchor-stats.js`. Detecting that one AFTER the fact is too late: by the time a
 * stale-anchor alert fires, the invitation has already been made and already fails.
 *
 * The runway maths is NOT reimplemented here. It comes from lib/anchor-burn.js,
 * shared with `bin/doctor.js`, because the cost-per-anchor constant has drifted silently
 * before and two copies is that bug with a second place to hide. The doctor is a PULL — it
 * answers only when a human asks, and nobody was asking on a schedule. This is the push.
 *
 * A "0 unanchored" reading is only meaningful if the feed itself is fresh, so a stale or
 * unreachable feed is an ALERT, never a pass. That is the raw-vs-kept rule: a zero from an
 * unproven pipeline is indistinguishable from a broken one.
 *
 * Exit: 0 healthy · 1 ALERT (writes data/ops-alert.txt) · 2 UNTRUSTED (could not check).
 * --selftest forces the firing path so the alarm is exercised, not assumed.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Repo root. This file used to live in the operator's private workspace and resolve paths
// against it, while README.md:157 and SUBMISSION.md:47 both cited `scripts/tape-health.js`
// as the fix for the silent-death outage we confess to. For anyone who cloned the repo that
// file did not exist — we named our remedy and shipped the incident without it. It lives
// here now, and the operator-specific plumbing below is env-overridable instead of assumed.
const TAPE = path.join(__dirname, '..');

// Where the alert lands. Defaults inside the project so a fresh clone works unattended; our
// own deployment points this at the workspace file the heartbeat digest already reads.
const ALERT_DIR = process.env.TAPE_HEALTH_ALERT_DIR || path.join(TAPE, 'data');
// Overridable so the grace window can be exercised against a stub feed. Without this the
// backlog path is only ever testable by waiting for a real stall, which means in practice
// it is never tested — and an untested alarm is the thing this file exists to prevent.
const FEED = process.env.TAPE_HEALTH_FEED || 'https://drainfun.xyz/tape/api/feed.json';
const STATE = path.join(TAPE, 'data/daemon-state.json');
const ALERT = path.join(ALERT_DIR, 'ops-alert.txt');

// An anchor lands about once a minute when there is new work, and a forced heartbeat anchor
// fires every ~10 idle intervals. 25 minutes is comfortably past both, so it flags a real
// stall without alarming on ordinary quiet.
const MAX_ANCHOR_AGE_MIN = 25;
const MAX_UNANCHORED_MIN = 15;

// Runway floor. Four days is chosen to be longer than any plausible stretch of nobody
// reading alerts (a weekend plus slack), because the remedy — sending SOL — needs a human
// and is not instant. The doctor's own thresholds stay where they are: it FAILs under 24h,
// which is the right shape for a report someone is reading right now, and the wrong shape
// for a scheduled warning whose whole job is to arrive while there is still time to act.
//
// Overridable so the alarm can be PROVEN to fire rather than assumed to: raising the floor
// above the current runway is the only way to exercise this path without draining a real
// wallet. An untested alarm is what this file exists to refuse.
const MIN_RUNWAY_HOURS = Number(process.env.TAPE_HEALTH_MIN_RUNWAY_HOURS || 96);

// Backlog-start marker. Deliberately a separate tiny file rather than a field in the
// daemon's own state: this is the WATCHER's memory, and folding it into the thing being
// watched would let a wedged daemon erase the evidence that it is wedged.
const PENDING = path.join(ALERT_DIR, 'tape-health-pending.json');
const readPendingSince = () => {
  try { return Number(JSON.parse(fs.readFileSync(PENDING, 'utf8')).since) || null; } catch { return null; }
};
const writePendingSince = (since) => {
  try { fs.writeFileSync(PENDING, JSON.stringify({ since, note: 'unanchored backlog first seen at this ms' })); } catch { /* never throw from a watcher */ }
};
const clearPendingSince = () => {
  try { fs.unlinkSync(PENDING); } catch { /* ignore */ }
};

/** Name a remedy that matches the finding, or admit there isn't an obvious one. */
function prescribe(problems) {
  const t = problems.join(' | ');
  // Runway first: it is the only finding here whose remedy is "a human must send money",
  // so it must not be masked by a co-occurring process complaint that looks more actionable.
  // A drained payer also CAUSES the stale-anchor and unanchored-backlog findings, so when
  // both appear the balance is the root and restarting anything is wasted motion.
  if (/of runway|runway UNKNOWN/.test(t)) {
    const m = t.match(/anchor payer ([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return `send SOL to the anchor payer${m ? ` ${m[1]}` : ''} — needs Jiggy (costs money). `
      + 'Run `node projects/tape/bin/doctor.js` for the measured per-anchor cost and exact runway. '
      + 'Do NOT restart anything: a dry payer looks like a wedged daemon and restarting it fixes nothing';
  }
  if (/pm2 process tape-zc is MISSING|pm2 tape-zc is/.test(t)) {
    return 'pm2 start/restart tape-zc, then pm2 save so a reboot keeps it — this is the ZeroClaw daemon that runs the tape-anchor shell cron every 5min; the old standalone tape-anchor pm2 loop is deliberately stopped (see changelog #1148)';
  }
  if (/daemon reports unhealthy/.test(t)) {
    return 'read the daemon lastError above — usually RPC exhausted or SOL balance; restarting will NOT fix either';
  }
  if (/NOT anchored for|newest anchor is/.test(t)) {
    return 'daemon is supervised but not landing txs — check pm2 logs tape-zc for 429/RPC/billing, and the payer SOL balance, BEFORE restarting';
  }
  return 'no standard remedy for this combination — read the findings above before acting';
}

function get(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? require('http') : https;
    const req = mod.get(url, { timeout: 20000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => (res.statusCode === 200
        ? resolve(b)
        : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function main() {
  const selftest = process.argv.includes('--selftest');
  const problems = [];

  let feed;
  try {
    feed = JSON.parse(await get(FEED));
  } catch (e) {
    // Cannot read the feed => cannot claim health. Untrusted, not "fine".
    console.log(`TAPE HEALTH UNTRUSTED — feed unreachable: ${e.message}`);
    process.exit(2);
  }

  const asOf = new Date(feed.as_of);
  const feedAgeMin = (Date.now() - asOf.getTime()) / 60000;
  if (!Number.isFinite(feedAgeMin) || feedAgeMin > 30) {
    console.log(`TAPE HEALTH UNTRUSTED — feed is stale (${Math.round(feedAgeMin)} min); a zero from it proves nothing`);
    process.exit(2);
  }

  // Unanchored entries are NORMAL for a few minutes: a row lands, and the anchorer picks it
  // up on its next pass. MAX_UNANCHORED_MIN existed for exactly this and was declared but
  // never used — line 79 alerted the instant the count went above zero. So on 2026-08-02 a
  // row written at 19:09 produced a 19:10:01 ALERT telling me to restart a daemon that
  // anchored it 42 seconds later, at 19:10:43, and was never unhealthy. An alarm that fires
  // on normal operation and prescribes the wrong fix is worse than no alarm: it trains me to
  // skim past the one time it is real. That is the whole reason the anchor outage went
  // unnoticed for 20 minutes in the first place.
  //
  // The grace window needs to know WHEN the backlog started, which a single sample cannot
  // say, so first-seen is persisted between runs and cleared the moment it drains.
  const unanchored = Number(feed.unanchored_entries);
  const pendingAt = readPendingSince();
  if (unanchored > 0) {
    const since = pendingAt || Date.now();
    if (!pendingAt) writePendingSince(since);
    const stuckMin = (Date.now() - since) / 60000;
    if (stuckMin > MAX_UNANCHORED_MIN) {
      problems.push(`${unanchored} entr${unanchored === 1 ? 'y' : 'ies'} accepted but NOT anchored `
        + `for ${Math.round(stuckMin)} min (limit ${MAX_UNANCHORED_MIN})`);
    }
  } else if (pendingAt) {
    clearPendingSince(); // drained on its own, exactly as designed
  }

  // Anchor freshness, from the chain's own record rather than our process list.
  const anchorTs = Number((feed.latest_anchor || {}).block_time || 0);
  if (anchorTs) {
    const ageMin = (Date.now() / 1000 - anchorTs) / 60;
    if (ageMin > MAX_ANCHOR_AGE_MIN) problems.push(`newest anchor is ${Math.round(ageMin)} min old (limit ${MAX_ANCHOR_AGE_MIN})`);
  } else {
    problems.push('feed reports no latest_anchor block_time');
  }

  // The supervised process must exist AND be online. "Not in the list" was the actual
  // failure mode, so absence is a problem, not a skip.
  //
  // 2026-08-06: anchoring moved from a standalone always-on pm2 loop (process "tape-anchor")
  // to ZeroClaw's own shell-cron job of the same name, run every 5min by the ZeroClaw daemon
  // process "tape-zc" (see changelog #1148 — the old loop double-anchored alongside
  // ZeroClaw's cron, only 74 of 300 anchors were actually ZeroClaw's). The old pm2 process is
  // now deliberately stopped forever, so this check follows the real supervisor.
  try {
    const list = JSON.parse(execSync('pm2 jlist', {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}` },
    }));
    const proc = list.find((p) => p.name === 'tape-zc');
    if (!proc) problems.push('pm2 process tape-zc is MISSING (nothing is supervising the ZeroClaw anchor cron)');
    else if (proc.pm2_env.status !== 'online') problems.push(`pm2 tape-zc is ${proc.pm2_env.status}`);
  } catch (e) {
    problems.push(`could not read pm2 state: ${e.message}`);
  }

  // The daemon's self-reported health catches the wedged-but-running case (RPC exhausted).
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (st.healthy === false) {
      problems.push(`daemon reports unhealthy: ${String((st.lastError || {}).message || 'unknown').slice(0, 100)}`);
    }
  } catch (e) {
    problems.push(`could not read daemon state: ${e.message}`);
  }

  // Will the payer still be paying in four days? Asked of the chain, about the wallet that
  // actually signed the last anchor — not the one our config names. Those two disagreed
  // silently for days once, and in that state this alarm would have been unreachable.
  try {
    const { anchorRunway } = require(path.join(TAPE, 'lib/anchor-burn'));
    const rw = await anchorRunway();
    if (rw && rw.hours !== null && rw.hours < MIN_RUNWAY_HOURS) {
      problems.push(`anchor payer ${rw.payer} has ~${(rw.hours / 24).toFixed(1)}d of runway `
        + `(${rw.sol.toFixed(6)} SOL, ~${rw.anchorsLeft} anchors at ${rw.burn.perHour.toFixed(1)}/h) `
        + `— floor is ${(MIN_RUNWAY_HOURS / 24).toFixed(0)}d`);
    } else if (rw && rw.hours === null) {
      // Balance known, burn rate not. Not an emergency, but not a clean bill either.
      problems.push(`anchor payer ${rw.payer} holds ${rw.sol.toFixed(6)} SOL but no recent `
        + 'anchors to size the runway from — runway UNKNOWN');
    }
    // rw === null means nothing has been anchored yet, which the other assertions already
    // cover far more directly. Silence here is correct rather than a second alarm.
  } catch (e) {
    // A runway we could not read is UNKNOWN, and unknown must not read as fine — same
    // raw-vs-kept rule as the feed above. Surfaced as a finding, not a silent skip, and
    // deliberately NOT exit 2: the other four assertions were still measured and are still
    // worth reporting, so downgrading the whole run to untrusted would lose real signal.
    problems.push(`could not read anchor runway: ${e.message}`);
  }

  if (selftest) problems.push('SELFTEST — forced failure to prove the alarm path fires');

  if (problems.length) {
    const msg = `TAPE HEALTH ALERT ${new Date().toISOString()}\n`
      + problems.map((p) => `  - ${p}`).join('\n')
      + `\n  feed: chain=${feed.chain_entries} anchored_through=${feed.anchored_through_seq} unanchored=${feed.unanchored_entries}\n`
      // The prescription used to be an unconditional "restart tape-anchor", which on
      // 2026-08-02 told me to bounce a daemon that was online, never errored, and had
      // already done the work. Naming the wrong remedy costs more than naming none:
      // restarting a healthy anchorer mid-tx is how a real incident gets manufactured.
      + `  fix: ${prescribe(problems)}\n`;
    try { fs.writeFileSync(ALERT, msg); } catch { /* alerting must not throw */ }
    console.log(msg.trim());
    process.exit(1);
  }

  // Clear a stale alert so a resolved incident stops nagging.
  try { if (fs.existsSync(ALERT) && fs.readFileSync(ALERT, 'utf8').includes('TAPE HEALTH')) fs.unlinkSync(ALERT); } catch { /* ignore */ }
  // Report the REAL count. This line used to hardcode "unanchored=0", so a backlog sitting
  // inside the grace window was logged as a zero — the same comfortable-zero habit the rest
  // of this file was written to refuse, hiding in the success message.
  console.log(`TAPE HEALTH OK — chain=${feed.chain_entries} anchored_through=${feed.anchored_through_seq} `
    + `unanchored=${unanchored}${unanchored > 0 ? ' (within grace, draining)' : ''}, newest anchor fresh`);
  process.exit(0);
}

main().catch((e) => { console.log(`TAPE HEALTH UNTRUSTED — ${e.message}`); process.exit(2); });
