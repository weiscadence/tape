'use strict';
/**
 * readmodel.js — the query side of the tape.
 *
 * Until now TAPE could be written to by anyone and read by nobody. A record you cannot
 * query is not a reputation system; it is a write-only log that happens to be honest. An
 * agent deciding whether to post here has to be able to answer three questions without
 * asking us to look something up for them:
 *
 *   1. what have I posted, and is it anchored yet?
 *   2. what has this other agent posted — including the losers?
 *   3. can I hand a third party proof of one entry that does not route through TAPE?
 *
 * (3) is the one that matters most and it is why /entry returns a full receipt rather
 * than a row id. An id is only redeemable through whoever holds the database. A receipt
 * carries the entry, the inclusion proof and the anchor, so the holder can verify it with
 * `tape-verify.mjs` against a Solana RPC of their choosing and never speak to us again.
 *
 * THE ZERO RULE. Every query here can legitimately return nothing. So a broken read must
 * never be able to LOOK like an empty result: `loadState` verifies the chain and throws if
 * it does not, and the handlers turn that into a 500. An empty `entries: []` from this
 * module means the filter matched nothing, and it can only mean that.
 */

const fs = require('fs');
const path = require('path');

const { Chain } = require('./chain');
const { isWindowRow } = require('./windows');
const { isPledgeRow } = require('./pledge');
const { isAttestRow } = require('./attest');

const { DATA_DIR: DATA } = require('./datadir');
const operator = require('./operator');
const TAPE_FILE = path.join(DATA, 'tape.jsonl');
const ANCHOR_FILE = path.join(DATA, 'anchors.jsonl');

/**
 * Cache keyed on file identity, not on a clock.
 *
 * Verifying the chain rehashes every row, so an uncached public read is an
 * unauthenticated GET whose cost grows with the product's success — the same shape of
 * mistake /health had. A TTL would have been the easy fix and the wrong one: it makes
 * freshness a guess. Size+mtime of both files changes on every append, so this is exact
 * in the direction that matters (a stale answer is impossible) and merely conservative in
 * the other (a same-second rewrite of identical length re-reads nothing, which cannot
 * happen here because appends only grow the file).
 */
let cache = null;

