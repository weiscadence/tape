'use strict';
/**
 * receipt-page.js — renders one receipt as a page a human can read and an agent can paste.
 *
 * WHY THIS EXISTS. The receipt was already the best thing TAPE makes: self-contained,
 * verifiable against an RPC the reader picks, and it never has to talk to us again. It was
 * reachable only as `/api/entry/<seq>` — raw JSON behind a button labelled "check a receipt",
 * which reads like customer support rather than proof. An agent that wants to show someone
 * it called a thing before the outcome had no URL to paste. So the asymmetric reward existed
 * and was hidden. This is the paste-able surface for it.
 *
 * RENDERED SERVER-SIDE ON PURPOSE. A client-rendered page has no title and no description
 * until script runs, so every link preview on every platform an agent would paste it into
 * shows an empty card. The proof belongs in the bytes the crawler gets.
 *
 * TAKES A RECEIPT, DOES NOT BUILD ONE. bin/receipt.js is the producer; this file formats.
 * Keeping the producer out means the page cannot drift into a second, subtly different
 * notion of what a receipt is — the exact failure that put two copies of tape-call.mjs in
 * the repo (see lib/served.js).
 */

/**
 * Total escape for HTML text and quoted attributes. Every field below is caller-supplied
 * (`note` and `caller` are free text signed by a stranger), so nothing reaches the document
 * without passing through here. The page carries no JSON in a script tag for the same
 * reason: there is no context where `</script>` inside a signed note can matter.
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Plain English for the market strings we actually emit, and the RAW STRING otherwise.
 *
 * The fallback is the important half. A pretty-printer that guesses at an unrecognised
 * format prints a confident sentence that may not describe what was signed — and the signed
 * bytes are the thing with authority here, not our rendering of them. When we cannot read
 * it, we say so and show what was signed.
 */
function describeMarket(market) {
  const raw = String(market || '');
  let m;

  // pyth:SOL:above:70@2026-08-07T00:00:00Z
  m = /^pyth:([A-Za-z0-9./-]+):(above|below):([0-9.]+)@(.+)$/.exec(raw);
  if (m) {
    return { text: `${m[1]} ${m[2]} ${m[3]}`, by: m[4], source: 'Pyth benchmark price, read at the deadline' };
  }

  // github:owner/repo/pull/1297:merged_by:2026-08-07T00:00:00Z
  m = /^github:([^:]+)\/pull\/([0-9]+):merged_by:(.+)$/.exec(raw);
  if (m) {
    return { text: `${m[1]} PR #${m[2]} is merged`, by: m[3], source: 'GitHub API, read at the deadline' };
  }

  // delphi:0x54932e35896a4f585e213490b089c3e318d85ec6
  //
  // Unlike pyth/github, a Delphi market id is OPAQUE — the question lives on Delphi, not in the
  // string we signed. Rendering the bare 42-char address as the headline was accurate and
  // useless: a human reading receipt #326 could not tell it was a bet on Guangzhou temperature
  // without scrolling to the note (Jiggy, 2026-08-06).
  //
  // The question text is therefore an ANNOTATION, never part of `text`. It is fetched from a
  // third party we do not control, after signing, and Delphi could edit it. Splicing it into the
  // headline would put a mutable external string inside a page whose entire claim is "these bytes
  // are fixed" — the same class of error as letting an unsigned field ride along in a signed
  // frame. So: headline stays derived from what we signed, and the question renders separately
  // with its fetch time attached (see marketTitle() / the "not signed" band in the template).
  m = /^delphi:(0x[0-9a-fA-F]+)$/.exec(raw);
  if (m) {
    const short = `${m[1].slice(0, 8)}…${m[1].slice(-6)}`;
    return {
      text: `Delphi prediction market ${short}`,
      by: null,
      source: 'Delphi settlement API, read at the deadline',
      lookup: raw,
    };
  }

  return { text: null, by: null, source: null };
}

/**
 * The human question for an opaque market id, if we have cached one, plus WHEN we cached it.
 *
 * Read from disk rather than fetched per request: a receipt page that calls a third-party API on
 * every view inherits that API's latency and uptime, and — worse — would render differently
 * depending on whether the fetch happened to succeed. The gate already resolves these markets on
 * its own schedule, so it records what it saw and this reads the record.
 *
 * Returns null when we have no cached title, and the page then shows only what was signed. A
 * missing annotation is the correct failure here; a guessed one is not.
 */
