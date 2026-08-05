'use strict';
/**
 * window-drive.test.js — the driver had no tests, and both bugs it shipped were the kind a
 * test would have caught in a second.
 *
 * On 2026-08-02 the hourly cron died with rc=1 and the schedule stopped advancing. Two
 * independent causes, neither exotic:
 *
 *   1. The driver picked the newest `schedule_commit` as the active round and never looked
 *      for `schedule_void`. A retracted epoch — BOGUS-EPOCH-XX, written by an operator-error
 *      test and properly voided on-chain — was therefore adopted as current, freezing
 *      2026-W34 for 46 hours with two callers already enrolled and owed questions.
 *   2. When that dead round finally expired, the successor label fell back to the current
 *      ISO week, which was already committed. windows.js correctly refuses to reissue a
 *      commitment, so the driver walked into that refusal every single hour.
 *
 * Each test below drives the real `main()` against a real chain in a temp dir. The paired
 * negative controls matter as much as the positives: a driver that never advances would
 * pass "does not reuse a label" trivially, so the un-voided case must still advance.
 */

const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const ed = require('../lib/ed25519');
const W = require('../lib/windows');
const { Chain } = require('../lib/chain');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const mkKey = () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  const raw = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pubRaw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Buffer.concat([raw, pubRaw]);
};

const boardKey = mkKey();
const HOUR = 3600;

/** A chain in a temp dir, plus helpers to append board-signed window rows to it. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-drive-'));
  const file = path.join(dir, 'tape.jsonl');
  const chain = new Chain(file);
  const put = (row) => chain.append(W.signWindowRow(W.buildWindowRow(row), boardKey));
  return { dir, file, chain, put };
}

/** Run the driver against `file` in --dry-run, capturing what it WOULD do.
 *  Dry-run on purpose: these tests are about which command the driver chooses, and letting
 *  it shell out to windows.js for real would test windows.js instead. */
function drive(file, argv = []) {
  const drivePath = require.resolve('../bin/window-drive.js');
  delete require.cache[drivePath];
  const prev = process.env.TAPE_CHAIN;
  process.env.TAPE_CHAIN = file;
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const rc = require(drivePath).main(['--dry-run', ...argv]);
    return { rc, out: lines.join('\n') };
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.TAPE_CHAIN; else process.env.TAPE_CHAIN = prev;
    delete require.cache[drivePath];
  }
}

const commit = (epoch, closesAt) => ({
  type: 'schedule_commit',
  epoch,
  seed_commit: crypto.randomBytes(32).toString('hex'),
  catalog_hash: crypto.randomBytes(32).toString('hex'),
  enroll_closes_at: closesAt, // buildWindowRow wants the integer and stringifies it itself
  windows_per_caller: 3,
});

const enroll = (epoch, callerKey) => ({
  type: 'enroll',
  epoch,
  caller: 'test-caller',
  ts_claimed: new Date().toISOString(),
  nonce: crypto.randomBytes(16).toString('hex'),
});

console.log('\na retracted epoch is not the active round');

t('the driver skips a voided commit and drives the live round behind it', () => {
  const f = fixture();
  const past = Math.floor(Date.now() / 1000) - HOUR;
  f.put(commit('2026-W34', past));
  f.chain.append(W.signWindowRow(W.buildWindowRow(enroll('2026-W34')), mkKey()));
  f.put(commit('BOGUS-EPOCH-XX', past));
  f.put({ type: 'schedule_void', epoch: 'BOGUS-EPOCH-XX', reason: 'operator error, retracted by appending' });

  const { out } = drive(f.file);
  assert.ok(/close 2026-W34/.test(out), `expected the driver to close 2026-W34, got:\n${out}`);
  assert.ok(!/BOGUS-EPOCH-XX/.test(out), `driver adopted the voided epoch:\n${out}`);
});

t('POSITIVE CONTROL: without the void row the same chain DOES adopt the bogus epoch', () => {
  // Without this the test above proves nothing — it would pass on a driver that simply
  // always picked the second-newest commit. The void row must be what makes the difference.
  const f = fixture();
  const past = Math.floor(Date.now() / 1000) - HOUR;
  f.put(commit('2026-W34', past));
  f.chain.append(W.signWindowRow(W.buildWindowRow(enroll('2026-W34')), mkKey()));
  f.put(commit('BOGUS-EPOCH-XX', past));

  const { out } = drive(f.file);
  assert.ok(/BOGUS-EPOCH-XX/.test(out), `expected the un-voided epoch to be adopted, got:\n${out}`);
});

