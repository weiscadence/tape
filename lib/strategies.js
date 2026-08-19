// STRATEGIES — per-strategy sections inside ONE caller identity.
//
// WHY (Jiggy, 2026-08-19): the alpha bridge posts under a single caller, `cadence-alpha`, but
// that caller is not one opinion — it is ~15 independent scanners with wildly different records.
// Measured over 1,605 closed calls: poly_trader 51% win / +26.6% median, vol_spike 71% / +36.1%,
// against wallet_coord 19% / −41.2% (n=515) and rh_chain 36% / −42.0%. Blended into one row, the
// winners quietly subsidise the losers and NOBODY can see which is which — least of all us, so we
// have no basis for killing a strategy that is bleeding.
//
// The obvious fix was one caller id per strategy. Jiggy's is better: keep one identity, split the
// BOARD. Fifteen identities would fragment the record, multiply keys to manage, and invite the
// reader to think fifteen unrelated agents showed up. Sections give the same per-strategy honesty
// with one signer.
//
// WHY DERIVED, AND WHY THAT IS NOT A LOOPHOLE. Same rule as lib/lanes.js: a taxonomy must never be
// retro-fitted into signed bytes. But the strategy tag is ALREADY inside the signed entry — the
// bridge writes `note: "poly_trader | <edge text>"`, and `note` is part of the hashed entry
// (lib/entry.js allowed-field list, canonical serialisation). So the section is recomputed from
// the signed note by anyone holding the public chain. It is not a field we can edit after an
// outcome, and it is not a category the caller failed to commit to.
//
// WHAT THIS MUST NOT BECOME: a filter. The point is to show wallet_coord losing IN PUBLIC, not to
// drop it. Publishing only the profitable sections would be survivorship bias — the same species
// of lie as backdating, which is the one thing this whole system exists to make impossible.
'use strict';

/**
 * The registry is explicit, not inferred from whatever prefix shows up. A typo'd or renamed
 * scanner must surface as `unclassified` and force a decision here, exactly like a new venue does
 * in lanes.js — an unclassified section is visible, a silently-absorbed one is not.
 *
 * `label` is display copy. `verdict` is NOT a score: it records what the historical closed-call
 * sample said at the time this file was written, so a reader can see that a section with 3 live
 * calls sits on top of 515 historical losses. The board's own numbers always win over this string.
 */
const REGISTRY = {
  poly_trader:             { label: 'Polymarket top-trader follow', family: 'prediction' },
  poly_combo_double:       { label: 'Polymarket combo (double)',    family: 'prediction' },
  obi_sweep:               { label: 'Order-book imbalance sweep',   family: 'prediction' },
  compound_edge:           { label: 'Compound edge',                family: 'prediction' },
  base_rate:               { label: 'Base-rate fade',               family: 'prediction' },
  near_term_edge:          { label: 'Near-term 50/50',              family: 'prediction' },
  vol_spike:               { label: 'Volume spike',                 family: 'flow' },
  wallet_coord:            { label: 'Wallet coordination',          family: 'flow' },
  rh_chain:                { label: 'RH chain momentum',            family: 'flow' },
  ton_momentum:            { label: 'TON momentum',                 family: 'flow' },
  hl_funding_extreme:      { label: 'HL funding extreme',           family: 'perp' },
  hl_sharp_consensus:      { label: 'HL sharp consensus',           family: 'perp' },
  funding_squeeze:         { label: 'Funding squeeze',              family: 'perp' },
  meteora_sustained_yield: { label: 'Meteora sustained yield',      family: 'lp' },
  stable_depeg:            { label: 'Stablecoin depeg',             family: 'other' },
  rwa_arb:                 { label: 'RWA arbitrage',                family: 'other' },
};

/**
 * Read the strategy tag out of a signed note.
 *
 * Anchored to the START of the note and to the `tag | ` shape the bridge writes. Deliberately
 * strict: free text later in a note must never be able to move a call into a section, which is the
 * same reason lanes.js anchors its patterns to the identifier's scheme prefix.
 *
 * Returns `null` for any row that is not a bridge row (hand-posted calls, protocol rows). Those are
 * not "unclassified strategies" — they have no strategy at all, and inventing a bucket for them
 * would put board-protocol rows on a strategy scoreboard.
 */
function strategyOf(note) {
  if (typeof note !== 'string') return null;
  const m = note.match(/^([a-z][a-z0-9_]{2,39})\s*\|/);
  if (!m) return null;
  const key = m[1];
  const known = REGISTRY[key];
  return {
    key,
    label: known ? known.label : key,
    family: known ? known.family : 'unclassified',
    known: Boolean(known),
  };
}

/**
 * Per-strategy records, shaped exactly like lanes.js `laneRecords` so the front end can render
 * both with one component and so the two can be diffed against each other.
 *
 * `calls` are published call objects; each must carry `strategy` (attached in publish.js) and the
 * machine-readable `tone` field. Matching on `status` prose instead of `tone` is the bug lanes.js
 * documents — every win counted as zero while the code looked correct.
 */
function strategyRecords(calls) {
  const out = new Map();
  for (const c of calls) {
    const s = c.strategy;
    if (!s || !s.key) continue; // no strategy tag => not a bridge call => not on this board
    if (!out.has(s.key)) {
      out.set(s.key, {
        strategy: s.key,
        label: s.label,
        family: s.family,
        known: s.known,
        derived: true,
        calls: 0, settled: 0, wins: 0, losses: 0, open: 0, waiting: 0, voided: 0, pnl: 0,
      });
    }
    const r = out.get(s.key);
    r.calls++;
    switch (c.tone) {
      case 'win':  r.wins++; r.settled++; break;
      case 'loss': r.losses++; r.settled++; break;
      case 'open': r.open++; break;
      case 'wait': r.waiting++; break;
      case 'void': r.voided++; break;
      default: break;
    }
    if (typeof c.pnl === 'number' && isFinite(c.pnl)) r.pnl += c.pnl;
  }
  for (const r of out.values()) {
    // null, not 0, when nothing has settled — "0% win rate" and "nothing has finished yet" are
    // different claims and must not render the same. Straight from lanes.js.
    r.win_rate = r.settled > 0 ? r.wins / r.settled : null;
    r.pnl = Math.round(r.pnl * 1e6) / 1e6;
  }
  // Most-settled first: a section with 40 finished calls is stronger evidence than one with 1.
  // Ranking by P&L would put an untested strategy's single lucky call above a long real record.
  return [...out.values()].sort((a, b) => b.settled - a.settled || b.calls - a.calls);
}

module.exports = { strategyOf, strategyRecords, REGISTRY };
