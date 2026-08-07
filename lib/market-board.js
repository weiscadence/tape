'use strict';
/**
 * market-board.js — the list of markets a caller may actually post on.
 *
 * WHY THIS FILE EXISTS. This logic lived inside bin/miniapp.js, which meant the board was
 * reachable only at /app/api/markets — a route on the MINI-APP listener, behind the Telegram
 * shell. The public agent API (bin/api.js, the one agent.json documents) had no market route
 * at all. So the protocol spec told a stranger "post a call, `market` is a lane-specific id"
 * and gave them no way to learn a single valid value. An agent that guesses gets a 400 from
 * the write path's grammar check, or a 502 from a resolver that will not touch the market —
 * both of which read as "TAPE is broken" rather than "that market was never callable".
 *
 * Discovery is not a nicety here. The write path deliberately refuses anything the SCORER
 * cannot close, so the set of postable markets is strictly smaller than the set of markets
 * that exist, and it is not derivable from outside. A gate that only says no is a gate you
 * cannot find the door in.
 *
 * ONE SOURCE, TWO SERVERS. Both bin/miniapp.js and bin/api.js require this module, so the
 * board an agent reads over the API is the same board the mini-app renders, built by the same
 * filters. Two copies of these thresholds would drift, and the drift would be silent: the app
 * would offer a market the API said was not callable, or worse the reverse.
 *
 * NO I/O AT REQUIRE TIME. start() must be called explicitly. A module that starts polling
 * third-party APIs merely because it was required is a module that cannot be unit-tested, and
 * every consumer inherits its network behaviour whether it wanted the board or not.
 */

const https = require('https');

const { fetchMarkets: hlMarkets } = require('./hyperliquid');
// Reused, not reimplemented: the CLI picker's binary test is the one the gate agrees with.
const { isBinaryYesNo } = require('../bin/markets');

/** Polymarket rows below this 24h notional are noise; a thin book prices nothing. */
const MIN_VOL24 = 50000;
/**
 * The price band. Outside it there is no opinion left to have: a 3¢ contract is not a call,
 * it is a lottery ticket, and a 97¢ one is a receipt for a fact. Both would farm a win rate
 * while adding no information, which is the same failure the tier ladder exists to close.
 */
const MIN_PRICE = 0.06;
const MAX_PRICE = 0.94;
/** How many Polymarket rows to keep after filtering, highest 24h volume first. */
const KEEP = 24;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let cache = { at: 0, data: [], venues: {} };
let timer = null;

/**
 * Merge one venue's rows into the cache, replacing only that venue's slice.
 *
 * A VENUE THAT FAILS MUST NOT TAKE THE OTHER DOWN WITH IT. The fetches are independent and
 * each keeps its own last-good slice, so Polymarket going dark leaves the Hyperliquid rows
 * live instead of emptying the whole board — the failure that would otherwise read to a
 * caller as "TAPE is broken" when one third-party API blipped.
 */
function commitVenue(venue, rows, note) {
  const others = cache.data.filter((r) => r.venue !== venue);
  cache = {
    at: Date.now(),
    data: others.concat(rows),
    venues: Object.assign({}, cache.venues, {
      [venue]: { at: Date.now(), count: rows.length, note: note || null },
    }),
  };
}

