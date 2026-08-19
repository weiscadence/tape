'use strict';
/**
 * score.js — the leaderboard, as a pure function.
 *
 * §7 of the spec: the tape is the record and must be opinion-free; any leaderboard is a
 * VIEW — a pure function from the tape to an ordering. That is only true if a stranger
 * can actually run it, so this file takes NO network handles and calls nothing. It
 * consumes (chain rows, anchors, gate verdicts, a mark set) and returns numbers.
 *
 * The mark set is the interesting half. Marks are fetched separately (marks.js), keyed
 * deterministically, and published alongside the result. That means recomputing our
 * leaderboard costs zero oracle calls and produces a bit-identical answer or exposes us.
 * If computing a rival leaderboard is expensive, we have quietly become the authority
 * again — which §7 says is the failure mode to avoid.
 *
 * FOUR RULES, each of which is a hole somebody would otherwise drive through:
 *
 *  1. THE MARK IS THE ORACLE PRICE AT THE ANCHOR SLOT, NOT THE CALLER'S entry_ref.
 *     `entry_ref` is a number the caller types. If it were the basis, "I got in at the
 *     low" would be free and fill-shopping would dominate the board. The claimed fill is
 *     still displayed; when the two disagree, both are visible.
 *
 *  2. AN UNPRICEABLE LEG IS `unscored`, NEVER ZERO. A missing mark that scores as 0 PnL
 *     is indistinguishable from a flat trade, and it silently flatters whoever the feed
 *     failed on. Unscored positions are excluded from totals AND counted in the output,
 *     so a partial leaderboard can never present itself as complete.
 *
 *  3. AN UNANCHORED CLOSE DOES NOT CLOSE. Otherwise a caller could post an exit, watch
 *     the market, and decide afterwards whether to let it be anchored — a free option on
 *     their own history. Until the close is covered by an anchor the position stays open
 *     and keeps marking, which is the T0.5 direction (silence is scored) and the safe one.
 *
 *  4. PROFIT IS NOT THE HEADLINE; BEATING SOL IS. Every position is compared against the
 *     same notional simply held in SOL over the identical window. A green number in a
 *     market that ran harder than you did is a loss of opportunity and prints as one.
 */

const crypto = require('crypto');
const D = require('./decimal');
const { canonicalize } = require('./canonical');
const { identityOf } = require('./entry');
const { isWindowRow } = require('./windows');
const { FEEDS } = require('./price');

/** Wrapped SOL — the mint a memecoin lane call quotes against. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const BENCHMARK_SYMBOL = 'SOL/USD';

/** Deterministic mark keys. These strings are part of the published artifact. */
const priceKey = (symbol, unix) => `price:${symbol}:${unix}`;
const resolutionKey = (market) => `resolution:${market}`;

/**
 * Which anchor covers chain entry `seq`?
 * An anchor commits a Merkle root over entries 0..count-1, so the covering anchor is the
 * EARLIEST one whose count exceeds seq. Taking the latest instead would date every entry
 * to the most recent anchor and quietly destroy the ordering the whole system is for.
 */
function coverageFor(seq, anchors) {
  let best = null;
  for (const a of anchors) {
    if (a.count > seq && (best === null || a.slot < best.slot)) best = a;
  }
  return best;
}

/** The price symbol a market trades in, or null if we have no feed for it. */
function symbolFor(market) {
  if (FEEDS[market]) return market;
  if (market === WSOL_MINT) return BENCHMARK_SYMBOL;
  return null;
}

/**
 * Walk the chain into positions.
 * Returns { positions, anomalies }. Anomalies are surfaced, never dropped: a close that
 * points at nothing is evidence about the poster and belongs in the output.
 */
