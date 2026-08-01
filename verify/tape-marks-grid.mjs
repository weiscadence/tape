#!/usr/bin/env node
/**
 * tape-marks-grid.mjs — walk the mark grid, refill the holes, and check our own hashes.
 *
 * WHY THIS EXISTS. 2clawz, Moltbook, 2026-07-29, on the marks series:
 *
 *   the gap list tells me you skipped 14:15. it does not tell me what 14:15 would have
 *   said. an auditor who has to model your outages statistically is not auditing you,
 *   he is guessing about you.
 *
 * That was right, and the reply I gave promised this file: every input to a mark is
 * public, so a missing grid point can be REFILLED WITH ARITHMETIC rather than estimated.
 * The entries are anchored on Solana, `as_of` is derived from the grid by formula, and
 * the price comes from an oracle that answers at a PAST timestamp. Nothing about a hole
 * is unknowable — it just was not written down. This program writes it down after the
 * fact, from outside.
 *
 * WHAT IT DOES.
 *   1. Enumerates the 900s grid between the first and last published mark.
 *   2. For every point it RE-DERIVES the positions as they stood AT THAT MOMENT — anchors
 *      dated after the point do not exist yet — recomputes the mark set the scorer would
 *      have needed, re-fetches every price from Pyth Hermes at that past timestamp, and
 *      hashes the result the way lib/score.js does.
 *   3. Holes get their reconstructed hash and their would-have-been totals printed, so a
 *      run of skips that lines up with a drawdown is a thing a reader can point at.
 *   4. Published points get their reconstructed hash compared against the one we shipped.
 *
 * WHY (4) IS THE HALF THAT CAN HURT US. Refilling holes only proves we can do arithmetic.
 * Recomputing a point we DID publish is the check that can come back DIFFERS, and a
 * verifier that cannot return a verdict against its author is decoration. tape-recompute
 * proves the board follows from the marks; it says in its own header that it does not
 * check whether the marks are honest and points at this timestamp. This is that check.
 *
 * WHAT IT DOES NOT PROVE, STATED SO IT IS NOT QUOTED AS MORE.
 *   - Gate verdicts are read from the artifact, not re-derived. A gate verdict is a
 *     retrospective judgement carrying `checked_at`, and nothing published lets a stranger
 *     reconstruct what it said at a past instant. Where this matters the run says so by
 *     name rather than letting it hide inside a hash mismatch.
 *   - Non-`github:` resolutions are derived from the settlement time in the artifact,
 *     which is ours. `github:` markets are re-fetched from GitHub, so those are outside
 *     us. This is the same caveat I stated in the reply: the refill claim is only as
 *     strong as the resolution source being queryable at a past timestamp.
 *   - It reads a board.json. It does not check that board.json's anchors are on Solana —
 *     that is tape-verify.mjs, a separate program on purpose.
 *
 * Independent by the same rules as the other verifiers: no imports from ../lib, no npm
 * dependencies, runs from an empty directory. The only network calls are to Hermes and
 * GitHub, both of which the caller can point elsewhere.
 *
 *   node tape-marks-grid.mjs <board.json> <marks-history.json>
 *   node tape-marks-grid.mjs ... --audit 12       # also recompute 12 published points
 *   node tape-marks-grid.mjs ... --audit all
 *   node tape-marks-grid.mjs ... --self-test      # controls; no verdict about the data
 *   node tape-marks-grid.mjs ... --json out.json
 *
 *   node tape-marks-grid.mjs ... --boundary     # oldest point today's code can reproduce
 *
 * exit 0 = no holes and every audited point reproduced
 *      1 = holes found, or a published hash did not reproduce
 *      2 = could not determine (bad input, oracle unreachable)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const GRID_SEC = 900;
const HERMES = process.env.HERMES_URL || 'https://hermes.pyth.network';
const GITHUB = process.env.GITHUB_API || 'https://api.github.com';
const MAX_SKEW_SEC = 60;

/* ---- canonical bytes + hash: reimplemented, never imported --------------------------
 * If this file imported the serializer it is checking, a bug in the serializer would be
 * reproduced faithfully here and both programs would agree, confidently, on the wrong
 * hash. The duplication IS the instrument.
 */