function refreshPolymarket() {
  const url = 'https://gamma-api.polymarket.com/markets'
    + '?closed=false&active=true&order=volume24hr&ascending=false&limit=60';
  https.get(url, (r) => {
    let buf = '';
    r.on('data', (c) => { buf += c; if (buf.length > 4e6) r.destroy(); });
    r.on('end', () => {
      try {
        const rows = JSON.parse(buf);
        const out = [];
        let droppedExpired = 0;
        const now = Date.now();
        for (const m of (Array.isArray(rows) ? rows : rows.data || [])) {
          if (!m.question) continue;
          /**
           * PAST ITS END DATE IS NOT CALLABLE, even though Polymarket still says active.
           *
           * Found 2026-08-07 by running every offered market through the write path: "US x Iran
           * Effective Ceasefire by July 31?" was on the board a week after it ended, priced at
           * 81¢, flagged `closed=false&active=true` by the upstream API. Polymarket had not
           * formally resolved it, so TAPE's own "already-resolved market" refusal (409) could
           * not catch it either — the resolver only knows what the venue has settled.
           *
           * That combination is the exact thing this whole record exists to make impossible: a
           * call anchored AFTER its outcome became knowable. July 31 is in the past; anyone can
           * look up what happened and then post a "prediction" carrying a real Solana slot. The
           * receipt would be entirely valid and completely worthless, and at agent speed someone
           * would find it and farm it.
           *
           * The Hyperliquid branch has always dropped expired rows (`dropped_expired`). This one
           * never did, because Polymarket's `active` flag reads like it already means this.
           */
          if (m.endDate && Date.parse(m.endDate) <= now) { droppedExpired++; continue; }
          // ONLY WHAT THE SCORER CAN CLOSE. Jiggy's own receipt #386 ("Chicago White Sox vs.
          // Boston Red Sox", YES at 82¢) is excluded from ranking forever, because that
          // market's outcomes are two team names and the gate cannot map them to a yes/no
          // side. The tap felt identical to a real call and produced a real receipt that can
          // never score. Offering such a market to an AGENT would be the same trap, run at
          // machine speed.
          if (!isBinaryYesNo(m)) continue;
          let yes = null;
          try {
            const p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
            yes = Number(p[0]);
          } catch { /* unparseable price — drop */ }
          if (!(yes >= MIN_PRICE && yes <= MAX_PRICE)) continue;
          const v = Number(m.volume24hr) || 0;
          if (v < MIN_VOL24) continue;
          out.push({
            venue: 'polymarket',
            market: `polymarket:${m.conditionId}`,
            q: m.question,
            yes: Math.round(yes * 100) / 100,
            vol24: Math.round(v),
            id: m.conditionId,
            ends: m.endDate || null,
          });
        }
        // Same counted-reason discipline the Hyperliquid branch uses: an empty or short board
        // must be able to say WHY, or it is indistinguishable from a broken fetch.
        commitVenue('polymarket', out.slice(0, KEEP),
          out.length ? null : `0 callable · ${droppedExpired} past their end date`);
      } catch { /* keep the last good slice */ }
    });
  }).on('error', () => { /* keep the last good slice */ });
}

function refreshHyperliquid() {
  return hlMarkets().then(({ rows, stats }) => {
    const out = rows.map((r) => ({
      venue: 'hyperliquid',
      market: r.market,
      q: r.question,
      yes: Math.round(Number(r.yes) * 100) / 100,
      // HIP-4 does not publish a 24h notional per outcome on the info endpoint, and inventing
      // one would put a fabricated number on a receipt.
      vol24: null,
      ends: r.ends,
    }));
    // An empty Hyperliquid slice is a real state most of the day — the daily contracts sit at
    // 0.99/0.01 near expiry and get filtered by the same band as Polymarket. The note makes an
    // empty slice say WHY, so it never reads as a broken fetch.
    //
    // EVERY ROW READ MUST BE ACCOUNTED FOR. If the reasons stop summing to `read`, the
    // remainder is shown rather than hidden.
    const named = stats.dropped_priced_out + stats.dropped_no_feed
      + stats.dropped_expired + stats.dropped_not_binary + stats.dropped_no_price;
    const parts = [
      `${stats.read} outcome markets read`,
      `${stats.dropped_priced_out} priced outside the band`,
      `${stats.dropped_no_feed} on assets we cannot settle`,
      `${stats.dropped_not_binary} not binary Yes/No`,
      `${stats.dropped_expired} past expiry`,
    ];
    if (stats.dropped_no_price) parts.push(`${stats.dropped_no_price} with no live price`);
    if (named !== stats.read) parts.push(`${stats.read - named} unaccounted for`);
    commitVenue('hyperliquid', out, out.length ? null : parts.join(' · '));
  }).catch(() => { /* keep the last good slice */ });
}

function refresh() { refreshPolymarket(); refreshHyperliquid(); }

/** Start the refresh loop. Idempotent — calling twice does not double the polling rate. */
function start(intervalMs) {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

/** The current board. Callers must not mutate it. */
function snapshot() { return cache; }

/** The row for one market id, or null. The write path uses this to check what it offered. */
function find(market) { return cache.data.find((x) => x.market === market) || null; }

module.exports = {
  start, stop, refresh, snapshot, find, commitVenue,
  MIN_VOL24, MIN_PRICE, MAX_PRICE, KEEP, DEFAULT_INTERVAL_MS,
};
