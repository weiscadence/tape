#!/usr/bin/env node
'use strict';
/**
 * leaderboard.js — compute the board from the tape.
 *
 *   node bin/leaderboard.js            # human-readable
 *   node bin/leaderboard.js --json     # the full artifact (board + marks + positions)
 *   node bin/leaderboard.js --as-of <unix>   # reproduce a past board
 *
 * The JSON artifact is the point. It carries the mark set and its hash, so anyone can
 * re-run scorePositions() offline and get the same numbers — or a different one, loudly.
 */

const fs = require('fs');
const path = require('path');
const D = require('../lib/decimal');
const { Chain } = require('../lib/chain');
const { GateLog } = require('../lib/gate-log');
const { fetchMarks } = require('../lib/marks');
const { buildPositions, scorePositions, leaderboard } = require('../lib/score');
const { gridAsOf, checkAsOf } = require('../lib/asof');

// See lib/datadir.js — one resolver, honoured everywhere.
const { DATA_DIR: DATA } = require('../lib/datadir');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const asOfArg = argv.indexOf('--as-of');
// Default to the derived grid point so a local run and a published one agree. An explicit
// --as-of stays allowed because asking "what did the board look like at T" is a legitimate
// question, but it is labelled: an off-grid artifact is a private view, not a publishable
// one, and tape-recompute.mjs will reject it as such rather than take our word for it.
const asOf = asOfArg >= 0 ? Number(argv[asOfArg + 1]) : gridAsOf();
if (asOfArg >= 0 && !checkAsOf(asOf).ok && !asJson) {
  console.error(`NOTE: ${checkAsOf(asOf).reason}\n      This view is not publishable; the recomputer will reject it.`);
}
const log = asJson ? () => {} : (m) => console.error(m);

function readAnchors() {
  const f = path.join(DATA, 'anchors.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const money = (v) => D.formatMoney(v, 2);

async function main() {
  const chain = new Chain(path.join(DATA, 'tape.jsonl'));
  const check = chain.verify();
  if (!check.ok) {
    // A board computed over a broken chain is worse than no board: it looks authoritative.
    console.error('CHAIN BROKEN — refusing to score:');
    check.errors.forEach((e) => console.error(`  seq ${e.seq}: ${e.error}`));
    process.exit(2);
  }
  const rows = chain.read();
  const anchors = readAnchors();
  const gate = new GateLog(path.join(DATA, 'gate.jsonl')).current();

  const { positions, anomalies } = buildPositions({ rows, anchors, gate });
  log(`chain OK: ${check.count} entries, ${anchors.length} anchors, ${positions.length} positions`);

  const marks = await fetchMarks(positions, asOf, { log });
  const result = scorePositions({ positions, marks, asOfUnix: asOf, anomalies });
  const board = leaderboard(result);

  const artifact = {
    as_of: asOf,
    as_of_iso: new Date(asOf * 1000).toISOString(),
    chain_head: check.head,
    chain_count: check.count,
    markset_hash: result.markset_hash,
    benchmark: 'SOL/USD (buy and hold, same notional, same window)',
    board,
    positions: result.scored,
    anomalies,
    totals: result.totals,
    marks,
    // The raw inputs travel with the result so a checker can re-derive POSITION STATUS —
    // voided, unanchored, ineligible — instead of taking our word for it. Without these
    // a recomputation can only check the arithmetic, and "this voided entry is actually
    // a closed winner" would sail straight through a board that otherwise adds up.
    chain: rows,
    anchors,
    gate: [...gate.values()],
  };

  if (asJson) { console.log(JSON.stringify(artifact, null, 2)); return; }

  console.log(`\nTAPE leaderboard — as of ${artifact.as_of_iso}`);
  console.log(`chain head ${check.head.slice(0, 16)}…  markset ${result.markset_hash.slice(0, 16)}…\n`);

  if (!board.length) console.log('  (no positions)');
  for (const b of board) {
    const flag = b.complete ? '' : `  ⚠ INCOMPLETE (${b.unscored} unscored)`;
    console.log(`  ${b.beat_hodl ? '▲' : '▼'} ${b.caller}`);
    console.log(`      vs holding SOL: ${money(b.edge)}   (pnl ${money(b.pnl)}, sol ${money(b.benchmark_pnl)})`);
    console.log(`      realized ${money(b.realized)}  unrealized ${money(b.unrealized)}  `
      + `${b.wins}W/${b.losses}L  ${b.open} open  ${b.excluded} excluded${flag}`);
  }

  const T = result.totals;
  console.log(`\n  scored ${T.scored}/${T.positions}   unscored ${T.unscored}   excluded ${T.excluded}`);
  if (T.unscored) {
    console.log('\n  not scored, and why (a number we cannot derive is a number we do not print):');
    for (const s of result.scored.filter((x) => x.scoring === 'unscored')) {
      console.log(`    seq ${s.seq} ${s.lane}/${s.market.slice(0, 46)}`);
      console.log(`         ${s.reason}`);
    }
  }
  if (T.excluded) {
    console.log('\n  excluded from ranking:');
    for (const s of result.scored.filter((x) => x.scoring === 'excluded')) {
      console.log(`    seq ${s.seq}: ${s.reason}`);
    }
  }
  if (anomalies.length) {
    console.log('\n  anomalies in the chain:');
    anomalies.forEach((a) => console.log(`    seq ${a.seq} ${a.kind}: ${a.detail}`));
  }
  console.log('');
}

main().catch((e) => { console.error(`leaderboard failed: ${e.message}`); process.exit(1); });
