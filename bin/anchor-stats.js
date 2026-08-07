#!/usr/bin/env node
/**
 * Re-derives the anchor-record numbers used in SUBMISSION.md and the Discord post.
 *
 * These are the numbers that carry the submission's actual claim -- not "we built an
 * anchoring daemon" but "it has been anchoring to mainnet, unattended, for a week." A
 * reviewer should never have to take that from prose, and we should never have to
 * remember it: the count moves every few minutes, so a figure typed into a document is
 * wrong shortly after it is typed. Published claims are therefore written as monotone
 * lower bounds ("more than N"), and this prints the live value behind them.
 *
 * Gaps are printed rather than summarised because they are the part that argues against
 * us. The 87-minute gap on 2026-07-30 is the daemon dying silently, which is what
 * scripts/tape-health.js was built to catch afterwards.
 *
 * Run: node bin/anchor-stats.js
 *      node bin/anchor-stats.js --assert    (stable output, for the claim ledger)
 *
 * --assert exists because the claim ledger compares a command's output byte-for-byte
 * against what it returned when the claim was recorded, and this command's normal output
 * changes every ~7 minutes. Recording the snapshot would have produced a permanent DRIFT
 * alarm that means nothing -- and an instrument that always alarms is one nobody reads,
 * which is worse than not having it. So --assert re-derives the LOWER BOUNDS we actually
 * published ("more than 1,400 anchors, more than 7 unbroken days, all mainnet") and prints
 * a stable line while they hold. It goes to HOLDS as the record grows and only changes if
 * a published claim stops being true -- e.g. anchors were deleted, or the mainnet-only
 * claim broke. That is the thing worth alarming on.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'anchors.jsonl');

// A FRESH CLONE HAS NO data/ AND THAT IS DELIBERATE (see .gitignore): an operator who
// inherited our anchors could not tell their own first anchor from ours. But this is the
// first command the write-up asks a reader to run, and until now it answered a clean clone
// with a raw ENOENT stack trace — so the single most likely first experience of this project
// was an unhandled exception, from the one command whose whole job is to make our headline
// claim checkable. Say what happened and where the real numbers are instead.
if (!fs.existsSync(file)) {
  console.log(`no anchor record at ${path.relative(process.cwd(), file)} — nothing to re-derive.

This is the expected state of a FRESH CLONE, not a failure: data/ is gitignored on purpose,
so a clone starts empty rather than inheriting our record (.gitignore says why).

  • To read OUR live numbers, which is what the write-up cites:
        curl -s https://tape.drainfun.xyz/api/integrity
        curl -s https://tape.drainfun.xyz/api/feed.json
    Those are served from the anchors this command would otherwise summarise, and every
    root in them is on Solana mainnet where you can check it without us.

  • To start YOUR OWN record, so this command has something to measure:
        node bin/doctor.js        # reports what is configured and what is missing
        node bin/daemon.js --once # writes and anchors one interval (needs a funded key)`);
  process.exit(0);
}

const a = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const first = a[0];
const last = a[a.length - 1];
const hours = (last.blockTime - first.blockTime) / 3600;

const gaps = [];
for (let i = 1; i < a.length; i += 1) {
  const mins = (a[i].blockTime - a[i - 1].blockTime) / 60;
  if (mins > 25) gaps.push({ after: new Date(a[i - 1].blockTime * 1000).toISOString(), mins: Math.round(mins) });
}

// The published lower bounds, in one place. Monotone: a growing record keeps satisfying
// them, so this line is stable; it moves only if the claim genuinely stopped being true.
const BOUND_ANCHORS = 1400;
const BOUND_DAYS = 7;
if (process.argv.includes('--assert')) {
  const offMainnet = a.filter((x) => !/main/i.test(x.cluster || '')).length;
  const fail = [];
  if (a.length < BOUND_ANCHORS) fail.push(`anchors ${a.length} < ${BOUND_ANCHORS}`);
  if (hours / 24 < BOUND_DAYS) fail.push(`span ${(hours / 24).toFixed(2)}d < ${BOUND_DAYS}d`);
  if (offMainnet) fail.push(`${offMainnet} anchor(s) not on mainnet`);
  if (fail.length) {
    console.log(`BROKEN: ${fail.join('; ')}`);
    process.exit(1);
  }
  console.log(`HOLDS: >${BOUND_ANCHORS} anchors, >${BOUND_DAYS} unbroken days, all mainnet`);
  process.exit(0);
}

console.log(`anchors            ${a.length}`);
console.log(`  on mainnet       ${a.filter((x) => /main/i.test(x.cluster || '')).length}`);
console.log(`  backfilled       ${a.filter((x) => x.backfilled).length}`);
console.log(`first              ${new Date(first.blockTime * 1000).toISOString()}  slot ${first.slot}`);
console.log(`last               ${new Date(last.blockTime * 1000).toISOString()}  slot ${last.slot}`);
console.log(`span               ${hours.toFixed(1)}h = ${(hours / 24).toFixed(2)} days`);
console.log(`mean interval      ${(hours * 60 / (a.length - 1)).toFixed(1)} min`);
console.log(`entries committed  ${last.count} (latest root)`);
console.log(`gaps over 25 min   ${gaps.length}`);
for (const g of gaps) console.log(`  after ${g.after}  ${g.mins} min`);
