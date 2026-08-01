#!/usr/bin/env node
// tape-recompute.mjs — recompute a TAPE leaderboard and check ours against it.
//
//   node tape-recompute.mjs board.json
//
// WHY THIS FILE EXISTS AND WHY IT IS DELIBERATELY DUPLICATED CODE:
//
// A leaderboard that only its author can compute is not a record, it is an opinion with
// good production values. The claim TAPE makes is that anyone can re-derive the ranking
// and catch us if it disagrees. That claim is worth exactly nothing if the checker
// imports the thing it is checking — a bug in the scorer would be reproduced faithfully
// by its own verifier and both would agree, confidently, on the wrong number.
//
// So this shares NO code with ../lib. It reimplements the decimal arithmetic, both PnL
// formulas, the benchmark and the ranking from the spec, runs from an empty directory
// with no install, and must be able to return MISMATCH about us. That last property is
// the only one that makes the other three mean anything.
//
// WHAT IT PROVES: that the published board follows from the published chain, anchors and
// marks — including which positions were eligible to be ranked at all. Position status is
// RE-DERIVED here, not read from the artifact. The first version of this file trusted the
// artifact's own `status` field, and a control caught the consequence: a voided entry
// relabelled as a closed winner passed every arithmetic check, because the arithmetic was
// never the lie. The hash chain is recomputed too, so a row cannot be edited or inserted.
//
// WHAT IT DOES NOT PROVE: (a) that the marks are honest — re-fetch them from Pyth and
// GitHub at the timestamps printed below; (b) that the anchors are really on Solana —
// that is tape-verify.mjs's job, and it is a separate program on purpose. Both limits are
// stated because an unstated scope limit is how a verifier gets quoted as proving more
// than it looked at.
//
// Exit: 0 MATCH · 1 MISMATCH · 2 unusable input.

import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

// ---- base58 + ed25519, reimplemented (node ships the curve; the DER wrapper is a const)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of str) { if (ch !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
function sigOk(msg, sigB58, pubB58) {
  try {
    const sig = b58decode(sigB58), pub = b58decode(pubB58);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return edVerify(null, msg, createPublicKey({ key: Buffer.concat([SPKI, pub]), format: 'der', type: 'spki' }), sig);
  } catch { return false; }
}
const SIG_DOMAIN = 'tape:v1:entry:';
const WINDOW_SIG_DOMAIN = 'tape:v1:window:';