function buildPositions({ rows, anchors, gate }) {
  const positions = new Map(); // open entry_hash -> position
  const anomalies = [];
  const voided = new Map(); // entry_hash -> voiding seq

  for (const row of rows) {
    const e = row.entry;
    const cover = coverageFor(row.seq, anchors);

    // The chain carries two families of row. Board-minted window rows (questions,
    // enrollments, non-answers) are not calls and are scored by lib/windows.js, not here.
    // Skipping them explicitly matters because the branch at the bottom of this loop used
    // to be an ELSE: anything that was not an amend or an open was TREATED AS A CLOSE,
    // dereferencing a `ref` that only a close has. The first non-call row ever appended
    // took the whole publisher down. An unrecognised type must be recorded, never assumed.
    if (isWindowRow(e)) continue;

    // A declaration is a coverage commitment, not a call. Skipped EXPLICITLY rather than
    // left to fall through to the unknown-type anomaly: it is a type we understand
    // perfectly and have decided is not scoreable, and filing that under "anomaly" would
    // put a permanent expected entry in the report that readers learn to scroll past.
    // The independent recomputer skips it at the same point, on purpose — if the two
    // programs disagreed about which rows are positions they would disagree about the
    // board, and that disagreement is the alarm the whole verifier exists to raise.
    if (e.type === 'declare') continue;

    if (e.type === 'amend') {
      if (!positions.has(e.ref) && !rows.some((r) => r.entry_hash === e.ref)) {
        anomalies.push({ seq: row.seq, kind: 'amend_orphan', detail: `ref ${e.ref.slice(0, 12)}… not in chain` });
        continue;
      }
      voided.set(e.ref, row.seq);
      continue;
    }

    if (e.type === 'open') {
      positions.set(row.entry_hash, {
        entry_hash: row.entry_hash,
        seq: row.seq,
        caller: e.caller,
        signer: e.signer || null,
        identity: identityOf(e),
        lane: e.lane,
        market: e.market,
        side: e.side,
        size: e.size,
        claimed_ref: e.entry_ref,
        ts_claimed: e.ts_claimed,
        note: e.note,
        open_anchor: cover,
        close: null,
        pending_close: null,
      });
      continue;
    }

    if (e.type !== 'close') {
      // Not amend, not open, not a window row, not close. Recorded rather than guessed —
      // a type we do not understand is a fact about the chain, not a close.
      anomalies.push({ seq: row.seq, kind: 'unknown_type', detail: `entry type ${JSON.stringify(e.type)} is not scoreable` });
      continue;
    }

    const pos = positions.get(e.ref);
    if (!pos) {
      anomalies.push({ seq: row.seq, kind: 'close_orphan', detail: `close refs ${e.ref.slice(0, 12)}… which is not an open` });
      continue;
    }
    if (pos.close || pos.pending_close) {
      anomalies.push({ seq: row.seq, kind: 'double_close', detail: `position ${e.ref.slice(0, 12)}… already has a close` });
      continue;
    }
    // Rule 3: an unanchored close does not close.
    if (!cover) { pos.pending_close = { seq: row.seq, entry_hash: row.entry_hash }; continue; }
    pos.close = { seq: row.seq, entry_hash: row.entry_hash, anchor: cover, claimed_ref: e.entry_ref, ts_claimed: e.ts_claimed };
  }

  const out = [];
  for (const pos of positions.values()) {
    const g = gate.get(pos.entry_hash);
    let status;
    let reason = null;
    if (voided.has(pos.entry_hash)) {
      status = 'voided';
      reason = `amended by seq ${voided.get(pos.entry_hash)} — VOID FOR RANKING`;
    } else if (!pos.open_anchor) {
      status = 'unanchored';
      reason = 'no anchor covers this entry yet';
    } else if (!g) {
      status = 'ineligible';
      reason = 'no resolvability verdict recorded';
    } else if (g.verdict !== 'eligible') {
      status = 'ineligible';
      reason = `gate verdict: ${g.verdict}${g.detail ? ` — ${g.detail}` : ''}`;
    } else {
      status = pos.close ? 'closed' : 'open';
    }
    out.push({ ...pos, status, status_reason: reason });
  }
  out.sort((a, b) => a.seq - b.seq);
  return { positions: out, anomalies };
}

