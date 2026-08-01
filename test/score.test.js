'use strict';
/**
 * score.test.js — the leaderboard, and every way it could lie.
 *
 * The failure this file is written against is not "wrong arithmetic". It is a scorer
 * that produces a confident, plausible, green number when it should have refused: a
 * missing mark scored as flat, an unresolved bet scored as break-even, a profit shown
 * without the benchmark that turns it into a loss. Every one of those looks like a
 * working leaderboard from the outside.
 *
 * So the arithmetic tests are the cheap half. The expensive half is the negative
 * controls: each guard is exercised in the state it claims to detect, and the tests
 * marked `spec:` assert the product claims from TAPE-SPEC.md §1 — if the code ever stops
 * making them true, a test breaks rather than a paragraph quietly becoming false.
 */

const assert = require('assert');
const D = require('../lib/decimal');
const { buildEntry, entryHash, newNonce } = require('../lib/entry');
const { linkHash, GENESIS } = require('../lib/chain');
const S = require('../lib/score');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// ---------------------------------------------------------------------------------
// Fixtures. Rows are built the way chain.js builds them so the scorer is reading the
// real record shape, but by hand — so that malformed histories (orphan closes, double
// closes) can be constructed, which Chain.append correctly refuses to create.
// ---------------------------------------------------------------------------------
/**
 * Build a chain. A spec may be a function receiving the rows so far, so a close/amend can
 * reference the real hash of an earlier entry. (The first draft of this helper rebuilt
 * the chain to discover the hash, which regenerated the nonces and produced refs that
 * pointed at entries that no longer existed — four tests failed for a fixture bug rather
 * than a code one. Worth the note: a test harness can lie the same way production can.)
 */
function mkChain(specs) {
  const rows = [];
  let prev = GENESIS;
  for (const spec of specs) {
    const entry = buildEntry({ nonce: newNonce(), ...(typeof spec === 'function' ? spec(rows) : spec) });
    const eh = entryHash(entry);
    const seq = rows.length;
    rows.push({ seq, entry_hash: eh, prev, link: linkHash(prev, seq, eh), entry });
    prev = rows[rows.length - 1].link;
  }
  return rows;
}
/** A close/amend of the position opened at row `i`. */
const CLOSE = (i, over = {}) => (rows) => ({
  type: 'close', caller: 'alice', lane: 'memecoin', market: 'BTC/USD', side: 'long',
  size: '1000', entry_ref: '110', ts_claimed: '2026-07-28T21:00:00Z',
  ref: rows[i].entry_hash, ...over,
});
const anchor = (count, slot, blockTime) => ({ count, slot, blockTime, signature: `sig${slot}`, root: 'r'.repeat(64) });
const gateAll = (rows, verdict = 'eligible') =>
  new Map(rows.map((r) => [r.entry_hash, { entry_hash: r.entry_hash, verdict, detail: 'test' }]));
const px = (price, at) => ({ ok: true, price, publish_time: at, source: 'test' });

const OPEN = (over = {}) => ({
  type: 'open', caller: 'alice', lane: 'memecoin', market: 'BTC/USD', side: 'long',
  size: '1000', entry_ref: '100', ts_claimed: '2026-07-28T20:00:00Z', ...over,
});