// ---- exact decimals, reimplemented ------------------------------------------------
const RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const SCALE = 18;
function P(s, what = 'value') {
  if (typeof s !== 'string' || !RE.test(s)) throw new Error(`${what}: not a decimal string: ${JSON.stringify(s)}`);
  const neg = s[0] === '-';
  const [w, f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(w + f);
  return { n: neg ? -n : n, s: f.length };
}
function F(n, s) {
  const neg = n < 0n;
  let d = (neg ? -n : n).toString();
  if (s > 0) {
    if (d.length <= s) d = '0'.repeat(s - d.length + 1) + d;
    const frac = d.slice(d.length - s).replace(/0+$/, '');
    d = frac ? `${d.slice(0, d.length - s)}.${frac}` : d.slice(0, d.length - s);
  }
  d = d.replace(/^0+(?=\d)/, '');
  return neg && !/^0(\.0*)?$/.test(d) ? `-${d}` : d;
}
const AL = (a, b) => { const A = P(a), B = P(b), s = Math.max(A.s, B.s);
  return [A.n * 10n ** BigInt(s - A.s), B.n * 10n ** BigInt(s - B.s), s]; };
const add = (a, b) => { const [x, y, s] = AL(a, b); return F(x + y, s); };
const sub = (a, b) => { const [x, y, s] = AL(a, b); return F(x - y, s); };
const mul = (a, b) => { const A = P(a), B = P(b); return F(A.n * B.n, A.s + B.s); };
function div(a, b) {
  const A = P(a), B = P(b);
  if (B.n === 0n) throw new Error('division by zero');
  const sh = SCALE + B.s - A.s;
  let num = A.n, den = B.n;
  if (sh >= 0) num *= 10n ** BigInt(sh); else den *= 10n ** BigInt(-sh);
  const neg = (num < 0n) !== (den < 0n);
  const an = num < 0n ? -num : num, ad = den < 0n ? -den : den;
  let q = an / ad;
  if ((an % ad) * 2n >= ad) q += 1n;               // half away from zero, as declared
  return F(neg ? -q : q, SCALE);
}
const cmp = (a, b) => { const [x, y] = AL(a, b); return x < y ? -1 : x > y ? 1 : 0; };
const sum = (xs) => xs.reduce((a, x) => add(a, x), '0');

// ---- canonical JSON, reimplemented -------------------------------------------------
function canon(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') throw new Error('canonical: raw number');
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

const WSOL = 'So11111111111111111111111111111111111111112';
const BENCH = 'SOL/USD';
const FEEDS = new Set(['SOL/USD', 'BTC/USD', 'ETH/USD']);
const symbolFor = (m) => (FEEDS.has(m) ? m : m === WSOL ? BENCH : null);
const pk = (sym, at) => `price:${sym}:${at}`;
const rk = (market) => `resolution:${market}`;

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

// ---- the chain and the positions, re-derived ---------------------------------------
const GENESIS = '0'.repeat(64);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const entryHash = (e) => sha(canon(e));
const linkHash = (prev, seq, eh) => sha(canon({ prev, seq: String(seq), entry: eh }));

/**
 * Recompute the hash chain. An edited or inserted row breaks a link and is named.
 *
 * Signatures are checked here too, and the three states are kept apart: unsigned (a
 * supported T0 call), signed-and-valid, and signed-but-broken. Collapsing the third into
 * the first is the downgrade attack — strip a signature and a forged attribution becomes
 * an anonymous call that still displays someone's name.
 */
function checkChain(rows) {
  const errs = [];
  let prev = GENESIS;
  let signed = 0;
  let sigErrs = 0;
  rows.forEach((r, i) => {
    if (r.seq !== i) errs.push(`seq ${i}: stored seq is ${r.seq}`);
    if (r.prev !== prev) errs.push(`seq ${i}: prev does not match the previous link`);
    let eh;
    try { eh = entryHash(r.entry); } catch { errs.push(`seq ${i}: entry does not canonicalize`); prev = r.link; return; }
    if (eh !== r.entry_hash) errs.push(`seq ${i}: entry_hash does not match the entry content`);
    if (linkHash(r.prev, r.seq, r.entry_hash) !== r.link) errs.push(`seq ${i}: link hash does not match`);
    const e = r.entry;
    if (e.signer || e.sig) {
      signed++;
      // Two row families, two signature domains, and the domain is chosen by the row's
      // own `p` marker rather than by trying both. Checking a window row under the call
      // domain fails every honest board-minted row — which is what this program did on
      // its first run against a chain containing them, and it reported the operator as a
      // forger. A verifier that is wrong in the ACCUSING direction is as broken as one
      // wrong in the forgiving direction; it just fails in a way that looks diligent.
      const domain = e.p === 'tape-window' ? WINDOW_SIG_DOMAIN : SIG_DOMAIN;
      if (!e.signer || !e.sig) { sigErrs++; errs.push(`seq ${i}: signer and sig must both be present`); }
      else if (!sigOk(Buffer.from(domain + canon({ ...e, sig: null }), 'utf8'), e.sig, e.signer)) {
        sigErrs++;
        errs.push(`seq ${i}: signature does not verify for ${e.signer.slice(0, 8)}…`);
      }
    }
    prev = r.link;
  });
  // A duplicate entry hash is a replay: the same signed call re-posted by someone else.
  const seen = new Set();
  rows.forEach((r, i) => {
    if (seen.has(r.entry_hash)) errs.push(`seq ${i}: duplicate of an earlier entry (replay)`);
    seen.add(r.entry_hash);
  });
  return { errs, signed, sigErrs };
}

/**
 * Rebuild each anchor's Merkle root from the chain and check it.
 *
 * Found by a negative control that this file MISSED on its first pass: inflating an
 * anchor's `count` made unanchored entries look anchored, and nothing noticed, because
 * the count was taken on faith. It is not a free parameter — the root commits to exactly
 * that many leaves, so recomputing the tree over rows [0, count) either reproduces the
 * published root or proves the count was invented.
 *
 * Domain separation (0x00 leaves, 0x01 nodes) and PROMOTING an odd tail instead of
 * duplicating it both matter here: get either wrong and two different entry sets collapse
 * to one root, which is the CVE-2012-2459 shape.
 */
const bsha = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest();
const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);
function merkleRoot(entries) {
  if (!entries.length) return bsha(Buffer.from('tape:empty:v1', 'utf8')).toString('hex');
  let cur = entries.map((e) => bsha(LEAF, Buffer.from(canon(e), 'utf8')));
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? bsha(NODE, cur[i], cur[i + 1]) : cur[i]);
    cur = next;
  }
  return cur[0].toString('hex');
}
function checkAnchors(rows, anchors) {
  const errs = [];
  for (const a of anchors) {
    if (a.count > rows.length) { errs.push(`anchor slot ${a.slot} claims ${a.count} entries but the chain has ${rows.length}`); continue; }
    const root = merkleRoot(rows.slice(0, a.count).map((r) => r.entry));
    if (root !== a.root) {
      errs.push(`anchor slot ${a.slot}: root over its first ${a.count} entries recomputes to ${root.slice(0, 16)}…, published ${String(a.root).slice(0, 16)}…`);
    }
  }
  return errs;
}

