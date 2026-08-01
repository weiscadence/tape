'use strict';
/**
 * price-fallback.test.js — does the mark survive the day Pyth stops answering?
 *
 * Pyth Core deprecates unauthenticated Hermes on 2026-07-31. Testing that the fallback
 * "exists" by reading the code proves nothing: the only interesting state is the one where
 * the primary is DEAD, and that state never occurs while the test suite is passing for the
 * ordinary reason. So every test here kills a source on purpose and asserts on what comes
 * out the other side. A fallback that has only ever been exercised by its happy path is an
 * untested fallback wearing a passing suite as a disguise.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { priceAt, SOURCES } = require('../lib/price');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { probeDivergence, outOfReach, bucketOf, CANDLE_SEC } = require('../lib/price-sources');
const { requireDecimalString } = require('../lib/canonical');

const HOUR_AGO = () => Math.floor(Date.now() / 1000) - 3600;

/**
 * Swap the HTTPS transport for one that answers with `body(host)`. Used only where the
 * condition cannot be provoked at a live venue (a missing candle bucket); the adapter
 * under test is the real one. Returns the undo, which the caller must run in a finally.
 */
function stubHttps(body) {
  const real = https.request;
  https.request = (opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    process.nextTick(() => {
      res.emit('data', JSON.stringify(body(opts.host, opts.path)));
      res.emit('end');
    });
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => cb(res);
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = real; };
}

/** Replace `fetch` on the named sources with a thrower, run fn, always restore. */
async function withDead(names, fn) {
  const saved = new Map();
  for (const s of SOURCES) {
    if (names.includes(s.name)) {
      saved.set(s, s.fetch);
      s.fetch = async () => { const e = new Error(`${s.name} is dead (simulated outage)`); throw e; };
    }
  }
  try { return await fn(); }
  finally { for (const [s, f] of saved) s.fetch = f; }
}

test('primary alive: mark comes from pyth and is not flagged degraded', async () => {
  const r = await priceAt('SOL/USD', HOUR_AGO());
  assert.ok(r.ok, r.reason);
  assert.ok(r.source.startsWith('pyth:'), `expected pyth, got ${r.source}`);
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(r.primary_failure, undefined);
});

test('pyth dead: coinbase serves the mark, loudly flagged', async () => {
  const at = HOUR_AGO();
  const control = await priceAt('SOL/USD', at);
  assert.ok(control.ok, 'control must price before the outage test means anything');

  const r = await withDead(['pyth'], () => priceAt('SOL/USD', at));
  assert.ok(r.ok, `fallback failed to price: ${r.reason}`);
  assert.ok(r.source.startsWith('coinbase:'), `expected coinbase, got ${r.source}`);

  // The substitution must be impossible to miss downstream.
  assert.strictEqual(r.degraded, true, 'a non-primary mark must be flagged degraded');
  assert.match(r.primary_failure, /pyth/, 'must name which source fell');
  assert.match(r.source_url, /^https:\/\/api\.exchange\.coinbase\.com\//);

  // No confidence interval exists at a venue. `null` means unknown; a fabricated 0 would
  // read as the most certain mark on the board.
  assert.strictEqual(r.conf, null);
  assert.strictEqual(r.conf_bps, null);

  requireDecimalString(r.price, 'fallback price');

  // The whole justification for allowing the substitution is that it lands inside the
  // primary's own error bar. Assert that, not merely that a number came back.
  const spread = Math.abs(Number(r.price) - Number(control.price));
  const bps = (spread / Number(control.price)) * 10000;
  assert.ok(bps < 50, `fallback diverged ${bps.toFixed(1)} bps from pyth — too far to substitute`);
});

test('pyth and coinbase dead: bitstamp still serves, from unshared infrastructure', async () => {
  const at = HOUR_AGO();
  const r = await withDead(['pyth', 'coinbase'], () => priceAt('SOL/USD', at));
  assert.ok(r.ok, `third source failed to price: ${r.reason}`);
  assert.ok(r.source.startsWith('bitstamp:'), `expected bitstamp, got ${r.source}`);
  assert.strictEqual(r.degraded, true);
  assert.match(r.primary_failure, /pyth/);
  assert.match(r.primary_failure, /coinbase/);
});

/**
 * THE TEST THAT WOULD HAVE CAUGHT THE FIRST VERSION OF THIS FILE.
 *
 * Every test above asks for a price one hour old, and Kraken answers a one-hour-old
 * question perfectly well. Settlement does not: it prices a deadline, and deadlines are
 * days old by the time anyone argues about them. Asking at settlement depth is what
 * exposed that Kraken's OHLC window only reaches ~12 hours. So the depth is the fixture.
 */
const SETTLEMENT_AGO = () => Math.floor(Date.now() / 1000) - 27 * 3600;

test('at settlement depth the chain still resolves, and the shallow source is SKIPPED not failed', async () => {
  const at = SETTLEMENT_AGO();

  const primary = await priceAt('SOL/USD', at);
  assert.ok(primary.ok, `control failed at settlement depth: ${primary.reason}`);

  const deep = await withDead(['pyth', 'coinbase'], () => priceAt('SOL/USD', at));
  assert.ok(deep.ok, `nothing could price a 27h-old settlement: ${deep.reason}`);
  assert.ok(deep.source.startsWith('bitstamp:'), `expected bitstamp at depth, got ${deep.source}`);

  // Kraken must be declined for being out of reach, and the reason must say that rather
  // than looking like an outage. "no candle for bucket N" sent me to the wrong layer once.
  const all = await withDead(['pyth', 'coinbase', 'bitstamp'], () => priceAt('SOL/USD', at));
  assert.strictEqual(all.ok, false);
  assert.match(all.reason, /kraken: \d+s old, beyond measured reach/,
    `kraken should be skipped for reach, got: ${all.reason}`);
  assert.doesNotMatch(all.reason, /kraken: kraken has no candle/,
    'an out-of-reach source must not report an outage-shaped error');
});

test('reach is enforced per source, not assumed uniform', async () => {
  const shallow = SOURCES.find((s) => s.name === 'kraken');
  const deep = SOURCES.find((s) => s.name === 'bitstamp');
  const now = Math.floor(Date.now() / 1000);
  assert.ok(outOfReach(shallow, now - 27 * 3600), 'kraken must be out of reach at 27h');
  assert.strictEqual(outOfReach(shallow, now - 3600), null, 'kraken must be in reach at 1h');
  assert.strictEqual(outOfReach(deep, now - 27 * 3600), null, 'bitstamp must be in reach at 27h');
});

test('NEGATIVE CONTROL — all sources dead: no price, and the reason names every one', async () => {
  const r = await withDead(['pyth', 'coinbase', 'bitstamp', 'kraken'], () => priceAt('SOL/USD', HOUR_AGO()));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.price, undefined, 'a failed mark must never carry a price');
  for (const name of ['pyth', 'coinbase', 'bitstamp', 'kraken']) {
    assert.match(r.reason, new RegExp(name), `reason must name ${name}`);
  }
  assert.deepStrictEqual(r.sources_tried, ['pyth', 'coinbase', 'bitstamp', 'kraken']);
});

