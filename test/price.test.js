'use strict';
/**
 * price.test.js — the mark, in both states.
 *
 * The failure this file is written against: an oracle wrapper that returns a plausible
 * number no matter what happened upstream. Every "ok:false" path below therefore has to
 * be reachable in a real run, and the exactness tests exist because a leaderboard that
 * prints 0.1+0.2 has already lost the argument it was built to win.
 */

const assert = require('assert');
const { priceAt, scaleToDecimal, MAX_SKEW_SEC } = require('../lib/price');
const { requireDecimalString } = require('../lib/canonical');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { console.log(`  ✓ ${name}`); pass++; })
  .catch((e) => { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; });

async function main() {
  console.log('\nexact decimal scaling (no floats anywhere)');
  await t('negative exponent places the point exactly', () => {
    assert.strictEqual(scaleToDecimal('7337725076', -8), '73.37725076');
  });
  await t('trailing zeros are trimmed, not rounded', () => {
    assert.strictEqual(scaleToDecimal('7391440200', -8), '73.914402');
  });
  await t('mantissa shorter than the exponent pads correctly', () => {
    assert.strictEqual(scaleToDecimal('42', -8), '0.00000042');
  });
  await t('whole numbers survive', () => {
    assert.strictEqual(scaleToDecimal('150000', 0), '150000');
  });
  await t('positive exponent multiplies', () => {
    assert.strictEqual(scaleToDecimal('15', 3), '15000');
  });
  await t('negatives keep their sign', () => {
    assert.strictEqual(scaleToDecimal('-125', -2), '-1.25');
  });
  await t('output is always a canonical decimal string', () => {
    for (const [m, e] of [['7337725076', -8], ['42', -8], ['150000', 0], ['-125', -2]]) {
      requireDecimalString(scaleToDecimal(m, e), 'scaled');
    }
  });
  // NEGATIVE CONTROL: the float path this module exists to avoid.
  //
  // My first version of this control used 7337725076 * 1e-8, which happens to print
  // exactly — so the control FAILED, correctly, by asserting something untrue. The real
  // divergence class is not "float loses digits on every value", it is "String() switches
  // to exponent notation at the extremes", which silently produces a non-decimal string
  // that canonical.js would reject and a rival implementation would hash differently.
  await t('negative control: float formatting escapes to exponent notation, ours does not', () => {
    assert.strictEqual(String(1 * 1e-7), '1e-7');
    assert.strictEqual(scaleToDecimal('1', -7), '0.0000001');
    assert.strictEqual(String(1 * 1e21), '1e+21');
    assert.strictEqual(scaleToDecimal('1', 21), '1000000000000000000000');
    requireDecimalString(scaleToDecimal('1', -7), 'tiny');
    requireDecimalString(scaleToDecimal('1', 21), 'huge');
  });
  await t('negative control: float accumulation diverges where exact scaling does not', () => {
    assert.notStrictEqual(String(0.1 + 0.2), '0.3');
    assert.strictEqual(scaleToDecimal('3', -1), '0.3');
  });

  console.log('\nrefusals (unknown must never look like fine)');
  await t('unregistered symbol is refused and names itself', async () => {
    const r = await priceAt('DOGE/USD');
    assert.strictEqual(r.ok, false);
    assert.ok(/no feed registered for DOGE\/USD/.test(r.reason), r.reason);
    assert.strictEqual(r.price, undefined, 'a refused mark must carry no price');
  });
  await t('a future timestamp is refused, not answered with the newest tick', async () => {
    const r = await priceAt('SOL/USD', Math.floor(Date.now() / 1000) + 3600);
    assert.strictEqual(r.ok, false);
    assert.ok(/future/.test(r.reason), r.reason);
    assert.strictEqual(r.price, undefined);
  });
  await t('a nonsense timestamp is refused', async () => {
    const r = await priceAt('SOL/USD', -5);
    assert.strictEqual(r.ok, false);
    assert.ok(/bad timestamp/.test(r.reason), r.reason);
  });
  await t('a pre-launch timestamp yields no usable mark', async () => {
    // 2015: long before this feed existed. Whatever comes back must not be usable.
    const r = await priceAt('SOL/USD', 1420070400);
    assert.strictEqual(r.ok, false, `expected refusal, got price ${r.price}`);
    assert.strictEqual(r.price, undefined);
  });

  console.log('\nlive oracle');
  const now = await priceAt('SOL/USD');
  await t('latest SOL/USD returns a usable mark', () => {
    assert.strictEqual(now.ok, true, now.reason);
    requireDecimalString(now.price, 'now.price');
    assert.ok(Number(now.price) > 0, `price ${now.price}`);
    assert.ok(now.skew_sec <= MAX_SKEW_SEC, `skew ${now.skew_sec}`);
    assert.ok(/^pyth:[0-9a-f]{64}$/.test(now.source), now.source);
  });
  await t('confidence is reported, in bps, and is sane', () => {
    assert.ok(now.conf_bps !== null && Number(now.conf_bps) >= 0, `conf_bps ${now.conf_bps}`);
    assert.ok(Number(now.conf_bps) < 1000, `confidence ${now.conf_bps}bps is too wide to mark against`);
  });
  await t('a mark at a PAST timestamp is reproducible (recomputable tomorrow)', async () => {
    const ts = Math.floor(Date.now() / 1000) - 3600;
    const a = await priceAt('SOL/USD', ts);
    const b = await priceAt('SOL/USD', ts);
    assert.strictEqual(a.ok, true, a.reason);
    assert.strictEqual(a.price, b.price, 'same timestamp gave two different prices');
    assert.strictEqual(a.publish_time, b.publish_time);
    assert.ok(a.skew_sec <= MAX_SKEW_SEC, `skew ${a.skew_sec}`);
  });
  await t('a past mark differs from the latest mark (we are not just re-reading now)', async () => {
    const old = await priceAt('SOL/USD', Math.floor(Date.now() / 1000) - 86400);
    assert.strictEqual(old.ok, true, old.reason);
    assert.notStrictEqual(old.publish_time, now.publish_time,
      'historical query returned the current tick — the time argument is being ignored');
  });
  await t('BTC/USD and ETH/USD feeds are live too', async () => {
    for (const sym of ['BTC/USD', 'ETH/USD']) {
      const r = await priceAt(sym);
      assert.strictEqual(r.ok, true, `${sym}: ${r.reason}`);
      assert.ok(Number(r.price) > 0, `${sym} price ${r.price}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