/** Earliest anchor whose Merkle tree covers this seq. Later ones would misdate it. */
function coverageFor(seq, anchors) {
  let best = null;
  for (const a of anchors) if (a.count > seq && (best === null || a.slot < best.slot)) best = a;
  return best;
}

/**
 * Walk the chain into positions, independently. This is the half that the arithmetic
 * checks cannot substitute for: whether an entry was voided, unanchored or gated is a
 * fact about the CHAIN, and taking it from the artifact would let the scorekeeper choose
 * who is eligible after seeing the outcomes.
 */
function derivePositions(rows, anchors, gateRows) {
  const gate = new Map((gateRows || []).map((g) => [g.entry_hash, g]));
  const open = new Map();
  const voided = new Map();
  for (const row of rows) {
    const e = row.entry;
    const cover = coverageFor(row.seq, anchors);
    // Board-minted window rows share the chain but are not positions. This program
    // survived them by accident — `open.get(undefined)` misses and the row falls through
    // the close branch — and surviving by accident is how a row family ends up silently
    // reinterpreted the day one of them happens to carry a `ref`. Skip them on purpose.
    if (e.p === 'tape-window') continue;
    // Declarations are coverage commitments, not positions. Skipped here for the same
    // reason lib/score.js skips them: this program exists to disagree with the publisher
    // about arithmetic, not about vocabulary, and a row family only one of us recognises
    // would produce a MISMATCH that means nothing.
    if (e.type === 'declare') continue;
    if (e.type === 'amend') { voided.set(e.ref, row.seq); continue; }
    if (e.type === 'open') {
      open.set(row.entry_hash, { entry_hash: row.entry_hash, seq: row.seq, caller: e.caller,
        // Identity, re-derived: a signed call is keyed on its KEY, an unsigned one on the
        // name anyone could type. They are never the same identity even when the name is.
        signer: e.signer || null, identity: e.signer ? `key:${e.signer}` : `name:${e.caller}`,
        lane: e.lane, market: e.market, side: e.side, size: e.size, claimed_ref: e.entry_ref,
        openAt: cover ? cover.blockTime : null, anchored: !!cover, close: null });
      continue;
    }
    const p = open.get(e.ref);
    if (!p || p.close) continue;              // orphan / double close: not a position edge
    if (!cover) continue;                     // an unanchored close does not close
    p.close = { seq: row.seq, at: cover.blockTime };
  }
  return [...open.values()].map((p) => {
    const g = gate.get(p.entry_hash);
    let status = 'open', reason = null;
    if (voided.has(p.entry_hash)) { status = 'voided'; reason = `amended by seq ${voided.get(p.entry_hash)}`; }
    else if (!p.anchored) { status = 'unanchored'; reason = 'no anchor covers this entry'; }
    else if (!g || g.verdict !== 'eligible') { status = 'ineligible'; reason = `gate: ${g ? g.verdict : 'no verdict'}`; }
    else if (p.close) status = 'closed';
    return { ...p, status, status_reason: reason };
  }).sort((a, b) => a.seq - b.seq);
}

// ---- scoring, reimplemented from the spec ------------------------------------------
function scoreOne(p, marks, asOf) {
  if (p.status !== 'open' && p.status !== 'closed') return { scoring: 'excluded', caller: p.caller, identity: p.identity };
  const openAt = p.openAt;
  const endAt = p.close ? p.close.at : asOf;

  let pnl = null, realized = false, benchEnd = endAt;

  if (p.lane === 'prediction') {
    const r = marks[rk(p.market)];
    if (!r || !r.supported) return { scoring: 'unscored', reason: 'no resolver' };
    if (!r.resolved) return { scoring: 'unscored', reason: 'unresolved binary, no odds feed' };
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

function board(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.identity)) by.set(r.identity, []);
    by.get(r.identity).push(r);
  }
  const out = [...by.entries()].map(([identity, rs]) => {
    const ok = rs.filter((r) => r.scoring === 'scored');
    const realized = sum(ok.filter((r) => r.realized).map((r) => r.pnl));
    const unrealized = sum(ok.filter((r) => !r.realized).map((r) => r.pnl));
    const pnl = add(realized, unrealized);
    const bench = sum(ok.map((r) => r.benchmark_pnl));
    return { identity, caller: rs[0].caller, realized, unrealized, pnl, benchmark_pnl: bench, edge: sub(pnl, bench),
      beat_hodl: cmp(sub(pnl, bench), '0') > 0,
      unscored: rs.filter((r) => r.scoring === 'unscored').length };
  });
  out.sort((a, b) => cmp(b.edge, a.edge) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  return out;
}

