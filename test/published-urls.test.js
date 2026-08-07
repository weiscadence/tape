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

// Both prose documents written for machine readers. Hoisted here because the download check
// above uses them too — llms.txt names six downloadable tools.
const PROSE_DOCS = ['tape-skill.md', 'llms.txt'];
const PROSE_TEXT = PROSE_DOCS
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8'))
  .join('\n');

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
  // Prose docs are concatenated in below (see PROSE_DOCS): llms.txt names six downloadable
  // tools, and a name added there but not to lib/served.js is the exact "shipped a tool and
  // never exposed it" pattern the ALLOWED map documents four separate times.
  const text = JSON.stringify(doc) + PROSE_TEXT;
  // `md` added 2026-08-07 with tape-skill.md. The extension list is an allowlist, so a new file
  // type is invisible to this check until it is named here — the skill was documented, linked
  // and unserved-by-default, and this assertion said nothing.
  const files = [...new Set([...text.matchAll(/https:\/\/tape\.drainfun\.xyz\/([A-Za-z0-9._-]+\.(?:mjs|json|html|md))/g)].map((m) => m[1]))];
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
/**
 * BOTH PAGES, 2026-08-07. This block called itself "the landing page" and read index.html —
 * true when it was written, false since "/" moved to landing.html and index.html became the
 * app (see bin/web.js). So the page a first-time visitor actually lands on had NO link check
 * at all, and the check that existed was silently guarding a different file than its own
 * comments claimed. Found by adding links to landing.html and noticing the suite stayed green.
 *
 * Reading the map of served names rather than a hardcoded pair would be better still, but the
 * two HTML entry points are the two a reader can arrive at, and naming them is honest about
 * that. A third page added later gets no coverage until someone adds it here — stated, rather
 * than left as a silent hole.
 */