/**
 * THE TEST THAT WOULD HAVE CAUGHT THE SECOND VERSION OF THIS FILE.
 *
 * Every outage test above asks for a price one hour old, and at that depth the candle
 * containing the asked-for second is long closed, so the venue answers and the fallback
 * looks healthy. `latest` is a different regime: the newest CLOSED 60s candle is by
 * construction at least 60s behind "now". The old skew rule measured that distance from
 * the candle's START against a 60s ceiling — unsatisfiable — so with Pyth dead the
 * `latest` path had NO working source while this file was green. Pyth is sub-second and
 * never tripped the rule, which is precisely why nothing noticed.
 *
 * The depth was the fixture last time. This time the fixture is the argument itself:
 * `latest` (atUnix omitted) rather than a timestamp.
 */
test('latest with pyth dead: a venue serves it (the path the hour-old tests never enter)', async () => {
  const control = await priceAt('BTC/USD');
  assert.ok(control.ok, 'control must price before the outage test means anything');
  assert.ok(control.source.startsWith('pyth:'), `control should be pyth, got ${control.source}`);

  const r = await withDead(['pyth'], () => priceAt('BTC/USD'));
  assert.ok(r.ok, `latest fallback did not fire: ${r.reason}`);
  assert.match(r.source, /^(coinbase|bitstamp|kraken):/, `unexpected source ${r.source}`);
  assert.strictEqual(r.degraded, true, 'a venue mark must be flagged degraded');
  assert.match(r.primary_failure, /pyth/, 'must name which source fell');
  requireDecimalString(r.price, 'latest fallback price');

  const bps = (Math.abs(Number(r.price) - Number(control.price)) / Number(control.price)) * 10000;
  assert.ok(bps < 50, `latest fallback diverged ${bps.toFixed(1)} bps from pyth`);
});

/**
 * ABLATION. The test above can go green for reasons unrelated to the fix — if the venue
 * print happened to land inside 60s of the old rule, it would have passed before the
 * change too and proves nothing. So recompute the PRE-FIX rule against the very print
 * that just passed and assert it would have been rejected.
 */