console.log('\nexact decimal arithmetic (the maths a second implementation must reproduce)');
t('addition is exact where floats are not', () => {
  assert.strictEqual(D.add('0.1', '0.2'), '0.3');
});
t('negative control: the float path really does diverge here', () => {
  // Without this, the test above proves nothing — it could be passing because the value
  // happens to be float-safe. Assert the wrongness we are avoiding actually exists.
  assert.notStrictEqual(String(0.1 + 0.2), '0.3');
  assert.strictEqual(String(0.1 + 0.2), '0.30000000000000004');
});
t('multiplication keeps every place', () => {
  assert.strictEqual(D.mul('1.005', '3'), '3.015');
  assert.strictEqual(D.mul('0.0000001', '0.0000001'), '0.00000000000001');
});
t('trailing zeros never create a second string for one value', () => {
  assert.strictEqual(D.add('1.50', '0'), '1.5');
  assert.strictEqual(D.sub('1.5', '1.5'), '0');
});
t('negative zero collapses to zero', () => {
  assert.strictEqual(D.mul('-1', '0'), '0');
  assert.strictEqual(D.sub('0', '0'), '0');
});
t('division rounds half away from zero, symmetrically', () => {
  assert.strictEqual(D.div('1', '3'), '0.333333333333333333');
  assert.strictEqual(D.div('2', '3'), '0.666666666666666667');
  assert.strictEqual(D.div('-2', '3'), '-0.666666666666666667');
});
t('negative control: division by zero throws rather than returning Infinity', () => {
  assert.ok(throws(() => D.div('1', '0')));
  assert.strictEqual(1 / 0, Infinity); // what we refuse to inherit
});
t('negative control: a raw number is rejected, not coerced', () => {
  assert.ok(throws(() => D.add(0.1, '0.2')));
});
t('cmp orders across differing scales', () => {
  assert.strictEqual(D.cmp('1.10', '1.1'), 0);
  assert.strictEqual(D.cmp('-0.001', '0'), -1);
});
t('round is display-only and does not lose the underlying value', () => {
  assert.strictEqual(D.round('1.005', 2), '1.01');
  assert.strictEqual(D.round('-1.005', 2), '-1.01');
});
t('NEGATIVE CONTROL: a non-zero quantity never PRINTS as zero', () => {
  // Caught on the first real board: a benchmark of -0.002073835500977007 displayed as
  // "0" at two decimal places. The scorer had refused every silent zero upstream and
  // the formatter reintroduced one at the last step.
  assert.strictEqual(D.round('-0.002073835500977007', 2), '0'); // the trap
  assert.strictEqual(D.formatMoney('-0.002073835500977007'), '-0.00207384');
  assert.strictEqual(D.formatMoney('0'), '+0');
  assert.strictEqual(D.formatMoney('0.000000000001'), '+<1e-8');
  assert.strictEqual(D.formatMoney('-0.000000000001'), '-<1e-8');
  assert.strictEqual(D.formatMoney('12.345'), '+12.35');
  assert.strictEqual(D.formatMoney(null), '—');
});

console.log('\nanchor coverage (which slot dates an entry)');
t('the EARLIEST anchor covering a seq is the one that dates it', () => {
  const anchors = [anchor(2, 100, 1000), anchor(5, 200, 2000), anchor(9, 300, 3000)];
  assert.strictEqual(S.coverageFor(0, anchors).slot, 100);
  assert.strictEqual(S.coverageFor(3, anchors).slot, 200);
});
t('negative control: it is not simply returning the latest anchor', () => {
  const anchors = [anchor(2, 100, 1000), anchor(5, 200, 2000), anchor(9, 300, 3000)];
  assert.notStrictEqual(S.coverageFor(0, anchors).slot, 300);
});
t('an entry beyond every anchor count is uncovered, not defaulted', () => {
  assert.strictEqual(S.coverageFor(9, [anchor(2, 100, 1000)]), null);
});

