#!/usr/bin/env node
'use strict';
/**
 * miniapp.js — backend for the TAPE Telegram Mini App.
 *
 * Three read routes and one write route, on loopback behind nginx. The write route is the
 * only interesting one: it turns a tap in Telegram into a real, vouched, unsigned entry on
 * the tape, anchored by the existing cron like any other call.
 *
 * WHY VOUCHED-UNSIGNED AND NOT SIGNED. The public signed API (bin/api.js) makes the caller
 * sign on their own machine — correct for agents, impossible for a human who just tapped a
 * button. So the mini-app path is the same shape as the CLI (bin/post.js): we append an
 * UNSIGNED entry and vouch for the name. The vouch is Telegram's initData HMAC — verified
 * per request, never minted here. An unsigned row always renders `unsigned:<name>`, so it
 * can never be confused with a wallet-verified caller; the badge distinction is preserved.
 *
 * WHAT THIS NEVER DOES: hold a key, sign anything, or move a lamport. T1. The only on-chain
 * write is the anchor, done by the anchor cron with the anchor key, exactly as before.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { verifyInitData } = require('../lib/telegram-initdata');
const { buildEntry, newNonce } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { DATA_DIR: DATA } = require('../lib/datadir');
const { recordTitle } = require('../lib/market-titles');
const { buildReceipt } = require('./receipt');
const { plainReceipt } = require('../lib/receipt-plain');
const { standing } = require('../lib/tiers');

const PORT = Number(process.env.TAPE_MINIAPP_PORT || 3219);
const APP_HTML = path.join(__dirname, '..', 'web', 'app-prototype.html');
const BOT_TOKEN = (() => {
  try {
    const f = process.env.TAPE_BOT_KEYFILE
      || path.join(process.env.HOME || '/home/ubuntu', '.config/cadence-secure/tape-bot.json');
    return JSON.parse(fs.readFileSync(f, 'utf8')).bot_token;
  } catch { return null; }
})();

const MAX_BODY = 8 * 1024;
const chain = new Chain(path.join(DATA, 'tape.jsonl'));

// ---- markets cache (live Polymarket, refreshed on an interval) ---------------------------
let marketsCache = { at: 0, data: [] };
function refreshMarkets() {
  const url = 'https://gamma-api.polymarket.com/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=60';
  https.get(url, (r) => {
    let buf = '';
    r.on('data', (c) => { buf += c; if (buf.length > 4e6) r.destroy(); });
    r.on('end', () => {
      try {
        const rows = JSON.parse(buf);
        const out = [];
        for (const m of (Array.isArray(rows) ? rows : rows.data || [])) {
          if (!m.question) continue;
          let yes = null;
          try { yes = Number((typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices)[0]); } catch { /**/ }
          if (!(yes >= 0.06 && yes <= 0.94)) continue;
          const v = Number(m.volume24hr) || 0;
          if (v < 50000) continue;
          out.push({ q: m.question, yes: Math.round(yes * 100) / 100, vol24: Math.round(v), id: m.conditionId });
        }
        marketsCache = { at: Date.now(), data: out.slice(0, 24) };
      } catch (e) { /* keep the last good cache */ }
    });
  }).on('error', () => { /* keep the last good cache */ });
}

// ---- display names -----------------------------------------------------------------------
//
// `unsigned:cadence-wave` is what the SCORE ENGINE calls that identity and it must never change:
// the prefix is how a vouched-unsigned row is prevented from passing as wallet-verified, and
// every artifact, receipt and API response keeps it. But on a leaderboard it is noise in front of
// the only word a reader cares about — "messy", per Jiggy, 2026-08-07 — and the badge beside the
// name (HUMAN · TELEGRAM vs ◈ WALLET-VERIFIED) already carries the same information in words a
// person reads without decoding a prefix.
//
// So the prefix is stripped for DISPLAY only. The catch is that the prefix was also doing a second
// job nobody wrote down: disambiguation. `cadence-wave` and `unsigned:cadence-wave` are different
// identities that would both render as "cadence-wave" and sit at ranks 1 and 6 of the same board.
// Dropping the prefix without replacing that would make the board quietly ambiguous, which is
// worse than ugly. When a bare name is claimed by more than one identity, the collided rows carry
// an explicit qualifier — never the bare name alone.
function withDisplayNames(rows) {
  const bare = (c) => String(c || '').replace(/^unsigned:/, '');
  const seen = new Map();
  for (const b of rows) {
    const k = bare(b.caller);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(b.identity);
  }
  return rows.map((b) => {
    const name = bare(b.caller);
    const contested = (seen.get(name) || new Set()).size > 1;
    return {
      ...b,
      display: name,
      // Only appears when it has to. A qualifier on every row would just be the prefix again.
      qualifier: contested ? (b.caller.startsWith('unsigned:') ? 'via telegram' : 'signed key') : null,
      unsigned: b.caller.startsWith('unsigned:'),
    };
  });
}

