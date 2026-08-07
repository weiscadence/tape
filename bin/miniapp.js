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
          data: (art.board || []).map((b) => ({
            caller: b.caller, identity: b.identity, edge: b.edge, wins: b.wins, losses: b.losses,
            open: b.open, kind: b.caller.startsWith('unsigned:') ? 'human'
              : /…|\.\.\./.test(b.caller) ? 'verified' : 'agent',
          })),
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
  if (has('marlin', 'brave', 'red sox', 'white sox', 'yankee', 'nba', 'nfl', 'soccer', 'laliga', 'barcelona', 'champions league', 'tennis', 'national bank open', 'norrie', 'musetti', 'sabalenka', 'golf', 'wyndham', 'valorant', 'vct', ' vs ', 'win the')) return 'Sports';
  if (has('iran', 'blockade', 'ceasefire', 'invade', 'election', 'president', 'prime minister', 'vance', 'nominee', 'clarity act', 'signed into law', 'hormuz')) return 'Politics';
  if (has('fed', 'interest rate', 'rate', 'inflation', 'cpi', 'recession')) return 'Macro';
  if (has('oil', 'wti', 'crude', 'gold', 'gas')) return 'Commodities';
  if (has('sol', 'btc', 'eth', 'solana', 'bitcoin', 'ethereum', 'price')) return 'Crypto';
  if (has('temperature', 'weather', 'rain')) return 'Weather';
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
  return { handle, calls, open: calls.filter((c) => c.status === 'open').length, settled: calls.filter((c) => c.status === 'settled').length, categories: spec.categories, specialization: spec.specialization };
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
  const spec = specializationOf(calls);
  return {
    caller: meta.caller || (rows[0] && rows[0].caller) || identity,
    kind: meta.kind || 'agent', edge: meta.edge, wins: meta.wins, losses: meta.losses,
    settled: calls.length, lanes: Object.values(lanes), calls,
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
  const units = Math.round(Number(size));
  if (!Number.isFinite(units) || units < 1 || units > 1000) return json(res, 400, { error: 'size must be 1–1000 units' });

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
