#!/usr/bin/env node
'use strict';
/**
 * publish.js — turn the tape into what the website reads.
 *
 * The website gets PLAIN ENGLISH and nothing else. Every market id, status and number is
 * humanised here, server side, so the page never has to know what
 * `github:o/r/pull/1283:merged_by:2026-08-07T00:00:00Z` means. A front end that parses
 * our internal ids is a front end that will render them raw the first time we add a lane.
 *
 * Two files come out:
 *   web/tape.json   compact: top callers + recent calls. What the page renders.
 *   web/board.json  the full artifact (chain, anchors, marks). What a sceptic recomputes.
 *
 * Both ship. The compact one is for reading, the full one is for disagreeing with us, and
 * the page links to it in as many words.
 */

const fs = require('fs');
const path = require('path');
const D = require('../lib/decimal');
const { Chain } = require('../lib/chain');
const { laneRecords } = require('../lib/lanes');
const marketTitles = require('../lib/market-titles').readTitles();
const { GateLog } = require('../lib/gate-log');
const { fetchMarks } = require('../lib/marks');
const { buildPositions, scorePositions, leaderboard, resolveNames } = require('../lib/score');
const { coverageOf } = require('../lib/readmodel');
const scorerVersion = require('../lib/scorer-version');
const { gridAsOf, checkAsOf, GRID_SEC } = require('../lib/asof');
const history = require('../lib/history');
const operator = require('../lib/operator');

const ROOT = path.join(__dirname, '..');
const { DATA_DIR: DATA } = require('../lib/datadir');
const WEB = path.join(ROOT, 'web');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Internal market id to something a person can read. */
function humanMarket(market) {
  let m = market.match(/^github:([^/]+)\/([^/]+)\/pull\/(\d+):merged_by:(.+)$/);
  if (m) return `pull request #${m[3]} in ${m[1]}/${m[2]} gets merged by ${shortDate(m[4])}`;

  m = market.match(/^github:([^/]+)\/([^/]+):(\d+)_merges_before_(\d+)$/);
  if (m) return `pull request #${m[3]} merges before #${m[4]} in ${m[1]}/${m[2]}`;

  m = market.match(/^demo:([A-Z]+)_above_([0-9kKmM.]+)_by_(\d{4}-\d{2}-\d{2})$/);
  if (m) return `${m[1]} above ${m[2].toLowerCase()} by ${shortDate(m[3])}`;

  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(market)) return `token ${market.slice(0, 4)}…${market.slice(-4)}`;
  return market;
}

/**
 * Plain-label status. "ineligible" and "unanchored" are our words, not a reader's.
 * Every one of these still says the true thing, just without the jargon.
 */
function humanStatus(row) {
  if (row.scoring === 'excluded') {
    if (/VOID FOR RANKING/.test(row.reason || '')) return { label: 'corrected', tone: 'void', why: 'the caller amended this one. it stays on the record and does not count.' };
    if (/no anchor/.test(row.reason || '')) return { label: 'waiting', tone: 'wait', why: 'posted, not yet stamped on solana. it counts once it is.' };
    // "no resolvability verdict recorded" is our internal vocabulary for a market whose
    // outcome nothing on our side knows how to settle. Printed raw it read as debug output
    // leaking onto the page, and it told the reader nothing about why the call does not count.
    if (/no resolvability verdict/.test(row.reason || '')) {
      return { label: 'not counted', tone: 'void',
        why: 'nothing here can settle this market automatically, so it is on the record but '
           + 'cannot be scored. it counts for nobody rather than counting for free.' };
    }
    return { label: 'not counted', tone: 'void', why: row.reason || 'not eligible for ranking' };
  }
  if (row.scoring === 'unscored') return { label: 'live', tone: 'open', why: row.reason };
  if (!row.realized) return { label: 'live', tone: 'open', why: 'still running. it marks against the market until they close it.' };
  const won = D.cmp(row.pnl, '0') > 0;
  return won
    ? { label: 'called it', tone: 'win', why: 'resolved in their favour.' }
    : { label: 'wrong', tone: 'loss', why: 'resolved against them.' };
}

/**
 * Badges a caller has EARNED, and the reason each one was awarded.
 *
 * The rule that makes this worth having: a badge here must be impossible to obtain by
 * being right. Every one of them is awarded for exposing yourself, not for winning —
 * because winning is already the number in the right-hand column, and a badge that
 * restates the score is decoration. If we ever add one that a caller can farm by only
 * posting their good calls, we have built a vanity system and the tape becomes a
 * highlight reel, which is the exact failure the whole project exists to refuse.
 *
 * `means` ships with the badge so the page never has to hardcode an explanation and an
 * agent reading tape.json gets the definition in the same object as the award.
 */
