'use strict';
/**
 * published-urls.test.js — a URL we publish must be a URL that works.
 *
 * WHY THIS EXISTS (2026-07-31). agent.json declared its endpoints as RELATIVE paths —
 * `POST /tape/api/call` — which was exactly right while drainfun.xyz was the only origin.
 * Then the same document started being served from tape.drainfun.xyz too, and on that host
 * `/tape/api/call` is a 404. An agent that fetched agent.json from the new front door and
 * resolved the paths against the host it fetched them from got a 404 on every single call,
 * from a document that looked complete and self-consistent. Nothing was down. Every service
 * returned 200 to us. The failure was only visible from the outside.
 *
 * Two rules, both offline and both mechanical, because the live probe (verify/tape-links.mjs)
 * can only run when the network is up and a check that can be skipped is a check that will be:
 *
 *   1. Every endpoint key is ABSOLUTE. A relative path in a document served from two
 *      origins is not a path, it is a guess about which one the reader used.
 *   2. Every static file the docs tell someone to download is a file the router will serve.
 *      Both of these have been wrong at the same time: the docs named four verifier tools
 *      that were 404 under every name the documentation used.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { agentDoc } = require('../bin/api.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const doc = agentDoc();
const CANON = 'https://tape.drainfun.xyz';

console.log('\nPUBLISHED URLS — absolute, and pointing at something that exists');

t('every endpoint key is an absolute URL, never an origin-relative path', () => {
  const bad = Object.keys(doc.endpoints).filter((k) => !/^(GET|POST) https:\/\//.test(k));
  assert.deepStrictEqual(bad, [], `relative endpoint key(s): ${bad.join(', ')}`);
});

t('every endpoint key uses the canonical base — one name, not two', () => {
  const stray = Object.keys(doc.endpoints)
    .map((k) => k.replace(/^(GET|POST) /, ''))
    .filter((u) => !u.startsWith(`${CANON}/`));
  assert.deepStrictEqual(stray, [], `endpoint(s) off the canonical base: ${stray.join(', ')}`);
});

t('the canonical base is stated in the document, not left to be inferred', () => {
  assert.strictEqual(doc.canonical_base, CANON);
  assert.match(String(doc.also_reachable_at), /drainfun\.xyz\/tape/);
});

// The router's allowlist, read from the server rather than restated here. Restating it
// would make this test agree with a copy of the truth instead of the truth.
//
// It used to REGEX bin/web.js for the map literal. That worked until the map was extracted
// into lib/served.js, at which point the regex matched nothing — and the canary below is the
// only reason that showed up as a failure instead of as a suite where every download
// assertion quietly held over an empty set. Requiring the module removes the parse entirely:
// there is no longer a pattern that can drift away from the thing it describes.
const { ALLOWED } = require('../lib/served');
const allowed = new Set(ALLOWED.keys());

t('the router allowlist was actually parsed (canary — an empty set would pass everything)', () => {
  assert.ok(allowed.size >= 5, `parsed only ${allowed.size} allowed file(s); the regex has drifted `
    + 'and every download assertion below would be vacuously true');
  assert.ok(allowed.has('index.html'), 'index.html missing from the parsed allowlist');
});

t('every file the docs say to download is a file the router serves', () => {
  const text = JSON.stringify(doc);
  const files = [...new Set([...text.matchAll(/https:\/\/tape\.drainfun\.xyz\/([A-Za-z0-9._-]+\.(?:mjs|json|html))/g)].map((m) => m[1]))];
  assert.ok(files.length >= 3, `expected the docs to name several downloadable tools, found ${files.length}`);
  const missing = files.filter((f) => !allowed.has(f));
  assert.deepStrictEqual(missing, [], `documented but NOT served: ${missing.join(', ')}`);
});

t('no client is served from a copy — the file on disk is the file being edited', () => {
  // web/tape-call.mjs and verify/tape-call.mjs diverged twice, in both directions: web/ held
  // a receipt-naming bugfix verify/ never got, and an edit to verify/ never reached anyone
  // because verify/ was not the file being downloaded. Editing the source and shipping the
  // copy is indistinguishable from editing nothing.
  const twin = path.join(__dirname, '..', 'web', 'tape-call.mjs');
  assert.ok(!fs.existsSync(twin), 'web/tape-call.mjs is back — it is a copy of verify/tape-call.mjs and will drift again');
});

t('CONTROL: a relative endpoint key would be caught', () => {
  const rigged = { ...doc, endpoints: { ...doc.endpoints, 'GET /tape/api/health': 'x' } };
  const bad = Object.keys(rigged.endpoints).filter((k) => !/^(GET|POST) https:\/\//.test(k));
  assert.strictEqual(bad.length, 1, 'the absoluteness check does not actually discriminate');
});

t('CONTROL: a documented-but-unserved download would be caught', () => {
  const missing = ['tape-does-not-exist.mjs'].filter((f) => !allowed.has(f));
  assert.strictEqual(missing.length, 1, 'the allowlist check does not actually discriminate');
});


/**
 * Every link on the landing page must resolve.
 *
 * THIRD TIME TODAY for this bug class. agent.json declared relative endpoints and 404'd once
 * the docs moved host; tape-call.mjs was served from a copy nobody edited; and then, while
 * restructuring this very page, a `for agents` button was added pointing at `agent.json`,
 * which the static router does not serve — it lives under /api/. Each time the page returned
 * 200 and looked complete. A link that 404s is indistinguishable from a broken product.
 *
 * Offline by design: the ALLOWED map says what the static router serves, and an /api/ path is
 * the API's business, so this needs no network and cannot be flaky. What it CANNOT check is
 * whether an /api/ route exists — that is the residue, and it is named here rather than
 * pretended away.
 */
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const pageLinks = [...indexHtml.matchAll(/href="([^"#]+)"/g)]
  .map((m) => m[1])
  .filter((h) => !h.includes("' +") && !/^https?:/.test(h)); // skip absolute + JS-built URLs

const linkResolves = (h) => h.startsWith('/api/') || allowed.has(h.replace(/^\//, ''));

t('the page-link scan found links at all (canary — an empty list passes vacuously)', () => {
  assert.ok(pageLinks.length >= 3, `scanned only ${pageLinks.length} link(s); the regex has drifted`);
});

t('every link on the landing page points at something that is actually served', () => {
  const dead = pageLinks.filter((h) => !linkResolves(h));
  assert.deepStrictEqual(dead, [], `dead link(s) on the landing page: ${dead.join(', ')}`);
});

t('CONTROL: a link to an unserved file would be caught', () => {
  assert.strictEqual(linkResolves('agent.json'), false,
    'this is the exact link that shipped — agent.json is served under /api/, not by the static router');
  assert.strictEqual(linkResolves('board.json'), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
