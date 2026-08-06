'use strict';
/**
 * resolve.js — the resolvability gate.
 *
 * WHY THIS EXISTS (2026-07-28, within twenty minutes of the genesis anchor):
 * T0.1 says a claim must be committed BEFORE its outcome is knowable, because anchoring
 * after resolution proves nothing. I wrote that rule, then broke it on my own first
 * three entries. I read the PR states at 20:13, wrote predictions, and anchored at
 * 20:36 — and #1297 had merged at 20:22, in the gap. Two of three genesis entries were
 * already decided at the moment I committed them.
 *
 * Nothing caught it, because the rule lived only in a spec document. A rule that is not
 * executable is a wish. So: before an entry is anchored, its market is queried against
 * its resolution source, and an ALREADY-RESOLVED market is REFUSED.
 *
 * This is not a nicety. Without it the system's headline promise inverts: posting
 * already-settled predictions is the single cheapest way to fake a genius track record,
 * and it would be indistinguishable from skill on the leaderboard.
 */

const https = require('https');
const { priceAt } = require('./price');

/** Market id grammar: `github:<owner>/<repo>/pull/<n>:merged_by:<iso>` or `github:<owner>/<repo>:<a>_merges_before_<b>`. */
const GH_MERGED_BY = /^github:([^/]+)\/([^/]+)\/pull\/(\d+):merged_by:(.+)$/;
const GH_ORDER = /^github:([^/]+)\/([^/]+):(\d+)_merges_before_(\d+)$/;

/**
 * Price markets, resolved against Pyth. Two spellings for one meaning:
 *   canonical  `pyth:SOL:above:200@2026-08-01T00:00:00Z`
 *   demo/docs  `demo:SOL_above_200_by_2026-08-01`   (date-only ⇒ midnight UTC)
 *
 * WHY THIS EXISTS (2026-07-30): the two `demo:` markets in our own docs had NO resolver,
 * so every caller who followed the example got REFUSED at the gate — 393 of 1519 gate
 * checks. The examples were a footgun. A price oracle is the fix AND the point: "predict a
 * crypto price by a date" is the headline use of the prediction lane, and Pyth's historical
 * benchmark makes it deterministic — the price AT the deadline timestamp is fixed history,
 * identical for every reader, and unknowable before the deadline (so it satisfies T0.1).
 */
const PYTH_MARKET = /^pyth:([A-Z]{2,6}):(above|below):([0-9]+(?:\.[0-9]+)?[kmKM]?)@(.+)$/;
const DEMO_MARKET = /^demo:([A-Z]{2,6})_(above|below)_([0-9]+(?:\.[0-9]+)?[kmKM]?)_by_(.+)$/;

/**
 * Polymarket binary markets, resolved against Polymarket's UMA settlement.
 *   `polymarket:0x<64-hex conditionId>`
 *
 * WHY THIS EXISTS (2026-08-05): our best reasoning IS prediction-market fundamentals, and
 * until now TAPE could not score exactly that — a Delphi/Polymarket pick landed on-record
 * but came back `unscored — no resolver`, so our real work never touched the leaderboard.
 * A prediction market is the cleanest thing TAPE can score: it settles YES/NO objectively,
 * on a date, with none of the liquidity/mint ambiguity a memecoin call carries.
 *
 * The conditionId (the on-chain CTF conditionId, immutable) identifies the QUESTION; the
 * caller's YES/NO is `entry.side`, scored against the resolved outcome. A slug can be reused
 * or renamed, so we key on the conditionId that cannot.
 *
 * TRUST MODEL: the outcome that must be objective is read from CLOB's `tokens[].winner`,
 * which mirrors the on-chain UMA payout — the same value every reader gets, unchangeable
 * once settled, and NOT something the operator sets. This trusts Polymarket's API to report
 * its own chain honestly, exactly as the github resolver trusts api.github.com to report a
 * merge. Reading the CTF payout on-chain is the harder-to-spoof upgrade and the noted next
 * step; it is not required for the outcome to be objective, only to remove Polymarket's API
 * from the trust path.
 */
const POLYMARKET_MARKET = /^polymarket:(0x[0-9a-fA-F]{64})$/;

/** Delphi Agent Arena market, keyed by its on-chain market address (20 bytes / 40 hex). */
const DELPHI_MARKET = /^delphi:(0x[0-9a-fA-F]{40})$/;