t('a still-open live round is left alone, not advanced past', () => {
  const f = fixture();
  const future = Math.floor(Date.now() / 1000) + HOUR;
  f.put(commit('2026-W34', future));
  f.put(commit('BOGUS-EPOCH-XX', future));
  f.put({ type: 'schedule_void', epoch: 'BOGUS-EPOCH-XX', reason: 'operator error, retracted by appending' });

  const { out } = drive(f.file);
  assert.ok(/2026-W34: enrollment OPEN/.test(out), `expected W34 open, got:\n${out}`);
  assert.ok(!/WOULD RUN: windows.js commit/.test(out), `driver opened a round while one was live:\n${out}`);
});

console.log('\nan epoch label is a seed commitment and is never reused');

t('the successor skips labels already committed, including voided ones', () => {
  // The real failure: BOGUS-EPOCH-XX does not parse as YYYY-Www, so nextEpoch() fell back to
  // the current ISO week — which was already committed. windows.js refused, and rc=1 every hour.
  const f = fixture();
  const past = Math.floor(Date.now() / 1000) - HOUR;
  const { isoWeek, nextEpoch } = require('../bin/window-drive.js');
  const thisWeek = isoWeek();
  f.put(commit(thisWeek, past));                  // the label the fallback would land on
  f.put(commit('BOGUS-EPOCH-XX', past));          // unparseable, zero enrollees -> triggers advance

  const { out } = drive(f.file);
  const m = /WOULD RUN: windows\.js commit (\S+)/.exec(out);
  assert.ok(m, `expected the driver to open a successor, got:\n${out}`);
  assert.notStrictEqual(m[1], thisWeek, 'driver proposed a label that is already committed');
  assert.strictEqual(m[1], nextEpoch(thisWeek), `expected the next free label, got ${m[1]}`);
});

t('an empty round hands off to its successor rather than stalling', () => {
  const f = fixture();
  const past = Math.floor(Date.now() / 1000) - HOUR;
  f.put(commit('2026-W40', past));

  const { out } = drive(f.file);
  assert.ok(/ZERO enrollees/.test(out), `expected the empty-round message, got:\n${out}`);
  assert.ok(/commit 2026-W41/.test(out), `expected 2026-W41 to open, got:\n${out}`);
});

t('NEGATIVE CONTROL: an explicit --epoch inspects without opening a successor', () => {
  const f = fixture();
  const past = Math.floor(Date.now() / 1000) - HOUR;
  f.put(commit('2026-W40', past));
  f.put(commit('2026-W41', past));

  const { out } = drive(f.file, ['--epoch', '2026-W40']);
  assert.ok(/not opening a successor/.test(out), `expected the inspect guard, got:\n${out}`);
  assert.ok(!/WOULD RUN: windows\.js commit/.test(out), `--epoch opened a round:\n${out}`);
});

console.log('\nthe sweep is evidence, and repeating it is not a failure');

t('two sweeps in the same second do not crash the driver', () => {
  // sweep_report carries swept_at at one-second resolution, so a repeat over unchanged state
  // builds a byte-identical row and the chain's replay refusal rejects it. That refusal is
  // correct and stays; what was wrong is that it took the whole driver down with rc=1.
  const { execFileSync } = require('child_process');
  const f = fixture();
  const cli = require.resolve('../bin/windows.js');
  const env = { ...process.env, TAPE_CHAIN: f.file };
  const run = () => execFileSync(process.execPath, [cli, 'sweep'], { encoding: 'utf8', env });
  run();
  const second = run(); // must not throw
  assert.ok(/already on chain|sweep_report written/.test(second), `unexpected output:\n${second}`);
});

t('POSITIVE CONTROL: the chain still refuses a genuine replayed row', () => {
  // The narrow catch above must not have blunted the anti-replay guard itself.
  const f = fixture();
  const row = W.signWindowRow(W.buildWindowRow(commit('2026-W40', 1785600000)), boardKey);
  f.chain.append(row);
  assert.throws(() => f.chain.append(row), /already at seq/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