console.log('\nposition building (§1: it stays open until you publicly close it)');
const twoRow = mkChain([OPEN()]);
t('an anchored open with an eligible verdict is an open position', () => {
  const { positions } = S.buildPositions({ rows: twoRow, anchors: [anchor(1, 10, 1000)], gate: gateAll(twoRow) });
  assert.strictEqual(positions.length, 1);
  assert.strictEqual(positions[0].status, 'open');
});
t('a close that is covered by an anchor closes the position', () => {
  const rows = mkChain([OPEN(), CLOSE(0)]);
  const { positions } = S.buildPositions({ rows, anchors: [anchor(2, 10, 1000)], gate: gateAll(rows) });
  assert.strictEqual(positions.length, 1);
  assert.strictEqual(positions[0].status, 'closed');
});
t('NEGATIVE CONTROL: an UNANCHORED close does not close the position', () => {
  // Rule 3. If this ever passes as `closed`, a caller can post an exit, watch the market,
  // and decide afterwards whether to let it be anchored — a free option on their history.
  const rows = mkChain([OPEN(), CLOSE(0)]);
  // the anchor covers only entry 0 — the close at seq 1 is outside it
  const { positions } = S.buildPositions({ rows, anchors: [anchor(1, 10, 1000)], gate: gateAll(rows) });
  assert.strictEqual(positions[0].status, 'open', 'unanchored close must NOT close the position');
  assert.strictEqual(positions[0].pending_close !== null, true, 'the pending close must still be visible');
});
t('a second close on one position is an anomaly, not a double count', () => {
  const rows = mkChain([OPEN(), CLOSE(0), CLOSE(0, { entry_ref: '999' })]);
  const { positions, anomalies } = S.buildPositions({ rows, anchors: [anchor(3, 10, 1000)], gate: gateAll(rows) });
  assert.strictEqual(positions.length, 1);
  assert.strictEqual(positions[0].close.seq, 1, 'the FIRST close is the one that counts');
  assert.ok(anomalies.some((a) => a.kind === 'double_close'), 'the extra close must be reported');
});
t('a close pointing at nothing is reported, not silently dropped', () => {
  const rows = mkChain([OPEN()]);
  const orphan = buildEntry({ type: 'close', caller: 'alice', lane: 'memecoin', market: 'BTC/USD',
    side: 'long', size: '1000', entry_ref: '110', ts_claimed: '2026-07-28T21:00:00Z',
    ref: 'f'.repeat(64), nonce: newNonce() });
  rows.push({ seq: 1, entry_hash: entryHash(orphan), prev: rows[0].link, link: 'x'.repeat(64), entry: orphan });
  const { anomalies } = S.buildPositions({ rows, anchors: [anchor(2, 10, 1000)], gate: gateAll(rows) });
  assert.ok(anomalies.some((a) => a.kind === 'close_orphan'));
});
t('spec T0.4: an amended entry is VOID FOR RANKING but still present', () => {
  const rows = mkChain([OPEN(), CLOSE(0, { type: 'amend', entry_ref: '100' })]);
  const { positions } = S.buildPositions({ rows, anchors: [anchor(2, 10, 1000)], gate: gateAll(rows) });
  assert.strictEqual(positions.length, 1, 'the voided entry is still listed, not deleted');
  assert.strictEqual(positions[0].status, 'voided');
  assert.match(positions[0].status_reason, /VOID FOR RANKING/);
});
t('NEGATIVE CONTROL: a gate verdict of `unknown` is not eligible', () => {
  // "I could not check" must never be read as "it is fine" — the same distinction
  // resolve.js and price.js both keep. A resolver outage must not promote entries.
  const { positions } = S.buildPositions({
    rows: twoRow, anchors: [anchor(1, 10, 1000)], gate: gateAll(twoRow, 'unknown'),
  });
  assert.strictEqual(positions[0].status, 'ineligible');
});
t('NEGATIVE CONTROL: no gate verdict at all is not eligible either', () => {
  const { positions } = S.buildPositions({ rows: twoRow, anchors: [anchor(1, 10, 1000)], gate: new Map() });
  assert.strictEqual(positions[0].status, 'ineligible');
});
t('an unanchored open is unanchored, not open', () => {
  const { positions } = S.buildPositions({ rows: twoRow, anchors: [], gate: gateAll(twoRow) });
  assert.strictEqual(positions[0].status, 'unanchored');
});