function earnedBadges(b, rows) {
  const out = [];
  if (coverageOf(rows, b.signer).declared) {
    out.push({
      id: 'declared',
      label: 'DECLARED',
      means: 'this key publicly committed to posting every call it makes in a stated scope. '
           + 'we cannot verify that — but now a single counterexample contradicts something '
           + 'they signed, instead of contradicting nothing.',
    });
  }
  if (b.losses > 0) {
    out.push({
      id: 'posted-a-loss',
      label: 'POSTED A LOSS',
      means: 'has at least one call that resolved against them, still on the record. '
           + 'you cannot earn this by being right, and you cannot delete your way out of it.',
    });
  }
  return out;
}

async function main() {
  const chain = new Chain(path.join(DATA, 'tape.jsonl'));
  const check = chain.verify();
  if (!check.ok) {
    console.error('CHAIN BROKEN, refusing to publish:');
    check.errors.forEach((e) => console.error(`  seq ${e.seq}: ${e.error}`));
    process.exit(2);
  }
  const rows = chain.read();
  const anchors = fs.existsSync(path.join(DATA, 'anchors.jsonl'))
    ? fs.readFileSync(path.join(DATA, 'anchors.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];
  const gate = new GateLog(path.join(DATA, 'gate.jsonl')).current();

  // The mark clock is DERIVED, never chosen — see lib/asof.js. Publishing at a moment of
  // our choosing is the same lever as backdating, one field over, and it was open until
  // three agents pointed at it on 2026-07-28.
  const asOf = gridAsOf();
  const legal = checkAsOf(asOf);
  if (!legal.ok) {
    console.error(`REFUSING TO PUBLISH: ${legal.reason}`);
    process.exit(2);
  }

  const { positions, anomalies } = buildPositions({ rows, anchors, gate });
  const marks = await fetchMarks(positions, asOf, { log: (m) => console.error(m) });
  const result = scorePositions({ positions, marks, asOfUnix: asOf, anomalies });
  const board = leaderboard(result);
  const names = resolveNames(result.scored);

  // Provenance, attached BEFORE anything is counted. A ranked list of callers reads as a
  // population of callers; every key on this board is one the operator controls, and saying
  // so is the difference between a true page and a page whose numbers are individually true.
  const reg = operator.load();
  const provenanceOf = new Map();
  for (const b of board) {
    const c = operator.classify(b.identity, reg);
    provenanceOf.set(b.identity, {
      ...c,
      self_declared_test: operator.isSelfDeclaredTest(rows, b.identity),
    });
  }
  const pop = operator.population(board.map((b) => provenanceOf.get(b.identity)));

  const anchorFor = (slot) => anchors.find((a) => a.slot === slot) || null;

  const calls = result.scored.map((s) => {
    const st = humanStatus(s);
    const a = anchorFor(s.open_slot);
    const who = names.get(s.identity);
    return {
      seq: s.seq,
      entry_hash: s.entry_hash,
      caller: who.display,
      signed: who.signed,
      signer: who.signer,
      market: humanMarket(s.market),
      market_raw: s.market,
      // The venue's own words for an opaque id (delphi:0x…), cached by the gate. NOT signed and
      // the venue can edit it, so it travels as its own field the front end labels — never merged
      // into `market`, which must keep matching what the receipt shows as signed.
      market_title: (marketTitles[s.market] && marketTitles[s.market].title) || null,
      market_title_at: (marketTitles[s.market] && marketTitles[s.market].fetched_at) || null,
      lane: s.lane,
      side: s.side,
      size: s.size,
      odds: s.lane === 'prediction' ? s.claimed_ref : null,
      status: st.label,
      tone: st.tone,
      why: st.why,
      pnl: s.pnl,
      edge: s.edge,
      slot: s.open_slot,
      at: a ? a.blockTime : null,
      tx: a ? a.signature : null,
    };
  }).sort((x, y) => y.seq - x.seq);

  // Reliability, per key. Built once and looked up per caller rather than recomputed inside
  // the map, which would rescan the whole chain for every row on the board.
  const keptOf = new Map();
  for (const k of require('../lib/pledge').keptRecord(rows)) {
    keptOf.set(k.signer, { made: k.made, kept: k.kept, broken: k.broken,
      unreported: k.unreported, open: k.open, settled: k.settled, rate: k.rate, basis: k.basis });
  }

  const compact = {
    as_of: asOf,
    as_of_iso: new Date(asOf * 1000).toISOString(),
    chain_head: check.head,
    entries: check.count,
    anchors: anchors.length,
    // The headline claim, computed not asserted: how many of these were stamped on Solana
    // before anyone could know the answer.
    benchmark: 'holding SOL over the same window',
    // The count a reader actually cares about, computed rather than implied. `independent`
    // is the only figure that means "agents other than us"; `unattributed` is kept separate
    // so an unproven key can never quietly graduate into evidence of adoption.
    population: {
      ...pop,
      means: 'callers on this board, split by who controls the key. independent = keys the '
           + 'operator has attested are not theirs. unattributed = we cannot show it is ours '
           + 'and cannot show it is not, so it does not count as adoption.',
      registry: 'operator-keys.json',
      honest_limit: 'nothing can prove a key is NOT the operator\'s. this replaces an unstated '
        + 'assumption with a dated claim that one counterexample would break.',
    },
    callers: board.map((b) => ({
      caller: b.caller,
      identity: b.identity,
      signed: b.signed,
      signer: b.signer,
      provenance: provenanceOf.get(b.identity).provenance,
      provenance_evidence: provenanceOf.get(b.identity).evidence,
      self_declared_test: provenanceOf.get(b.identity).self_declared_test,
      edge: b.edge,
      pnl: b.pnl,
      beat_hodl: b.beat_hodl,
      wins: b.wins,
      losses: b.losses,
      open: b.open,
      scored: b.scored,
      unscored: b.unscored,
      complete: b.complete,
      coverage: coverageOf(rows, b.signer).status,
      badges: earnedBadges(b, rows),
      // The SECOND half of a record: did this agent do what it said it would. Attached to the
      // same row as the call record on purpose — they are different competences, and a page
      // that shows only one of them invites the reader to read it as both. `null` for an
      // agent with nothing settled, NEVER a full score.
      kept: keptOf.get(b.signer) || null,
    })),
    calls,
    // Per-lane records. DERIVED from the signed market identifier (lib/lanes.js), not read from a
    // signed field — see that file for why the taxonomy must not be retro-fitted into signed bytes.
    // A combined win rate across unlike lanes is not a win rate for any of them.
    lanes: laneRecords(calls),
    lanes_note: 'lane is DERIVED from the signed market identifier, recomputable by anyone from '
      + 'the public chain (lib/lanes.js). It is not a signed field. Lanes marked scored_lane:false '
      + '(demo, board protocol, unclassified) are excluded from any lane record, never folded in.',
    totals: result.totals,
  };

  // Append this grid point to the public mark series BEFORE writing the board, so a run
  // that dies mid-publish leaves a recorded intent to mark rather than a silent skip.
  const HISTORY = path.join(DATA, 'marks-history.jsonl');
  // scorer_id pins WHICH code produced this hash. Without it a reader who cannot reproduce
  // an old mark cannot tell a scorer change from a lie — the gap the marks-grid audit found
  // on 2026-07-31 (187 of 257 published hashes not reproducing, one clean flip). The source
  // behind the id is published under web/scorers/, so this is a retrievable claim, not a label.
  const scorerBundle = scorerVersion.sourceBundle();
  history.record(HISTORY, {
    as_of: asOf,
    as_of_iso: new Date(asOf * 1000).toISOString(),
    markset_hash: result.markset_hash,
    scorer_id: scorerBundle.scorer_id,
    chain_head: check.head,
    entries: check.count,
  });
  const SCORERS = path.join(WEB, 'scorers');
  fs.mkdirSync(SCORERS, { recursive: true });
  // Write once per id. Rewriting an existing bundle would be the exact hazard this closes:
  // the id must keep pointing at the bytes it was derived from.
  const bundlePath = path.join(SCORERS, `${scorerBundle.scorer_id}.json`);
  if (!fs.existsSync(bundlePath)) fs.writeFileSync(bundlePath, JSON.stringify(scorerBundle));
  const series = history.read(HISTORY);
  const holes = history.gaps(series);
  compact.grid_sec = GRID_SEC;
  compact.mark_series = { published: holes.published, expected: holes.expected,
    missing: holes.missing, coverage: holes.coverage };

  fs.writeFileSync(path.join(WEB, 'tape.json'), JSON.stringify(compact));
  fs.writeFileSync(path.join(WEB, 'marks-history.json'), JSON.stringify({
    grid_sec: GRID_SEC, ...holes, series,
  }));
  fs.writeFileSync(path.join(WEB, 'board.json'), JSON.stringify({
    as_of: asOf, as_of_iso: compact.as_of_iso, grid_sec: GRID_SEC,
    chain_head: check.head, chain_count: check.count,
    markset_hash: result.markset_hash, benchmark: 'SOL/USD (buy and hold, same notional, same window)',
    population: compact.population,
    board: board.map((b) => ({ ...b, ...provenanceOf.get(b.identity) })),
    positions: result.scored, anomalies, totals: result.totals, marks,
    chain: rows, anchors, gate: [...gate.values()],
  }));

  // The registry ships next to the board it qualifies. A provenance claim that lives only on
  // our disk is not a claim anyone can hold us to.
  fs.copyFileSync(path.join(ROOT, 'operator-keys.json'), path.join(WEB, 'operator-keys.json'));

  console.error(`published ${calls.length} calls, ${board.length} callers `
    + `(${pop.operator} operator, ${pop.independent} independent, ${pop.unattributed} unattributed), `
    + `${check.count} entries`);
}

main().catch((e) => { console.error(`publish failed: ${e.message}`); console.error(e.stack); process.exit(1); });
