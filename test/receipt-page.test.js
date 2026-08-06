'use strict';
/**
 * receipt-page.test.js — the shareable receipt page, /r/<seq>.
 *
 * WHAT THIS GUARDS. The page exists to be pasted into places we do not control, which means
 * two things have to be true and neither is visible by looking at it:
 *
 *   1. Every field on the page is signed by a stranger. `caller` and `note` are free text
 *      chosen by whoever holds the key. If one of them can close a tag, the receipt page
 *      turns the tape into an injection vector aimed at everyone the link gets pasted to.
 *      The XSS test below signs nothing — it feeds a hostile receipt straight to the
 *      renderer, which is the only way to exercise the escape path in the state it exists
 *      for.
 *
 *   2. The commands the page PRINTS have to be the commands that work. The page tells a
 *      reader to fetch `/tape-verify.mjs` and `/api/entry/<seq>`; if either path stops being
 *      served, the page still renders perfectly while its central promise — check this
 *      without us — silently becomes a pair of 404s. So the URLs are asserted against
 *      lib/served.js, the actual routing table, rather than against a copy of my intent.
 *
 * The route regex is tested for what it must REFUSE, because it is the only pattern in
 * bin/web.js that takes a path segment from the user.
 */

const assert = require('assert');
const { test } = require('node:test');

const { renderReceiptPage, renderPendingPage, renderNotFoundPage, describeMarket, esc } =
  require('../lib/receipt-page');
const { ALLOWED } = require('../lib/served');

const RECEIPT = {
  entry: {
    v: '1', type: 'open', caller: 'cadence-wave', lane: 'prediction',
    market: 'pyth:SOL:above:70@2026-08-07T00:00:00Z', side: 'yes', size: '1',
    entry_ref: '0.72', ts_claimed: '2026-07-30T22:35:53.513Z', ref: null,
    nonce: 'da137742ba196fee14cc49d4a3b06c7c', note: 'first price market on the tape',
    signer: '2hsSKcSzE7KNhDRFMLHetWx3P6qyrVBJAXyMpHFK2Mcu', sig: '287fAZSx',
  },
  proof: [{ side: 'left', hash: 'd2a5' }, { side: 'left', hash: '32bf' }],
  anchor: {
    signature: '3ATsMXFa', root: 'f3cfbe89', slot: 436241109, cluster: 'mainnet',
    explorer: 'https://solscan.io/tx/3ATsMXFa',
  },
  entry_hash: '5b6c925f', seq: 43,
};

test('renders the claim, the anchor, and the key', () => {
  const html = renderReceiptPage(RECEIPT);
  assert.match(html, /cadence-wave/);
  assert.match(html, /SOL above 70/);
  assert.match(html, /436241109/);
  assert.match(html, /2hsSKcSzE7KNhDRFMLHetWx3P6qyrVBJAXyMpHFK2Mcu/);
  // The link-preview card is the reason this page is server-rendered at all. If the meta
  // tags go missing the page still looks right and every paste of it looks like nothing.
  assert.match(html, /<meta property="og:title" content="[^"]+"/);
  assert.match(html, /<meta property="og:url" content="https:\/\/tape\.drainfun\.xyz\/r\/43"/);
});

test('the page never claims the call was right', () => {
  const html = renderReceiptPage(RECEIPT);
  // The honesty box is load-bearing: a receipt proves existence and time, not correctness,
  // and a page that blurs the two is exactly the overclaim TAPE is supposed to make costly.
  assert.match(html, /says nothing about whether the call was/i);
});