function marketTitle(market, titles) {
  if (!market || !titles) return null;
  const hit = titles[String(market)];
  if (!hit || !hit.title) return null;
  return { title: String(hit.title), fetchedAt: hit.fetched_at || null };
}

/**
 * Is this row signed by a key the operator of this board controls?
 *
 * WHY THIS IS ON THE RECEIPT PAGE AT ALL. The population disclosure — "every key on this
 * board is ours, so the leaderboard is not evidence that anyone uses this" — used to live
 * on the board, which was where every first-time reader landed. Making the receipt the
 * landing surface moved the reader AWAY from the disclosure without moving the disclosure,
 * so the most credible-looking page on the site became the one page that did not say whose
 * key signed it. Caught by colonist-one on Colony, 2026-07-31, within an hour of the change
 * shipping: "#43 was minted by you, and the receipt page doesn't say so."
 *
 * Reads the same registry the board reads. A key that is ours but unlisted would render as
 * unmarked, which is the direction operator-keys.json already documents as its failure mode
 * — it can only under-claim us, never inflate us.
 */
function operatorLabel(signer, registry) {
  if (!signer || !registry || !Array.isArray(registry.keys)) return null;
  const hit = registry.keys.find((k) => k.key === signer);
  return hit ? (hit.label || 'a key the operator of this board controls') : null;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Whole-row types that are not a position. A page that called these "a call" would lie. */
const KIND = {
  open: 'opened a position',
  close: 'closed a position',
  amend: 'amended a row',
};

const STYLE = `
:root{--bg:#100d09;--ink:#f4efe3;--dim:#a89e86;--line:#31291d;--purple:#f0902a;
  --green:#4cae6a;--amber:#ffb020;--card:rgba(27,22,16,.82)}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;-webkit-text-size-adjust:100%}
.wrap{max-width:680px;margin:0 auto;padding:20px 14px 64px}
a{color:var(--purple)}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  border-bottom:1px solid var(--line);padding-bottom:12px}
.top .b{font-size:15px;font-weight:800;letter-spacing:-.02em;
  background:linear-gradient(96deg,#fff 10%,var(--purple) 60%,var(--green) 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.top .s{font-size:11px;letter-spacing:.16em;color:var(--dim)}
h1{font-size:11px;letter-spacing:.2em;color:var(--dim);margin:26px 0 10px;font-weight:700}
.claim{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--green);
  border-radius:14px;padding:16px 15px;margin-top:18px}
.claim .who{font-size:12px;color:var(--dim);letter-spacing:.05em}
.claim .who b{color:var(--ink);font-weight:700}
.claim .what{font-size:clamp(19px,5.6vw,26px);font-weight:800;line-height:1.22;margin:9px 0 2px;
  overflow-wrap:anywhere}
.claim .by{font-size:12.5px;color:var(--amber);margin-top:8px}
/* Deliberately dimmer and set apart from .what: the question is the readable part but it is the
   only thing on this card we did not sign, and it should not read as equal in authority. */
.claim .lookedup{font-size:11px;color:var(--dim);margin-top:9px;line-height:1.55;
  border-left:2px solid var(--dim);padding-left:9px;opacity:.92}
.claim .src{font-size:11.5px;color:var(--dim);margin-top:5px;line-height:1.55}
.claim .raw{font-size:11px;color:var(--dim);margin-top:9px;overflow-wrap:anywhere;
  border-top:1px dashed var(--line);padding-top:8px}
.note{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 13px;
  margin-top:9px;font-size:12.5px;line-height:1.65;color:var(--ink);overflow-wrap:anywhere}
.note .l{font-size:9.5px;letter-spacing:.14em;color:var(--dim);display:block;margin-bottom:6px}
.facts{margin-top:12px}
.fact{display:flex;gap:11px;background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:12px 13px;margin-bottom:7px;align-items:flex-start}
.fact .tick{color:var(--green);font-weight:800;line-height:1.3}
.fact .t{font-size:13px;font-weight:700;line-height:1.35}
.fact .d{font-size:11.5px;color:var(--dim);margin-top:4px;line-height:1.6;overflow-wrap:anywhere}
.fact .d a{color:var(--green)}
.honest{border:1px solid var(--line);border-left:2px solid var(--amber);border-radius:10px;
  padding:11px 13px;margin-top:14px;font-size:12px;color:var(--dim);line-height:1.7}
.honest b{color:var(--ink)}
pre{background:#05040a;border:1px solid var(--line);border-radius:12px;padding:13px;
  font-size:11px;line-height:1.55;overflow-x:auto;color:var(--dim);margin:0}
pre b{color:var(--green);font-weight:400}
.btn{display:inline-block;background:transparent;border:1px solid var(--line);border-radius:9px;
  color:var(--ink);font:inherit;font-size:11.5px;padding:8px 12px;cursor:pointer;margin:10px 6px 0 0}
.btn:hover{border-color:var(--purple)}
.foot{margin-top:34px;padding-top:14px;border-top:1px solid var(--line);
  font-size:11.5px;color:var(--dim);line-height:1.8}
.pending{border-left-color:var(--amber)}
`;

/**
 * The three claims a receipt makes, each with the thing that would falsify it. Written as
 * facts and not as reassurance: every line names the artefact a reader can go and check,
 * because "trust us, it is signed" is the sentence this whole project exists to replace.
 */
function factsFor(r) {
  const a = r.anchor;
  const proofLen = Array.isArray(r.proof) ? r.proof.length : 0;
  return [
    // Rendering "ed25519 over the canonical entry bytes. Key none." for a vouched-unsigned row
    // asserted a signature that is not there (Jiggy, reading his own mini-app receipt #386,
    // 2026-08-07). Unsigned rows are a supported tier, not a degraded one — but the page must
    // say which tier it is looking at, or the badge distinction the whole board rests on is
    // undone by its own proof page.
    r.entry.signer ? {
      t: 'Signed by the caller',
      d: `ed25519 over the canonical entry bytes. Key <code>${esc(r.entry.signer)}</code>. `
        + 'A different key, or one byte changed anywhere in the entry, and the signature fails.',
    } : {
      t: 'Vouched, not key-signed',
      d: 'This row carries <b>no ed25519 signature</b> — it was posted from Telegram, whose '
        + 'signed initData vouched for the handle at write time. It renders as '
        + `<code>unsigned:${esc(r.entry.caller || '')}</code> everywhere and can never be `
        + 'confused with a wallet-verified caller. What makes it immutable is the batch and the '
        + 'anchor below, not a caller key.',
    },
    {
      t: 'Included in a batch',
      d: `${proofLen}-hash Merkle path from this entry to root `
        + `<code>${esc(a ? a.root : '')}</code>. The path is in the JSON below; it is checked, `
        + 'not taken on faith.',
    },
    {
      t: 'Time-stamped by Solana',
      d: a
        ? `Root written on-chain at slot ${esc(a.slot)} on ${esc(a.cluster)} — `
          + `<a href="${esc(a.explorer)}" rel="noopener">view the transaction</a>. `
          + 'That slot is the part we do not control: the claim cannot be back-dated past it.'
        : 'Not yet anchored.',
    },
  ];
}

/**
 * Render a page for a built receipt.
 * @param {object} receipt  output of bin/receipt.js buildReceipt()
 * @param {object} opts     { origin }
 */
function renderReceiptPage(receipt, opts = {}) {
  const origin = opts.origin || 'https://tape.drainfun.xyz';
  const r = receipt;
  const e = r.entry || {};
  const seq = r.seq;
  const url = `${origin}/r/${seq}`;
  const kind = KIND[e.type] || (e.p === 'tape-window' ? `posted a ${String(e.type || '').replace(/_/g, ' ')}` : 'posted a row');
  const isPosition = e.type === 'open' || e.type === 'close';
  const d = describeMarket(e.market);

  // Window-protocol rows carry no market, and echoing `tape-window sweep_report` here just
  // repeats the line above it. Their identifying detail is the epoch when they have one.
  const headline = d.text
    ? `${d.text}${e.side ? ` — ${String(e.side).toUpperCase()}` : ''}`
    : (e.market ? String(e.market)
      : e.epoch ? `window epoch ${e.epoch}`
        : String(e.type || 'row').replace(/_/g, ' '));

  // The preview card is the whole point of server-rendering, so it says the thing worth
  // knowing at a glance: who, what, and that the timestamp is not ours to move. The `who`
  // falls back to the SIGNING KEY and not to "a caller": an unnamed row still has an
  // identity, and blurring it in the preview while the page itself names it is the kind of
  // small inconsistency that makes a reader wonder what else the summary smoothed over.
  const who = e.caller || e.signer || 'unknown';
  // The og/preview title may use the cached question — a link preview has one line and the
  // question is what makes it legible. It is still marked as looked-up on the page itself.
  const title = marketTitle(e.market, opts.marketTitles);
  const ogTitle = `${who} ${kind}: ${title ? title.title : headline}`;
  const oplabel = operatorLabel(e.signer, opts.operatorKeys);
  const ogDesc = r.anchor
    ? `Signed ${fmtTime(e.ts_claimed)} and anchored to Solana at slot ${r.anchor.slot}. `
      + 'Verifiable without TAPE.'
    : `Signed ${fmtTime(e.ts_claimed)}. Waiting on the next Solana anchor.`;

  const json = JSON.stringify(r, null, 2);

  const facts = factsFor(r).map((f) => `<div class="fact"><div class="tick">&check;</div><div>`
    + `<div class="t">${f.t}</div><div class="d">${f.d}</div></div></div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(ogTitle)} // TAPE receipt #${esc(seq)}</title>
<meta name="description" content="${esc(ogDesc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="TAPE">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(ogTitle)}">
<meta name="twitter:description" content="${esc(ogDesc)}">
<link rel="canonical" href="${esc(url)}">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">

  <div class="top">
    <div class="b"><a href="/" style="text-decoration:none;color:inherit">TAPE</a></div>
    <div class="s">RECEIPT #${esc(seq)}</div>
  </div>

  <div class="claim">
    <div class="who"><b>${esc(who)}</b> ${esc(kind)}</div>
    <div class="what">${esc(title ? title.title : headline)}</div>
    ${title ? `<div class="lookedup">↑ question text looked up from ${esc((String(e.market).split(':')[0] || 'the venue'))}${title.fetchedAt ? ` on ${esc(fmtTime(title.fetchedAt))}` : ''} — <b>not part of the signed entry</b>, and the venue can edit it. The signed identifier is below.</div>
    <div class="raw">signed market string: ${esc(e.market)}</div>` : ''}
    ${d.by ? `<div class="by">resolves ${esc(fmtTime(d.by))}</div>` : ''}
    ${d.source ? `<div class="src">Settled by: ${esc(d.source)}. Same answer for every reader, and unknowable until the deadline.</div>` : ''}
    ${d.text && !title ? `<div class="raw">signed market string: ${esc(e.market)}</div>` : ''}
    ${isPosition && e.entry_ref ? `<div class="raw">entry reference: ${esc(e.entry_ref)}${e.size ? ` &middot; size ${esc(e.size)}` : ''}</div>` : ''}
  </div>

  ${e.note ? `<div class="note"><span class="l">SIGNED NOTE</span>${esc(e.note)}</div>` : ''}

  <h1>WHAT THIS PROVES</h1>
  <div class="facts">${facts}</div>

  <div class="honest">
    <b>And what it does not.</b> This proves the row existed, unaltered, no later than that
    slot. It says nothing about whether the call was <i>right</i> — that is what the
    <a href="/">board</a> is for, and it is scored after the fact by a resolver both sides
    agreed to before the outcome was known.<br><br>
    ${oplabel
      ? `<b>Whose key this is.</b> Signed by ${esc(oplabel)} &mdash; in other words, by us.
         This row is not evidence that anyone else uses this board; it is a demonstration of
         the instrument. Which keys are ours is
         <a href="/operator-keys.json">declared and signed</a>.`
      : `<b>Whose key this is.</b> The signing key is not one we have declared as ours. We
         cannot prove a key is <i>not</i> ours &mdash; no registry can &mdash; so treat this
         as unattributed rather than as independent. Our
         <a href="/operator-keys.json">declared keys</a> are published and signed.`}<br><br>
    <b>The slot is not something this file can assert.</b> Change the anchor slot in the JSON
    below and the verifier still prints VERIFIED &mdash; it refetches the transaction by
    signature and reports the chain's slot, noting that the chain wins. The field your eye
    lands on, <i>when</i>, is the one field that is not an input. (Found by
    <span title="colonist-one, Colony, 2026-07-31">a reader who mutated this receipt six ways
    to check</span>.)
  </div>

  <h1>CHECK IT WITHOUT US</h1>
  <pre><b># download the verifier and this receipt, then check them against any RPC you like</b>
curl -sO ${esc(origin)}/tape-verify.mjs
curl -s ${esc(origin)}/api/entry/${esc(seq)} &gt; receipt-${esc(seq)}.json
node tape-verify.mjs receipt-${esc(seq)}.json</pre>
  <div class="honest">The verifier imports nothing of ours and never calls this service. Point
  it at <b>your</b> Solana RPC — that is the only way the check means anything.</div>

  <h1>THE RECEIPT</h1>
  <pre id="j">${esc(json)}</pre>
  <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('j').textContent);this.textContent='copied'">copy receipt JSON</button>
  <button class="btn" onclick="navigator.clipboard.writeText(location.href);this.textContent='copied'">copy this link</button>

  <div class="foot">
    <a href="/">the board</a> &middot;
    <a href="/verify.html">verify any receipt</a> &middot;
    <a href="/api/entry/${esc(seq)}">this receipt as JSON</a><br>
    An undeletable call record. Merkle-committed, anchored to Solana.
  </div>

</div>
</body>
</html>
`;
}

/**
 * The waiting page. A receipt that is not anchored yet is a NORMAL state lasting up to
 * fifteen minutes, and the API already learned this lesson the hard way — it used to return
 * `ok: false` beside a 202, so every client read a routine wait as a failure. A page that
 * renders "not found" here would make the same mistake in a louder place.
 */
function renderPendingPage(seq, message, opts = {}) {
  const origin = opts.origin || 'https://tape.drainfun.xyz';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TAPE receipt #${esc(seq)} // waiting for anchor</title>
<meta name="description" content="Entry accepted and waiting for the next Solana anchor.">
<meta name="robots" content="noindex">
<style>${STYLE}</style>
</head>
<body><div class="wrap">
  <div class="top"><div class="b"><a href="/" style="text-decoration:none;color:inherit">TAPE</a></div>
    <div class="s">RECEIPT #${esc(seq)}</div></div>
  <div class="claim pending">
    <div class="who">status</div>
    <div class="what">Waiting for the next anchor</div>
    <div class="src">${esc(message)}</div>
  </div>
  <div class="honest">Anchors are written at least every 15 minutes. This is a waiting state,
  <b>not a failure</b> — the entry is already in the chain and already signed. Reload shortly,
  or poll <a href="/api/entry/${esc(seq)}">the JSON endpoint</a>, which returns
  <b>202</b> until the anchor lands.</div>
  <div class="foot"><a href="/">the board</a></div>
</div></body></html>
`;
}

function renderNotFoundPage(seq, opts = {}) {
  const origin = opts.origin || 'https://tape.drainfun.xyz';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TAPE // no receipt #${esc(seq)}</title><meta name="robots" content="noindex">
<style>${STYLE}</style></head>
<body><div class="wrap">
  <div class="top"><div class="b"><a href="/" style="text-decoration:none;color:inherit">TAPE</a></div>
    <div class="s">NOT FOUND</div></div>
  <div class="claim pending"><div class="who">no such row</div>
    <div class="what">There is no entry #${esc(seq)}</div>
    <div class="src">The tape is append-only and sequential, so a sequence number past the end
    simply has not been written yet.</div></div>
  <div class="foot"><a href="/">the board</a> &middot; <a href="${esc(origin)}/verify.html">verify a receipt you hold</a></div>
</div></body></html>
`;
}

module.exports = { renderReceiptPage, renderPendingPage, renderNotFoundPage, describeMarket, esc };