test('ablation: the pre-fix skew rule rejects the latest print that now passes', async () => {
  const r = await withDead(['pyth'], () => priceAt('BTC/USD'));
  assert.ok(r.ok, `need a passing print to ablate against: ${r.reason}`);

  // Pre-fix: distance from the candle's START to "now", capped at the module ceiling.
  const preFixSkew = Math.abs(r.publish_time - Math.floor(Date.now() / 1000));
  const preFixLimit = Math.min(r.granularity_sec || 60, 60);
  assert.ok(preFixSkew > preFixLimit,
    `the pre-fix rule would have ACCEPTED this print (${preFixSkew}s vs ${preFixLimit}s) — `
    + 'the latest-fallback test is green for some reason other than the fix');

  // Post-fix: measured to the EDGE of the window the candle speaks for, so it is inside.
  assert.ok(r.skew_sec <= 60, `post-fix skew ${r.skew_sec}s should be within the ceiling`);
});

/**
 * The ceiling must still BIND after being made granularity-aware, or the fix traded a
 * false negative for a false positive. A candle whose window ended two hours ago is stale
 * by any definition and must be refused.
 */
test('the freshness ceiling still bites: a long-closed window is refused', async () => {
  const stale = { price: '1.00', conf: null, publish_time: Math.floor(Date.now() / 1000) - 7200,
    source: 'fake:candle60:close', url: 'https://example.invalid/', granularity_sec: 60 };
  const coinbase = SOURCES.find((s) => s.name === 'coinbase');
  const saved = coinbase.fetch;
  coinbase.fetch = async () => stale;
  try {
    const r = await withDead(['pyth'], () => priceAt('BTC/USD'));
    // Bitstamp/kraken may still answer; what matters is that the stale print was not used.
    assert.doesNotMatch(r.ok ? r.source : '', /^fake:/, 'a 2h-old window was accepted as fresh');
    assert.strictEqual(r.price === '1.00', false, 'the stale fake price was used as a mark');
  } finally { coinbase.fetch = saved; }
});

/**
 * Bucket identity moved OUT of the skew check when skew became a freshness measure.
 * Coinbase used to fall back to the newest row when the asked-for bucket was missing,
 * which returned a different minute's price wearing a valid-looking mark; the old skew
 * rule rejected it by accident. That guarantee now lives in the adapter, so assert it
 * there rather than trusting that the accident still happens.
 */
test('a venue names a missing bucket instead of substituting the newest one', async () => {
  const at = Math.floor(Date.now() / 1000) - 3600;
  const b = bucketOf(at);

  // A response that is well-formed and current but simply lacks the asked-for bucket —
  // the gap case. Coinbase cannot be made to produce this on demand, so the transport is
  // stubbed; everything above it is the real adapter.
  const wrongBucket = [[b - CANDLE_SEC, 1, 2, 3, '64000.00', 10]];
  const restore = stubHttps((host) => {
    if (!/coinbase/.test(host)) throw new Error(`unexpected host ${host}`);
    return wrongBucket;
  });

  let r;
  try { r = await withDead(['pyth', 'bitstamp', 'kraken'], () => priceAt('BTC/USD', at)); }
  finally { restore(); }

  assert.strictEqual(r.ok, false, `coinbase substituted bucket ${b - CANDLE_SEC}: ${r.price}`);
  assert.match(r.reason, new RegExp(`coinbase has no candle for bucket ${b}`),
    `a missing bucket must be named as such, got: ${r.reason}`);
  assert.doesNotMatch(r.reason, /coinbase: stale mark/,
    'a missing bucket must not be reported as a freshness problem');

  // POSITIVE CONTROL: the same stub with the RIGHT bucket must be accepted, or the test
  // above proves only that the stub is broken.
  const rightBucket = [[b, 1, 2, 3, '64000.00', 10]];
  const restore2 = stubHttps(() => rightBucket);
  let good;
  try { good = await withDead(['pyth', 'bitstamp', 'kraken'], () => priceAt('BTC/USD', at)); }
  finally { restore2(); }
  assert.ok(good.ok, `positive control failed — the stub cannot serve a good mark: ${good.reason}`);
  assert.strictEqual(good.price, '64000');
});

test('a future timestamp is refused before any source is asked', async () => {
  const r = await priceAt('SOL/USD', Math.floor(Date.now() / 1000) + 86400);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /future/);
  assert.strictEqual(r.price, undefined);
});

test('divergence probe re-measures the claim instead of trusting the comment', async () => {
  const d = await probeDivergence('SOL/USD', HOUR_AGO());
  const ok = d.reads.filter((r) => r.ok);
  assert.ok(ok.length >= 2, `need >=2 live sources to measure a spread, got ${ok.length}`);
  // Every read must be reproducible by a stranger: the URL is the instruction.
  for (const r of ok) assert.match(r.url, /^https:\/\//);
  assert.ok(Number(d.spread_bps) < 50, `sources disagree by ${d.spread_bps} bps`);
});