function canon(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') throw new Error('canonical: raw number — quantities must be strings');
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/* ---- decimal arithmetic on strings (totals only; never floats on money) ------------ */
function P(s) {
  const str = String(s);
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error(`not a decimal string: ${str}`);
  const [i, f = ''] = str.replace('-', '').split('.');
  return { n: BigInt((str.startsWith('-') ? '-' : '') + i + f), s: f.length };
}
function F(n, s) {
  const neg = n < 0n; let d = (neg ? -n : n).toString().padStart(s + 1, '0');
  const out = s ? `${d.slice(0, -s)}.${d.slice(-s)}` : d;
  return (neg ? '-' : '') + out;
}
const AL = (a, b) => { const A = P(a), B = P(b), s = Math.max(A.s, B.s);
  return [A.n * 10n ** BigInt(s - A.s), B.n * 10n ** BigInt(s - B.s), s]; };
const add = (a, b) => { const [x, y, s] = AL(a, b); return F(x + y, s); };
const sub = (a, b) => { const [x, y, s] = AL(a, b); return F(x - y, s); };
const mul = (a, b) => { const A = P(a), B = P(b); return F(A.n * B.n, A.s + B.s); };
function div(a, b) {
  const A = P(a), B = P(b);
  if (B.n === 0n) throw new Error('divide by zero');
  const S = 18, num = A.n * 10n ** BigInt(S + B.s - A.s);
  return F(num / B.n, S);
}
const cmp = (a, b) => { const [x, y] = AL(a, b); return x < y ? -1 : x > y ? 1 : 0; };
const sum = (xs) => xs.reduce((a, x) => add(a, x), '0');

/* ---- the vocabulary, restated from the spec ---------------------------------------- */
const WSOL = 'So11111111111111111111111111111111111111112';
const BENCH = 'SOL/USD';
const FEEDS = {
  'SOL/USD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};
const symbolFor = (m) => (FEEDS[m] ? m : m === WSOL ? BENCH : null);
const pk = (sym, at) => `price:${sym}:${at}`;
const rk = (market) => `resolution:${market}`;

/* ---- normalizeMarks: the exact shape that gets hashed ------------------------------ */
function normalizeMarks(marks) {
  const out = {};
  for (const k of Object.keys(marks).sort()) {
    const v = marks[k];
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

/* ---- the horizon: what the chain looked like at a past instant ---------------------
 *
 * THIS IS THE WHOLE TRICK, so it is worth being loud about. Reconstructing a mark at a
 * past grid point with TODAY's positions is the single mistake that would make every
 * reconstruction wrong while looking completely reasonable: a call closed at 15:00 would
 * be treated as closed at 09:00 too, and its mark would be taken at the wrong leg.
 *
 * An anchor is a fact with a blockTime on Solana. At grid point `t`, anchors with
 * blockTime > t HAVE NOT HAPPENED. So coverage is recomputed against a filtered anchor
 * set, and everything downstream — is this entry anchored, is it closed, was it voided —
 * falls out of that one filter.
 */
function coverageForAt(seq, anchors, t) {
  let best = null;
  for (const a of anchors) {
    if (a.count > seq && a.blockTime <= t && (best === null || a.slot < best.slot)) best = a;
  }
  return best;
}

function derivePositionsAt(rows, anchors, gateRows, t) {
  const gate = new Map((gateRows || []).map((g) => [g.entry_hash, g]));
  const open = new Map();
  const voided = new Map();

  for (const row of rows) {
    const e = row.entry;
    const cover = coverageForAt(row.seq, anchors, t);
    if (e.p === 'tape-window') continue;      // window rows are not calls
    if (e.type === 'declare') continue;       // coverage commitments are not calls

    if (e.type === 'amend') {
      // An amendment that was not yet anchored at `t` had not voided anything at `t`.
      // Without this the reconstruction would retroactively delete a position that was
      // live at the time — the same class of error as using today's close times.
      if (cover) voided.set(e.ref, row.seq);
      continue;
    }
    if (e.type === 'open') {
      open.set(row.entry_hash, {
        entry_hash: row.entry_hash, seq: row.seq, caller: e.caller,
        signer: e.signer || null, identity: e.signer ? `key:${e.signer}` : `name:${e.caller}`,
        lane: e.lane, market: e.market, side: e.side, size: e.size, claimed_ref: e.entry_ref,
        openAt: cover ? cover.blockTime : null, anchored: !!cover, close: null,
      });
      continue;
    }
    const p = open.get(e.ref);
    if (!p || p.close) continue;
    if (!cover) continue;                     // an unanchored close does not close
    p.close = { seq: row.seq, at: cover.blockTime };
  }

  return [...open.values()].map((p) => {
    const g = gate.get(p.entry_hash);
    let status = 'open', reason = null;
    if (voided.has(p.entry_hash)) { status = 'voided'; reason = `amended by seq ${voided.get(p.entry_hash)}`; }
    else if (!p.anchored) { status = 'unanchored'; reason = 'no anchor covers this entry as of the grid point'; }
    else if (!g || g.verdict !== 'eligible') { status = 'ineligible'; reason = `gate: ${g ? g.verdict : 'no verdict'}`; }
    else if (p.close) status = 'closed';
    return { ...p, status, status_reason: reason };
  }).sort((a, b) => a.seq - b.seq);
}

/* ---- which marks does a point need? ------------------------------------------------ */
function markRequestsAt(positions, t, have = {}) {
  const reqs = new Map();
  const need = (key, spec) => { if (!reqs.has(key) && !have[key]) reqs.set(key, spec); };
  for (const p of positions) {
    if (p.status !== 'open' && p.status !== 'closed') continue;
    const openAt = p.openAt;
    const endAt = p.close ? p.close.at : t;
    need(pk(BENCH, openAt), { kind: 'price', symbol: BENCH, at: openAt });
    need(pk(BENCH, endAt), { kind: 'price', symbol: BENCH, at: endAt });
    if (p.lane === 'prediction') {
      need(rk(p.market), { kind: 'resolution', market: p.market });
      const r = have[rk(p.market)];
      if (r && r.supported && r.resolved && r.at) {
        const at = Math.floor(new Date(r.at).getTime() / 1000);
        need(pk(BENCH, at), { kind: 'price', symbol: BENCH, at });
      }
      continue;
    }
    const sym = symbolFor(p.market);
    if (!sym) continue;
    need(pk(sym, openAt), { kind: 'price', symbol: sym, at: openAt });
    need(pk(sym, endAt), { kind: 'price', symbol: sym, at: endAt });
  }
  return [...reqs.entries()].map(([key, spec]) => ({ key, ...spec })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

/* ---- the oracle ---------------------------------------------------------------------
 * A historical Pyth query is immutable: the same timestamp returns the same tick forever,
 * which is the property the whole refill claim rests on. So this memoizes freely — but a
 * FAILURE is never memoized, because an outage that becomes permanent would turn a
 * transient into a fabricated hole.
 */
const priceCache = new Map();
let hermesCalls = 0;

/**
 * A 429 is NOT an outage, and conflating the two is how this program would manufacture a
 * hole that does not exist. Being rate-limited means "ask again more slowly"; recording it
 * as a failed mark would print a reconstructed hash over an incomplete mark set and call
 * our own published point a mismatch. So throttled responses are retried with backoff and
 * only a persistent failure is allowed to become a result.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
const MIN_GAP_MS = Number(process.env.ORACLE_GAP_MS || 120);

async function fetchJson(url, { timeoutMs = 15000, tries = 5 } = {}) {
  let wait = 500;
  for (let attempt = 1; ; attempt++) {
    const gap = MIN_GAP_MS - (Date.now() - lastCall);
    if (gap > 0) await sleep(gap);
    lastCall = Date.now();

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'tape-marks-grid/1' } });
      if (r.status === 429 || r.status >= 500) {
        if (attempt >= tries) throw new Error(`HTTP ${r.status} after ${tries} attempts`);
        const ra = Number(r.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait);
        wait = Math.min(wait * 2, 8000);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt >= tries || !/abort|network|fetch failed|ECONN/i.test(String(e.message))) throw e;
      await sleep(wait); wait = Math.min(wait * 2, 8000);
    } finally { clearTimeout(timer); }
  }
}

async function priceAt(symbol, at) {
  const key = pk(symbol, at);
  if (priceCache.has(key)) return priceCache.get(key);
  const id = FEEDS[symbol];
  if (!id) return { ok: false, symbol, reason: `no feed registered for ${symbol}` };

  const url = `${HERMES}/v2/updates/price/${at}?ids[]=${id}`;
  let out;
  try {
    hermesCalls++;
    const j = await fetchJson(url);
    const p = j?.parsed?.[0];
    if (!p) throw new Error('no parsed price in response');
    const skew = Math.abs(p.price.publish_time - at);
    if (skew > MAX_SKEW_SEC) throw new Error(`stale mark, nearest print is ${skew}s away`);
    out = {
      ok: true, symbol, price: scaleToDecimal(p.price.price, p.price.expo),
      publish_time: p.price.publish_time, source: `pyth:${id}`, source_url: url,
    };
  } catch (e) {
    // Not cached: see the header comment. A transient must stay transient.
    return { ok: false, symbol, at, reason: `hermes: ${e.message}`, source_url: url };
  }
  priceCache.set(key, out);
  return out;
}

/**
 * Pyth ships an integer mantissa and an exponent; float maths here would round money.
 *
 * THE TRAILING ZEROS ARE LOAD-BEARING, AND THAT IS A HOLE THIS PROGRAM FOUND.
 *
 * The published canonical rules (agent.json `.signing.canonical`) pin the decimal string
 * with `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`. That regex forbids LEADING zeros and says nothing
 * at all about TRAILING ones — so "73.666235" and "73.66623500" are both legal spellings of
 * the same price, they canonicalize to different bytes, and the mark set therefore hashes
 * differently. Nothing published says which spelling to use, and the mantissa/exponent →
 * decimal conversion is not published anywhere at all.
 *
 * The consequence is not academic: the first version of this file padded, our publisher
 * strips, and the reconstruction reported DIFFERS against a board that was entirely honest.
 * An independent auditor implementing the published spec correctly would have filed that
 * as evidence of tampering. A spec that lets two honest parties disagree is exactly the
 * failure `.signing.canonical` opens by naming — "two honest parties must produce IDENTICAL
 * bytes ... or the record becomes he-said-she-said" — and it is unfixed in the text.
 *
 * So this matches the publisher's actual behaviour (strip trailing fractional zeros, strip
 * leading zeros) rather than the published text, and says loudly that it had to.
 */
function scaleToDecimal(mantissa, expo) {
  if (!/^-?\d+$/.test(String(mantissa))) throw new Error(`non-integer mantissa ${mantissa}`);
  const neg = String(mantissa).startsWith('-');
  let digits = String(mantissa).replace('-', '');
  if (expo >= 0) {
    digits += '0'.repeat(expo);
    return (neg ? '-' : '') + digits.replace(/^0+(?=\d)/, '');
  }
  const places = -expo;
  if (digits.length <= places) digits = '0'.repeat(places - digits.length + 1) + digits;
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return (neg ? '-' : '') + out.replace(/^0+(?=\d)/, '');
}

/* ---- resolutions at a past instant --------------------------------------------------
 * `github:` markets are re-fetched: a PR's merged_at is public and immutable, so
 * "was it merged as of t" is arithmetic on a number GitHub gives a stranger. Everything
 * else falls back to the settlement time recorded in the artifact, which is OURS — that
 * is a weaker link and the report names every mark that used it.
 */
const resolutionCache = new Map();

async function resolutionAt(market, t, artifactMark) {
  const cacheKey = market;
  let base = resolutionCache.get(cacheKey);

  if (base === undefined) {
    const gh = /^github:([^/]+)\/([^/]+)\/pull\/(\d+):merged_by:(.+)$/.exec(market);
    if (gh) {
      const [, owner, repo, num] = gh;
      try {
        const j = await fetchJson(`${GITHUB}/repos/${owner}/${repo}/pulls/${num}`);
        base = { independent: true, supported: true, merged_at: j.merged_at || null };
      } catch (e) {
        base = { independent: false, unreachable: `github: ${e.message}`, supported: false, merged_at: null };
      }
    } else {
      base = { independent: false, merged_at: artifactMark?.at || null,
        supported: artifactMark ? !!artifactMark.supported : false };
    }
    resolutionCache.set(cacheKey, base);
  }

  if (base.unreachable) {
    return { kind: 'resolution', supported: false, resolved: null, outcome: null, at: null,
      _source: 'unreachable', _detail: base.unreachable };
  }
  // Resolution is monotone: a market settles once and stays settled. So "resolved as of t"
  // is a comparison, not a re-judgement.
  const settledAt = base.merged_at;
  const resolved = !!(settledAt && Math.floor(new Date(settledAt).getTime() / 1000) <= t);
  return {
    kind: 'resolution', supported: !!base.supported, resolved,
    outcome: resolved ? 'yes' : null, at: resolved ? settledAt : null,
    _source: base.independent ? 'github' : 'artifact',
  };
}

/* ---- one grid point, reconstructed from scratch ------------------------------------ */
async function reconstruct(art, t) {
  const positions = derivePositionsAt(art.chain, art.anchors, art.gate, t);
  const marks = {};
  const notes = { artifact_derived_resolutions: [], failed: [], gate_used: false };

  // Loops for the same reason lib/marks.js does: a settled binary's benchmark leg only
  // becomes discoverable once its resolution is known.
  for (let round = 0; round < 4; round++) {
    const reqs = markRequestsAt(positions, t, marks);
    if (!reqs.length) break;
    for (const r of reqs) {
      if (r.kind === 'price') {
        const m = await priceAt(r.symbol, r.at);
        marks[r.key] = m;
        if (!m.ok) notes.failed.push(`${r.key}: ${m.reason}`);
      } else {
        const artMark = (art.marks || {})[rk(r.market)];
        const m = await resolutionAt(r.market, t, artMark);
        if (m._source === 'artifact') notes.artifact_derived_resolutions.push(r.market);
        if (m._source === 'unreachable') notes.failed.push(`${r.key}: ${m._detail}`);
        delete m._source; delete m._detail;
        marks[r.key] = m;
      }
    }
  }
  if (positions.some((p) => p.status === 'ineligible')) notes.gate_used = true;

  const scored = positions.map((p) => scoreOne(p, marks, t));
  const ok = scored.filter((s) => s.scoring === 'scored');
  const totals = {
    positions: scored.length, scored: ok.length,
    unscored: scored.filter((s) => s.scoring === 'unscored').length,
    pnl: sum(ok.map((s) => s.pnl)),
    benchmark_pnl: sum(ok.map((s) => s.benchmark_pnl)),
    edge: sum(ok.map((s) => s.edge)),
  };
  return {
    as_of: t,
    as_of_iso: new Date(t * 1000).toISOString(),
    markset_hash: sha(canon(normalizeMarks(marks))),
    marks,
    positions_by_status: positions.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {}),
    // NOT the same number as the series' `entries`, and the difference is not a bug in
    // either. The series records the chain LENGTH at publish time; this is the count that
    // was ANCHORED by the grid point. Rows are appended before they are anchored, so the
    // published figure is legitimately the larger of the two — and a stranger cannot
    // re-derive it, because nothing public records when a row was appended, only when it
    // was anchored. Named differently so the two are never quietly compared.
    entries_anchored: art.chain.filter((r) => coverageForAt(r.seq, art.anchors, t)).length,
    marks_needed: Object.keys(marks).length,
    totals, notes,
  };
}

function scoreOne(p, marks, asOf) {
  if (p.status !== 'open' && p.status !== 'closed') return { scoring: 'excluded' };
  const openAt = p.openAt;
  const endAt = p.close ? p.close.at : asOf;
  let pnl = null, realized = false, benchEnd = endAt;

  if (p.lane === 'prediction') {
    const r = marks[rk(p.market)];
    if (!r || !r.supported) return { scoring: 'unscored', reason: 'no resolver' };
    if (!r.resolved) return { scoring: 'unscored', reason: 'unresolved binary' };
    const odds = p.claimed_ref;
    if (cmp(odds, '0') <= 0 || cmp(odds, '1') >= 0) return { scoring: 'unscored', reason: 'odds outside (0,1)' };
    const cost = p.side === 'yes' ? odds : sub('1', odds);
    pnl = r.outcome === p.side ? sub(div(p.size, cost), p.size) : sub('0', p.size);
    realized = true;
    benchEnd = r.at ? Math.floor(new Date(r.at).getTime() / 1000) : endAt;
  } else if (p.side === 'long' || p.side === 'short') {
    const sym = symbolFor(p.market);
    if (!sym) return { scoring: 'unscored', reason: 'no feed' };
    const a = marks[pk(sym, openAt)], b = marks[pk(sym, endAt)];
    if (!a?.ok || !b?.ok) return { scoring: 'unscored', reason: 'missing price mark' };
    const move = sub(div(b.price, a.price), '1');
    pnl = mul(p.size, p.side === 'long' ? move : sub('0', move));
    realized = p.status === 'closed';
  } else {
    return { scoring: 'unscored', reason: `no scorer for ${p.lane}/${p.side}` };
  }

  const s0 = marks[pk(BENCH, openAt)], s1 = marks[pk(BENCH, benchEnd)];
  if (!s0?.ok || !s1?.ok) return { scoring: 'unscored', reason: 'missing benchmark mark' };
  const bench = mul(p.size, sub(div(s1.price, s0.price), '1'));
  return { scoring: 'scored', realized, pnl, benchmark_pnl: bench, edge: sub(pnl, bench) };
}

/* ---- the grid walk ----------------------------------------------------------------- */
function walk(series, grid = GRID_SEC) {
  const times = series.map((r) => r.as_of).filter(Number.isInteger).sort((a, b) => a - b);
  if (times.length < 2) return { times, missing: [], expected: times.length };
  const have = new Set(times);
  const missing = [];
  for (let t = times[0]; t <= times[times.length - 1]; t += grid) if (!have.has(t)) missing.push(t);
  return { times, missing, expected: (times[times.length - 1] - times[0]) / grid + 1 };
}

/* ---- the definition boundary --------------------------------------------------------
 *
 * A markset_hash commits to a mark set, but NOT to the algorithm that decided which marks
 * belong in it. Change the scorer — add a resolver, change a gate rule — and every hash
 * published before the change becomes unreproducible by the code that comes after, while
 * the series still reads as one continuous run of honest-looking hex.
 *
 * That is not hypothetical here: this scan is what found it. Someone auditing our series
 * with a current checker gets a wall of DIFFERS across old points and has no way to tell
 * "they changed the scorer" from "they doctored the record". A verifier that cannot make
 * that distinction hands out the most serious accusation it has, for free.
 *
 * Binary search, on the ASSUMPTION that reproducibility flips at most once — true for a
 * deploy, false if the definition churned repeatedly. The assumption is checked rather
 * than trusted: the run samples both sides and reports if it finds a violation, in which
 * case the boundary is reported as approximate and the samples are printed.
 */
async function findBoundary(art, series, sample = 4) {
  const ok = async (i) => {
    const r = await reconstruct(art, series[i].as_of);
    return r.markset_hash === series[i].markset_hash;
  };
  // Anchor the "reproducing" end on a point that actually reproduces rather than assuming
  // the newest does. A single point can legitimately fail while its neighbours pass: if
  // the primary oracle was rate-limited at publish time the publisher falls back to a
  // venue candle, and a Pyth-only checker like this one cannot reproduce that mark by
  // construction. Taking the newest on faith turned exactly that case into "the entire
  // series is broken", which is a much louder claim than the evidence supported.
  const PROBE = Math.min(6, series.length);
  let hi = -1, degradedTail = 0;
  for (let k = 1; k <= PROBE; k++) {
    const i = series.length - k;
    if (await ok(i)) { hi = i; break; }
    degradedTail++;
  }
  if (hi < 0) {
    return { boundary: null, note: `none of the newest ${PROBE} points reproduce — this is not a definition boundary, it is a broken reconstruction, a broken series, or a sustained oracle fallback` };
  }
  const oldest = await ok(0);
  if (oldest) return { boundary: null, note: 'every point reproduces; no definition change detected', degradedTail };

  let lo = 0;                                  // ok(lo)=false, ok(hi)=true
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await ok(mid)) hi = mid; else lo = mid;
  }

  // Check the single-flip assumption instead of asserting it.
  const violations = [];
  for (let k = 1; k <= sample; k++) {
    const before = Math.floor((lo * k) / (sample + 1));
    const after = hi + Math.floor(((series.length - 1 - hi) * k) / (sample + 1));
    if (before < lo && await ok(before)) violations.push(series[before].as_of_iso + ' (reproduces, but is older than the boundary)');
    if (after > hi && !(await ok(after))) violations.push(series[after].as_of_iso + ' (fails, but is newer than the boundary)');
  }
  return {
    boundary: series[hi],
    last_failing: series[lo],
    reproducing: series.length - hi,
    not_reproducing: hi,
    single_flip: violations.length === 0,
    violations,
  };
}

/* ---- controls -----------------------------------------------------------------------
 * A zero holes result is only worth reading if this program CAN report a hole, and a
 * "every hash reproduced" is only worth reading if it CAN report a mismatch. Both are
 * exercised here against synthetic inputs, because a check that has never fired is
 * indistinguishable from a check that cannot.
 */
async function selfTest(art, series) {
  const out = [];
  const pass = (n, ok, d) => { out.push({ name: n, ok, detail: d }); return ok; };
  let allOk = true;

  // 1. POSITIVE CONTROL: delete a published point and prove the walker finds exactly it.
  //    The victim is taken from the RECENT end on purpose. Points published before the
  //    definition boundary (see --boundary) cannot be reproduced by today's algorithm at
  //    all, so using an old one here would test the oracle against a hash computed by
  //    different code and fail for a reason that has nothing to do with this control.
  const victim = series[series.length - 2];
  const punched = series.filter((r) => r.as_of !== victim.as_of);
  const w = walk(punched);
  allOk &= pass('hole detection', w.missing.length === 1 && w.missing[0] === victim.as_of,
    `removed ${victim.as_of_iso}; walker reported [${w.missing.join(',')}]`);

  // 2. POSITIVE CONTROL: the refill reproduces the hash that was actually published for it.
  //    This is the strongest single statement the program can make — a point treated as a
  //    hole, refilled with nothing but public inputs, lands on our shipped hash.
  const refill = await reconstruct(art, victim.as_of);
  allOk &= pass('refill reproduces the published hash', refill.markset_hash === victim.markset_hash,
    `refilled ${refill.markset_hash.slice(0, 16)}… vs published ${victim.markset_hash.slice(0, 16)}…`);

  // 3. NEGATIVE CONTROL: a tampered published hash must come back DIFFERS. Without this,
  //    "matches" could just mean the comparison never runs.
  const tampered = victim.markset_hash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  allOk &= pass('tampered hash is rejected', refill.markset_hash !== tampered,
    'one-character edit of the published hash is not accepted as a match');

  // 4. NEGATIVE CONTROL: the horizon actually bites. Reconstructing the first point with
  //    today's anchors (no horizon) must differ from reconstructing it correctly —
  //    otherwise the horizon filter is dead code and every past point is silently marked
  //    with today's position set.
  const first = series[0].as_of;
  const withHorizon = derivePositionsAt(art.chain, art.anchors, art.gate, first);
  const noHorizon = derivePositionsAt(art.chain, art.anchors, art.gate, 2 ** 31 - 1);
  allOk &= pass('horizon filter is live',
    JSON.stringify(withHorizon) !== JSON.stringify(noHorizon),
    `${withHorizon.length} positions at ${series[0].as_of_iso} vs ${noHorizon.length} today`);

  // 5. REGRESSION CONTROL for the trailing-zero hole (see scaleToDecimal). This is the bug
  //    that made an honest board read as DIFFERS, and it is invisible in a hash — the only
  //    way it stays fixed is if something asserts the spelling directly.
  allOk &= pass('decimal spelling matches the publisher',
    scaleToDecimal('7366623500', -8) === '73.666235' && scaleToDecimal('7398119540', -8) === '73.9811954'
      && scaleToDecimal('100', -2) === '1' && scaleToDecimal('-7366623500', -8) === '-73.666235',
    'trailing fractional zeros stripped; published regex does not pin this, our publisher does');

  // 6. POSITIVE CONTROL: the oracle is answering at past timestamps at all. A hole refill
  //    that silently got zero prices would print a clean hash over an empty mark set.
  const probe = await priceAt(BENCH, first);
  allOk &= pass('oracle answers at a past timestamp', probe.ok === true,
    probe.ok ? `${BENCH} at ${first} = ${probe.price}` : probe.reason);

  return { ok: !!allOk, checks: out };
}

/* ---- main --------------------------------------------------------------------------- */
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : (args[i + 1] ?? true); };
const has = (n) => args.includes(n);
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--audit', '--json'].includes(args[i - 1])));

if (files.length < 2) {
  console.error('usage: node tape-marks-grid.mjs <board.json> <marks-history.json> [--audit N|all] [--self-test] [--json out.json]');
  process.exit(2);
}

let art, hist;
try { art = JSON.parse(readFileSync(files[0], 'utf8')); }
catch (e) { console.error(`UNUSABLE: cannot read board: ${e.message}`); process.exit(2); }
try { hist = JSON.parse(readFileSync(files[1], 'utf8')); }
catch (e) { console.error(`UNUSABLE: cannot read marks history: ${e.message}`); process.exit(2); }

for (const k of ['chain', 'anchors', 'marks']) {
  if (!(k in art)) { console.error(`UNUSABLE: board has no "${k}"`); process.exit(2); }
}
const series = Array.isArray(hist) ? hist : hist.series;
if (!Array.isArray(series) || series.length < 2) { console.error('UNUSABLE: marks history has no series'); process.exit(2); }

const grid = Number(hist.grid_sec || GRID_SEC);

/* An auditor who disagrees with a refilled hash needs the mark set, not the digest of it.
 * Emits JSON and nothing else, so it can be piped. */
if (has('--dump')) {
  const t = Number(flag('--dump'));
  const r = await reconstruct(art, t);
  const published = series.find((s) => s.as_of === t);
  console.log(JSON.stringify({
    as_of: r.as_of, as_of_iso: r.as_of_iso,
    reconstructed_hash: r.markset_hash,
    published_hash: published ? published.markset_hash : null,
    match: published ? r.markset_hash === published.markset_hash : null,
    positions_by_status: r.positions_by_status,
    notes: r.notes,
    normalized_marks: normalizeMarks(r.marks),
  }, null, 2));
  process.exit(0);
}

console.log('TAPE mark-grid reconstruction');
console.log(`  board      ${files[0]}  (${art.chain.length} chain rows, ${art.anchors.length} anchors)`);
console.log(`  series     ${files[1]}  (${series.length} published points, grid ${grid}s)`);
console.log(`  oracle     ${HERMES}`);
console.log('');

const report = { grid_sec: grid, generated_for: series.length, holes: [], audited: [], self_test: null };

if (has('--self-test')) {
  const st = await selfTest(art, series);
  console.log('CONTROLS');
  for (const c of st.checks) console.log(`  ${c.ok ? 'pass' : 'FAIL'}  ${c.name} — ${c.detail}`);
  console.log('');
  report.self_test = st;
  if (!st.ok) { console.error('CONTROLS FAILED — this run cannot be trusted to report a hole or a mismatch.'); process.exit(2); }
}

const w = walk(series, grid);
const coverage = (series.length / w.expected * 100).toFixed(2);
console.log(`GRID  ${new Date(w.times[0] * 1000).toISOString()} → ${new Date(w.times[w.times.length - 1] * 1000).toISOString()}`);
console.log(`      ${series.length} published of ${w.expected} grid points (${coverage}%), ${w.missing.length} hole(s)`);
console.log('');

/* Holes: refilled, not estimated. */
if (w.missing.length) {
  console.log(`REFILLING ${w.missing.length} HOLE(S) FROM THE ORACLE`);
  for (const t of w.missing) {
    const r = await reconstruct(art, t);
    report.holes.push(r);
    console.log(`  ${r.as_of_iso}  markset ${r.markset_hash.slice(0, 24)}…`);
    console.log(`      would have shown: ${r.totals.scored}/${r.totals.positions} scored, pnl ${r.totals.pnl}, edge ${r.totals.edge}`);
    if (r.notes.failed.length) console.log(`      INCOMPLETE: ${r.notes.failed.join(' | ')}`);
  }
  console.log('');
} else {
  console.log('No holes: every grid point between the first and last mark was published.');
  console.log('(Run with --self-test to confirm this program can report a hole at all.)');
  console.log('');
}

/* Where does today's algorithm stop being able to reproduce our own history? */
if (has('--boundary')) {
  const b = await findBoundary(art, series);
  console.log('DEFINITION BOUNDARY');
  if (!b.boundary) {
    console.log(`  ${b.note}`);
  } else {
    console.log(`  oldest point today's algorithm reproduces: ${b.boundary.as_of_iso}`);
    console.log(`  newest point it does NOT reproduce:        ${b.last_failing.as_of_iso}`);
    console.log(`  ${b.reproducing} reproducing, ${b.not_reproducing} not`);
    console.log(`  single clean flip: ${b.single_flip ? 'yes — consistent with one scorer change, not with tampering' : 'NO — definition churned more than once'}`);
    for (const v of b.violations) console.log(`    violation: ${v}`);
    console.log('  A hash published before this point was computed by different code. That is a');
    console.log('  gap in the record, not proof of either honesty or tampering: nothing published');
    console.log('  pins the scorer version a hash was produced under.');
  }
  console.log('');
  report.boundary = b;
}

/* Published points: the half that can come back DIFFERS. */
const auditArg = flag('--audit', '0');
let targets = [];
if (auditArg === 'all') targets = series.slice();
else if (Number(auditArg) > 0) {
  const n = Math.min(Number(auditArg), series.length);
  const step = (series.length - 1) / Math.max(1, n - 1);
  targets = Array.from({ length: n }, (_, i) => series[Math.round(i * step)]);
}

let mismatches = 0, incomplete = 0;
if (targets.length) {
  console.log(`AUDITING ${targets.length} PUBLISHED POINT(S) — recomputed from public inputs only`);
  for (const row of targets) {
    const r = await reconstruct(art, row.as_of);
    const match = r.markset_hash === row.markset_hash;
    if (!match) mismatches++;
    if (r.notes.failed.length) incomplete++;
    report.audited.push({ ...r, published_hash: row.markset_hash, match });
    console.log(`  ${match ? 'MATCH  ' : 'DIFFERS'}  ${r.as_of_iso}  ${r.markset_hash.slice(0, 16)}… vs ${row.markset_hash.slice(0, 16)}…`);
    if (r.notes.failed.length) console.log(`            incomplete: ${r.notes.failed.join(' | ')}`);
    if (r.notes.artifact_derived_resolutions.length) {
      console.log(`            resolutions taken from the artifact (not independently re-fetched): ${[...new Set(r.notes.artifact_derived_resolutions)].join(', ')}`);
    }
  }
  console.log('');
}

console.log(`oracle calls: ${hermesCalls}`);
if (has('--json')) { writeFileSync(String(flag('--json')), JSON.stringify(report, null, 2)); console.log(`report written to ${flag('--json')}`); }

if (w.missing.length === 0 && mismatches === 0) {
  console.log('RESULT: no holes' + (targets.length ? `, ${targets.length} published point(s) reproduced from public inputs` : '') + '.');
  process.exit(0);
}
console.log(`RESULT: ${w.missing.length} hole(s), ${mismatches} published point(s) that did not reproduce.`);
process.exit(1);