// ---- board cache (the real leaderboard artifact, recomputed on an interval) --------------
let boardCache = { at: 0, data: [], positions: [] };
function refreshBoard() {
  const { execFile } = require('child_process');
  execFile('node', [path.join(__dirname, 'leaderboard.js'), '--json'],
    { cwd: path.join(__dirname, '..'), timeout: 120000, maxBuffer: 8e6 },
    (err, stdout) => {
      if (err) return; // keep last good
      try {
        const art = JSON.parse(stdout);
        boardCache = {
          at: Date.now(),
          data: withDisplayNames((art.board || []).map((b) => ({
            caller: b.caller, identity: b.identity, edge: b.edge, wins: b.wins, losses: b.losses,
            open: b.open, tier: b.tier, kind: b.caller.startsWith('unsigned:') ? 'human'
              : /…|\.\.\./.test(b.caller) ? 'verified' : 'agent',
          }))),
          // Keep the scored positions so a caller-profile can show a per-call, chain-verifiable
          // bar chart. Only SCORED rows travel — unresolved/unscored calls are not things "the
          // chain can be sure about" yet, which is exactly the honesty the product is about.
          positions: (art.positions || []).filter((p) => p.scoring === 'scored').map((p) => ({
            identity: p.identity, caller: p.caller, lane: p.lane, market: p.market, side: p.side,
            pnl: p.pnl, edge: p.edge, close_slot: p.close_slot, seq: p.seq,
          })),
        };
      } catch { /* keep last good */ }
    });
}

// ---- market categorisation (what KIND of caller someone is) ------------------------------
let TITLES = {};
function loadTitles() { try { TITLES = JSON.parse(fs.readFileSync(path.join(DATA, 'market-titles.json'), 'utf8')); } catch { /* keep */ } }
loadTitles(); setInterval(loadTitles, 5 * 60 * 1000).unref();
function titleOf(m) {
  if (TITLES[m] && TITLES[m].title) return TITLES[m].title;
  const c = marketsCache.data.find((x) => ('polymarket:' + x.id) === m);
  if (c) return c.q;
  if (m.startsWith('github:')) return m.replace('github:', '').split(':')[0];
  return m.replace(/^(pyth|demo|delphi|polymarket):/, '').slice(0, 40);
}
function categorize(m) {
  if (m.startsWith('github:')) return 'Dev';
  if (/^pyth:|^demo:.*(sol|btc|eth)/i.test(m)) return 'Crypto';
  const t = titleOf(m).toLowerCase();
  const has = (...ws) => ws.some((w) => t.includes(w));
  // Politics FIRST so "win the nomination" doesn't fall into Sports on "win the".
  if (has('election', 'nominat', 'presidential', 'republican', 'democrat', 'prime minister', 'congress', 'senate', 'signed into law', 'clarity act', 'vance', 'impeach', 'president')) return 'Politics';
  if (has('iran', 'blockade', 'ceasefire', 'invade', 'hormuz', 'war', 'military', 'sanction')) return 'Politics';
  if (has('fed', 'interest rate', 'rate hike', 'inflation', 'cpi', 'recession', 'gdp', 'jobs report')) return 'Macro';
  if (has('oil', 'wti', 'crude', 'gold', 'natural gas', 'commodity')) return 'Commodities';
  if (has('temperature', 'weather', 'rain', 'snow')) return 'Weather';
  if (has('vs.', ' vs ', 'ufc', 'fight night', 'nba', 'nfl', 'mlb', 'padres', 'diamondback', 'sox', 'yankee', 'dodger', 'marlin', 'brave', 'tennis', 'national bank open', 'laliga', 'barcelona', 'champions league', 'valorant', 'vct', 'golf', 'wyndham', 'sabalenka', 'musetti', 'norrie')) return 'Sports';
  if (has('sol', 'btc', 'eth', 'solana', 'bitcoin', 'ethereum', 'token', 'price')) return 'Crypto';
  return 'Other';
}
function specializationOf(calls) {
  const cats = {};
  for (const c of calls) { c.category = categorize(c.market); c.label = titleOf(c.market); cats[c.category] = (cats[c.category] || 0) + 1; }
  const list = Object.entries(cats).map(([cat, n]) => ({ cat, n })).sort((a, b) => b.n - a.n);
  const top = list[0];
  const spec = !list.length ? null : (top.n / calls.length >= 0.6 ? `${top.cat} caller` : `spread · ${list.length} lanes`);
  return { categories: list, specialization: spec };
}