// ---------------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------------
const openPos = (over = {}) => ({
  entry_hash: 'a'.repeat(64), seq: 0, caller: 'alice', lane: 'memecoin', market: 'BTC/USD',
  side: 'long', size: '1000', claimed_ref: '1', ts_claimed: '2026-07-28T20:00:00Z', note: null,
  open_anchor: anchor(1, 10, 1000), close: null, pending_close: null,
  status: 'open', status_reason: null, ...over,
});
const MARKS = {
  'price:BTC/USD:1000': px('100', 1000),
  'price:BTC/USD:2000': px('110', 2000),
  'price:SOL/USD:1000': px('200', 1000),
  'price:SOL/USD:2000': px('200', 2000),
};
const score = (positions, marks = MARKS, asOf = 2000) =>
  S.scorePositions({ positions, marks, asOfUnix: asOf });

console.log('\nscoring directional positions');
t('a long that went up ten percent makes ten percent of notional', () => {
  const r = score([openPos()]);
  assert.strictEqual(r.scored[0].scoring, 'scored');
  assert.strictEqual(r.scored[0].pnl, '100');
});
t('a short over the same move loses the same amount', () => {
  const r = score([openPos({ side: 'short' })]);
  assert.strictEqual(r.scored[0].pnl, '-100');
});
t('spec: the mark is the oracle price at the anchor, NOT the caller`s claimed fill', () => {
  // claimed_ref is a wild 0.01 "I got in at the low"; it must not move the number.
  const a = score([openPos({ claimed_ref: '0.01' })]).scored[0];
  const b = score([openPos({ claimed_ref: '999999' })]).scored[0];
  assert.strictEqual(a.pnl, b.pnl, 'the claimed fill must not change PnL');
  assert.strictEqual(a.entry_mark, '100', 'the entry mark must be the oracle price');
  assert.strictEqual(a.claimed_ref, '0.01', 'the claim is still displayed');
});
t('NEGATIVE CONTROL: a missing exit mark is `unscored`, never a flat trade', () => {
  // This is the whole file in one test. A zero here is indistinguishable from a real
  // break-even and it silently flatters whoever the feed failed on.
  const marks = { ...MARKS };
  delete marks['price:BTC/USD:2000'];
  const r = score([openPos()], marks);
  assert.strictEqual(r.scored[0].scoring, 'unscored');
  assert.strictEqual(r.scored[0].pnl, null, 'an unscored position must carry NO number');
  assert.match(r.scored[0].reason, /exit mark unavailable/);
  assert.strictEqual(r.totals.pnl, '0');
  assert.strictEqual(r.totals.unscored, 1, 'and the count of what is missing is published');
});
t('NEGATIVE CONTROL: an `ok:false` mark is refused with its reason, not unwrapped', () => {
  const marks = { ...MARKS, 'price:BTC/USD:2000': { ok: false, reason: 'stale mark: nearest tick is 900s away' } };
  const r = score([openPos()], marks);
  assert.strictEqual(r.scored[0].scoring, 'unscored');
  assert.match(r.scored[0].reason, /stale mark/);
});
t('NEGATIVE CONTROL: PnL without its benchmark is not published', () => {
  const marks = { ...MARKS };
  delete marks['price:SOL/USD:2000'];
  const r = score([openPos()], marks);
  assert.strictEqual(r.scored[0].scoring, 'unscored');
  assert.match(r.scored[0].reason, /benchmark mark unavailable/);
});
t('a market with no registered feed is unscored and says so', () => {
  const r = score([openPos({ market: 'DOGWIFHAT_MINT_ADDRESS' })]);
  assert.strictEqual(r.scored[0].scoring, 'unscored');
  assert.match(r.scored[0].reason, /no price feed registered/);
});
t('excluded positions carry no number either', () => {
  const r = score([openPos({ status: 'voided', status_reason: 'amended by seq 4 — VOID FOR RANKING' })]);
  assert.strictEqual(r.scored[0].scoring, 'excluded');
  assert.strictEqual(r.scored[0].pnl, null);
  assert.strictEqual(r.totals.excluded, 1);
});