test('hostile caller and note cannot escape into the document', () => {
  const evil = JSON.parse(JSON.stringify(RECEIPT));
  evil.entry.caller = '</title><script>alert(1)</script>';
  evil.entry.note = '"><img src=x onerror=alert(2)>';
  evil.entry.market = 'pyth:X:above:1@2026-01-01T00:00:00Z"><script>alert(3)</script>';
  const html = renderReceiptPage(evil);

  // Assert on TAGS, not on the substring `onerror=`. The escaped payload legitimately
  // contains that text — `&lt;img src=x onerror=...&gt;` is inert and is exactly what a
  // correctly escaped hostile note looks like. A substring assertion here fails on working
  // code, which is worse than no assertion: it teaches you to loosen the test that guards
  // the injection path. What must not exist is an opening tag we did not write.
  assert.ok(!/<script/i.test(html), 'a script tag survived escaping');
  assert.ok(!/<img/i.test(html), 'an img tag survived escaping');
  // And specifically inside the attribute where it would break out of the meta tag.
  const og = /<meta property="og:title" content="([^"]*)"/.exec(html);
  assert.ok(og, 'og:title missing');
  assert.ok(!og[1].includes('<'), 'raw < inside a quoted attribute');
});

test('the receipt JSON is rendered as text, not as a script payload', () => {
  const evil = JSON.parse(JSON.stringify(RECEIPT));
  evil.entry.note = '</pre><script>alert(1)</script>';
  const html = renderReceiptPage(evil);
  assert.ok(!/<\/pre><script>/.test(html));
  assert.match(html, /&lt;\/pre&gt;/);
});

test('the verify commands point at paths that are actually served', () => {
  const html = renderReceiptPage(RECEIPT);
  const verifier = /curl -sO \S+\/([\w.-]+\.mjs)/.exec(html);
  assert.ok(verifier, 'page no longer prints a verifier download');
  assert.ok(ALLOWED.has(verifier[1]),
    `page tells readers to download ${verifier[1]}, which the web server does not serve`);
  // The JSON endpoint lives on the API listener, so it cannot be checked against ALLOWED;
  // assert the shape instead so a rename of /api/entry cannot pass unnoticed.
  assert.match(html, /\/api\/entry\/43/);
});

test('an unreadable market string is shown raw, never guessed at', () => {
  const odd = JSON.parse(JSON.stringify(RECEIPT));
  odd.entry.market = 'somethingnew:v9:whatever';
  const html = renderReceiptPage(odd);
  assert.match(html, /somethingnew:v9:whatever/);
  // No invented settlement source for a format we do not understand.
  assert.ok(!/Settled by:/.test(html));
});

test('describeMarket refuses to invent a reading', () => {
  assert.equal(describeMarket('pyth:SOL:above:70@2026-08-07T00:00:00Z').text, 'SOL above 70');
  assert.equal(describeMarket('github:o/r/pull/12:merged_by:2026-08-07T00:00:00Z').text,
    'o/r PR #12 is merged');
  assert.equal(describeMarket('mystery').text, null);
  assert.equal(describeMarket(undefined).text, null);
});

test('window-protocol rows are not described as calls', () => {
  const win = {
    entry: { p: 'tape-window', v: '1', type: 'sweep_report', signer: 'Hg2rHvPM', sig: 'x' },
    proof: [], anchor: RECEIPT.anchor, entry_hash: 'aa', seq: 51,
  };
  const html = renderReceiptPage(win);
  assert.ok(!/opened a position/.test(html));
  assert.match(html, /posted a sweep report/);
  // Falls back to the signing key rather than to an anonymous placeholder.
  assert.match(html, /Hg2rHvPM/);
});

test('pending is a waiting state and says so, in words, not just a status code', () => {
  const html = renderPendingPage(7, 'entry 7 is not covered by any anchor yet');
  assert.match(html, /not a failure/i);
  assert.match(html, /15 minutes/);
  // Must not be indexed: it is a transient state, and a cached "waiting" page outliving the
  // anchor by weeks would read as a broken receipt.
  assert.match(html, /<meta name="robots" content="noindex">/);
});

test('not-found explains the append-only reason rather than implying a deletion', () => {
  const html = renderNotFoundPage(99999);
  assert.match(html, /append-only/);
  assert.match(html, /99999/);
});

