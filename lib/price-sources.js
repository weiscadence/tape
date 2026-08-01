'use strict';
/**
 * price-sources.js — where a mark can come from, and what each source costs you.
 *
 * WHY THIS FILE EXISTS (dated, not hypothetical):
 * Pyth Core deprecates its unauthenticated Hermes endpoints on 2026-07-31. Every mark on
 * this board was read from that one host with no second opinion, which means the day it
 * stops answering, every open position goes `unscored` and every pending settlement stops
 * settling. A leaderboard whose scoring dies with one vendor is not a record, it is a
 * rental.
 *
 * THE CONSTRAINT A FALLBACK MUST MEET. price.js's whole argument is that the number comes
 * from outside us and a stranger can re-derive it. So a source qualifies only if it is:
 *   1. public and unauthenticated — a verifier needs no key we control,
 *   2. queryable AT A PAST TIMESTAMP — otherwise yesterday's board cannot be rechecked,
 *   3. exactly addressable — the record names the URL that reproduces the number.
 * That rules out most "free tier" APIs, which are (1)-shaped but key-gated in practice.
 *
 * ORDER, AND WHY IT IS NOT ARBITRARY. Pyth stays first while it lives: it is the on-chain
 * oracle these positions are notionally priced against, and it is the only one of the four
 * that publishes a confidence interval, so a wide tick stays visible instead of being
 * rounded into false precision. Coinbase, Bitstamp and Kraken are venue prints — no
 * interval, and a 60s candle instead of a tick. Among the venues the order is by MEASURED
 * REACH (see REACH_SEC), because a source that cannot see back far enough is useless
 * exactly when a settlement is being disputed.
 *
 * MEASURED, NOT ASSUMED. At unix 1785459427 the sources read:
 *   pyth     74.395  (conf 0.040 = 5.4 bps)
 *   coinbase 74.37   (60s candle close, bucket 1785459420)
 *   kraken   74.39   (60s candle close, bucket 1785459420)
 * The venue prints land INSIDE Pyth's own confidence interval. That is the justification
 * for allowing the substitution at all — not "close enough", but "smaller than the error
 * bar the primary source publishes about itself". If that ever stops being true the
 * substitution stops being honest, so `probeDivergence()` below re-measures it on demand
 * rather than leaving this comment to rot.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It never averages sources. A blended price is
 * a number no one published and no one can re-derive; it would make our board unverifiable
 * in exactly the way §7 warns about. One source wins, and the mark says which.
 */

const https = require('https');

/** Pyth mainnet price-feed ids. Each has been queried live and returned a parsed price. */
const PYTH_FEEDS = {
  'SOL/USD': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'BTC/USD': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH/USD': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

const COINBASE_PRODUCTS = { 'SOL/USD': 'SOL-USD', 'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD' };
const BITSTAMP_PAIRS = { 'SOL/USD': 'solusd', 'BTC/USD': 'btcusd', 'ETH/USD': 'ethusd' };
const KRAKEN_PAIRS = { 'SOL/USD': 'SOLUSD', 'BTC/USD': 'XBTUSD', 'ETH/USD': 'ETHUSD' };

/**
 * HOW FAR BACK EACH SOURCE CAN ACTUALLY ANSWER — measured 2026-07-31, not read off a doc.
 *
 * This constant exists because the first version of this file did not have it and was
 * wrong. Kraken was written in as a general-purpose third source; it answered every test,
 * because every test asked for a price one hour old. The first settlement-shaped query —
 * a deadline 27 hours back — returned "kraken has no candle for bucket 1785369600".
 * Kraken's OHLC `since` window returns ~720 candles, so at 1-minute granularity it can
 * see about twelve hours and no further. A fallback that silently cannot cover the range
 * it is called for is not a fallback; it is a fourth way to fail.
 *
 * Probed at 1h / 12h / 27h / 7d / 30d for SOL/USD:
 *   coinbase  hit hit hit hit hit
 *   bitstamp  hit hit hit hit hit
 *   kraken    hit hit MISS MISS MISS
 *
 * So reach is now a declared property the chain ENFORCES — a source too shallow for the
 * requested timestamp is skipped with a stated reason, instead of being asked and
 * producing an outage-shaped error that hides the real cause.
 *
 * Binance was evaluated and rejected: `api.binance.com` returns 451 from this host, and a
 * source that depends on where the verifier is standing cannot be part of a record whose
 * whole claim is that a stranger can re-derive it.
 */
const REACH_SEC = {
  pyth: null,                 // historical endpoint, no measured floor; let it fail honestly
  coinbase: 30 * 86400,
  bitstamp: 30 * 86400,
  kraken: 12 * 3600,          // measured ceiling, not a guess
};

/** Candle width for the venue sources. A mark lands in exactly one bucket. */
const CANDLE_SEC = 60;

function httpGetJson(host, path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'GET',
      headers: { 'User-Agent': 'tape-price', Accept: 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          const e = new Error(`${host} ${res.statusCode}`);
          e.status = res.statusCode;
          return reject(e);
        }
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`${host} non-JSON: ${e.message}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${host} timeout`)));
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry only the transient classes. A 429 during a board build is "we asked too fast" and
 * must not become `unscored` on an honest position; a 404 is an answer and retrying it is
 * just latency.
 */
