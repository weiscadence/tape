'use strict';
/**
 * concurrency.test.js — two writers must not fork the tape.
 *
 * WHY THIS EXISTS: `append()` reads the chain to find (prev, seq) and then writes. Until
 * tonight there was exactly one writer, so nobody noticed. Opening a public intake means
 * the anchoring daemon and the API append to the same file, and a lost race does not
 * merely drop an entry: two rows claim the same seq and the same prev, and every verifier
 * downstream reports TAMPER on a record nobody tampered with. An honest system that
 * accuses itself of fraud under load is worse than one that simply drops writes.
 *
 * The test spawns real OS processes, because in-process concurrency would not exercise
 * the file lock at all. And it runs in BOTH states: with the lock, and with the lock
 * defeated, so we can see the corruption actually happens without it. A concurrency test
 * that has never seen the race is a test that proves the machine was idle.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Chain } = require('../lib/chain');

const LIB = path.join(__dirname, '..', 'lib');
const WRITERS = 6;
const PER_WRITER = 10;

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

/** A worker that hammers append() on one chain file. `locked=false` bypasses the lock. */
function workerSource(file, locked) {
  return `
const { Chain } = require(${JSON.stringify(path.join(LIB, 'chain.js'))});
const { buildEntry, newNonce } = require(${JSON.stringify(path.join(LIB, 'entry.js'))});
const c = new Chain(${JSON.stringify(file)});
${locked ? '' : '// defeat the lock: call the unguarded path directly\nc.append = c._appendLocked.bind(c);'}
for (let i = 0; i < ${PER_WRITER}; i++) {
  c.append(buildEntry({
    type: 'open', caller: 'w' + process.argv[2], lane: 'memecoin', market: 'BTC/USD',
    side: 'long', size: '1', entry_ref: '1',
    ts_claimed: new Date().toISOString(), nonce: newNonce(),
  }));
}
`;
}

function race(locked) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-race-'));
  const file = path.join(dir, 'chain.jsonl');
  const script = path.join(dir, 'worker.js');
  fs.writeFileSync(script, workerSource(file, locked));
  return new Promise((resolve) => {
    let done = 0;
    let crashed = 0;
    for (let i = 0; i < WRITERS; i++) {
      const p = spawn(process.execPath, [script, String(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
      p.stderr.on('data', () => {});
      p.on('exit', (code) => {
        if (code !== 0) crashed++;
        if (++done === WRITERS) resolve({ file, verify: new Chain(file).verify(), crashed });
      });
    }
  });
}

async function main() {
  console.log('\nconcurrent appends');

  await t(`${WRITERS} processes x ${PER_WRITER} appends: the chain still verifies`, async () => {
    const { verify, crashed } = await race(true);
    assert.strictEqual(crashed, 0, `${crashed} writers crashed`);
    assert.strictEqual(verify.count, WRITERS * PER_WRITER, 'every append must land');
    assert.strictEqual(verify.ok, true, `chain broke: ${JSON.stringify(verify.errors.slice(0, 3))}`);
  });

  await t('NEGATIVE CONTROL: with the lock defeated, the same load DOES fork the chain', async () => {
    // If this ever stops failing, the lock is no longer the thing keeping the chain
    // intact, and the test above has quietly become a test of nothing.
    const { verify } = await race(false);
    const broken = !verify.ok || verify.count !== WRITERS * PER_WRITER;
    assert.ok(broken,
      'expected corruption without the lock, got a clean chain — the race is no longer reachable, '
      + 'so the positive test above proves nothing');
  });

  await t('a stale lock left by a dead process does not wedge the tape forever', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-stale-'));
    const file = path.join(dir, 'chain.jsonl');
    const c = new Chain(file);
    // A lock from a process that died 10 minutes ago, well past LOCK_STALE_MS.
    // Age is backdated via mtime, not via a timestamp inside the body, because mtime is
    // what the implementation reads — a lock file can legitimately be empty for an
    // instant after creation, so its contents cannot be the evidence of age.
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, at: Date.now() - 600000 }));
    const old = (Date.now() - 600000) / 1000;
    fs.utimesSync(`${file}.lock`, old, old);
    const { buildEntry, newNonce } = require('../lib/entry');
    const rec = c.append(buildEntry({
      type: 'open', caller: 'x', lane: 'memecoin', market: 'BTC/USD', side: 'long',
      size: '1', entry_ref: '1', ts_claimed: new Date().toISOString(), nonce: newNonce(),
    }));
    assert.strictEqual(rec.seq, 0);
    assert.strictEqual(fs.existsSync(`${file}.lock`), false, 'the lock must be released after use');
  });

  await t('a FRESH lock is respected, not stolen', async () => {
    // The mirror of the test above. Stealing a live lock reintroduces the exact race the
    // lock exists to prevent, so "recovers from stale locks" must not mean "ignores locks".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-fresh-'));
    const file = path.join(dir, 'chain.jsonl');
    const c = new Chain(file);
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const { buildEntry, newNonce } = require('../lib/entry');
    const started = Date.now();
    let threw = false;
    try {
      c.append(buildEntry({
        type: 'open', caller: 'x', lane: 'memecoin', market: 'BTC/USD', side: 'long',
        size: '1', entry_ref: '1', ts_claimed: new Date().toISOString(), nonce: newNonce(),
      }));
    } catch { threw = true; }
    const waited = Date.now() - started;
    assert.ok(threw, 'holding a fresh lock must block the append, not be ignored');
    assert.ok(waited >= 1000, `expected it to wait for the lock, gave up after ${waited}ms`);
    fs.unlinkSync(`${file}.lock`);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
main();