test('esc is total over the characters that matter', () => {
  assert.equal(esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('the /r/ route accepts only a bare sequence number', () => {
  // Mirrors bin/web.js. Kept here because this is the one place in the static server that
  // takes a user-controlled path segment, and the reason it is safe is the totality of the
  // pattern: digits only, so no dot, no slash, no traversal, and nothing to normalise.
  const ROUTE = /^r\/([0-9]{1,9})$/;
  for (const ok of ['r/0', 'r/43', 'r/999999999']) assert.ok(ROUTE.test(ok), ok);
  for (const bad of [
    'r/latest', 'r/-1', 'r/43x', 'r/../served.js', 'r/4 3', 'r/1/2', 'r//1', 'r/1234567890',
    'r/0x2b', 'r/%2e%2e', 'r/', 'r',
  ]) assert.ok(!ROUTE.test(bad), `route should refuse ${bad}`);
});

test('the receipt page discloses when the signing key is the operators own', () => {
  // The regression this guards: the population disclosure lived on the board, and making
  // the receipt the landing surface moved the reader away from it without moving it. The
  // most credible-looking page on the site was the one that did not say whose key signed it.
  const registry = { keys: [{ key: RECEIPT.entry.signer, label: "the operator's own calling identity" }] };
  const html = renderReceiptPage(RECEIPT, { operatorKeys: registry });
  assert.match(html, /in other words, by us/);
  assert.match(html, /not evidence that anyone else uses this board/);
});

test('an undeclared key reads as unattributed, never as independent', () => {
  const html = renderReceiptPage(RECEIPT, { operatorKeys: { keys: [] } });
  assert.match(html, /unattributed rather than as independent/);
  assert.ok(!/in other words, by us/.test(html));
});

test('the page states that the anchor slot is not an input', () => {
  const html = renderReceiptPage(RECEIPT, { operatorKeys: null });
  assert.match(html, /chain wins/);
});

/**
 * An opaque market id renders as a readable question WITHOUT laundering it as signed content.
 *
 * The bug: receipt #326's headline was the bare 42-char Delphi address, so a human could not tell
 * it was a bet on Guangzhou temperature without scrolling (2026-08-06). The fix pulls the question
 * from a cache the gate writes.
 *
 * The risk the fix creates, which is what these tests actually guard: that question is fetched
 * from a third party AFTER signing and the venue can edit it. If it ever renders as though it were
 * part of the signed entry, the page's whole claim — these bytes are fixed — is quietly false for
 * the most prominent line on it. So the annotation must be labelled, and the signed identifier
 * must remain visible next to it.
 */
const DELPHI_RECEIPT = JSON.parse(JSON.stringify(RECEIPT));
DELPHI_RECEIPT.entry.market = 'delphi:0x54932e35896a4f585e213490b089c3e318d85ec6';
const TITLES = {
  'delphi:0x54932e35896a4f585e213490b089c3e318d85ec6':
    { title: 'Will ZGGG max temperature be at least 39.0C?', fetched_at: '2026-08-06T12:32:35.087Z' },
};

test('a cached market question becomes the headline but is marked unsigned', () => {
  const html = renderReceiptPage(DELPHI_RECEIPT, { operatorKeys: null, marketTitles: TITLES });
  assert.match(html, /Will ZGGG max temperature be at least 39\.0C\?/);
  assert.match(html, /not part of the signed entry/);
  assert.match(html, /the venue can edit it/);
  // The signed identifier must survive alongside it — the annotation supplements, never replaces.
  assert.match(html, /delphi:0x54932e35896a4f585e213490b089c3e318d85ec6/);
});

test('with no cached question the page shows only what was signed, and invents nothing', () => {
  const html = renderReceiptPage(DELPHI_RECEIPT, { operatorKeys: null, marketTitles: {} });
  assert.match(html, /delphi:0x54932e35896a4f585e213490b089c3e318d85ec6/);
  assert.ok(!/not part of the signed entry/.test(html), 'no provenance band without an annotation');
  assert.ok(!/Will ZGGG/.test(html), 'must not invent a question it never fetched');
});

test('a hostile market question cannot break out of the page', () => {
  // Same threat as caller/note: this string comes from a third party, not from us.
  const html = renderReceiptPage(DELPHI_RECEIPT, {
    operatorKeys: null,
    marketTitles: {
      'delphi:0x54932e35896a4f585e213490b089c3e318d85ec6':
        { title: '</div><script>alert(1)</script>', fetched_at: '2026-08-06T12:00:00Z' },
    },
  });
  assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'venue-supplied text must be escaped');
});
