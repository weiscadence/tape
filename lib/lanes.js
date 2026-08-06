// LANES — which track a call belongs to, so one record does not average across unlike things.
//
// WHY (Jiggy, 2026-08-06): the board was one undifferentiated stream, so a Guangzhou weather bet,
// a GitHub merge prediction and a SOL price binary all landed in the same track record. A crypto
// win rate diluted by weather calls is not a crypto win rate, and the combined number flatters or
// punishes whichever lane happens to be smaller. Same principle already written down as
// "a side identity is not a label" — sports calls are a different track from the alpha engine.
//
// WHY DERIVED AND NOT READ FROM THE ENTRY. Entries DO carry a signed `lane`, but only two values
// were ever used ('prediction', 'perp') and the eleven oldest calls carry none at all. Re-laning a
// signed entry is impossible without breaking its signature, and it should be — the taxonomy is a
// presentation choice and presentation choices must not be retro-fitted into signed bytes.
//
// So the lane shown on the board is DERIVED from the signed market identifier, deterministically,
// with the signed `lane` as a tiebreak. That means it can be recomputed by anyone from the public
// chain and it changes when we change this file, not when we edit history. `derived: true` is
// carried into the output so a reader is never told the venue signed a category we assigned.
'use strict';

// Order matters: first match wins. Keep patterns anchored to the identifier's scheme prefix so a
// market string can never fall into a lane because of something a caller wrote in free text.
const RULES = [
  { lane: 'crypto-price',       test: (m) => /^pyth:/i.test(m) || /^Crypto\./i.test(m) },
  { lane: 'prediction-markets', test: (m) => /^(delphi|polymarket|kalshi|manifold):/i.test(m) },
  { lane: 'software',           test: (m) => /^github:/i.test(m) },
  { lane: 'macro',              test: (m) => /^(fred|macro):/i.test(m) },
];

// Not a lane, and must never be scored into one: demo rows and the window/sweep protocol rows the
// board posts about itself. Folding these into a real lane would inflate its count with things
// that were never predictions.
const EXCLUDED = [
  { lane: 'demo',     test: (m) => /^demo:/i.test(m) },
  { lane: 'protocol', test: (m) => !m || /^tape-window/i.test(m) },
];

const LABEL = {
  'crypto-price': 'Crypto price',
  'prediction-markets': 'Prediction markets',
  'macro': 'Macro',
  'software': 'Software / shipping',
  'demo': 'Demo (not scored)',
  'protocol': 'Board protocol (not scored)',
  'unclassified': 'Unclassified',
};

/**
 * The lane for a market identifier.
 *
 * Returns `unclassified` rather than guessing when nothing matches — a new venue must show up as
 * unclassified on the board and force a decision here, instead of being quietly absorbed into
 * whichever lane happens to be nearest. An unclassified row is visible; a mis-laned one is not.
 */
function laneOf(market, signedLane) {
  const m = String(market || '');
  for (const r of EXCLUDED) if (r.test(m)) return { lane: r.lane, scored: false, derived: true };
  for (const r of RULES) if (r.test(m)) return { lane: r.lane, scored: true, derived: true };
  // Signed-lane tiebreak, only for rows whose market we cannot classify. 'perp' is a crypto
  // position by construction; 'prediction' without a recognised venue prefix stays unclassified
  // because we cannot say WHICH prediction venue settles it.
  if (signedLane === 'perp') return { lane: 'crypto-price', scored: true, derived: true };
  return { lane: 'unclassified', scored: false, derived: true };
}

/**
 * Group scored calls into per-lane records.
 *
 * Every lane reports its own denominator. A lane with two settled calls and a 100% win rate is
 * reported as exactly that, never rounded up into a headline — the whole point of splitting is to
 * stop a small sample hiding inside a big one.
 */
function laneRecords(calls) {
  const out = new Map();
  let unknownTone = new Set();
  for (const c of calls) {
    const { lane, scored } = laneOf(c.market_raw || c.market, c.lane);
    if (!out.has(lane)) {
      out.set(lane, { lane, label: LABEL[lane] || lane, scored_lane: scored, derived: true,
        calls: 0, settled: 0, wins: 0, losses: 0, open: 0, waiting: 0, voided: 0, pnl: 0 });
    }
    const r = out.get(lane);
    r.calls++;
    // `tone` and not `status`: status is prose for humans ("called it", "wrong") and the first
    // version of this matched it with /win/ and /loss/, so every win and loss on the board
    // silently counted as zero while the code looked like it worked. tone is the machine field
    // humanStatus() already emits for exactly this purpose.
    switch (c.tone) {
      case 'win':  r.wins++; r.settled++; break;
      case 'loss': r.losses++; r.settled++; break;
      case 'open': r.open++; break;
      case 'wait': r.waiting++; break;
      case 'void': r.voided++; break;
      default: unknownTone.add(String(c.tone));
    }
    if (typeof c.pnl === 'number' && isFinite(c.pnl)) r.pnl += c.pnl;
  }
  for (const r of out.values()) {
    // null, not 0, when nothing has settled. A 0% win rate and "no completed calls yet" are
    // different claims and the board must not render them the same way.
    r.win_rate = r.settled > 0 ? r.wins / r.settled : null;
    r.pnl = Math.round(r.pnl * 1e6) / 1e6;
  }
  const records = [...out.values()].sort((a, b) => b.calls - a.calls);
  // A tone this function does not know about would land in no bucket and quietly deflate the
  // lane's counts — the same failure the status-regex version shipped with. Surface it loudly
  // instead: an unrecognised tone is a code change we have not made yet, not an empty lane.
  if (unknownTone.size) {
    records.unknownTone = [...unknownTone];
    if (!process.env.TAPE_LANES_QUIET) {
      console.error(`lanes.js: UNRECOGNISED tone(s) ${[...unknownTone].join(', ')} — `
        + 'those calls are counted in `calls` but in no outcome bucket. Add them to the switch.');
    }
  }
  return records;
}

module.exports = { laneOf, laneRecords, LABEL, RULES, EXCLUDED };