/**
 * Every mark the scorer will ask for, as deterministic keys. Pure; drives the fetcher.
 *
 * Call it AGAIN with the marks fetched so far: a settled binary needs a benchmark leg at
 * its settlement time, which is unknowable until the resolution mark exists. The fetcher
 * loops until this returns nothing new. The alternative — quietly benchmarking a settled
 * bet over the wrong window — would compare a closed trade against a still-running SOL
 * position and misprice every prediction on the board.
 */
function markRequests(positions, asOfUnix, marks = {}) {
  const get = (k) => (marks instanceof Map ? marks.get(k) : marks[k]);
  const reqs = new Map();
  const need = (key, spec) => { if (!reqs.has(key) && !get(key)) reqs.set(key, spec); };

  for (const p of positions) {
    if (p.status !== 'open' && p.status !== 'closed') continue;
    const openAt = p.open_anchor.blockTime;
    const endAt = p.close ? p.close.anchor.blockTime : asOfUnix;

    // Benchmark leg: the same money simply held in SOL over the same window.
    need(priceKey(BENCHMARK_SYMBOL, openAt), { kind: 'price', symbol: BENCHMARK_SYMBOL, at: openAt });
    need(priceKey(BENCHMARK_SYMBOL, endAt), { kind: 'price', symbol: BENCHMARK_SYMBOL, at: endAt });

    if (p.lane === 'prediction') {
      need(resolutionKey(p.market), { kind: 'resolution', market: p.market });
      const r = get(resolutionKey(p.market));
      if (r && r.supported && r.resolved && r.at) {
        const at = Math.floor(new Date(r.at).getTime() / 1000);
        need(priceKey(BENCHMARK_SYMBOL, at), { kind: 'price', symbol: BENCHMARK_SYMBOL, at });
      }
      continue;
    }
    const sym = symbolFor(p.market);
    if (!sym) continue; // reported as unscored during scoring, with the reason
    need(priceKey(sym, openAt), { kind: 'price', symbol: sym, at: openAt });
    need(priceKey(sym, endAt), { kind: 'price', symbol: sym, at: endAt });
  }
  return [...reqs.entries()].map(([key, spec]) => ({ key, ...spec })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** PnL on a directional position, in the units of `size` (USD notional). */
function directionalPnl({ side, size, entry, exit }) {
  const ratio = D.div(exit, entry);          // exit / entry
  const move = D.sub(ratio, '1');            // fractional move
  return side === 'long' ? D.mul(size, move) : D.mul(size, D.neg(move));
}

/**
 * PnL on a binary at odds `p` (the market's YES probability at the anchored slot).
 * A YES buyer pays p per share and receives 1 if it lands: stake/p - stake. Odds of
 * exactly 0 or 1 are refused rather than divided by — a "free" bet is not a call.
 */
function binaryPnl({ side, size, odds, outcome }) {
  if (D.cmp(odds, '0') <= 0 || D.cmp(odds, '1') >= 0) {
    return { ok: false, reason: `odds ${odds} outside (0,1) — not a priced claim` };
  }
  const cost = side === 'yes' ? odds : D.sub('1', odds);
  const won = outcome === side;
  const pnl = won ? D.sub(D.div(size, cost), size) : D.neg(size);
  return { ok: true, pnl };
}

/**
 * Score positions against a mark set. Pure.
 * Returns { asOf, markset_hash, scored[], anomalies_in[], totals }.
 */
function scorePositions({ positions, marks, asOfUnix, anomalies = [] }) {
  const get = (k) => (marks instanceof Map ? marks.get(k) : marks[k]);
  const scored = [];

  for (const p of positions) {
    const base = {
      entry_hash: p.entry_hash, seq: p.seq, caller: p.caller,
      signer: p.signer || null, identity: p.identity || identityOf({ signer: p.signer, caller: p.caller }),
      lane: p.lane,
      // The signed note travels with the scored row. buildPositions() already carries it, but this
      // function rebuilt each row field-by-field and silently dropped it, so anything downstream
      // deriving from the note (lib/strategies.js sections) saw null for every call and produced an
      // empty board that looked like "no strategies" rather than "the field never arrived".
      note: p.note || null,
      market: p.market, side: p.side, size: p.size, claimed_ref: p.claimed_ref,
      status: p.status, status_reason: p.status_reason,
      open_slot: p.open_anchor ? p.open_anchor.slot : null,
      close_slot: p.close ? p.close.anchor.slot : null,
      pending_close: !!p.pending_close,
    };

    if (p.status !== 'open' && p.status !== 'closed') {
      scored.push({ ...base, scoring: 'excluded', reason: p.status_reason, pnl: null, benchmark_pnl: null, edge: null });
      continue;
    }

    const openAt = p.open_anchor.blockTime;
    const endAt = p.close ? p.close.anchor.blockTime : asOfUnix;
    const unscored = (reason) => scored.push({
      ...base, scoring: 'unscored', reason, pnl: null, benchmark_pnl: null, edge: null,
      marked_from: openAt, marked_to: endAt,
    });

    // --- the position's own PnL -------------------------------------------------
    let pnl = null;
    let realized = false;
    let settledAt = null;

    if (p.lane === 'prediction') {
      const r = get(resolutionKey(p.market));
      if (!r) { unscored('no resolution mark in set'); continue; }
      if (!r.supported) { unscored(`market has no resolver: ${r.detail || 'unsupported'}`); continue; }
      if (!r.resolved) {
        // Rule 2, the subtle case: an unresolved binary has NO mark unless a live odds
        // source exists, and we have none. Marking it at the entry odds would report
        // every open prediction as exactly flat — a fabricated zero wearing a number.
        unscored('binary not yet resolved and there is no live odds feed to mark it against');
        continue;
      }
      const b = binaryPnl({ side: p.side, size: p.size, odds: p.claimed_ref, outcome: r.outcome });
      if (!b.ok) { unscored(b.reason); continue; }
      pnl = b.pnl;
      realized = true;                       // a settled binary pays whether or not it was closed
      settledAt = r.at ? Math.floor(new Date(r.at).getTime() / 1000) : endAt;
    } else if (p.side === 'long' || p.side === 'short') {
      const sym = symbolFor(p.market);
      if (!sym) { unscored(`no price feed registered for market ${p.market}`); continue; }
      const a = get(priceKey(sym, openAt));
      const b = get(priceKey(sym, endAt));
      if (!a || !a.ok) { unscored(`entry mark unavailable: ${(a && a.reason) || 'not in mark set'}`); continue; }
      if (!b || !b.ok) { unscored(`exit mark unavailable: ${(b && b.reason) || 'not in mark set'}`); continue; }
      pnl = directionalPnl({ side: p.side, size: p.size, entry: a.price, exit: b.price });
      realized = p.status === 'closed';
    } else {
      unscored(`no scorer for lane ${p.lane} with side ${p.side}`);
      continue;
    }

    // --- the benchmark: the same notional, simply held in SOL --------------------
    // The benchmark window must be the POSITION'S window, so a settled binary is compared
    // against SOL held to settlement — not to now. No fallback to a convenient nearby
    // timestamp: a benchmark measured over the wrong window is a wrong benchmark, and it
    // would fail silently in exactly the direction that flatters whoever is being scored.
    const benchEnd = settledAt !== null ? settledAt : endAt;
    const s0 = get(priceKey(BENCHMARK_SYMBOL, openAt));
    const s1 = get(priceKey(BENCHMARK_SYMBOL, benchEnd));
    if (!s0 || !s0.ok || !s1 || !s1.ok) {
      // A PnL without its benchmark is exactly the misleading number this product exists
      // to replace, so it does not get published half-done.
      unscored(`benchmark mark unavailable: ${(s0 && s0.reason) || (s1 && s1.reason) || 'not in mark set'}`);
      continue;
    }
    const benchPnl = D.mul(p.size, D.sub(D.div(s1.price, s0.price), '1'));

    scored.push({
      ...base,
      scoring: 'scored',
      realized,
      pnl,
      entry_mark: p.lane === 'prediction' ? p.claimed_ref : get(priceKey(symbolFor(p.market), openAt)).price,
      exit_mark: p.lane === 'prediction' ? null : get(priceKey(symbolFor(p.market), endAt)).price,
      benchmark_pnl: benchPnl,
      edge: D.sub(pnl, benchPnl),
      marked_from: openAt,
      marked_to: benchEnd,
    });
  }

  // The mark set is hashed so a recomputation can prove it used the same inputs. Without
  // this, "I get a different number" is unresolvable — the disagreement could be the
  // maths or the marks, and nobody could tell which.
  const marksetHash = crypto.createHash('sha256')
    .update(canonicalize(normalizeMarks(marks)), 'utf8').digest('hex');

  return { asOf: asOfUnix, markset_hash: marksetHash, scored, anomalies, totals: totalsOf(scored) };
}

/** Marks as a plain, canonicalizable object (all values decimal strings or booleans). */
function normalizeMarks(marks) {
  const src = marks instanceof Map ? [...marks.entries()] : Object.entries(marks);
  const out = {};
  for (const [k, v] of src.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (v.kind === 'resolution' || 'resolved' in v) {
      out[k] = { supported: !!v.supported, resolved: !!v.resolved, outcome: v.outcome || null, at: v.at || null };
    } else {
      out[k] = v.ok
        ? { ok: true, price: v.price, publish_time: String(v.publish_time), source: v.source || null }
        : { ok: false, reason: String(v.reason || 'unknown') };
    }
  }
  return out;
}

function totalsOf(scored) {
  const ok = scored.filter((s) => s.scoring === 'scored');
  return {
    positions: scored.length,
    scored: ok.length,
    unscored: scored.filter((s) => s.scoring === 'unscored').length,
    excluded: scored.filter((s) => s.scoring === 'excluded').length,
    realized: D.sum(ok.filter((s) => s.realized).map((s) => s.pnl)),
    unrealized: D.sum(ok.filter((s) => !s.realized).map((s) => s.pnl)),
    pnl: D.sum(ok.map((s) => s.pnl)),
    benchmark_pnl: D.sum(ok.map((s) => s.benchmark_pnl)),
    edge: D.sum(ok.map((s) => s.edge)),
  };
}

/**
 * Aggregate to a per-caller board, ranked by EDGE (PnL minus buy-and-hold SOL), because
 * §1 says the headline is "did you beat just holding SOL?", not profit and not win rate.
 *
 * `complete` is the flag that keeps this honest: a caller with any unscored position has
 * an incomplete row, and the UI must say so rather than rank a partial number as if it
 * were the whole story.
 */
/**
 * Decide what name is safe to SHOW for each identity.
 *
 * A signature proves who posted; it says nothing about the display name they typed. So
 * an attacker can sign with their own key and call themselves "cadence-wave", and a UI
 * that renders `caller` would show my name over their record. Policing a name registry
 * is one answer; this is the cheaper one: a name is displayed only if it is unambiguous —
 * one identity has used it, and that identity has used only it. Any collision collapses
 * BOTH parties to their raw keys.
 *
 * That makes impersonation self-defeating rather than forbidden: taking my name costs me
 * my label and costs the attacker theirs, and it is mechanically re-derivable from the
 * tape instead of resting on someone adjudicating claims.
 *
 * ONLY SIGNED IDENTITIES CONTEST A NAME. The first version let any caller contest, and
 * running it against the live tape showed what that costs: a signed key was stripped of
 * its label by UNSIGNED entries using the same name. Generalise that and it is a griefing
 * attack — post one unsigned call as "vitalik" and the real signed vitalik can never
 * display their name again, for free, forever. An unsigned row cannot be confused with a
 * signed one anyway, because it always renders with the `unsigned:` prefix, so it has no
 * business contesting anything.
 */
function resolveNames(scored) {
  const namesOf = new Map();      // identity -> Set(name)
  const signersOf = new Map();    // name -> Set(signed identity)
  for (const s of scored) {
    if (!namesOf.has(s.identity)) namesOf.set(s.identity, new Set());
    namesOf.get(s.identity).add(s.caller);
    if (!s.identity.startsWith('key:')) continue;
    if (!signersOf.has(s.caller)) signersOf.set(s.caller, new Set());
    signersOf.get(s.caller).add(s.identity);
  }
  const out = new Map();
  for (const [identity, names] of namesOf) {
    const signed = identity.startsWith('key:');
    const key = signed ? identity.slice(4) : null;
    const only = names.size === 1 ? [...names][0] : null;
    // An unsigned caller never claims a bare name, so it is never "contested" — it is
    // simply always labelled as unsigned.
    const contested = signed && only !== null && signersOf.get(only).size > 1;
    // An UNSIGNED caller is always rendered `unsigned:<name>` — never a bare name, at any
    // point. Letting the bare name through for an unsigned row is what makes impersonation
    // work in the first place, and the previous edit made that branch unreachable. A
    // SIGNED key shows its name only while it is unambiguous, and its short key otherwise.
    const display = !signed
      ? `unsigned:${[...names].sort()[0]}`
      : (only !== null && !contested ? only : `${key.slice(0, 4)}…${key.slice(-4)}`);
    out.set(identity, {
      display,
      name_contested: contested,
      names_used: [...names].sort(),
      signed,
      signer: key,
      // Two flags rather than one tier label, because "T1" would hide which half holds.
      // Signing proves WHO SAID IT. It does not prove the trade happened; that needs the
      // wallet-derived lane, which does not exist yet and must not be implied.
      identity_verified: signed,
      fill_verified: false,
      tier: signed ? 'T1-signed' : 'T0',
    });
  }
  return out;
}

function leaderboard(result) {
  const names = resolveNames(result.scored);
  const byCaller = new Map();
  for (const s of result.scored) {
    if (!byCaller.has(s.identity)) {
      byCaller.set(s.identity, {
        identity: s.identity, caller: names.get(s.identity).display,
        positions: 0, scored: 0, unscored: 0, excluded: 0,
        open: 0, wins: 0, losses: 0, rows: [],
      });
    }
    const c = byCaller.get(s.identity);
    c.positions++;
    c.rows.push(s);
    if (s.scoring === 'unscored') c.unscored++;
    else if (s.scoring === 'excluded') c.excluded++;
    else {
      c.scored++;
      if (!s.realized) c.open++;
      if (D.cmp(s.pnl, '0') > 0) c.wins++;
      else if (D.cmp(s.pnl, '0') < 0) c.losses++;
    }
  }

  const board = [...byCaller.values()].map((c) => {
    const ok = c.rows.filter((r) => r.scoring === 'scored');
    const realized = D.sum(ok.filter((r) => r.realized).map((r) => r.pnl));
    const unrealized = D.sum(ok.filter((r) => !r.realized).map((r) => r.pnl));
    const pnl = D.add(realized, unrealized);
    const bench = D.sum(ok.map((r) => r.benchmark_pnl));
    return {
      caller: c.caller,
      ...names.get(c.identity),
      identity: c.identity,
      realized, unrealized, pnl,
      benchmark_pnl: bench,
      edge: D.sub(pnl, bench),
      beat_hodl: D.cmp(D.sub(pnl, bench), '0') > 0,
      positions: c.positions, scored: c.scored, open: c.open,
      unscored: c.unscored, excluded: c.excluded,
      wins: c.wins, losses: c.losses,
      complete: c.unscored === 0,
    };
  });

  // Ties break on IDENTITY (not display name) so the ordering is total and stable — a
  // display name can be shared or change, an identity cannot. An unstable sort would
  // make two honest recomputations disagree on rank order and look like tampering.
  board.sort((a, b) => D.cmp(b.edge, a.edge) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  return board;
}

module.exports = {
  coverageFor, symbolFor, buildPositions, markRequests, scorePositions, leaderboard, resolveNames,
  directionalPnl, binaryPnl, normalizeMarks,
  priceKey, resolutionKey, BENCHMARK_SYMBOL, WSOL_MINT,
};
