'use strict';
/**
 * hyperliquid.js — read HIP-4 outcome markets as callable TAPE markets.
 *
 * WHY A SECOND VENUE AT ALL (2026-08-07). Polymarket's settlement lives on Polygon and is
 * decided by UMA's optimistic oracle — token holders voting, with a dispute window. HIP-4
 * settles differently: Hyperliquid's own validator set executes resolution against a data
 * source pinned when the market was created. No vote, no dispute game. For a record whose
 * entire product is "this close was not invented by the operator", a venue whose outcome is
 * consensus state is strictly better evidence than a venue whose outcome is an API response.
 *
 * THE ID IS SELF-DESCRIBING ON PURPOSE, AND THIS IS THE IMPORTANT PART.
 *
 * HIP-4 market slots are RECYCLED: one slot carries a rolling/recurring market and is reused
 * after each settlement. So `outcome: 1019` means "SOL vs 74.202 expiring 2026-08-07T06:00Z"
 * today and something else tomorrow. An id of the form `hyperliquid:1019` would therefore be
 * a DANGLING POINTER the moment the slot rolls — a call anchored last week would silently
 * re-point at this week's market and settle against the wrong question. On an append-only
 * record that cannot be corrected, that is the worst class of bug this file could have.
 *
 * So the id carries the whole question:
 *
 *     hyperliquid:<outcomeId>:<ASSET>:above:<threshold>@<ISO-8601 expiry>
 *     hyperliquid:1019:SOL:above:74.202@2026-08-07T06:00:00Z
 *
 * The outcome id is kept for PROVENANCE (it points back at the exact venue market at the
 * time of the call) and is never the thing settlement depends on. Everything needed to
 * settle is in the id itself, so the row stays resolvable forever even after Hyperliquid
 * recycles the slot and drops the metadata.
 *
 * TWO FILTERS THAT ARE NOT COSMETIC — the same rule bin/markets.js states for Polymarket:
 * the picker must only offer what the scorer can close.
 *
 * 1. `class:priceBinary` only. HIP-4 also lists multi-price bucket questions (three-way
 *    "which band does BTC land in"). lib/resolve.js refuses anything not cleanly binary, so
 *    offering one would hand a caller an entry that can never settle.
 * 2. Registered price assets only. Settlement runs through lib/price.js, which has feeds for
 *    BTC/ETH/SOL. HYPE markets are listed by the venue and are NOT offered here, because a
 *    market we cannot price is a market we cannot close. Dropped rows are COUNTED and
 *    reported so an empty menu reads as "4 read, 4 filtered", never as ambiguous silence.
 *
 * DIRECTION WAS MEASURED, NOT ASSUMED (2026-08-07 05:20 UTC). All four live priceBinary
 * markets had spot BELOW target and YES priced 0.001–0.020 — four independent observations
 * agreeing that YES means "at or above targetPrice at expiry". A guess here would flip every
 * settlement on the venue, so it is stated as a measurement with a date.
 */

const https = require('https');

const HOST = 'api.hyperliquid.xyz';

/** Assets we can actually settle. Kept in sync with lib/price-sources.js PYTH_FEEDS. */
const SETTLEABLE = new Set(['BTC', 'ETH', 'SOL']);

/** Same "there is no opinion left to have" band bin/markets.js uses for Polymarket. */
const MIN_PRICE = 0.08;
const MAX_PRICE = 0.92;

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: HOST, path: '/info', method: 'POST', timeout: 15000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; if (buf.length > 4e6) res.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`hyperliquid ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`hyperliquid sent non-JSON: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('hyperliquid timed out after 15s')));
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * HIP-4 encodes the whole contract in a pipe-delimited description string:
 *   `class:priceBinary|underlying:BTC|expiry:20260807-0600|targetPrice:64869|period:1d`
 * Parsed defensively — an unrecognised shape must drop the row, never throw inside the
 * filter and read as "the venue has nothing".
 */
function parseDescription(desc) {
  const out = {};
  for (const part of String(desc || '').split('|')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** `20260807-0600` ⇒ `2026-08-07T06:00:00Z`. Returns null if it is not exactly that shape. */
function parseExpiry(s) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
  return isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Outcome prices live in `allMids` keyed `#<outcomeId><sideIndex>` — side 0 is Yes, side 1
 * is No, and the pair sums to 1 by construction (the two sides share one merged book).
 * We read YES and derive NO rather than reading both, so a partial feed cannot produce a
 * row whose two legs disagree.
 */
function yesPriceFrom(mids, outcomeId) {
  const raw = mids[`#${outcomeId}0`];
  const v = Number(raw);
  return isFinite(v) ? v : null;
}

/**
 * Fetch the callable HIP-4 board.
 * Returns `{ rows, stats }` with the same contract bin/markets.js uses.
 */
async function fetchMarkets({ limit = 12, now = Date.now() } = {}) {
  const [meta, mids] = await Promise.all([
    post({ type: 'outcomeMeta' }),
    post({ type: 'allMids' }),
  ]);
  const outcomes = Array.isArray(meta && meta.outcomes) ? meta.outcomes : [];

  const stats = {
    read: outcomes.length,
    dropped_not_binary: 0,
    dropped_no_feed: 0,
    dropped_priced_out: 0,
    dropped_expired: 0,
    dropped_no_price: 0,
  };
  const rows = [];

  for (const o of outcomes) {
    const d = parseDescription(o.description);
    if (d.class !== 'priceBinary') { stats.dropped_not_binary++; continue; }

    const asset = String(d.underlying || '').toUpperCase();
    if (!SETTLEABLE.has(asset)) { stats.dropped_no_feed++; continue; }

    const expiry = parseExpiry(d.expiry);
    const target = Number(d.targetPrice);
    if (!expiry || !isFinite(target)) { stats.dropped_not_binary++; continue; }

    // Same rule as Polymarket: a market whose window has already closed must never be
    // offered. TAPE's one guarantee is that a claim was anchored before its outcome could
    // be known; offering a settled market hands the caller the exact shot this record exists
    // to refuse.
    if (Date.parse(expiry) <= now) { stats.dropped_expired++; continue; }

    const yes = yesPriceFrom(mids, o.outcome);
    if (yes === null) { stats.dropped_no_price++; continue; }
    if (yes < MIN_PRICE || yes > MAX_PRICE) { stats.dropped_priced_out++; continue; }

    rows.push({
      venue: 'hyperliquid',
      market: `hyperliquid:${o.outcome}:${asset}:above:${d.targetPrice}@${expiry}`,
      // A human-readable rendering of the same contract the id encodes. Annotation only —
      // settlement never reads this string.
      question: `${asset} at or above $${d.targetPrice} on ${expiry.slice(0, 16).replace('T', ' ')} UTC`,
      yes: yes.toFixed(4),
      no: (1 - yes).toFixed(4),
      ends: expiry,
    });
    if (rows.length >= limit) break;
  }

  return { rows, stats };
}

module.exports = {
  fetchMarkets, parseDescription, parseExpiry, yesPriceFrom,
  SETTLEABLE, MIN_PRICE, MAX_PRICE,
};