// ---- main ---------------------------------------------------------------------------
const file = process.argv[2];
if (!file) { console.error('usage: node tape-recompute.mjs <board.json>'); process.exit(2); }
let art;
try { art = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { console.error(`UNUSABLE: cannot read artifact: ${e.message}`); process.exit(2); }
for (const k of ['marks', 'positions', 'board', 'as_of', 'markset_hash', 'chain', 'anchors']) {
  if (!(k in art)) { console.error(`UNUSABLE: artifact has no "${k}"`); process.exit(2); }
}

const problems = [];

// 0. The mark time must be DERIVED, not chosen.
//
//    This check is the reason the file needed a second pass. Everything below re-derives
//    the arithmetic from `art.as_of` — and then trusted `art.as_of` itself, which is the
//    one input the operator picks freely. An open position marks at `as_of`, so choosing
//    when to publish chooses the PnL. Measured on real Pyth data: 0.90% of free swing on
//    SOL/USD across a six-hour window of publish times, more on a leveraged lane.
//
//    A cherry-picked mark passed every check in this file, cleanly, because the lie was
//    never in the arithmetic — the same mistake this file's header records having already
//    made once with position status. Grid alignment is what makes it mechanical: the mark
//    time must be the floor of some wall clock to GRID_SEC, so it is enumerable rather
//    than asserted.
//
//    Scope limit, stated: this proves the mark was not taken at a hand-picked INSTANT. It
//    does not prove we published at every grid point — see mark_series/missing for that,
//    which is reported, not enforced, because a gap has innocent causes too.
const GRID_SEC = Number.isInteger(art.grid_sec) ? art.grid_sec : 900;
if (!Number.isInteger(art.as_of)) {
  problems.push(`as_of is not an integer: ${art.as_of}`);
} else if (art.as_of % GRID_SEC !== 0) {
  problems.push(
    `as_of ${art.as_of} is off the ${GRID_SEC}s mark grid by ${art.as_of % GRID_SEC}s — `
    + 'mark times must be derived by flooring the clock, not chosen');
} else if (art.as_of > Math.floor(Date.now() / 1000) + GRID_SEC) {
  // On-grid but ahead of the checker's clock. Grid alignment alone does not catch this:
  // a mark a day forward is perfectly divisible. An artifact is always checked at or
  // after publication, so future is the only direction that cannot be innocent — one
  // grid of tolerance absorbs skew between our clock and the reader's.
  problems.push(
    `as_of ${art.as_of} is ahead of the clock on this machine — a book cannot be marked `
    + 'at a price that has not happened yet');
}

// 1. The mark set must hash to what was published, or every number below is about
//    different inputs than the ones we claimed to use.
const recomputedHash = createHash('sha256').update(canon(normalizeMarks(art.marks)), 'utf8').digest('hex');
if (recomputedHash !== art.markset_hash) {
  problems.push(`markset hash: published ${art.markset_hash.slice(0, 16)}… but the marks in this file hash to ${recomputedHash.slice(0, 16)}…`);
}

// 2. The chain must be internally consistent before anything derived from it is believed.
const { errs: chainErrs, signed: signedCount, sigErrs } = checkChain(art.chain);
chainErrs.forEach((e) => problems.push(`chain: ${e}`));
const anchorErrs = checkAnchors(art.chain, art.anchors);
anchorErrs.forEach((e) => problems.push(`anchor: ${e}`));

// 3. Positions, re-derived from the chain rather than read from the artifact.
const derived = derivePositions(art.chain, art.anchors, art.gate);
const published = new Map(art.positions.map((p) => [p.entry_hash, p]));
if (derived.length !== art.positions.length) {
  problems.push(`position count: published ${art.positions.length}, re-derived ${derived.length}`);
}

const mine = [];
for (const p of derived) {
  const pub = published.get(p.entry_hash);
  if (!pub) { problems.push(`seq ${p.seq}: re-derived a position the artifact does not list`); continue; }
  if (pub.status !== p.status) {
    problems.push(`seq ${p.seq} status: published "${pub.status}", re-derived "${p.status}" (${p.status_reason})`);
  }
  const r = scoreOne(p, art.marks, art.as_of);
  mine.push({ ...r, caller: p.caller, identity: p.identity });
  if (r.scoring !== pub.scoring) {
    problems.push(`seq ${p.seq}: published "${pub.scoring}", recomputed "${r.scoring}"${r.reason ? ` (${r.reason})` : ''}`);
    continue;
  }
  if (r.scoring !== 'scored') continue;
  for (const f of ['pnl', 'benchmark_pnl', 'edge']) {
    if (cmp(r[f], pub[f]) !== 0) problems.push(`seq ${p.seq} ${f}: published ${pub[f]}, recomputed ${r[f]}`);
  }
  if (r.realized !== pub.realized) problems.push(`seq ${p.seq} realized: published ${pub.realized}, recomputed ${r.realized}`);
}

// 3. The ranking itself.
const myBoard = board(mine);
if (myBoard.length !== art.board.length) {
  problems.push(`board size: published ${art.board.length}, recomputed ${myBoard.length}`);
} else {
  myBoard.forEach((b, i) => {
    const t = art.board[i];
    if (b.identity !== t.identity) problems.push(`rank ${i + 1}: published ${t.identity}, recomputed ${b.identity}`);
    else for (const f of ['pnl', 'realized', 'unrealized', 'benchmark_pnl', 'edge']) {
      if (cmp(b[f], t[f]) !== 0) problems.push(`${b.caller} ${f}: published ${t[f]}, recomputed ${b[f]}`);
    }
    if (b.identity === t.identity && b.beat_hodl !== t.beat_hodl) {
      problems.push(`${b.caller} beat_hodl: published ${t.beat_hodl}, recomputed ${b.beat_hodl}`);
    }
  });
}

const scored = mine.filter((m) => m.scoring === 'scored').length;
console.log(`\n  as of      ${art.as_of_iso || art.as_of}`);
console.log(`  markset    ${recomputedHash.slice(0, 24)}…  ${recomputedHash === art.markset_hash ? '(matches published)' : 'DIFFERS FROM PUBLISHED'}`);
console.log(`  chain      ${art.chain.length} entries — ${chainErrs.length ? `${chainErrs.length} PROBLEMS` : 'links recomputed, intact'}`);
// Count signature failures explicitly. The first version regexed the error strings for
// the word "signature", so a blanked signature — whose error reads "signer and sig must
// both be present" — printed "all verified independently" while the record was broken.
console.log(`  signatures ${signedCount} signed of ${art.chain.length} — ${
  signedCount === 0 ? 'none (all T0, self-reported)'
  : sigErrs ? `${sigErrs} INVALID` : 'all verified independently'}`);
console.log(`  anchors    ${art.anchors.length} — ${anchorErrs.length ? `${anchorErrs.length} ROOT MISMATCH` : 'every Merkle root rebuilt from the chain and matched'}`);
console.log(`  positions  ${derived.length} re-derived from the chain (${scored} scored independently)`);
console.log(`  callers    ${myBoard.length}`);
if (myBoard.length) {
  console.log('');
  // Render the identity, never the bare typed name. Two rows both printing "cadence-wave"
  // is precisely the confusion the naming rule exists to prevent, and a checker that
  // reproduces that confusion cannot be used to spot it.
  myBoard.forEach((b, i) => {
    const signed = b.identity.startsWith('key:');
    const who = signed ? `${b.caller} [signed ${b.identity.slice(4, 8)}…${b.identity.slice(-4)}]` : `${b.caller} [unsigned]`;
    console.log(`    ${i + 1}. ${who}  edge ${b.edge}  (pnl ${b.pnl}, sol ${b.benchmark_pnl})`);
  });
}

if (problems.length) {
  console.log(`\n  MISMATCH — ${problems.length} disagreement${problems.length > 1 ? 's' : ''} with the published board:\n`);
  problems.forEach((p) => console.log(`    · ${p}`));
  console.log('\n  This board does not follow from these marks. Do not trust it.\n');
  process.exit(1);
}
console.log('\n  MATCH — the published board follows from the published marks.');
console.log('  (Not checked: whether the marks themselves are honest. Re-fetch them from');
console.log('   Pyth and GitHub at the timestamps above to check that half.)\n');
process.exit(0);