/** Uniform refusal: a market we cannot cleanly read/map is REFUSED, never coerced to open. */
const unsupported = (detail) => ({ supported: false, resolved: null, outcome: null, at: null, detail });

/** Parse a threshold that may carry a `k`/`m` suffix (`150k` ⇒ 150000). Returns NaN if malformed. */
function parseThreshold(s) {
  const mult = { k: 1e3, K: 1e3, m: 1e6, M: 1e6 };
  const suf = s.slice(-1);
  return suf in mult ? Number(s.slice(0, -1)) * mult[suf] : Number(s);
}

/** Pyth price-feed ids (mainnet). Extend deliberately — an unknown asset is refused, not guessed. */
const PYTH_FEEDS = {
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

/**
 * Read the settlement price of `asset` AS OF unix-seconds `ts`. Deterministic.
 *
 * This used to be a second, independent Pyth client pointed at benchmarks.pyth.network —
 * a different host from the one price.js reads, but the same vendor and the same
 * unauthenticated deprecation (2026-07-31). Two clients meant the fallback chain built for
 * marks did nothing for SETTLEMENT, which is the worse of the two to lose: an unmarked
 * position is stale, an unsettled one never resolves at all and the board quietly stops
 * being a record of outcomes.
 *
 * So settlement now goes through the same ordered source chain as every other mark. One
 * price path, one place to audit, one place to add a source. It also drops the float math
 * that was here (`Number(price) * 10 ** expo`) in favour of the exact decimal string the
 * rest of the codebase requires — a settlement that flips on a rounding artifact is the
 * single most expensive bug this file could have.
 */
async function pythPriceAt(asset, ts) {
  const mark = await priceAt(`${asset}/USD`, ts);
  if (!mark.ok) throw new Error(`no source could settle ${asset}@${ts}: ${mark.reason}`);
  return {
    value: Number(mark.price),   // comparison against a numeric threshold
    exact: mark.price,           // exact string, for the audit detail
    publishTime: mark.publish_time,
    source: mark.source,
    degraded: Boolean(mark.degraded),
  };
}

/** Shared logic for both price-market spellings. */
async function resolvePriceMarket(asset, dir, thresholdStr, deadlineStr) {
  const feed = PYTH_FEEDS[asset];
  if (!feed) return { supported: false, resolved: null, outcome: null, at: null,
    detail: `no Pyth feed for asset ${asset} (known: ${Object.keys(PYTH_FEEDS).join(', ')})` };
  const deadline = new Date(deadlineStr);
  if (isNaN(deadline)) return { supported: false, resolved: null, outcome: null, at: null,
    detail: `unparseable deadline ${deadlineStr}` };
  const threshold = parseThreshold(thresholdStr);
  if (isNaN(threshold)) return { supported: false, resolved: null, outcome: null, at: null,
    detail: `unparseable threshold ${thresholdStr}` };
  // Validate the whole market up front, so a malformed one is REFUSED, never posted as "open".
  if (new Date() < deadline) {
    return { supported: true, resolved: false, outcome: null, at: null,
      detail: `${asset} ${dir} ${thresholdStr}, deadline ${deadline.toISOString()} not reached` };
  }
  const ts = Math.floor(deadline.getTime() / 1000);
  const { value, exact, publishTime, source, degraded } = await pythPriceAt(asset, ts);
  const hit = dir === 'above' ? value >= threshold : value <= threshold;
  return { supported: true, resolved: true, outcome: hit ? 'yes' : 'no',
    at: new Date(publishTime * 1000).toISOString(),
    // The source travels with the outcome. A settlement is the one number nobody may have
    // to take on trust, so the record says which oracle decided it — and says so loudest
    // when it was not the primary one.
    source, degraded,
    detail: `${asset}=${exact} at deadline ${deadline.toISOString()}, needed ${dir} ${thresholdStr}`
      + ` [${source}${degraded ? ', DEGRADED: primary oracle unavailable' : ''}]` };
}

/**
 * Where the read-only GitHub credential comes from.
 *
 * TAPE_GITHUB_TOKEN_FILE exists so the internet-facing intake can run in a sandbox that
 * cannot see ~/.config/cadence-secure at all. That directory holds the anchor key (which
 * holds SOL), bot tokens and every social credential; the resolver needs exactly one
 * read-only scope against public repos. Pointing the two at the same file made the whole
 * secret store reachable from the one process an anonymous POST can reach.
 *
 * The token is OPTIONAL by design. GitHub answers public-repo reads unauthenticated, so a
 * deployment with no credential still resolves — slower quota, same answers. A gate that
 * REQUIRES a secret to run is a gate that fails whenever the secret is unavailable, and
 * this one fails closed (502, post refused), so making it optional is what stops a missing
 * file from being a denial of service on honest callers.
 *
 * Cached after first read: it was being re-read off disk on every request.
 */
let ghTokenCache;
function ghToken() {
  if (ghTokenCache !== undefined) return ghTokenCache;
  const fs = require('fs'), os = require('os'), path = require('path');
  const file = process.env.TAPE_GITHUB_TOKEN_FILE
    || path.join(os.homedir(), '.config/cadence-secure/github.json');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    ghTokenCache = raw.startsWith('{') ? (JSON.parse(raw).token || null) : (raw || null);
  } catch {
    ghTokenCache = null;
  }
  return ghTokenCache;
}