const PAGES = ['landing.html', 'index.html'];
const pageLinks = PAGES.flatMap((f) => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8');
  return [...html.matchAll(/href="([^"#]+)"/g)]
    .map((m) => m[1])
    .filter((h) => !h.includes("' +") && !/^https?:/.test(h)) // skip absolute + JS-built URLs
    .map((h) => ({ page: f, href: h }));
});

/**
 * Routes that are real but are not static files, so the ALLOWED map cannot vouch for them.
 *
 * `/app` is nginx -> the mini-app listener (and bin/web.js aliases the same name to index.html
 * for direct hits). Measured live while extending this scan to landing.html: /app 301s to
 * /app/ which returns 200. Without this list the extension reported the site's most-clicked
 * link as dead — a checker that cries wolf on a working route gets muted, and a muted checker
 * is worse than none.
 *
 * KEPT DELIBERATELY SHORT. Every entry is a route this offline test cannot actually verify, so
 * the list is the residue, not a convenience. It must never grow to the point where a genuinely
 * dead link can hide in it — which is what the CONTROL below exists to keep honest.
 */
const NON_STATIC_ROUTES = ['/app', '/app/'];
const linkResolves = (h) => h.startsWith('/api/')
  || NON_STATIC_ROUTES.includes(h)
  || allowed.has(h.replace(/^\//, ''));

t('the page-link scan found links at all (canary — an empty list passes vacuously)', () => {
  assert.ok(pageLinks.length >= 3, `scanned only ${pageLinks.length} link(s); the regex has drifted`);
});

t('the scan covers BOTH entry pages (canary — one silent page is how this bug shipped)', () => {
  for (const p of PAGES) {
    assert.ok(pageLinks.some((l) => l.page === p), `no links scanned from ${p}`);
  }
});

t('every link on either entry page points at something that is actually served', () => {
  const dead = pageLinks.filter((l) => !linkResolves(l.href)).map((l) => `${l.page} -> ${l.href}`);
  assert.deepStrictEqual(dead, [], `dead link(s): ${dead.join(', ')}`);
});

t('CONTROL: a link to an unserved file would be caught', () => {
  assert.strictEqual(linkResolves('agent.json'), false,
    'this is the exact link that shipped — agent.json is served under /api/, not by the static router');
  assert.strictEqual(linkResolves('board.json'), true);
});

/**
 * The skill doc's /api/ paths must be paths the API actually declares.
 *
 * This is the residue named above ("what it CANNOT check is whether an /api/ route exists"),
 * and it bit immediately: tape-skill.md told agents to `GET /caller/<your-pubkey>` for their
 * standing. The route is `/api/caller/`. The bare path 404s. Every other check in this file
 * passed — the link scan only covers HTML, and the download scan only covers static files, so
 * a prose instruction in the one document written specifically FOR agents was the least
 * guarded surface on the site.
 *
 * Offline: agent.json's own endpoint list is the authority, so this cannot be flaky and cannot
 * drift from the server. Path params are normalised to `*` because `<pubkey>` and `<signer>`
 * are the same route with different prose.
 */
const SKILL = PROSE_TEXT;
const normalise = (p) => p.replace(/<[^>]*>?/g, '*').replace(/\/+$/, '');
const declared = new Set(
  Object.keys(doc.endpoints)
    .map((k) => normalise(k.replace(/^(GET|POST) /, '').replace(CANON, '')))
);
// agent.json does not list itself, and /api/agent (the HTML-ish intro) is a sibling of it.
// Both are verified-live 200s; naming them here keeps the residue explicit rather than
// widening the regex until nothing can fail.
const SELF_DESCRIBING = ['/api/agent.json', '/api/agent'];

const skillPaths = [...new Set(
  [...SKILL.matchAll(/(?:^|[\s`("'])(\/api\/[A-Za-z0-9._/-]*(?:<[^>]*>)?[A-Za-z0-9._/-]*)/g)]
    .map((m) => normalise(m[1]))
    .filter(Boolean)
)];

t('the prose path scan found paths at all (canary — an empty list passes vacuously)', () => {
  assert.ok(skillPaths.length >= 6,
    `scanned only ${skillPaths.length} /api/ path(s) from the prose docs; the regex has drifted`);
});

t('BOTH prose docs are in the scan (canary — one silent doc is how the last one shipped)', () => {
  for (const f of PROSE_DOCS) {
    const body = fs.readFileSync(path.join(__dirname, '..', 'web', f), 'utf8');
    assert.ok(/\/api\//.test(body), `${f} contributed no /api/ paths — it is being scanned vacuously`);
  }
});

t('every /api/ path quoted in the skill doc is a route the API declares', () => {
  const undeclared = skillPaths.filter((p) => !declared.has(p) && !SELF_DESCRIBING.includes(p));
  assert.deepStrictEqual(undeclared, [],
    `skill doc instructs agents to call undeclared route(s): ${undeclared.join(', ')}`);
});

t('the skill doc never quotes a bare route that is only valid under /api/', () => {
  // The actual shipped bug: `GET /caller/<pubkey>`, no /api/ prefix, 404 on every host.
  // Take the STATIC PREFIX of each route, so parameterised ones are covered too. The first
  // version of this filtered out anything containing `*` — which excluded /api/caller/*, the
  // exact route the bug was in, and the test passed on the reintroduced bug. Caught only by
  // re-breaking it on purpose; a green suite is not evidence that the check discriminates.
  const bareNames = [...new Set([...declared]
    .map((p) => p.replace(/^\/api\//, '').split('*')[0].replace(/\/+$/, ''))
    .filter(Boolean))];
  const bare = bareNames.filter((n) => new RegExp(`(?:GET|POST) /${n}\\b`).test(SKILL));
  assert.deepStrictEqual(bare, [],
    `quoted without the /api/ prefix: ${bare.map((b) => `/${b}`).join(', ')}`);
});

t('CONTROL: an undeclared route in the skill doc would be caught', () => {
  assert.strictEqual(declared.has('/api/caller/*'), true, 'normalisation dropped a real route');
  assert.strictEqual(declared.has('/api/does-not-exist'), false,
    'the declared-route check does not actually discriminate');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