console.log('\nscoring binaries (predictions)');
const RES_YES = { supported: true, resolved: true, outcome: 'yes', at: '1970-01-01T00:33:20Z', detail: 'merged' };
const predPos = (over = {}) => openPos({
  lane: 'prediction', market: 'github:o/r/pull/1:merged_by:2026-08-07T00:00:00Z',
  side: 'yes', size: '100', claimed_ref: '0.8', ...over,
});
const PRED_MARKS = {
  ...MARKS,
  'resolution:github:o/r/pull/1:merged_by:2026-08-07T00:00:00Z': RES_YES,
};
t('a YES at 0.8 that lands returns stake/odds − stake', () => {
  const r = score([predPos()], PRED_MARKS);
  assert.strictEqual(r.scored[0].scoring, 'scored');
  assert.strictEqual(r.scored[0].pnl, '25'); // 100/0.8 − 100
  assert.strictEqual(r.scored[0].realized, true);
});
t('a YES that misses loses the whole stake, not a fraction of it', () => {
  const marks = { ...PRED_MARKS,
    'resolution:github:o/r/pull/1:merged_by:2026-08-07T00:00:00Z': { ...RES_YES, outcome: 'no' } };
  assert.strictEqual(score([predPos()], marks).scored[0].pnl, '-100');
});
t('a NO is priced off (1 − odds), the other side of the same book', () => {
  const marks = { ...PRED_MARKS,
    'resolution:github:o/r/pull/1:merged_by:2026-08-07T00:00:00Z': { ...RES_YES, outcome: 'no' } };
  const r = score([predPos({ side: 'no' })], marks);
  assert.strictEqual(r.scored[0].pnl, '400'); // 100/0.2 − 100
});
t('spec T0.5: a settled binary pays whether or not the caller closed it', () => {
  // Silence is scored. Leaving a won bet open does not defer the outcome, because the
  // resolution is mechanical and external — the caller's inaction cannot change it.
  const r = score([predPos()], PRED_MARKS);
  assert.strictEqual(r.scored[0].status, 'open');
  assert.strictEqual(r.scored[0].realized, true);
});
t('NEGATIVE CONTROL: an unresolved binary is unscored, NOT marked flat at entry odds', () => {
  // Marking an open prediction at the odds it was bought at reports every one of them as
  // exactly break-even — a fabricated zero wearing a plausible number.
  const marks = { ...PRED_MARKS,
    'resolution:github:o/r/pull/1:merged_by:2026-08-07T00:00:00Z':
      { supported: true, resolved: false, outcome: null, at: null } };
  const r = score([predPos()], marks);
  assert.strictEqual(r.scored[0].scoring, 'unscored');
  assert.strictEqual(r.scored[0].pnl, null);
  assert.match(r.scored[0].reason, /no live odds feed/);
});
t('NEGATIVE CONTROL: a market with no resolver is unscored, not assumed open', () => {
  const marks = { ...PRED_MARKS,
    'resolution:github:o/r/pull/1:merged_by:2026-08-07T00:00:00Z':
      { supported: false, resolved: null, outcome: null, at: null, detail: 'no resolver' } };
  assert.strictEqual(score([predPos()], marks).scored[0].scoring, 'unscored');
});
t('odds of 0 or 1 are refused rather than divided by', () => {
  assert.strictEqual(S.binaryPnl({ side: 'yes', size: '100', odds: '0', outcome: 'yes' }).ok, false);
  assert.strictEqual(S.binaryPnl({ side: 'yes', size: '100', odds: '1', outcome: 'yes' }).ok, false);
  assert.strictEqual(score([predPos({ claimed_ref: '1' })], PRED_MARKS).scored[0].scoring, 'unscored');
});
t('a settled binary is benchmarked to SETTLEMENT time, not to now', () => {
  const settleUnix = Math.floor(new Date(RES_YES.at).getTime() / 1000); // 2000
  const reqs = S.markRequests([S.buildPositions({ rows: [], anchors: [], gate: new Map() }) && predPos()],
    9999, PRED_MARKS);
  assert.ok(reqs.every((r) => r.key !== `price:SOL/USD:${settleUnix}`),
    'settlement-time benchmark already satisfied by the mark set');
  // and with asOf far in the future, the benchmark window still ends at settlement:
  const r = S.scorePositions({ positions: [predPos()], marks: PRED_MARKS, asOfUnix: 9999 });
  assert.strictEqual(r.scored[0].marked_to, settleUnix);
});

