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
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'anchors.jsonl');
const a = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const first = a[0];
const last = a[a.length - 1];
const hours = (last.blockTime - first.blockTime) / 3600;

const gaps = [];
for (let i = 1; i < a.length; i += 1) {
  const mins = (a[i].blockTime - a[i - 1].blockTime) / 60;
  if (mins > 25) gaps.push({ after: new Date(a[i - 1].blockTime * 1000).toISOString(), mins: Math.round(mins) });
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