async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const transient = e.status === 429 || (e.status >= 500 && e.status < 600) || !e.status;
      if (!transient || i === attempts - 1) throw e;
      await sleep(400 * 2 ** i);
    }
  }
  throw last;
}

/** Exact (mantissa, expo) -> decimal string. No floats anywhere near a mark. */
function scaleToDecimal(intStr, expo) {
  if (!/^-?\d+$/.test(String(intStr))) throw new TypeError(`price: non-integer mantissa ${intStr}`);
  if (!Number.isInteger(expo)) throw new TypeError(`price: non-integer expo ${expo}`);
  const neg = String(intStr).startsWith('-');
  let digits = String(intStr).replace('-', '');
  if (expo >= 0) {
    digits += '0'.repeat(expo);
    return (neg ? '-' : '') + digits.replace(/^0+(?=\d)/, '');
  }
  const places = -expo;
  if (digits.length <= places) digits = '0'.repeat(places - digits.length + 1) + digits;
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return (neg ? '-' : '') + out.replace(/^0+(?=\d)/, '');
}

/** A venue quote arrives as a decimal string already. Normalise without going through Number. */
function normaliseDecimal(s, what) {
  const t = String(s).trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new TypeError(`${what}: not a decimal string: ${s}`);
  const neg = t.startsWith('-');
  const [w, f = ''] = t.replace('-', '').split('.');
  const frac = f.replace(/0+$/, '');
  const whole = w.replace(/^0+(?=\d)/, '');
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
}

/** The bucket a timestamp falls in, for candle sources. */
const bucketOf = (unix) => Math.floor(unix / CANDLE_SEC) * CANDLE_SEC;

/* ------------------------------------------------------------------ sources */

/**
 * A source adapter returns { price, conf, publish_time, source, url, granularity_sec }
 * on success and THROWS on failure. It never returns a price it is unsure about — the
 * caller's job is to decide what an absent price means, and it can only do that if
 * "absent" is unambiguous.
 *
 * `url` is not decoration. It is the reproduction instruction: paste it, get this number.
 */

const pyth = {
  name: 'pyth',
  primary: true,
  maxSkewSec: 60,
  supports: (symbol) => Boolean(PYTH_FEEDS[symbol]),
  async fetch(symbol, wanted, { latest }) {
    const id = PYTH_FEEDS[symbol];
    const path = latest ? `/v2/updates/price/latest?ids[]=${id}` : `/v2/updates/price/${wanted}?ids[]=${id}`;
    const doc = await withRetry(() => httpGetJson('hermes.pyth.network', path));
    const p = (doc.parsed || []).find((x) => x.id === id);
    if (!p || !p.price) throw new Error('pyth returned no parsed price');
    return {
      price: scaleToDecimal(p.price.price, p.price.expo),
      conf: scaleToDecimal(p.price.conf, p.price.expo),
      publish_time: p.price.publish_time,
      source: `pyth:${id}`,
      url: `https://hermes.pyth.network${path}`,
      granularity_sec: 0,
      pyth_slot: p.metadata ? p.metadata.slot : null,
    };
  },
};

