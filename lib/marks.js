'use strict';
/**
 * marks.js — the only part of scoring that touches the network.
 *
 * It is separate from score.js on purpose. The mark set it produces is a plain JSON
 * object that gets PUBLISHED with the leaderboard, which means a stranger recomputes our
 * ranking with zero oracle calls and either gets our number or catches us. If verifying
 * the leaderboard required re-fetching hundreds of historical ticks, we would be the
 * only party who could afford to check — and §7 says that is how we quietly become the
 * authority again.
 *
 * A failed fetch is RECORDED as a failure and kept in the set. Dropping it would leave a
 * hole that the scorer reports as "not in mark set", which reads like our bug rather than
 * the oracle's outage; keeping `{ok:false, reason}` preserves what actually happened.
 */

const fs = require('fs');
const path = require('path');
const { priceAt } = require('./price');
const { resolveMarket } = require('./resolve');
const { markRequests } = require('./score');

const CACHE_FILE = require('./datadir').dataPath('marks-cache.json');

/**
 * WHAT MAY BE CACHED, AND WHY THAT IS NOT THE THING price.js WARNS ABOUT.
 *
 * price.js says never quietly reuse a stale tick when the feed is down — that would mark
 * a live position at a price from a different market regime. This cache is a different
 * animal, and the line between them is worth stating because they look identical from
 * the outside:
 *
 *   - A HISTORICAL tick, requested at a FIXED PAST timestamp, is immutable. Pyth returns
 *     the same answer forever; anyone can re-fetch it and check. Storing it is
 *     memoization of a pure function, and re-asking is pure waste — which is what got us
 *     rate-limited into `unscored` on honest positions.
 *   - A LATEST tick is a moving value. It is never cached, at any age.
 *
 * Enforced below rather than left as a convention: an entry is only written to the cache
 * when it carries `ok`, a `publish_time`, and a request time old enough that it cannot
 * still be moving. A failure is NEVER cached — an outage must not become permanent.
 */
const CACHEABLE_AGE_SEC = 120;

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 0));
}
function cacheable(req, mark) {
  if (req.kind !== 'price') return false;              // resolutions can change: never cached
  if (!mark || !mark.ok) return false;                 // an outage must not become permanent
  if (!Number.isInteger(req.at)) return false;
  return req.at < Math.floor(Date.now() / 1000) - CACHEABLE_AGE_SEC;
}

/**
 * Fetch every mark the positions need. Loops because a settled binary's benchmark leg is
 * only discoverable once its resolution is known (see markRequests).
 */
async function fetchMarks(positions, asOfUnix, { marks = {}, maxRounds = 4, log = () => {}, useCache = true } = {}) {
  const out = { ...marks };
  const cache = useCache ? loadCache() : {};
  let hits = 0, fetched = 0;
  for (let round = 0; round < maxRounds; round++) {
    const reqs = markRequests(positions, asOfUnix, out);
    if (!reqs.length) break;
    log(`  marks round ${round + 1}: ${reqs.length} needed`);
    for (const r of reqs) {
      if (useCache && cache[r.key]) { out[r.key] = cache[r.key]; hits++; continue; }
      if (r.kind === 'price') {
        out[r.key] = await priceAt(r.symbol, r.at);
        fetched++;
        if (useCache && cacheable(r, out[r.key])) cache[r.key] = out[r.key];
      } else {
        try {
          out[r.key] = { kind: 'resolution', ...(await resolveMarket(r.market)) };
        } catch (e) {
          // An unreachable resolver is `supported:false` with the reason attached, which
          // the scorer refuses. It is never `resolved:false` — "I could not check" and
          // "it is still open" are different facts and must not collapse into one.
          out[r.key] = { kind: 'resolution', supported: false, resolved: null, outcome: null,
            at: null, detail: `resolver error: ${e.message}` };
        }
      }
    }
  }
  const left = markRequests(positions, asOfUnix, out);
  if (left.length) throw new Error(`marks did not converge after ${maxRounds} rounds (${left.length} outstanding)`);
  if (useCache && fetched) saveCache(cache);
  log(`  marks: ${hits} from cache, ${fetched} fetched`);
  return out;
}

module.exports = { fetchMarks, cacheable, CACHE_FILE, CACHEABLE_AGE_SEC };