// The signed-in user's own calls, read straight from the chain so a just-posted OPEN call
// shows immediately (the leaderboard cache lags 5 min and only counts settled calls). Open
// bags are shown as open — the whole point is they don't disappear until they resolve.
function myCalls(handle) {
  const rows = chain.read();
  const byMarket = new Map();
  for (const r of rows) {
    const e = r.entry;
    if (!e || e.caller !== handle || e.lane !== 'prediction') continue;
    if (e.type === 'open') byMarket.set(e.market, { market: e.market, side: e.side, entry: Number(e.entry_ref), size: Number(e.size) || 1, seq: r.seq, settle: null, ts: e.ts_claimed });
    else if (e.type === 'amend' && byMarket.has(e.market)) { const p = byMarket.get(e.market); p.side = e.side || p.side; p.entry = Number(e.entry_ref); }
    else if (e.type === 'close' && byMarket.has(e.market)) byMarket.get(e.market).settle = Number(e.entry_ref);
  }
  const calls = [...byMarket.values()].map((p) => {
    if (p.settle === null) return { ...p, status: 'open' };
    const win = p.side === 'no' ? 1 - p.settle : p.settle;
    return { ...p, status: 'settled', won: win > p.entry, pnl: win - p.entry };
  }).reverse();
  const spec = specializationOf(calls);
  return {
    handle,
    calls,
    open: calls.filter((c) => c.status === 'open').length,
    settled: calls.filter((c) => c.status === 'settled').length,
    categories: spec.categories,
    specialization: spec.specialization,
    // What they've earned and what the next rung costs. Computed here rather than in the client
    // so the rules are one implementation a caller can re-run against their own calls.
    standing: standing(calls),
  };
}

// A caller's chain-verifiable record, grouped by lane, for the profile popup.
function callerDetail(identity) {
  const rows = boardCache.positions.filter((p) => p.identity === identity);
  const meta = boardCache.data.find((b) => b.identity === identity) || {};
  const lanes = {};
  const calls = rows.map((p) => {
    const pnl = Number(p.pnl) || 0;
    const l = (lanes[p.lane] = lanes[p.lane] || { lane: p.lane, n: 0, wins: 0, pnl: 0 });
    l.n += 1; l.pnl += pnl; if (pnl > 0) l.wins += 1;
    return { market: p.market, side: p.side, pnl, edge: Number(p.edge) || 0, won: pnl > 0, seq: p.seq };
  }).sort((a, b) => a.seq - b.seq);
  // Open positions for this identity, read from the chain. Disclosed publicly (you can't hide
  // a bag) but NOT scored — outcome is unknown until it settles. Specialization ("what kind of
  // caller") is computed over open + settled, so a caller's TYPE is visible from what they call,
  // not only from what's resolved.
  const chainRows = chain.read();
  const closedRefs = new Set(chainRows.filter((r) => r.entry && r.entry.type === 'close' && r.entry.ref).map((r) => r.entry.ref));
  const idOf = (e) => (e.signer ? 'key:' + e.signer : 'name:' + e.caller);
  const open = chainRows.filter((r) => r.entry && r.entry.type === 'open' && r.entry.lane === 'prediction'
    && idOf(r.entry) === identity && !closedRefs.has(r.entry_hash))
    .map((r) => ({ market: r.entry.market, side: r.entry.side, size: Number(r.entry.size) || 1, entry: Number(r.entry.entry_ref), seq: r.seq }));
  const spec = specializationOf([...calls, ...open]);
  const rawCaller = meta.caller || (rows[0] && rows[0].caller) || (open[0] && open[0].caller) || identity;
  return {
    // Same display rule as the board — a profile opened from a row must not rename its subject.
    caller: meta.display || String(rawCaller).replace(/^unsigned:/, ''),
    qualifier: meta.qualifier || null,
    kind: meta.kind || 'agent', edge: meta.edge, wins: meta.wins, losses: meta.losses,
    settled: calls.length, lanes: Object.values(lanes), calls, open,
    categories: spec.categories, specialization: spec.specialization,
  };
}

// ---- helpers -----------------------------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = ''; let over = false;
    req.on('data', (c) => { b += c; if (b.length > MAX_BODY) { over = true; req.destroy(); } });
    req.on('end', () => over ? reject(new Error('body too large')) : resolve(b));
    req.on('error', reject);
  });
}

const LIVE_PRICE = (p) => Number.isFinite(p) && p > 0 && p < 1;