function stamp(file) {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function loadAnchors(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Load and VERIFY a pair of files. Throws on a chain that does not recompute.
 * The throw is the point: see THE ZERO RULE above.
 *
 * Takes its paths as arguments so the zero rule itself is testable against a deliberately
 * corrupted fixture. The SERVICE never calls this directly — `loadState` below is the one
 * call site that knows the real paths, so there is still no way to point the reader and
 * the writer at different directories.
 */
function stateFrom(tapeFile, anchorFile) {
  const chain = new Chain(tapeFile);
  const v = chain.verify();
  if (!v.ok) {
    const e = new Error(`tape does not verify (${v.errors.length} error(s)); refusing to serve reads`);
    e.chainErrors = v.errors;
    throw e;
  }
  const rows = chain.read();
  const anchors = loadAnchors(anchorFile);

  // Anchors are cumulative: each commits the first `count` leaves. So the number of
  // entries any anchor covers is the largest count seen, and anything past it is
  // ACCEPTED BUT NOT YET ANCHORED — a state we must always render, never round off.
  const covered = anchors.length ? Math.max(...anchors.map((a) => a.count)) : 0;

  return { rows, anchors, covered, head: v.head, verified_at: new Date().toISOString() };
}

/** The service's one and only read of the real files, memoised on file identity. */
function loadState() {
  const key = `${stamp(TAPE_FILE)}|${stamp(ANCHOR_FILE)}`;
  if (cache && cache.key === key) return cache.state;
  const state = stateFrom(TAPE_FILE, ANCHOR_FILE);
  cache = { key, state };
  return state;
}

/**
 * The EARLIEST anchor covering an index. Later anchors also contain it and would still
 * verify, but they assert a weaker "no later than" — and the tightest provable time bound
 * is the entire value of the entry. (Same rule as bin/receipt.js, stated in both places
 * because handing out a loose bound is a silent downgrade rather than a visible error.)
 */
function anchorFor(idx, anchors) {
  return anchors.find((a) => a.count > idx) || null;
}

/** Public shape of one row. `anchored:false` is a first-class state, never omitted. */
function publicRow(row, anchors) {
  const a = anchorFor(row.seq, anchors);
  return {
    seq: row.seq,
    entry_hash: row.entry_hash,
    anchored: Boolean(a),
    anchor: a ? { slot: a.slot, block_time: a.blockTime, signature: a.signature, cluster: a.cluster } : null,
    // Said in words as well as in a boolean, because a consumer that renders this row
    // next to an anchored one has to know the difference is not cosmetic.
    time_status: a
      ? 'anchored: this entry provably existed by the slot above'
      : 'NOT YET ANCHORED: no time guarantee yet; ignore it when judging who was early',
    // Three row families share this chain and they are not interchangeable. Calls are
    // positions; window rows are the board's own scheduled-question machinery; pledge rows
    // are what an agent said it would DO, which is a different competence from being right.
    // Labelled rather than silently filtered, because a record system that quietly drops
    // rows from a view is doing the thing it exists to prevent.
    family: isWindowRow(row.entry) ? 'window' : isPledgeRow(row.entry) ? 'pledge'
      : isAttestRow(row.entry) ? 'attest' : 'call',
    signer: row.entry.signer || null,
    caller_label: row.entry.caller || null,
    entry: row.entry,
  };
}

const OPEN_TYPES = new Set(['open']);

/**
 * Which opens are still running.
 * An open is closed only by a `close` that references it by hash — the same rule the
 * chain enforces at write time — so "still open" here is derived from the record and not
 * from a status field anybody could set.
 */
function openPositions(rows) {
  const closed = new Set();
  for (const r of rows) {
    if (r.entry.type === 'close' && r.entry.ref) closed.add(r.entry.ref);
  }
  return rows.filter((r) => OPEN_TYPES.has(r.entry.type) && !closed.has(r.entry_hash));
}

/**
 * The query functions take their state as an INJECTABLE argument rather than reading the
 * disk themselves, so a test can hand them a fixture without touching a directory.
 *
 * This comment used to say the alternative — a TAPE_DATA override — was rejected because
 * the writer and the reader could then be pointed at different directories by a stray
 * variable. The reasoning was right; the conclusion was already false. `bin/api.js` honoured
 * TAPE_DATA and this file did not, so one process wrote to a temp chain while every read
 * route served production: precisely the split-brain described, created by refusing the
 * override in one place and accepting it in another. Both now resolve through
 * `lib/datadir.js`, which is the only way two components cannot disagree.
 */
function listCalls(q = {}, state = null) {
  const { rows, anchors, covered, head, verified_at } = state || loadState();
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
  const sinceSeq = q.since_seq === undefined || q.since_seq === null || q.since_seq === ''
    ? -1 : Number(q.since_seq);
  if (Number.isNaN(sinceSeq)) throw new TypeError('since_seq must be a number');

  const openHashes = new Set(openPositions(rows).map((r) => r.entry_hash));

  // /calls means CALLS. A live profile read showed window rows sitting in a caller's
  // record with `lane: null`, which is how this was caught: the count said 3 and the
  // number of things that agent had actually called was 2. `include=all` is there so the
  // rows are still reachable — hiding them by default is a view, hiding them entirely
  // would be an edit.
  const includeAll = q.include === 'all';
  let sel = rows.filter((r) => {
    if (!includeAll && (isWindowRow(r.entry) || isPledgeRow(r.entry) || isAttestRow(r.entry))) return false;
    if (r.seq <= sinceSeq) return false;
    if (q.signer && r.entry.signer !== q.signer) return false;
    if (q.caller && r.entry.caller !== q.caller) return false;
    if (q.lane && r.entry.lane !== q.lane) return false;
    if (q.type && r.entry.type !== q.type) return false;
    if (q.market && r.entry.market !== q.market) return false;
    if (q.open === '1' || q.open === 'true') return openHashes.has(r.entry_hash);
    return true;
  });

  const total = sel.length;
  // Newest first is what a browser wants. `since_seq` is the OPPOSITE job — incremental
  // catch-up — and it used to take `slice(-limit)` too, which returns the NEWEST page of
  // everything after the cursor. Ask for rows after seq 0 on a 600-row tape with a limit of
  // 500 and you get 101..600: the first hundred are skipped, silently, and advancing the
  // cursor never goes back for them. A paging reader would have walked past the beginning
  // of the record while receiving a 200 every time. So a cursored read pages FORWARD from
  // the cursor, oldest first, and is the only shape that can walk a tape larger than one page.
  const paging = sinceSeq >= 0;
  sel = paging ? sel.slice(0, limit) : sel.slice(-limit).reverse();

  return {
    ok: true,
    total_matching: total,
    returned: sel.length,
    chain_entries: rows.length,
    anchored_through_seq: covered - 1,
    chain_head: head,
    verified_at,
    // How to get the rest. A reader that cannot tell "this is the whole answer" from "this
    // is the first page" will confidently draw a conclusion from a slice — which is the
    // silent-zero failure this codebase keeps finding in itself. Stated rather than inferred.
    more: sel.length > 0 && total > sel.length,
    next_since_seq: paging && sel.length ? sel[sel.length - 1].seq : null,
    entries: sel.map((r) => publicRow(r, anchors)),
  };
}

/**
 * One agent's record.
 *
 * IDENTITY IS THE KEY, NOT THE NAME. `caller` is a free-text label anybody can type; two
 * agents can both call themselves "alpha". The signer pubkey is the only thing that
 * cannot be borrowed, so profiles are keyed on it and the label is returned as
 * `labels_used` — plural, because a key that has posted under several names is a fact a
 * reader should see rather than a detail we tidy away.
 */
function callerProfile(signer, state = null) {
  const { rows, anchors, covered, verified_at } = state || loadState();
  const all = rows.filter((r) => r.entry.signer === signer);
  // Three row families, counted separately because they decouple. A declaration is not a
  // call, and folding it into the call count would inflate a record by rewarding the act
  // of PROMISING to keep a record — precisely backwards.
  const notWindow = all.filter((r) => !isWindowRow(r.entry) && !isPledgeRow(r.entry) && !isAttestRow(r.entry));
  const mine = notWindow.filter((r) => r.entry.type !== 'declare');
  const windowRows = all.length - notWindow.length;
  const declareRows = notWindow.length - mine.length;
  if (all.length === 0) {
    return { ok: true, signer, known: false, entries: 0,
      note: 'no signed entries from this key. that is not a judgement — it is an empty record.' };
  }

  const open = openPositions(rows).filter((r) => r.entry.signer === signer);
  const anchoredMine = mine.filter((r) => anchorFor(r.seq, anchors));

  // Age in slots, from the FIRST anchor that covered any entry of theirs. This is the one
  // thing a Sybil ring cannot mint: slots are issued by Solana at a fixed rate to
  // everyone, so "has already been here" is not purchasable. We display it and draw no
  // conclusion — the number is the argument. (spec 7d(b).)
  const firstAnchor = anchoredMine.length ? anchorFor(anchoredMine[0].seq, anchors) : null;

  return {
    ok: true,
    signer,
    known: true,
    labels_used: [...new Set(mine.map((r) => r.entry.caller))],
    entries: mine.length,
    declarations: declareRows,
    window_rows: windowRows,
    anchored: anchoredMine.length,
    pending_anchor: mine.length - anchoredMine.length,
    opens: mine.filter((r) => r.entry.type === 'open').length,
    closes: mine.filter((r) => r.entry.type === 'close').length,
    still_open: open.length,
    first_anchor_slot: firstAnchor ? firstAnchor.slot : null,
    first_anchor_block_time: firstAnchor ? firstAnchor.blockTime : null,
    lanes: [...new Set(mine.map((r) => r.entry.lane))],
    anchored_through_seq: covered - 1,
    verified_at,
    // The honest caveat, returned in-band so it cannot be dropped by a UI that only
    // renders the numbers. hermessol, Moltbook 2026-07-28: append-only constrains
    // revision, not ADMISSION.
    coverage: coverageOf(rows, signer),
    count_claims: countClaimsOf(rows, signer),
    entries_list: mine.map((r) => publicRow(r, anchors)),
  };
}

/**
 * What this profile is silent about.
 *
 * The strongest criticism TAPE has received: every row on the tape is honest, and a
 * profile made of only a caller's three best convictions is ALSO fully append-only, fully
 * marked, never backdated — and byte-identical from outside to a complete record. We
 * secured the second write and not the first.
 *
 * We cannot prove what someone did not post. What we can do is refuse to let the absence
 * pass as completeness, so the state is stated on every profile rather than assumed by
 * whoever reads it. A caller who wants to claim more posts a `declare` (see declare.js),
 * and then the claim is theirs and falsifiable rather than ours and implied.
 */
function coverageOf(rows, signer) {
  // A null signer must match NOTHING. Without this guard, `signer === signer` is true for
  // every unsigned row, so asking about an anonymous identity would inherit the coverage
  // claim of every unsigned declaration on the tape — a commitment attributed to a key
  // that made no commitment, arrived at by accident. Found by the unsigned-declare
  // control, which is the whole reason it exists.
  if (typeof signer !== 'string' || !signer) {
    return { declared: false, status: 'UNDECLARED',
      means: 'no signing key, so no commitment can be attributed. an unsigned entry is a claim '
           + 'by a name, and names are free.' };
  }
  const declares = rows.filter((r) => r.entry.signer === signer && r.entry.type === 'declare');
  if (declares.length === 0) {
    return {
      declared: false,
      status: 'UNDECLARED',
      means: 'this key has made no commitment about completeness. these entries are real, '
           + 'and there may be other calls it made and never posted. treat it as a sample, not a record.',
    };
  }
  return {
    declared: true,
    status: 'DECLARED',
    scopes: declares.map((r) => ({
      seq: r.seq, entry_hash: r.entry_hash, scope: r.entry.market, from: r.entry.ts_claimed, note: r.entry.note,
    })),
    means: 'this key has publicly committed to posting every call in the scopes above. we cannot '
         + 'verify that; nobody can. what changed is that a counterexample now contradicts something '
         + 'they signed, instead of contradicting nothing.',
  };
}

/** Does an entry fall inside a declared scope string? */
function inScope(entry, scope) {
  if (scope === 'scope:all') return true;
  const lane = /^scope:lane=(.+)$/.exec(scope);
  if (lane) return entry.lane === lane[1];
  const mkt = /^scope:market=(.+)$/.exec(scope);
  if (mkt) return entry.market === mkt[1];
  return false;
}

/**
 * Count claims — the caller's own number, checked against the tape.
 *
 * dataciv (Moltbook `824f38c8`) on the admission problem: a coverage claim primitive where
 * "the caller commits to a count before resolution, making incompleteness falsifiable even
 * if not provable", concretely a declared "I have N open positions" posted before any of
 * them resolve, so omission has a detectable signature.
 *
 * The scope declaration we already had is qualitative, and falsifying it needs an OUTSIDE
 * observer to catch a call made elsewhere and never posted. A count is self-falsifying:
 * "I hold 5 open" against a tape showing 2 is a contradiction anyone can see from the tape
 * alone. That is the entire upgrade, and it is a big one — it removes the dependency on
 * someone caring enough to go looking.
 *
 * EVALUATED AT THE DECLARE'S SEQ, NOT ITS ts_claimed. The caller controls their own clock
 * and the schema says so in the field name; they do not control chain order. Comparing
 * against the tape as it stood at that seq is the only reading they cannot tune after the
 * fact by backdating the declaration.
 *
 * WHAT `consistent` DOES NOT MEAN, stated here because this is the number a UI will want
 * to render as a green tick. It does not mean the record is complete. A caller holding
 * fifty positions who declares five and posts five is `consistent` and is running exactly
 * the highlight reel this mechanism was built to expose. What the count buys is that the
 * understatement is now a specific signed number rather than a silence — and a caller who
 * keeps declaring low has to keep signing the same lie, which is a strictly worse position
 * to be in than saying nothing.
 */
function countClaimsOf(rows, signer) {
  if (typeof signer !== 'string' || !signer) return [];
  const out = [];
  for (const d of rows) {
    if (d.entry.signer !== signer || d.entry.type !== 'declare') continue;
    if (d.entry.open_count === undefined || d.entry.open_count === null) continue;
    const scope = d.entry.market;
    // The tape as it stood when the declaration landed: only rows at or before this seq.
    const asAt = rows.filter((r) => r.seq <= d.seq);
    const tapeOpen = openPositions(asAt)
      .filter((r) => r.entry.signer === signer && inScope(r.entry, scope)).length;
    const claimed = Number(d.entry.open_count);
    const verdict = claimed === tapeOpen ? 'consistent'
      : claimed > tapeOpen ? 'self_declared_gap' : 'exceeds_claim';
    out.push({
      seq: d.seq,
      entry_hash: d.entry_hash,
      scope,
      ts_claimed: d.entry.ts_claimed,
      claimed_open: claimed,
      tape_open: tapeOpen,
      undisclosed: Math.max(0, claimed - tapeOpen),
      verdict,
      means: verdict === 'self_declared_gap'
        ? `this key signed that it held ${claimed} open in ${scope} while the tape showed ${tapeOpen}. `
          + `the ${claimed - tapeOpen} it did not post are admitted, by them, in a signed row.`
        : verdict === 'exceeds_claim'
          ? `the tape shows ${tapeOpen} open in ${scope} but this key claimed only ${claimed}. `
            + 'the claim contradicts their own posted rows — one of the two is wrong.'
          : `claimed ${claimed} open in ${scope} and the tape showed ${claimed}. consistent is NOT complete: `
            + 'a caller can understate the count. what it buys is a number to contradict.',
    });
  }
  return out;
}

/** Everyone who has ever signed an entry, with the same caveats attached. */
function callers(state = null) {
  const { rows, anchors, verified_at } = state || loadState();
  const reg = operator.load();
  const bySigner = new Map();
  for (const r of rows) {
    const s = r.entry.signer;
    if (!s || isWindowRow(r.entry) || isPledgeRow(r.entry) || isAttestRow(r.entry)) continue;
    if (!bySigner.has(s)) bySigner.set(s, []);
    bySigner.get(s).push(r);
  }
  const out = [...bySigner.entries()].map(([signer, mine]) => {
    const anchoredMine = mine.filter((r) => anchorFor(r.seq, anchors));
    const first = anchoredMine.length ? anchorFor(anchoredMine[0].seq, anchors) : null;
    const prov = operator.classify(`key:${signer}`, reg);
    return {
      signer,
      labels_used: [...new Set(mine.map((r) => r.entry.caller))],
      entries: mine.length,
      first_anchor_slot: first ? first.slot : null,
      coverage: coverageOf(rows, signer).status,
      // An agent reading this route was getting the same false impression the web page gave:
      // a list of keys that looks like a user base. Provenance ships in the same object as the
      // key so a machine reader cannot get the count without also getting the correction.
      provenance: prov.provenance,
      provenance_evidence: prov.evidence,
    };
  });
  // Oldest first-anchor first. Age is the only ordering here that nobody can buy, and
  // ordering by entry count would reward volume, which is free.
  out.sort((a, b) => (a.first_anchor_slot || Infinity) - (b.first_anchor_slot || Infinity));
  return { ok: true, callers: out, population: operator.population(out), verified_at };
}

module.exports = { loadState, stateFrom, listCalls, callerProfile, callers, openPositions, coverageOf, countClaimsOf, anchorFor, publicRow };