console.log('\nthe headline: did you beat just holding SOL? (§1)');
t('spec: a green trade in a market SOL outran is a NEGATIVE edge', () => {
  // +10% on BTC while SOL did +50%. Profit says yes; the only number that matters says no.
  const marks = { ...MARKS, 'price:SOL/USD:2000': px('300', 2000) };
  const r = score([openPos()], marks);
  assert.strictEqual(r.scored[0].pnl, '100');
  assert.strictEqual(r.scored[0].benchmark_pnl, '500');
  assert.strictEqual(r.scored[0].edge, '-400');
  const board = S.leaderboard(r);
  assert.strictEqual(board[0].beat_hodl, false, 'a profit that lost to holding must not read as a win');
});
t('a flat benchmark leaves edge equal to PnL', () => {
  const r = score([openPos()]);
  assert.strictEqual(r.scored[0].benchmark_pnl, '0');
  assert.strictEqual(r.scored[0].edge, '100');
});
t('spec §1: 90% win rate with one big open bag ranks BELOW 55% with clean books', () => {
  // The claim that justifies the whole "it stays open until you close it" mechanic.
  const winner = (i) => openPos({
    entry_hash: `w${i}`.padEnd(64, '0'), seq: i, caller: 'diamond-hands',
    close: { seq: 100 + i, entry_hash: 'c', anchor: anchor(999, 20, 2000) }, status: 'closed',
  });
  const bag = openPos({
    entry_hash: 'b'.padEnd(64, '0'), seq: 50, caller: 'diamond-hands',
    market: 'ETH/USD', side: 'long', size: '100000', status: 'open',
  });
  const clean = openPos({
    entry_hash: 'k'.padEnd(64, '0'), seq: 60, caller: 'clean-books', size: '2000',
    close: { seq: 61, entry_hash: 'c2', anchor: anchor(999, 20, 2000) }, status: 'closed',
  });
  const marks = {
    ...MARKS,
    'price:ETH/USD:1000': px('100', 1000),
    'price:ETH/USD:2000': px('60', 2000), // the bag is down 40%
  };
  const positions = [...Array(9)].map((_, i) => winner(i)).concat([bag, clean]);
  const board = S.leaderboard(score(positions, marks));
  // Look rows up by IDENTITY, not by display name: an unsigned caller renders as
  // `unsigned:<name>` so that a bare name never carries standing it did not earn.
  const dh = board.find((b) => b.identity === 'name:diamond-hands');
  const cb = board.find((b) => b.identity === 'name:clean-books');
  assert.strictEqual(dh.wins, 9);
  assert.strictEqual(dh.losses, 1);
  assert.strictEqual(cb.wins, 1);
  assert.ok(D.cmp(cb.edge, dh.edge) > 0, `clean books (${cb.edge}) must rank above ${dh.edge}`);
  assert.strictEqual(board[0].identity, 'name:clean-books');
});
t('a caller with any unscored position is flagged incomplete', () => {
  const marks = { ...MARKS };
  delete marks['price:BTC/USD:2000'];
  const board = S.leaderboard(score([openPos(), openPos({ entry_hash: 'z'.repeat(64), market: 'ETH/USD' })], marks));
  assert.strictEqual(board[0].complete, false);
  assert.strictEqual(board[0].unscored, 2);
});
t('ranking is a total order — ties break on caller, so two runs cannot disagree', () => {
  const a = openPos({ entry_hash: 'a'.repeat(64), caller: 'zeta' });
  const b = openPos({ entry_hash: 'b'.repeat(64), caller: 'alpha' });
  assert.deepStrictEqual(
    S.leaderboard(score([a, b])).map((x) => x.identity),
    S.leaderboard(score([b, a])).map((x) => x.identity),
  );
  assert.strictEqual(S.leaderboard(score([a, b]))[0].identity, 'name:alpha');
  assert.strictEqual(S.leaderboard(score([a, b]))[0].caller, 'unsigned:alpha');
});

