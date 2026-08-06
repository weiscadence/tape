#!/usr/bin/env node
'use strict';
/**
 * web.js — static server for the TAPE pages.
 *
 * Replaces `pm2 serve`, which binds 0.0.0.0. That listener was reachable on port 3217 from
 * anywhere the firewall let through, so the only thing standing between the open internet
 * and a process nginx was supposed to be the sole entrance to was one ufw rule. Defence
 * that depends on a single rule staying correct forever is a defence with one moving part
 * too many: bind loopback and the rule becomes a backstop instead of the wall.
 *
 * Serves an EXPLICIT FILE LIST rather than a directory. A directory server has to be
 * correct about path traversal on every request; a list is correct by construction, and
 * this directory sits inside the repo next to data the public has no business reading.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.TAPE_WEB_PORT || 3217);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const { ALLOWED, ROOT } = require('../lib/served');
const { buildReceipt } = require('./receipt');
const { renderReceiptPage, renderPendingPage, renderNotFoundPage } = require('../lib/receipt-page');

const ORIGIN = process.env.TAPE_ORIGIN || 'https://tape.drainfun.xyz';

/**
 * /r/<seq> — the shareable receipt page.
 *
 * Rendered here rather than in bin/api.js because api.js is the WRITE surface: the only
 * publicly reachable POST on this box, rate-limited and body-capped accordingly. A page
 * that exists to be pasted around and crawled belongs on the read-only listener.
 *
 * The route is `\d+` and nothing else. No `latest`, no entry-hash selector, even though
 * buildReceipt accepts both — a shared link must point at one fixed row forever, and
 * `/r/latest` is a URL whose meaning changes after you paste it.
 */
function receiptRoute(name, req, res) {
  const m = /^r\/([0-9]{1,9})$/.exec(name);
  if (!m) return false;
  const seq = m[1];

  let html;
  let status = 200;
  // Read fresh per request rather than at boot: declaring a new operator key must take
  // effect on the disclosure immediately, and a cached registry would keep a page saying
  // "not declared as ours" after we had declared it. Small file, and the honest direction
  // of staleness here is the one that flatters us, which is the one to design against.
  let operatorKeys = null;
  try { operatorKeys = JSON.parse(fs.readFileSync(path.join(ROOT, 'operator-keys.json'), 'utf8')); }
  catch { operatorKeys = null; }
  try {
    // Read per request for the same reason operatorKeys is: the gate updates this file on its
    // own schedule and a boot-time snapshot would keep serving a stale question.
    let marketTitles = null;
    try { marketTitles = require('../lib/market-titles').readTitles(); } catch { marketTitles = null; }
    html = renderReceiptPage(buildReceipt(seq), { origin: ORIGIN, operatorKeys, marketTitles });
  } catch (e) {
    // Same split the JSON endpoint makes, for the same reason: "not anchored yet" is a
    // routine fifteen-minute wait and must not render as a missing or censored entry.
    if (/not covered by any anchor/.test(e.message)) {
      status = 202;
      html = renderPendingPage(seq, e.message, { origin: ORIGIN });
    } else {
      status = 404;
      html = renderNotFoundPage(seq, { origin: ORIGIN });
    }
  }

  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    // The receipt now proves against the LATEST covering anchor (see bin/receipt.js, 2026-08-05),
    // so it advances as new anchors land — it is no longer immutable. A long cache served a stale
    // receipt pointing at an anchor a pruning RPC had since dropped, which read as amber "can't
    // tell" on a fresh visit (Jiggy hit this). Revalidate every load so the receipt is always
    // anchored recently enough to verify on any node. The entry it proves is still immutable; only
    // which fresh anchor witnesses it changes.
    'cache-control': status === 200 ? 'no-cache, must-revalidate' : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : buf);
  return true;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
    return res.end('method not allowed\n');
  }

  let name;
  try { name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''); }
  catch { name = ''; }
  // "/" is now the marketing landing; the app/board lives at "/app". Old links to "/" that
  // meant the board are handled by the landing's own "Enter the app" button, and /app.html
  // is accepted as a synonym so a stale bookmark still resolves.
  if (name === '') name = 'landing.html';
  else if (name === 'app' || name === 'app.html') name = 'index.html';

  // Scorer source bundles: scorers/<64-hex>.json. These cannot be a fixed allowlist entry
  // because the name IS the content digest and a new one appears whenever the scoring code
  // changes. The pattern is deliberately total — exactly 64 lowercase hex characters — so
  // it admits no separator, no dot, and therefore no traversal. A bundle that cannot be
  // downloaded would make the scorer_id on every mark row a label instead of a claim.
  if (receiptRoute(name, req, res)) return;

  const scorerMatch = /^scorers\/([0-9a-f]{64})\.json$/.exec(name);
  if (scorerMatch) {
    const file = path.join(ROOT, 'scorers', `${scorerMatch[1]}.json`);
    return fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found\n');
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': buf.length,
        // Immutable by construction: the filename is the digest of the contents.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  if (!ALLOWED.has(name)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found\n');
  }

  // ALLOWED is a whitelist of bare filenames, so traversal is already impossible. This
  // second check costs nothing and means a future edit that loosens the list above cannot
  // silently turn this into a directory server.
  const dir = ALLOWED.get(name);
  const file = path.join(dir, name);
  if (path.dirname(file) !== dir) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found\n');
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found\n');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(name)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': name.endsWith('.json') ? 'no-cache' : 'public, max-age=60',
      'x-content-type-options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

server.headersTimeout = 10 * 1000;
server.requestTimeout = 20 * 1000;
server.keepAliveTimeout = 5 * 1000;
server.maxConnections = 512;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tape web on 127.0.0.1:${PORT}; ${ALLOWED.size} files served`);
});
