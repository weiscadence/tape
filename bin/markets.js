#!/usr/bin/env node
'use strict';
/**
 * markets.js — what can I actually call right now?
 *
 * TAPE's write path takes a venue-qualified market id: `polymarket:0x5dc212b712dcf…`.
 * That is the correct thing to SIGN and a terrible thing to ask a human to type into a
 * chat window. Without this, using the agent means going to Polymarket in a browser,
 * finding the market, copying a 66-character condition id, and pasting it back — at which
 * point the chat interface has bought you nothing over a form.
 *
 * So this prints a short numbered menu, and the id stays machine-side where it belongs.
 * The human says "3, no, 0.59"; the agent posts the full id it read from this list.
 *
 * TWO FILTERS THAT ARE NOT COSMETIC:
 *
 * 1. Yes/No only. lib/resolve.js REFUSES to score a market that is not cleanly binary, so
 *    offering a three-way or a "Team A vs Team B" market would let someone post a call
 *    that TAPE can never settle — an entry that sits open forever and quietly degrades the
 *    one guarantee the record makes. The picker must only offer what the scorer can close.
 *
 * 2. Priced strictly inside the book (default 0.08–0.92). The top of Polymarket by
 *    24h volume is dominated by markets trading at 0.9995 where there is no opinion left
 *    to have. Calling one is not a prediction, and a demo that opens on one is a demo of
 *    nothing.
 *
 * A market that is filtered out is COUNTED and reported, so an empty menu is visibly
 * "43 read, 43 filtered" rather than an ambiguous silence that could equally mean the
 * venue is down.
 *
 * usage: markets.js [--limit N] [--search <text>] [--json]
 */

const https = require('https');

const GAMMA = 'gamma-api.polymarket.com';
const MIN_PRICE = 0.08;
const MAX_PRICE = 0.92;
const SCAN = 120;          // how many to read before filtering
const DEFAULT_SHOW = 8;

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: GAMMA, path: pathname, method: 'GET',
      headers: { accept: 'application/json' }, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`gamma ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`gamma sent non-JSON: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('gamma timed out after 15s')));
    req.on('error', reject);
    req.end();
  });
}

// outcomes/outcomePrices arrive as JSON-encoded STRINGS inside the JSON, not as arrays.
// Parsing them defensively matters: a shape change here would otherwise throw inside the
// filter and read as "no markets available".
function parseList(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

function isBinaryYesNo(m) {
  const o = parseList(m.outcomes).map((s) => String(s).trim().toLowerCase());
  return o.length === 2 && o[0] === 'yes' && o[1] === 'no';
}

async function fetchMarkets({ limit = DEFAULT_SHOW, search = null } = {}) {
  const qs = [
    'closed=false', 'active=true', 'order=volume24hr', 'ascending=false', `limit=${SCAN}`,
  ];
  const raw = await get(`/markets?${qs.join('&')}`);
  if (!Array.isArray(raw)) throw new Error('gamma returned a non-list');

  const now = Date.now();
  const stats = { read: raw.length, dropped_not_binary: 0, dropped_priced_out: 0, dropped_expired: 0, dropped_search: 0 };
  const rows = [];
  for (const m of raw) {
    if (!isBinaryYesNo(m)) { stats.dropped_not_binary++; continue; }
    const prices = parseList(m.outcomePrices).map(Number);
    const yes = prices[0];
    if (!isFinite(yes) || yes < MIN_PRICE || yes > MAX_PRICE) { stats.dropped_priced_out++; continue; }
    // Polymarket leaves markets tradeable past their scheduled end while UMA resolves.
    // TAPE's one rule is that a claim counts only if it was anchored BEFORE its outcome
    // could be known, so a menu that offers a market whose window has already closed is
    // handing the caller the exact shot this record exists to refuse.
    const ends = m.endDate ? Date.parse(m.endDate) : NaN;
    if (isFinite(ends) && ends <= now) { stats.dropped_expired++; continue; }
    if (search && !String(m.question || '').toLowerCase().includes(search.toLowerCase())) {
      stats.dropped_search++; continue;
    }
    rows.push({
      market: `polymarket:${m.conditionId}`,
      question: m.question,
      yes: yes.toFixed(4),
      // The NO price is what a NO caller books at. Deriving it here rather than letting a
      // language model compute 1-x keeps arithmetic out of the part of the pipeline that
      // is allowed to be creative.
      no: (1 - yes).toFixed(4),
      ends: m.endDate || null,
    });
    if (rows.length >= limit) break;
  }
  return { rows, stats };
}

function render({ rows, stats }) {
  const out = [];
  if (!rows.length) {
    out.push('No callable markets right now.');
    out.push(`(read ${stats.read} from Polymarket; ${stats.dropped_not_binary} were not Yes/No, ` +
      `${stats.dropped_priced_out} were priced outside ${MIN_PRICE}-${MAX_PRICE}, ` +
      `${stats.dropped_expired} were past their end date` +
      (stats.dropped_search ? `, ${stats.dropped_search} did not match the search` : '') + ')');
    return out.join('\n');
  }
  out.push('Callable markets right now — reply with the number, a side, and your price:');
  out.push('');
  rows.forEach((r, i) => {
    const ends = r.ends ? ` · ends ${String(r.ends).slice(0, 10)}` : '';
    out.push(`${i + 1}. ${r.question}`);
    out.push(`   yes ${r.yes} · no ${r.no}${ends}`);
    out.push(`   id: ${r.market}`);
  });
  out.push('');
  out.push('e.g. "2 no 0.59" — I post it, then anchor it to Solana.');
  // Stated in the tool output, not only in the skill prompt: the agent filling tape_post
  // reads this, and a lane it has to infer is a lane it can get wrong on a record that
  // cannot be corrected afterwards.
  out.push('every row above is lane: prediction');
  out.push(`(${stats.read} markets read; showing ${rows.length} binary Yes/No priced ${MIN_PRICE}-${MAX_PRICE})`);
  return out.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, dflt = null) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? dflt : argv[i + 1];
  };
  const limit = Math.max(1, Math.min(20, Number(flag('limit', DEFAULT_SHOW)) || DEFAULT_SHOW));
  const search = flag('search');
  const asJson = argv.includes('--json');

  const result = await fetchMarkets({ limit, search });
  console.log(asJson ? JSON.stringify(result, null, 1) : render(result));
}

if (require.main === module) {
  main().catch((e) => {
    // Loud, and distinguishable from an empty menu. "I could not reach the venue" and
    // "the venue has nothing for you" are different facts and must never print the same.
    console.error(`MARKETS UNAVAILABLE: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { fetchMarkets, isBinaryYesNo, parseList, MIN_PRICE, MAX_PRICE };