console.log('\nreproducibility (a rival must be able to recompute us)');
t('the same marks produce the same markset hash', () => {
  assert.strictEqual(score([openPos()]).markset_hash, score([openPos()]).markset_hash);
});
t('NEGATIVE CONTROL: changing one mark changes the hash', () => {
  const other = { ...MARKS, 'price:BTC/USD:2000': px('110.00000001', 2000) };
  assert.notStrictEqual(score([openPos()]).markset_hash, score([openPos()], other).markset_hash);
});
t('mark ordering does not change the hash (key order is not signal)', () => {
  const reordered = {};
  for (const k of Object.keys(MARKS).reverse()) reordered[k] = MARKS[k];
  assert.strictEqual(score([openPos()]).markset_hash, score([openPos()], reordered).markset_hash);
});
t('scoring is a pure function of asOf — recomputing tomorrow reproduces today', () => {
  const a = score([openPos()], MARKS, 2000);
  const b = score([openPos()], MARKS, 2000);
  assert.deepStrictEqual(a.scored, b.scored);
  assert.deepStrictEqual(a.totals, b.totals);
});
t('totals equal the sum of the published rows (no rounding drift)', () => {
  const marks = { ...MARKS, 'price:ETH/USD:1000': px('3', 1000), 'price:ETH/USD:2000': px('7', 2000) };
  const positions = [openPos(), openPos({ entry_hash: 'e'.repeat(64), market: 'ETH/USD', size: '333.33' })];
  const r = score(positions, marks);
  const manual = r.scored.filter((s) => s.scoring === 'scored').reduce((acc, s) => D.add(acc, s.pnl), '0');
  assert.strictEqual(r.totals.pnl, manual);
  assert.strictEqual(r.totals.edge, D.sub(r.totals.pnl, r.totals.benchmark_pnl));
});
t('mark requests are deterministic and de-duplicated', () => {
  const p = [openPos(), openPos({ entry_hash: 'q'.repeat(64) })];
  const r1 = S.markRequests(p, 2000).map((x) => x.key);
  const r2 = S.markRequests(p, 2000).map((x) => x.key);
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(new Set(r1).size, r1.length);
  assert.deepStrictEqual(r1, [...r1].sort());
});
t('mark requests already satisfied are not re-requested', () => {
  assert.strictEqual(S.markRequests([openPos()], 2000, MARKS).length, 0);
});

console.log('\nmark cache (memoization, NOT stale-price reuse)');
const { cacheable, CACHEABLE_AGE_SEC } = require('../lib/marks');
const nowSec = Math.floor(Date.now() / 1000);
t('a historical tick at a fixed past timestamp is cacheable — it is immutable', () => {
  assert.strictEqual(cacheable({ kind: 'price', at: nowSec - 86400 }, px('100', 1)), true);
});
t('NEGATIVE CONTROL: a recent/latest tick is never cached, at any age under the floor', () => {
  // This is the line between memoization and the stale-mark failure price.js warns about.
  // A moving value cached once would silently freeze the mark for every later run.
  assert.strictEqual(cacheable({ kind: 'price', at: nowSec }, px('100', 1)), false);
  assert.strictEqual(cacheable({ kind: 'price', at: nowSec - CACHEABLE_AGE_SEC + 5 }, px('100', 1)), false);
});
t('NEGATIVE CONTROL: a FAILED fetch is never cached — an outage must not become permanent', () => {
  assert.strictEqual(cacheable({ kind: 'price', at: nowSec - 86400 }, { ok: false, reason: 'hermes 429' }), false);
});
t('NEGATIVE CONTROL: a resolution is never cached — outcomes change, prices past do not', () => {
  assert.strictEqual(cacheable({ kind: 'resolution', market: 'x' }, { supported: true, resolved: false }), false);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
