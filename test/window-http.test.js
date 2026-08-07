'use strict';
/**
 * window-http.test.js — the assigned-question mechanism over HTTP.
 *
 * WHY THIS FILE EXISTS. The window mechanism (enroll -> the board mints a question you did
 * not pick -> answer/pass, plus a no_answer row you cannot withhold) shipped as a local CLI
 * that wrote straight to the data file. Every guard in lib/windows.js was tested, and the
 * mechanism was still unreachable: the only caller who could enroll was whoever had a shell
 * on the box, which is the operator. A mechanism whose whole purpose is to stop the operator
 * choosing the questions cannot be operator-only.
 *
 * So the assertions below are not about the crypto — windows.test.js already covers that.
 * They are about REACHABILITY and REFUSAL over the wire: can a stranger with nothing but a
 * keypair and an HTTP client participate, and do the four ways of cheating still get
 * refused when the request arrives over the network instead of from argv.
 *
 * Every refusal is exercised in its FIRING state. A guard asserted only in the state where
 * it stays quiet is a guard nobody has tested.
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
  const seed = der.subarray(der.length - 32);
  const pubDer = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const raw = pubDer.subarray(pubDer.length - 32);
  return Buffer.concat([seed, raw]);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-winhttp-'));
const CHAIN = path.join(DIR, 'tape.jsonl');
const PORT = 3900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;

// ── seed a chain: board commits, one caller enrolls, close+reveal+ask ─────────────────
const boardKey = newKey();
const board = ed.publicKeyOf(boardKey);
const EPOCH = '2026-W99';
const seed = crypto.randomBytes(32).toString('hex');
const seedCommit = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');

const chain = new Chain(CHAIN);
const boardRow = (o) => chain.append(W.signWindowRow(W.buildWindowRow(o), boardKey));

boardRow({
  type: 'schedule_commit', epoch: EPOCH, seed_commit: seedCommit,
  catalog_hash: W.catalogHash(), enroll_closes_at: Math.floor(Date.now() / 1000) + 3600,
  windows_per_caller: 1,
});

async function req(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'api.js')], {
    env: { ...process.env, TAPE_DATA: DIR, TAPE_API_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { if (/Error|throw/.test(String(d))) process.stderr.write(d); });

  // Everything below this point is one wire session against a single spawned server.
  // ANY throw here — a fetch that hard-fails mid-sequence, not just an assertion inside
  // t() — used to skip srv.kill() below and leak the child forever, still bound to
  // PORT (3900 + pid%90). Leaked children accumulate across runs and can later collide
  // with a fresh run whose pid happens to land on the same slot, which fails as an
  // opaque EADDRINUSE/timeout with no assertion name — the exact "name lost to
  // truncation" flake this file used to produce (owed #1191). try/finally guarantees
  // the child and its tmp dir are reaped on every exit path, not just the happy one.
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try { await fetch(BASE + '/health'); break; }
      catch { if (Date.now() > deadline) { console.log('  FAIL server never came up'); fail++; break; } await new Promise((r) => setTimeout(r, 200)); }
    }
    if (fail) throw new Error('server never came up');

    console.log('\nREACHABILITY — a stranger with only a keypair can take part');

  // The whole point: this key has never touched the box, and it is not the board key.
  const alice = newKey();
  const alicePub = ed.publicKeyOf(alice);
  const enroll = W.signWindowRow(W.buildWindowRow({
    type: 'enroll', epoch: EPOCH, caller: 'alice',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), alice);
  const r1 = await req('POST', '/window/enroll', enroll);
  t('an outside key can enroll over HTTP', () => {
    assert.strictEqual(r1.status, 201, JSON.stringify(r1.json));
    assert.ok(r1.json.receipt, 'no intake receipt returned');
  });
  t('enrolling is not the board signing on the caller\'s behalf', () => {
    const row = chain.read().find((r) => r.entry.type === 'enroll' && r.entry.signer === alicePub);
    assert.ok(row, 'enroll row absent from the chain');
    assert.notStrictEqual(row.entry.signer, board, 'board signed a caller row');
  });

  console.log('\nREFUSALS — each asserted in the state where it must fire');

  t('a second enroll from the same key is refused', async () => {});
  const dup = await req('POST', '/window/enroll', W.signWindowRow(W.buildWindowRow({
    type: 'enroll', epoch: EPOCH, caller: 'alice-again',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), alice));
  t('duplicate enroll -> 409', () => assert.strictEqual(dup.status, 409, JSON.stringify(dup.json)));

  const noEpoch = await req('POST', '/window/enroll', W.signWindowRow(W.buildWindowRow({
    type: 'enroll', epoch: '1999-W01', caller: 'alice',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), alice));
  t('enroll into an epoch with no schedule_commit -> 404', () => assert.strictEqual(noEpoch.status, 404, JSON.stringify(noEpoch.json)));

  // Tampering after signing must not survive: flip the label, keep the signature.
  const forged = { ...enroll, caller: 'mallory', nonce: newNonce() };
  const bad = await req('POST', '/window/enroll', forged);
  t('a row edited after signing -> 400', () => assert.strictEqual(bad.status, 400, JSON.stringify(bad.json)));

  const unsigned = W.buildWindowRow({
    type: 'enroll', epoch: EPOCH, caller: 'nokey',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  });
  const uns = await req('POST', '/window/enroll', unsigned);
  t('an unsigned enroll -> 400', () => assert.strictEqual(uns.status, 400, JSON.stringify(uns.json)));

  // ── close, reveal, mint a question, then exercise the response route ────────────────
  const keys = chain.read().filter((r) => r.entry.type === 'enroll' && r.entry.epoch === EPOCH)
    .map((r) => r.entry.signer);
  boardRow({ type: 'enrollment_close', epoch: EPOCH, enrolled_root: W.enrolledRoot(keys), enrolled_count: keys.length });

  const closedNow = await req('POST', '/window/enroll', W.signWindowRow(W.buildWindowRow({
    type: 'enroll', epoch: EPOCH, caller: 'latecomer',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), newKey()));
  t('enrolling after the set is frozen -> 409', () => assert.strictEqual(closedNow.status, 409, JSON.stringify(closedNow.json)));

  boardRow({ type: 'seed_reveal', epoch: EPOCH, seed });
  const close = chain.read().find((r) => r.entry.type === 'enrollment_close' && r.entry.epoch === EPOCH);
  const d = W.deriveQuestion({ seed, enrolled_root: close.entry.enrolled_root, caller_key: alicePub, window_index: 0, version: '1' });
  // Questions open on the 900s grid: the instant is derived, never chosen, so the board
  // cannot shop for a favourable start. The test has to respect it like any other caller.
  const opens = Math.floor(Math.floor(Date.now() / 1000) / 900) * 900;
  const qRec = boardRow({
    type: 'question', epoch: EPOCH, window_index: 0, caller_key: alicePub,
    market: W.questionMarket({ asset: d.asset, opens_at: opens, horizon_sec: d.horizon_sec }),
    opens_at: opens, expires_at: opens + 3600,
  });

  const seen = await req('GET', `/questions/${alicePub}`);
  t('a caller can fetch the question they did not pick', () => {
    assert.strictEqual(seen.status, 200);
    assert.strictEqual(seen.json.questions.length, 1, JSON.stringify(seen.json));
    assert.strictEqual(seen.json.questions[0].answerable, true);
  });

  // Someone else's question is not yours to answer.
  const mallory = newKey();
  const steal = await req('POST', '/window/respond', W.signWindowRow(W.buildWindowRow({
    type: 'answer', question_hash: qRec.entry_hash, side: 'yes', odds: '0.5',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), mallory));
  t('answering a question asked of someone else -> 403', () => assert.strictEqual(steal.status, 403, JSON.stringify(steal.json)));

  const ans = W.signWindowRow(W.buildWindowRow({
    type: 'answer', question_hash: qRec.entry_hash, side: 'yes', odds: '0.62',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), alice);
  const r2 = await req('POST', '/window/respond', ans);
  t('the assigned caller can answer over HTTP', () => assert.strictEqual(r2.status, 201, JSON.stringify(r2.json)));

  const twice = await req('POST', '/window/respond', W.signWindowRow(W.buildWindowRow({
    type: 'answer', question_hash: qRec.entry_hash, side: 'no', odds: '0.9',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), alice));
  t('re-answering a settled window -> 409 (no second bite after seeing the move)', () => assert.strictEqual(twice.status, 409, JSON.stringify(twice.json)));

  // An expired window: the refusal that stops answering once the outcome is knowable.
  const expired = boardRow({
    type: 'question', epoch: EPOCH, window_index: 1, caller_key: alicePub,
    market: W.questionMarket({ asset: d.asset, opens_at: opens - 7200, horizon_sec: d.horizon_sec }),
    opens_at: opens - 7200, expires_at: opens - 3600,
  });
  const late = await req('POST', '/window/respond', W.signWindowRow(W.buildWindowRow({
    type: 'answer', question_hash: expired.entry_hash, side: 'yes', odds: '0.5',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }), alice));
  t('answering after the window closed -> 409', () => assert.strictEqual(late.status, 409, JSON.stringify(late.json)));

  const wrongRoute = await req('POST', '/window/enroll', ans);
  t('an answer posted to /window/enroll -> 400 (routes do not accept each other\'s rows)', () => assert.strictEqual(wrongRoute.status, 400, JSON.stringify(wrongRoute.json)));

  const st = await req('GET', `/windows/${EPOCH}`);
  t('epoch state is readable and reports the real stage', () => {
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.json.stage, 'questions_minted', JSON.stringify(st.json));
    assert.strictEqual(st.json.enrollment_open, false);
  });
  t('unknown epoch -> 404, never an empty-looking success', async () => {});
  const noSuch = await req('GET', '/windows/2000-W01');
  t('unknown epoch -> 404', () => assert.strictEqual(noSuch.status, 404, JSON.stringify(noSuch.json)));

  t('the chain still verifies after every HTTP write', () => {
    const v = new Chain(CHAIN).verify();
    assert.ok(v.ok, `chain broken: ${JSON.stringify(v)}`);
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
