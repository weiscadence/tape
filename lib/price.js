'use strict';
/**
 * price.js — the mark.
 *
 * A leaderboard that shows profit needs a price, and the price is the place where a
 * scorekeeper cheats most easily: pick the tick that flatters, or quietly reuse a stale
 * one when the feed is down. So this module obeys the same rule the rest of TAPE does —
 * the number comes from outside us, and "I could not get a price" is a distinct, loud
 * outcome from "the price is fine". Never a silent zero, never a silent last-known.
 *
 * Primary source: Pyth Hermes. Two properties make it the right oracle here:
 *   1. It is queryable AT A PAST TIMESTAMP (`/v2/updates/price/<unix>`), so a mark can be
 *      taken at the anchor's Solana blockTime rather than at whatever moment our scorer
 *      happens to run. A leaderboard recomputed tomorrow must produce today's numbers.
 *   2. Every point carries a confidence interval, so a wide/uncertain tick is visible
 *      rather than being rounded into false precision.
 *
 * It is no longer the ONLY source, and the reason is dated: Pyth Core deprecates its
 * unauthenticated Hermes endpoints on 2026-07-31. A board that stops scoring the day a
 * vendor changes its billing is not an undeletable record. So price-sources.js carries an
 * ordered list — Pyth, then two independent public venues — and this module picks the
 * first that answers. Substitution is never silent: a mark served by a non-primary source
 * is flagged `degraded` and names the exact URL that reproduces it.
 *
 * THE RULE THAT MATTERS (see scoring): a caller's claimed fill price is NOT what they are
 * scored on. They are scored on the oracle price at the slot where their call was
 * anchored. Otherwise "I got in at the low" is a free parameter, and fill-shopping
 * becomes the dominant strategy — exactly the T0.1 hole in a different costume.
 */

const { requireDecimalString } = require('./canonical');
const { SOURCES, PYTH_FEEDS, scaleToDecimal, outOfReach } = require('./price-sources');

/** Kept as `FEEDS` for score.js, which asks only "is this symbol markable at all". */
const FEEDS = PYTH_FEEDS;

/**
 * Maximum distance (seconds) between the timestamp we asked for and the publish_time we
 * got back. Hermes answers a historical query with the nearest update, and near a feed
 * outage "nearest" can be minutes or hours away — which would silently mark a position
 * at a price from a different market regime. Observed skew on healthy feeds is 0-5s.
 *
 * This is measured to the EDGE of the window a print speaks for, not to its label. A tick
 * speaks for one instant; a 60s candle speaks for [start, start+60). Measuring a candle
 * from its start and then capping the allowance at 60 made the ceiling unsatisfiable on
 * the `latest` path — the newest CLOSED candle is always at least 60s behind "now", so
 * every venue was rejected as stale while answering correctly, and the Pyth fallback
 * could never fire. Bucket identity is the ADAPTER's job (each throws on the wrong
 * bucket); freshness is this check's job. Keeping those separate is what lets the
 * ceiling stay 60 without lying about what it measures.
 */
const MAX_SKEW_SEC = 60;

/**
 * Price for `symbol` at `atUnix` (omit for latest).
 *
 * Returns { ok, symbol, price, conf, conf_bps, publish_time, skew_sec, pyth_slot, reason }.
 * `ok:false` ALWAYS carries a reason and never carries a price — callers must be unable
 * to accidentally use a bad mark. This is the resolve.js `supported` distinction again:
 * unknown is not the same as fine.
 */
async function priceAt(symbol, atUnix = null) {
  const id = FEEDS[symbol];
  if (!id) {
    return { ok: false, symbol, reason: `no feed registered for ${symbol} (have: ${Object.keys(FEEDS).join(', ')})` };
  }
  const wanted = atUnix === null ? Math.floor(Date.now() / 1000) : atUnix;
  if (!Number.isInteger(wanted) || wanted <= 0) {
    return { ok: false, symbol, reason: `bad timestamp ${atUnix}` };
  }
  // A mark in the future is not a mark. Guard it here rather than trusting the upstream
  // to refuse: Hermes answers a future timestamp with its newest tick, which would look
  // exactly like a valid price.
  const nowSec = Math.floor(Date.now() / 1000);
  if (wanted > nowSec + MAX_SKEW_SEC) {
    return { ok: false, symbol, reason: `refusing to price ${wanted - nowSec}s in the future` };
  }

  // Walk the sources in order and take the first that answers. Every failure is kept, not
  // collapsed to "unreachable": when the board later shows `unscored`, the reason has to
  // say whether all three oracles were down or whether we asked for a symbol none of them
  // carry. Those are different bugs and one of them is ours.
  const failures = [];
  for (const src of SOURCES) {
    if (!src.supports(symbol)) { failures.push(`${src.name}: no feed for ${symbol}`); continue; }

    // Skip a source that cannot see this far back, and SAY SO. Asking a 12-hour venue for
    // a 27-hour-old settlement returns "no candle for bucket N", which reads like an
    // outage and sent me looking at the wrong layer once already.
    const reach = outOfReach(src, wanted);
    if (reach) { failures.push(reach); continue; }

    let raw;
    try { raw = await src.fetch(symbol, wanted, { latest: atUnix === null }); }
    catch (e) { failures.push(`${src.name}: ${e.message}`); continue; }

    const price = raw.price;
    requireDecimalString(price, 'price.price');
    if (raw.conf !== null && raw.conf !== undefined) requireDecimalString(raw.conf, 'price.conf');

    // The window this print speaks for: [publish_time, publish_time + granularity). A tick
    // has granularity 0, so the window collapses to the instant and this is the old check.
    const covStart = raw.publish_time;
    const covEnd = raw.publish_time + (raw.granularity_sec || 0);
    // Distance from the instant we asked about to that window — zero when it is inside.
    const skew = wanted < covStart ? covStart - wanted
      : wanted > covEnd ? wanted - covEnd : 0;
    if (skew > MAX_SKEW_SEC) {
      failures.push(`${src.name}: stale mark, nearest print covers `
        + `${covStart}-${covEnd}, ${skew}s from the mark (limit ${MAX_SKEW_SEC}s)`);
      continue;
    }

    // Confidence as basis points of price, so a wide tick is legible without maths.
    // Venue prints have no interval at all; `null` says "unknown", never "zero" — a
    // fabricated 0 bps would read as the most certain mark on the board.
    const confBps = (raw.conf === null || raw.conf === undefined || Number(price) === 0)
      ? null : String(Math.round((Number(raw.conf) / Number(price)) * 10000));

    return {
      ok: true, symbol, price, conf: raw.conf ?? null, conf_bps: confBps,
      publish_time: raw.publish_time, skew_sec: skew,
      pyth_slot: raw.pyth_slot ?? null,
      source: raw.source,
      // The reproduction instruction travels WITH the number. A verifier who disagrees
      // with our mark needs to know which endpoint to paste, not just which vendor.
      source_url: raw.url,
      granularity_sec: raw.granularity_sec,
      degraded: !src.primary,
      // Only present when we fell through, and it names what fell. Silence about a
      // substitution is the same failure as a silent stale tick.
      ...(src.primary ? {} : { primary_failure: failures.join(' | ') }),
    };
  }

  return { ok: false, symbol, at: wanted,
    reason: `no source could price ${symbol} at ${wanted} — ${failures.join(' | ')}`,
    sources_tried: SOURCES.map((s) => s.name) };
}

module.exports = { priceAt, scaleToDecimal, FEEDS, MAX_SKEW_SEC, SOURCES };