function ghGet(pathname) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'tape-resolver', Accept: 'application/vnd.github+json' };
    const tok = ghToken();
    if (tok) headers.Authorization = `token ${tok}`;
    const req = https.request({
      host: 'api.github.com', path: pathname, method: 'GET', headers,
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub ${res.statusCode} for ${pathname}`));
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Generic read-only JSON GET against a public host. Returns { status, json }; json is null
 * on a non-JSON body rather than throwing, so a 404 (a clean "no such market") is
 * distinguishable from a transport failure by the caller.
 */
function httpGetJson(host, pathname, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: pathname, method: 'GET',
      headers: { 'User-Agent': 'tape-resolver', Accept: 'application/json', ...extraHeaders } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = b ? JSON.parse(b) : null; } catch { /* leave null; caller sees status */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** gamma closedTime is `"2026-07-18 22:27:43+00"`; normalise to ISO, or null if unparseable. */
function gammaTimeToIso(s) {
  const d = new Date(String(s).replace(' ', 'T').replace(/\+00$/, 'Z'));
  return isNaN(d) ? null : d.toISOString();
}

/**
 * The SETTLEMENT time of a resolved Polymarket market.
 *
 * The outcome comes from CLOB; the timestamp comes from gamma's `closedTime`, because CLOB
 * carries only the SCHEDULED `end_date_iso`, which can sit years from the real UMA
 * resolution (a market scheduled to 2028 that settled in 2026). score.js benchmarks a
 * settled prediction against SOL HELD TO SETTLEMENT, so a wrong `at` misprices the call in
 * exactly the direction that would flatter or bury it silently. If gamma is unreachable we
 * fall back to the scheduled end — deterministic, and the only honest option left — and the
 * caller flags it as approximate in the detail string.
 */
async function polymarketSettledAt(conditionId, clobMkt) {
  try {
    const res = await httpGetJson('gamma-api.polymarket.com',
      `/markets?closed=true&condition_ids=${conditionId}`);
    if (res.status === 200 && Array.isArray(res.json) && res.json[0] && res.json[0].closedTime) {
      const iso = gammaTimeToIso(res.json[0].closedTime);
      if (iso) return { at: iso, approx: false };
    }
  } catch { /* fall through to scheduled end */ }
  const end = clobMkt.end_date_iso;
  return end && !isNaN(new Date(end))
    ? { at: new Date(end).toISOString(), approx: true }
    : { at: null, approx: true };
}

/**
 * Resolve a Polymarket binary market by conditionId.
 *
 * A market we cannot READ (404, transport error) is `supported:false`, never open — the
 * silent-zero rule: "I could not check" must not read as "it is fine". A market that is not
 * a clean two-outcome Yes/No is refused rather than coerced onto the yes/no grammar. Only a
 * closed market with EXACTLY ONE winning token yields a scoreable outcome; closed-with-no-
 * single-winner is a void/50-50 refund and has no yes/no result.
 */
async function resolvePolymarket(conditionId) {
  let mkt;
  try {
    const res = await httpGetJson('clob.polymarket.com', `/markets/${conditionId}`);
    if (res.status === 404) return unsupported(`no Polymarket market for condition ${conditionId}`);
    if (res.status !== 200 || !res.json) throw new Error(`CLOB ${res.status}`);
    mkt = res.json;
  } catch (e) {
    return unsupported(`could not read Polymarket market ${conditionId}: ${e.message}`);
  }

  const tokens = Array.isArray(mkt.tokens) ? mkt.tokens : [];
  if (tokens.length !== 2) {
    return unsupported(`Polymarket ${conditionId} is not binary (${tokens.length} outcomes) — TAPE scores yes/no only`);
  }
  const labelled = {};
  for (const t of tokens) {
    const o = String(t.outcome || '').trim().toLowerCase();
    if (o === 'yes' || o === 'no') labelled[o] = t;
  }
  if (!labelled.yes || !labelled.no) {
    return unsupported(`Polymarket ${conditionId} outcomes are not Yes/No (${tokens.map((t) => t.outcome).join('/')}) — cannot map to a yes/no side`);
  }

  const q = String(mkt.question || '').slice(0, 80);
  // `title` is the FULL question, not the 80-char `q` used in detail strings: the daemon feeds it
  // to recordTitle() so the board can headline a readable question instead of the bare conditionId.
  // The Delphi path already did this; this one did not, so the first Polymarket call posted here
  // would have rendered as `polymarket:0x5dc212…` — the exact unreadable-headline complaint from
  // 2026-08-06, reappearing in a venue that had never been exercised. Like the Delphi annotation,
  // this string is NOT signed and the venue can edit it; market-titles.js stamps `fetched_at` and
  // the page marks it unsigned.
  const title = String(mkt.question || '').slice(0, 300) || null;
  if (!mkt.closed) {
    return { supported: true, resolved: false, outcome: null, at: null, title,
      detail: `Polymarket open — "${q}"` };
  }

  const winners = tokens.filter((t) => t.winner === true);
  if (winners.length !== 1) {
    return unsupported(`Polymarket ${conditionId} closed with ${winners.length} winning outcomes (voided or 50-50) — no scoreable result`);
  }
  const outcome = String(winners[0].outcome).trim().toLowerCase(); // 'yes' | 'no'
  const { at, approx } = await polymarketSettledAt(conditionId, mkt);
  return { supported: true, resolved: true, outcome, at, title,
    detail: `Polymarket "${q}" resolved ${outcome.toUpperCase()}`
      + (at ? ` at ${at}${approx ? ' (scheduled end; gamma settlement time unavailable)' : ''}` : '') };
}

/**
 * Where the read-only Delphi API key comes from — the same pattern, and for the same reason,
 * as ghToken() above.
 *
 * WHY A KEY AT ALL, AND WHY ONLY THIS ONE (2026-08-05): our own fundamentals lane trades on
 * Gensyn's Delphi Agent Arena, whose markets settle ON-CHAIN via `winningOutcomeIdx`. To make
 * those calls scoreable on TAPE the intake service must read that settlement — and reading it
 * needs the competition API key (unauthenticated reads 401).
 *
 * The key is READ-ONLY: it lists/reads markets. PLACING A TRADE needs the wallet private key,
 * which is a SEPARATE credential and is deliberately NOT here — the sandboxed intake service
 * (see tape-api.service) is the one process an anonymous POST can reach, and a signing key in
 * it would be a signing key an attacker can reach. So the wallet never enters this process;
 * only the read key does, and its whole blast radius if leaked is "someone can read testnet
 * competition markets", the same trust class as the github token beside it.
 *
 * OPTIONAL, and fails CLOSED: with no key configured, a `delphi:` market resolves
 * `supported:false`, so the gate REFUSES the post rather than waving an unverifiable call
 * through. A resolver that cannot check must never report "fine".
 */
// The standard install location. Having a DEFAULT and not only an env var is deliberate: the key
// was configured on the systemd intake unit and nowhere else, so the pm2 anchor daemon and the
// crontab publish job both resolved every Delphi market as "not configured" and the board showed
// live calls as NOT COUNTED for a day (2026-08-06). Three processes, one expression, three answers
// — the same shape as the TAPE_KEY wallet bug the morning before. An env var that every runner
// must remember to set is a rule; a default the code finds on its own is a control.
//
// Env still wins when set, so a test or a staging box can point somewhere else. The default is
// only reached when nothing was configured, and it still fails closed if the file is unreadable.
const DELPHI_KEY_DEFAULT = '/etc/tape/delphi-key';
let delphiKeyCache;
function delphiKey() {
  if (delphiKeyCache !== undefined) return delphiKeyCache;
  const fs = require('fs');
  const file = process.env.TAPE_DELPHI_KEY_FILE || DELPHI_KEY_DEFAULT;
  if (!file) { delphiKeyCache = null; return null; }
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    delphiKeyCache = raw.startsWith('{') ? (JSON.parse(raw).api_access_key || null) : (raw || null);
  } catch {
    delphiKeyCache = null;
  }
  return delphiKeyCache;
}

/**
 * Resolve a Delphi Agent Arena binary market by its on-chain market address.
 *   `delphi:0x<40-hex market address>`
 *
 * Settlement is read from the competition REST feed (X-API-Key + X-Delphi-Mode: competition),
 * the same data the on-chain `winningOutcomeIdx` carries. Only a two-outcome Yes/No market
 * that has `status:"settled"` with a winning index on the Yes or No leg yields a scoreable
 * result; `failed` is a voided market (no outcome), and anything we cannot read is refused,
 * never assumed open.
 */
async function resolveDelphi(id) {
  const key = delphiKey();
  if (!key) return unsupported(`Delphi resolver not configured (no TAPE_DELPHI_KEY_FILE) — cannot verify ${id}`);

  let markets;
  try {
    const res = await httpGetJson('delphi-api.gensyn.ai', '/markets?limit=200',
      { 'X-API-Key': key, 'X-Delphi-Mode': 'competition' });
    if (res.status !== 200 || !res.json) throw new Error(`Delphi API ${res.status}`);
    markets = Array.isArray(res.json.markets) ? res.json.markets : [];
  } catch (e) {
    return unsupported(`could not read Delphi markets for ${id}: ${e.message}`);
  }

  const m = markets.find((x) => String(x.id || '').toLowerCase() === id.toLowerCase());
  if (!m) return unsupported(`Delphi market ${id} not in the active competition — cannot read to resolve`);

  const outcomes = (m.metadata && Array.isArray(m.metadata.outcomes)) ? m.metadata.outcomes : [];
  if (outcomes.length !== 2) {
    return unsupported(`Delphi ${id} is not binary (${outcomes.length} outcomes) — TAPE scores yes/no only`);
  }
  // Delphi labels the positive leg "Yes (...)" and the negative "No"; map onto the yes/no
  // side grammar by that prefix, and refuse anything that is not a clean Yes/No pair rather
  // than guess which leg is which.
  const yesIdx = outcomes.findIndex((o) => /^yes\b/i.test(String(o).trim()));
  const noIdx = outcomes.findIndex((o) => /^no\b/i.test(String(o).trim()));
  if (yesIdx === -1 || noIdx === -1 || yesIdx === noIdx) {
    return unsupported(`Delphi ${id} outcomes are not Yes/No (${outcomes.join(' / ')}) — cannot map to a yes/no side`);
  }

  const q = String((m.metadata && m.metadata.question) || '').slice(0, 80);
  // Full question, kept separate from the truncated `q` used in detail strings. This is the
  // human-readable ANNOTATION the receipt page caches — it is not signed and the venue can edit
  // it, so it travels as its own field rather than being spliced into anything authoritative.
  const title = String((m.metadata && m.metadata.question) || '').slice(0, 300) || null;
  if (m.status === 'failed') {
    return unsupported(`Delphi ${id} FAILED to resolve (voided) — no scoreable outcome`);
  }
  if (m.status !== 'settled' || m.winningOutcomeIdx === null || m.winningOutcomeIdx === undefined) {
    // open / awaiting_settlement / anything not yet final: genuinely unresolved, postable.
    return { supported: true, resolved: false, outcome: null, at: null, title,
      detail: `Delphi ${m.status || 'pending'} — "${q}"` };
  }

  const widx = Number(m.winningOutcomeIdx);
  if (widx !== yesIdx && widx !== noIdx) {
    return unsupported(`Delphi ${id} settled to outcome index ${widx}, neither the Yes nor No leg`);
  }
  const outcome = widx === yesIdx ? 'yes' : 'no';
  const at = m.settledAt && !isNaN(new Date(m.settledAt)) ? new Date(m.settledAt).toISOString() : null;
  return { supported: true, resolved: true, outcome, at, title,
    detail: `Delphi "${q}" settled ${outcome.toUpperCase()}${at ? ` at ${at}` : ''}` };
}

/**
 * Resolve a market NOW.
 * Returns { supported, resolved, outcome, at, detail }.
 *
 * `supported:false` is deliberately distinct from `resolved:false`. A market we cannot
 * read is not a market we know to be open — treating "I could not check" as "it is fine"
 * is the silent-zero failure this codebase keeps a canary for elsewhere. Callers must
 * refuse an unsupported market rather than wave it through.
 */
async function resolveMarket(market) {
  let m = market.match(GH_MERGED_BY);
  if (m) {
    const [, owner, repo, num, deadline] = m;
    const pr = await ghGet(`/repos/${owner}/${repo}/pulls/${num}`);
    const mergedAt = pr.merged_at;
    if (mergedAt) {
      const inTime = new Date(mergedAt) <= new Date(deadline);
      return { supported: true, resolved: true, outcome: inTime ? 'yes' : 'no', at: mergedAt,
        detail: `PR #${num} merged ${mergedAt}, deadline ${deadline}` };
    }
    if (new Date() > new Date(deadline)) {
      return { supported: true, resolved: true, outcome: 'no', at: deadline, detail: `deadline ${deadline} passed unmerged` };
    }
    return { supported: true, resolved: false, outcome: null, at: null, detail: `PR #${num} open, deadline ${deadline}` };
  }

  m = market.match(GH_ORDER);
  if (m) {
    const [, owner, repo, a, b] = m;
    const [pa, pb] = await Promise.all([
      ghGet(`/repos/${owner}/${repo}/pulls/${a}`), ghGet(`/repos/${owner}/${repo}/pulls/${b}`),
    ]);
    if (pa.merged_at && pb.merged_at) {
      const yes = new Date(pa.merged_at) < new Date(pb.merged_at);
      return { supported: true, resolved: true, outcome: yes ? 'yes' : 'no', at: pb.merged_at,
        detail: `#${a} ${pa.merged_at}, #${b} ${pb.merged_at}` };
    }
    // If B merged and A has not, the ordering is already decided — A can no longer be first.
    if (pb.merged_at && !pa.merged_at) {
      return { supported: true, resolved: true, outcome: 'no', at: pb.merged_at,
        detail: `#${b} merged ${pb.merged_at} while #${a} still open — order already determined` };
    }
    return { supported: true, resolved: false, outcome: null, at: null, detail: `#${a} / #${b} not both settled` };
  }

  m = market.match(PYTH_MARKET);
  if (m) return resolvePriceMarket(m[1], m[2], m[3], m[4]);

  m = market.match(DEMO_MARKET);
  if (m) {
    // Date-only deadlines (`2026-08-01`) mean midnight UTC that day.
    const dl = /^\d{4}-\d{2}-\d{2}$/.test(m[4]) ? `${m[4]}T00:00:00Z` : m[4];
    return resolvePriceMarket(m[1], m[2], m[3], dl);
  }

  m = market.match(POLYMARKET_MARKET);
  if (m) return resolvePolymarket(m[1]);

  m = market.match(DELPHI_MARKET);
  if (m) return resolveDelphi(m[1]);

  return { supported: false, resolved: null, outcome: null, at: null, detail: `no resolver for market ${market}` };
}

/**
 * THE GATE. Call immediately before anchoring, never at post time only — the window
 * between writing an entry and committing it is exactly where this bit me.
 * Returns { ok, refusals[] }.
 */
async function gateEntries(entries) {
  const refusals = [];
  for (const { seq, entry } of entries) {
    if (entry.lane !== 'prediction' || entry.type !== 'open') continue;
    let r;
    try { r = await resolveMarket(entry.market); }
    catch (e) { refusals.push({ seq, market: entry.market, reason: `resolver error: ${e.message}` }); continue; }
    if (!r.supported) { refusals.push({ seq, market: entry.market, reason: r.detail }); continue; }
    if (r.resolved) {
      refusals.push({ seq, market: entry.market,
        reason: `ALREADY RESOLVED (${r.outcome}) before anchoring — ${r.detail}` });
    }
  }
  return { ok: refusals.length === 0, refusals };
}

module.exports = { resolveMarket, gateEntries, DELPHI_KEY_DEFAULT };