/**
 * Coinbase Exchange public candles. Historical, unauthenticated, no key.
 * Rows are [time, low, high, open, close, volume] and arrive newest-first; we take the
 * bucket containing the requested second and mark at its CLOSE. Close (not high, not an
 * average) because it is the one field with a single unambiguous definition, which is
 * what makes it re-derivable by a stranger.
 */
const coinbase = {
  name: 'coinbase',
  primary: false,
  maxSkewSec: CANDLE_SEC,
  supports: (symbol) => Boolean(COINBASE_PRODUCTS[symbol]),
  async fetch(symbol, wanted, { latest }) {
    const product = COINBASE_PRODUCTS[symbol];
    const b = bucketOf(latest ? Math.floor(Date.now() / 1000) - CANDLE_SEC : wanted);
    const path = `/products/${product}/candles?granularity=${CANDLE_SEC}`
      + `&start=${b - CANDLE_SEC}&end=${b + CANDLE_SEC}`;
    const rows = await withRetry(() => httpGetJson('api.exchange.coinbase.com', path));
    if (!Array.isArray(rows) || !rows.length) throw new Error('coinbase returned no candles');
    // No `|| rows[0]` fallback. Taking the newest row when the asked-for bucket is absent
    // returns a price for a DIFFERENT minute that looks exactly like a good mark; the skew
    // check used to catch it by accident and no longer does, because skew now measures
    // freshness and this is a wrong-bucket bug. Bucket identity is guaranteed here, where
    // it can still be named, and matches how kraken and bitstamp already behave.
    const row = rows.find((r) => Number(r[0]) === b);
    if (!row) throw new Error(`coinbase has no candle for bucket ${b}`);
    if (!Array.isArray(row) || row.length < 5) throw new Error('coinbase candle malformed');
    return {
      price: normaliseDecimal(row[4], 'coinbase.close'),
      conf: null,
      publish_time: Number(row[0]),
      source: `coinbase:${product}:candle${CANDLE_SEC}:close`,
      url: `https://api.exchange.coinbase.com${path}`,
      granularity_sec: CANDLE_SEC,
    };
  },
};

/**
 * Kraken public OHLC. Same shape of guarantee as Coinbase, different operator — the point
 * of a third source is that it shares no infrastructure with the second.
 * Rows are [time, open, high, low, close, vwap, volume, count].
 */
const kraken = {
  name: 'kraken',
  primary: false,
  maxSkewSec: CANDLE_SEC,
  supports: (symbol) => Boolean(KRAKEN_PAIRS[symbol]),
  async fetch(symbol, wanted, { latest }) {
    const pair = KRAKEN_PAIRS[symbol];
    const b = bucketOf(latest ? Math.floor(Date.now() / 1000) - CANDLE_SEC : wanted);
    const path = `/0/public/OHLC?pair=${pair}&interval=1&since=${b - CANDLE_SEC * 2}`;
    const doc = await withRetry(() => httpGetJson('api.kraken.com', path));
    if (doc.error && doc.error.length) throw new Error(`kraken: ${doc.error.join(',')}`);
    const key = Object.keys(doc.result || {}).find((k) => k !== 'last');
    const rows = key ? doc.result[key] : null;
    if (!Array.isArray(rows) || !rows.length) throw new Error('kraken returned no candles');
    const row = rows.find((r) => Number(r[0]) === b);
    if (!row) throw new Error(`kraken has no candle for bucket ${b}`);
    return {
      price: normaliseDecimal(row[4], 'kraken.close'),
      conf: null,
      publish_time: Number(row[0]),
      source: `kraken:${pair}:candle${CANDLE_SEC}:close`,
      url: `https://api.kraken.com${path}`,
      granularity_sec: CANDLE_SEC,
    };
  },
};

/**
 * Bitstamp public OHLC. The deep-history venue: measured to 30 days at 1-minute steps,
 * unauthenticated, and quoted in real USD rather than a stablecoin proxy. It sits ahead of
 * Kraken precisely because Kraken cannot answer a settlement-aged question.
 * Rows are { timestamp, open, high, low, close, volume } as strings.
 */
