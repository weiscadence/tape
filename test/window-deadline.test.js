'use strict';
/**
 * window-deadline.test.js — the READ path must agree with the WRITE path about the deadline.
 *
 * handleEnroll refuses once now > enroll_closes_at, close row or no close row. windowState
 * used to compute `enrollment_open` from the close row alone, so between the committed
 * deadline and the moment the operator wrote the close row, GET /windows listed the epoch
 * under `enrolling_now` and the enroll it invited came back 409 (panel 2026-11-17).
 *
 * Two epochs, neither with a close row: one past its deadline, one not. Each claim is
 * asserted in both states, so the test cannot pass by reporting everything closed.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const W = require('../lib/windows');
const ed = require('../lib/ed25519');
const { Chain } = require('../lib/chain');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};
const newNonce = () => crypto.randomBytes(16).toString('hex');
const newKey = () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const pubDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return Buffer.concat([der.subarray(der.length - 32), pubDer.subarray(pubDer.length - 32)]);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-windl-'));
const PORT = 4000 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const boardKey = newKey();
const chain = new Chain(path.join(DIR, 'tape.jsonl'));
const LATE = '2026-W97', OPEN = '2026-W98';
const nowSec = Math.floor(Date.now() / 1000);
for (const [epoch, closes] of [[LATE, nowSec - 60], [OPEN, nowSec + 3600]]) {
  const seed = crypto.randomBytes(32).toString('hex');
  chain.append(W.signWindowRow(W.buildWindowRow({
    type: 'schedule_commit', epoch, seed_commit: crypto.createHash('sha256').update(seed, 'utf8').digest('hex'),
    catalog_hash: W.catalogHash(), enroll_closes_at: closes, windows_per_caller: 1,
  }), boardKey));
}

async function req(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'api.js')], {
    env: { ...process.env, TAPE_DATA: DIR, TAPE_API_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try { await fetch(BASE + '/health'); break; }
      catch { if (Date.now() > deadline) throw new Error('server never came up'); await new Promise((r) => setTimeout(r, 200)); }
    }
    const alice = newKey();
    const enroll = (epoch) => req('POST', '/window/enroll', W.signWindowRow(W.buildWindowRow({
      type: 'enroll', epoch, caller: 'alice', ts_claimed: new Date().toISOString(), nonce: newNonce(),
    }), alice));

    const idx = await req('GET', '/windows');
    const late = await req('GET', `/windows/${LATE}`);
    const open = await req('GET', `/windows/${OPEN}`);
    t('past the committed deadline, no close row: not reported open', () => {
      assert.strictEqual(late.status, 200, JSON.stringify(late.json));
      assert.strictEqual(late.json.enrollment_open, false, JSON.stringify(late.json));
    });
    t('before the deadline: still reported open (the check can say yes)', () => {
      assert.strictEqual(open.json.enrollment_open, true, JSON.stringify(open.json));
    });
    t('/windows enrolling_now lists only the epoch that will actually accept an enroll', () => {
      assert.strictEqual(idx.status, 200, JSON.stringify(idx.json));
      assert.deepStrictEqual(idx.json.enrolling_now, [OPEN]);
      const row = idx.json.epochs.find((e) => e.epoch === LATE);
      assert.strictEqual(row.enrollment_open, false);
    });
    const rLate = await enroll(LATE), rOpen = await enroll(OPEN);
    t('the write path agrees: late epoch 409, open epoch 201', () => {
      assert.strictEqual(rLate.status, 409, JSON.stringify(rLate.json));
      assert.strictEqual(rOpen.status, 201, JSON.stringify(rOpen.json));
    });
  } catch (e) {
    fail++;
    console.log(`  FAIL uncaught mid-sequence: ${(e && e.message) || e}`);
  } finally {
    srv.kill();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
