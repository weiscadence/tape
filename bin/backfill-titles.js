#!/usr/bin/env node
'use strict';
/**
 * backfill-titles.js — fetch the human question for every market on the chain that lacks one.
 *
 * WHY IT EXISTS. A receipt renders its market as a bare 64-hex condition id when we have no
 * cached question, which is accurate and unreadable — Jiggy's own receipt #386 read
 * `polymarket:0xa5144d48…` and he could not tell what he had called. The mini app now records
 * the question at call time, but that only helps calls made from here onward; every row already
 * on the tape needs a sweep.
 *
 * THE TRAP THIS SCRIPT EXISTS TO NOT FALL INTO. Gamma's `/markets` defaults to OPEN markets,
 * so `?condition_ids=<id>` silently returns `[]` for anything already resolved — precisely the
 * markets that make up a settled record. The first pass "found" one of two titles and reported
 * a clean run. `closed=true` is not optional here; it is the whole point.
 *
 * The title is an ANNOTATION, never signed and never authoritative: market-titles.js stamps the
 * fetch time and every renderer marks it as looked-up. A market we cannot resolve keeps showing
 * its raw signed string, which is the correct failure.
 */

const path = require('path');
const https = require('https');
const { Chain } = require('../lib/chain');
const { DATA_DIR } = require('../lib/datadir');
const { recordTitle, readTitles } = require('../lib/market-titles');

const get = (url) => new Promise((resolve, reject) => {
  https.get(url, { timeout: 15000 }, (r) => {
    let b = '';
    r.on('data', (c) => { b += c; if (b.length > 4e6) r.destroy(); });
    r.on('end', () => resolve(b));
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
});

async function questionFor(market) {
  const cid = market.split(':')[1];
  if (!/^0x[0-9a-fA-F]{64}$/.test(cid || '')) return null;
  // closed=true so RESOLVED markets are included. Without it this returns [] for exactly the
  // markets a settled record is made of, and the run looks clean while fixing nothing.
  const body = await get(`https://gamma-api.polymarket.com/markets?condition_ids=${cid}&closed=true`);
  try {
    const j = JSON.parse(body);
    const arr = Array.isArray(j) ? j : (j.data || []);
    return (arr[0] && arr[0].question) || null;
  } catch { return null; }
}

async function main() {
  const rows = new Chain(path.join(DATA_DIR, 'tape.jsonl')).read();
  const have = readTitles();
  const missing = [...new Set(rows
    .map((r) => r.entry && r.entry.market)
    .filter((m) => m && m.startsWith('polymarket:') && !have[m]))];

  console.log(`${missing.length} polymarket market(s) on the chain with no cached question`);
  let ok = 0;
  for (const m of missing) {
    let q = null;
    try { q = await questionFor(m); } catch (e) { console.log(`  ! ${m.slice(11, 21)} ${e.message}`); }
    if (q) { recordTitle(m, q); ok += 1; console.log(`  ok ${m.slice(11, 21)} -> ${q.slice(0, 72)}`); }
    else console.log(`  -- ${m.slice(11, 21)} no question available (receipt keeps the raw string)`);
  }
  console.log(`${ok}/${missing.length} resolved`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { questionFor };