const bitstamp = {
  name: 'bitstamp',
  primary: false,
  maxSkewSec: CANDLE_SEC,
  supports: (symbol) => Boolean(BITSTAMP_PAIRS[symbol]),
  async fetch(symbol, wanted, { latest }) {
    const pair = BITSTAMP_PAIRS[symbol];
    const b = bucketOf(latest ? Math.floor(Date.now() / 1000) - CANDLE_SEC : wanted);
    const path = `/api/v2/ohlc/${pair}/?step=${CANDLE_SEC}&limit=3&start=${b - CANDLE_SEC}`;
    const doc = await withRetry(() => httpGetJson('www.bitstamp.net', path));
    const rows = doc && doc.data && doc.data.ohlc;
    if (!Array.isArray(rows) || !rows.length) throw new Error('bitstamp returned no candles');
    const row = rows.find((r) => Number(r.timestamp) === b);
    if (!row) throw new Error(`bitstamp has no candle for bucket ${b}`);
    return {
      price: normaliseDecimal(row.close, 'bitstamp.close'),
      conf: null,
      publish_time: Number(row.timestamp),
      source: `bitstamp:${pair}:candle${CANDLE_SEC}:close`,
      url: `https://www.bitstamp.net${path}`,
      granularity_sec: CANDLE_SEC,
    };
  },
};

/**
 * Order is the policy: on-chain oracle first, then venues in order of measured reach.
 * Kraken is last because it is the shallowest, not because it is the least trustworthy.
 */
const SOURCES = [pyth, coinbase, bitstamp, kraken];

/** Reach attached to each adapter so the chain can enforce it rather than trust a table. */
for (const s of SOURCES) s.reachSec = REACH_SEC[s.name];

/**
 * Can this source honestly answer a question about `wanted`? Returns a reason string when
 * it cannot, so the skip is recorded rather than silent.
 */
function outOfReach(src, wanted) {
  if (!src.reachSec) return null;
  const age = Math.floor(Date.now() / 1000) - wanted;
  if (age <= src.reachSec) return null;
  return `${src.name}: ${age}s old, beyond measured reach of ${src.reachSec}s`;
}

/**
 * Re-measure the claim in this file's header instead of trusting it.
 *
 * Returns every source's read at one timestamp plus the spread, so the "venue prints sit
 * inside Pyth's confidence interval" assertion can be checked on any day rather than
 * believed because a comment says so. Used by the fallback test and safe to run by hand.
 */
async function probeDivergence(symbol, atUnix) {
  const wanted = Number.isInteger(atUnix) ? atUnix : Math.floor(Date.now() / 1000) - 300;
  const reads = [];
  for (const s of SOURCES) {
    if (!s.supports(symbol)) continue;
    try {
      const r = await s.fetch(symbol, wanted, { latest: false });
      reads.push({ source: s.name, ok: true, price: r.price, conf: r.conf, url: r.url });
    } catch (e) {
      reads.push({ source: s.name, ok: false, reason: e.message });
    }
  }
  const ok = reads.filter((r) => r.ok);
  const nums = ok.map((r) => Number(r.price));
  const spread = nums.length > 1 ? Math.max(...nums) - Math.min(...nums) : 0;
  const primary = ok.find((r) => r.source === 'pyth');
  return {
    symbol, at: wanted, reads,
    spread_abs: String(spread),
    spread_bps: nums.length > 1 ? String(Math.round((spread / Math.min(...nums)) * 10000)) : '0',
    primary_conf_bps: primary && primary.conf && Number(primary.price)
      ? String(Math.round((Number(primary.conf) / Number(primary.price)) * 10000)) : null,
  };
}

module.exports = {
  SOURCES, PYTH_FEEDS, COINBASE_PRODUCTS, BITSTAMP_PAIRS, KRAKEN_PAIRS, CANDLE_SEC,
  REACH_SEC, outOfReach, scaleToDecimal, normaliseDecimal, bucketOf, probeDivergence,
};
