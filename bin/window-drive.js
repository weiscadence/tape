#!/usr/bin/env node
'use strict';
/**
 * window-drive.js — advance the assigned-question schedule without a human in the loop.
 *
 * WHY THIS EXISTS. The mechanism was operator-driven end to end: a round only opened when
 * I ran `windows.js commit`, and only closed when I ran `close`. That makes the board the
 * thing being tested. "Enrollment is open" meant "Cadence happened to be awake", and an
 * agent that read an announcement an hour late found a door that had never really been
 * open. A schedule that depends on my attention is not a schedule.
 *
 * WHAT IT DOES NOT DO, stated so it is not read as more than it is. This does not make the
 * board trustworthy. The board still picks the seed, still signs the rows, and could still
 * run this script selectively. What it removes is the excuse: the phase transitions are now
 * a function of the wall clock and the chain, so a missing transition is a HOLE anyone can
 * point at rather than a scheduling accident only I can explain.
 *
 * ORDERING IS NOT ENFORCED HERE. Every step shells out to windows.js, which refuses to run
 * out of order. Reimplementing the order checks in the driver would give us two definitions
 * of the invariant and one of them would rot.
 *
 * IDEMPOTENT: at most one phase advance per run, plus a sweep. Safe to run every hour.
 *
 *   node bin/window-drive.js [--dry-run] [--epoch <YYYY-Www>] [--open-hours H] [--windows N]
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { Chain } = require('../lib/chain');
const W = require('../lib/windows');

const CLI = path.join(__dirname, 'windows.js');
const CHAIN = process.env.TAPE_CHAIN || path.join(__dirname, '..', 'data', 'tape.jsonl');

/** ISO-8601 week of a date, as `YYYY-Www`. Used only to seed the very first round. */
function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of this week decides the year, per ISO-8601.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The label after `YYYY-Www`. Rounds are NOT calendar weeks and the label does not claim
 *  to be one: it is a round counter that happens to be seeded from, and formatted like,
 *  the ISO week the first round opened in. Driving straight off the real ISO week was the
 *  obvious design and it is wrong here — three rounds were already spent inside two days
 *  while warming the mechanism up, so a week-keyed driver would have found the current
 *  week used and left the door shut until the calendar caught up. What matters is that a
 *  label is never reused, since an epoch identifies a seed commitment. */
function nextEpoch(label) {
  const m = /^(\d{4})-W(\d{2})$/.exec(label || '');
  if (!m) return isoWeek();
  const [, y, w] = m;
  const n = Number(w) + 1;
  return n > 53 ? `${Number(y) + 1}-W01` : `${y}-W${String(n).padStart(2, '0')}`;
}

function main(argv) {
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const dry = argv.includes('--dry-run');
  const openHours = flag('open-hours', '48');
  const windows = flag('windows', '3');

  const rows = new Chain(CHAIN).read();
  const committed = rows.filter((r) => W.isWindowRow(r.entry) && r.entry.type === 'schedule_commit');
  // The active round is the newest committed one. Once it is finished or provably empty
  // the driver opens its successor, so the door reopens on its own rather than waiting
  // for me to notice a round ended.
  const active = committed.length ? committed[committed.length - 1].entry.epoch : isoWeek();
  const epoch = flag('epoch', active);

  const of = (type) => rows.filter((r) => W.isWindowRow(r.entry)
    && r.entry.type === type && r.entry.epoch === epoch);
  const now = Math.floor(Date.now() / 1000);

  const run = (args) => {
    if (dry) { console.log(`WOULD RUN: windows.js ${args.join(' ')}`); return; }
    console.log(`RUN: windows.js ${args.join(' ')}`);
    process.stdout.write(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }));
  };

  // The sweep is not a phase. An expired window owes a no_answer row no matter which
  // epoch we are in, and skipping it is exactly the silence the mechanism exists to deny.
  run(['sweep']);

  const commit = of('schedule_commit')[0];
  if (!commit) {
    run(['commit', epoch, '--windows', windows, '--open-hours', openHours]);
    return 0;
  }

  const closesAt = Number(commit.entry.enroll_closes_at);
  if (now <= closesAt) {
    const mins = Math.round((closesAt - now) / 60);
    console.log(`${epoch}: enrollment OPEN, ${mins} min left (closes ${new Date(closesAt * 1000).toISOString()})`);
    return 0;
  }

  // A finished or empty round hands off to its successor, but only when we are driving the
  // round the chain says is current. An explicit --epoch is an operator inspecting one
  // round; it must not silently open another.
  const advance = (why) => {
    console.log(`${epoch}: ${why}`);
    if (epoch !== active) { console.log('  (--epoch given; not opening a successor)'); return 0; }
    run(['commit', nextEpoch(epoch), '--windows', windows, '--open-hours', openHours]);
    return 0;
  };

  if (!of('enrollment_close').length) {
    if (!of('enroll').length) {
      // Not an error and not something to paper over: the round is simply empty. Closing
      // an empty set would mint a schedule for nobody, and inventing an enrollee to avoid
      // an empty round is the exact failure mode this project exists to refuse.
      return advance('enrollment window passed with ZERO enrollees — no schedule to build');
    }
    run(['close', epoch]);
    return 0;
  }

  if (!of('seed_reveal').length) { run(['reveal', epoch]); return 0; }

  const enrolled = of('enroll').length;
  const perCaller = Number(commit.entry.windows_per_caller);
  if (of('question').length < enrolled * perCaller) { run(['ask', epoch]); return 0; }

  return advance(`complete — ${enrolled} enrolled, ${of('question').length} question(s) minted`);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { isoWeek, nextEpoch, main };