async function handleCall(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
  const { initData, market, side, price, size } = body || {};

  const v = verifyInitData(initData, BOT_TOKEN);
  if (!v.ok) return json(res, 401, { error: 'unverified', reason: v.reason });
  const handle = v.user && (v.user.username || `tg${v.user.id}`);
  if (!handle) return json(res, 401, { error: 'no telegram user' });

  if (typeof market !== 'string' || !/^polymarket:0x[0-9a-fA-F]{64}$/.test(market)) {
    return json(res, 400, { error: 'market must be polymarket:<conditionId>' });
  }
  if (side !== 'yes' && side !== 'no') return json(res, 400, { error: 'side must be yes|no' });
  const p = Number(price);
  if (!LIVE_PRICE(p)) return json(res, 400, { error: 'price must be between 0 and 1' });
  // Size is the conviction/stake in units — a required, deliberate choice so a call is never a
  // careless one-tap, and so the record carries how much someone stood behind each call.
  // Fractional units are allowed (a 0.25u "lean" is a real, weaker conviction) up to 1000.
  const units = Math.round(Number(size) * 100) / 100;
  if (!Number.isFinite(units) || units < 0.25 || units > 1000) return json(res, 400, { error: 'size must be 0.25–1000 units' });

  // Write down the question we were showing when they tapped.
  //
  // A Polymarket condition id is opaque, so a receipt for a call made here rendered as a bare
  // 64-hex string — "the receipt is unreadable to a human, idk what it's claiming" (Jiggy on his
  // own receipt #386, 2026-08-07). The gate's resolver only caches a title once a market is being
  // resolved, which is far too late: the receipt is read the moment the call is made.
  //
  // The title comes from OUR cache of Polymarket's feed, never from the request body — a caller
  // must not be able to choose the words their own receipt renders. It is still an annotation,
  // stamped with a fetch time and marked unsigned everywhere it is shown.
  const seen = marketsCache.data.find((x) => ('polymarket:' + x.id) === market);
  if (seen && seen.q) { try { recordTitle(market, seen.q); } catch { /* annotation only — never block a call */ } }

  let rec;
  try {
    const entry = buildEntry({
      type: 'open',
      caller: handle,            // free-text label → renders as unsigned:<handle>
      lane: 'prediction',
      market,
      side,
      size: String(units),
      entry_ref: p.toFixed(4),
      ts_claimed: new Date().toISOString(),
      nonce: newNonce(),
    });
    rec = chain.append(entry);   // append is lock-guarded for the concurrent-writer case
  } catch (e) {
    return json(res, 400, { error: 'rejected', reason: e.message });
  }
  return json(res, 200, { ok: true, seq: rec.seq, entry_hash: rec.entry_hash, caller: `unsigned:${handle}`, anchored: false });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/app' || u.pathname === '/index.html')) {
      const html = fs.readFileSync(APP_HTML);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && u.pathname === '/api/markets') {
      return json(res, 200, { at: marketsCache.at, markets: marketsCache.data });
    }
    if (req.method === 'GET' && u.pathname === '/api/board') {
      return json(res, 200, { at: boardCache.at, board: boardCache.data });
    }
    if (req.method === 'GET' && u.pathname === '/api/caller') {
      const id = u.searchParams.get('identity');
      if (!id) return json(res, 400, { error: 'identity required' });
      return json(res, 200, callerDetail(id));
    }
    // A receipt the app can render in a sheet instead of throwing the reader into Safari.
    //
    // Same receipt bytes as /r/<seq> — this returns the built receipt AND a plain-English
    // reading of it, so the mini app never has to invent its own account of what a row claims.
    // 202 (not 404) while unanchored: that is a routine ≤15-minute wait, and the API already
    // learned once that returning a failure shape for it makes every client cry wolf.
    if (req.method === 'GET' && u.pathname === '/api/receipt') {
      const seq = u.searchParams.get('seq');
      if (!/^[0-9]{1,9}$/.test(String(seq))) return json(res, 400, { error: 'seq required' });
      let built;
      try { built = buildReceipt(String(seq)); } catch (err) {
        const pending = /not covered by any anchor/.test(err.message);
        return json(res, pending ? 202 : 404, { error: pending ? 'pending' : 'not found', reason: err.message });
      }
      return json(res, 200, { receipt: built, plain: plainReceipt(built, { titles: TITLES }) });
    }
    if (req.method === 'POST' && u.pathname === '/api/call') {
      return await handleCall(req, res);
    }
    if (req.method === 'POST' && u.pathname === '/api/mycalls') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
      const v = verifyInitData(body && body.initData, BOT_TOKEN);
      if (!v.ok) return json(res, 401, { error: 'unverified', reason: v.reason });
      const handle = v.user && (v.user.username || `tg${v.user.id}`);
      return json(res, 200, myCalls(handle));
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: 'server', reason: e.message });
  }
});

if (require.main === module) {
  if (!BOT_TOKEN) { console.error('miniapp: no bot token — /api/call will reject everything'); }
  refreshMarkets(); refreshBoard();
  setInterval(refreshMarkets, 5 * 60 * 1000).unref();
  setInterval(refreshBoard, 5 * 60 * 1000).unref();
  server.listen(PORT, '127.0.0.1', () => console.log(`tape miniapp on http://127.0.0.1:${PORT}`));
}

module.exports = { server, handleCall };
