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
let boardCache = { at: 0, data: [] };
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
            caller: b.caller, edge: b.edge, wins: b.wins, losses: b.losses,
            open: b.open, kind: b.caller.startsWith('unsigned:') ? 'human'
              : /…|\.\.\./.test(b.caller) ? 'verified' : 'agent',
          })),
        };
      } catch { /* keep last good */ }
    });
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
  const { initData, market, side, price } = body || {};

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

  let rec;
  try {
    const entry = buildEntry({
      type: 'open',
      caller: handle,            // free-text label → renders as unsigned:<handle>
      lane: 'prediction',
      market,
      side,
      size: '1',
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
    if (req.method === 'POST' && u.pathname === '/api/call') {
      return await handleCall(req, res);
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
