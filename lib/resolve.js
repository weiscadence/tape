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

module.exports = { resolveMarket, gateEntries };
