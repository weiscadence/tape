'use strict';
/**
 * client.test.js — the downloadable client, checked against the real producer.
 *
 * WHY THIS FILE EXISTS. `tape-call.mjs` is the file a stranger's agent downloads and runs.
 * Its `check-receipt` command hand-listed the fields a receipt signs. When the receipt went
 * to v2 — gaining `anchor_by` and pulling `receipt_by` inside the signature — the client
 * kept checking the v1 shape, so it printed
 *
 *     BAD RECEIPT. The signature does not verify over these bytes.
 *     Either it was altered, or it was never signed by the key it names.
 *
 * for every genuine receipt the live service issued. The first command a new caller runs,
 * accusing us of forgery, on a correct receipt. Nothing caught it because every existing
 * test verified receipts with lib code — both sides of the check were the same assumption.
 *
 * So this suite crosses the boundary on purpose: the receipt is minted by bin/api.js (the
 * producer) and checked by spawning the actual .mjs file the way a caller would, in a temp
 * directory with no access to this repo's lib. If those two ever disagree again, this fails.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

// A throwaway receipt key: the producer must sign with SOMETHING, and the live key has no
// business being a test dependency.
const kp = crypto.generateKeyPairSync('ed25519');
const KEY = Buffer.concat([
  kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
  kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-client-'));
const keyFile = path.join(dir, 'receipt-key.json');
fs.writeFileSync(keyFile, JSON.stringify([...KEY]));

// Point the PRODUCER at that key and require it. Requiring bin/api.js does not bind a
// port (it guards on require.main), so this cannot race the live service.
process.env.TAPE_RECEIPT_KEY = keyFile;
const { intakeReceipt } = require('../bin/api.js');

// The client, copied out of the repo exactly as a caller would download it.
//
// Resolved from the SERVER'S OWN download map, never from a hardcoded directory. This test
// used to read `web/tape-call.mjs` while the router served `verify/tape-call.mjs`, so for as
// long as both copies existed it reported the real client green while exercising a file
// nobody could download. Asking the map means the test breaks loudly if the served path
// moves, instead of quietly testing the wrong file.
const { ALLOWED } = require('../lib/served');
const servedDir = ALLOWED.get('tape-call.mjs');
assert.ok(servedDir, 'tape-call.mjs is not in the served map — the client is undownloadable');
const client = path.join(dir, 'tape-call.mjs');
fs.copyFileSync(path.join(servedDir, 'tape-call.mjs'), client);

const run = (args, env = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [client, ...args],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
};

const writeReceipt = (r, name = 'tape-receipt.json') => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(r, null, 2));
  return name;
};

console.log('\n-- downloadable client vs live producer');

t('a receipt minted by the producer VERIFIES in the client', () => {
  const f = writeReceipt(intakeReceipt('a'.repeat(64), 7));
  const r = run(['check-receipt', f]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /RECEIPT VERIFIED/);
});

t('the client shows the anchor deadline the receipt commits to', () => {
  // The deadline is the falsifiable half of the promise. A holder who never sees it cannot
  // use it, which makes signing it decorative.
  const f = writeReceipt(intakeReceipt('b'.repeat(64), 8));
  assert.match(run(['check-receipt', f]).out, /PROMISES to anchor it by/);
});

t('CONTROL: one altered character is caught', () => {
  const rec = intakeReceipt('c'.repeat(64), 9);
  rec.seq = '10';                                    // the field a censor would move
  const r = run(['check-receipt', writeReceipt(rec, 'tampered.json')]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /BAD RECEIPT/);
});

t('CONTROL: a receipt signed by a DIFFERENT key is caught', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const otherKey = Buffer.concat([
    other.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]);
  const f2 = path.join(dir, 'other-key.json');
  fs.writeFileSync(f2, JSON.stringify([...otherKey]));
  // Re-require the producer in a child process bound to the other key, then present the
  // result as if it came from us: a forged acknowledgement.
  const forged = JSON.parse(execFileSync(process.execPath, ['-e',
    `process.env.TAPE_RECEIPT_KEY=${JSON.stringify(f2)};`
    + `console.log(JSON.stringify(require(${JSON.stringify(path.join(__dirname, '..', 'bin', 'api.js'))}).intakeReceipt('d'.repeat(64), 11)))`,
  ], { encoding: 'utf8' }));
  forged.receipt_by = require('../lib/ed25519').publicKeyOf(KEY);   // claim it was us
  const r = run(['check-receipt', writeReceipt(forged, 'forged.json')]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /BAD RECEIPT/);
});

t('CONTROL: an unsigned receipt is called what it is, not "verified"', () => {
  const rec = intakeReceipt('e'.repeat(64), 12);
  rec.receipt_sig = null; rec.receipt_by = null;
  const r = run(['check-receipt', writeReceipt(rec, 'unsigned.json')]);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /UNSIGNED RECEIPT/);
});

t('a v1 receipt still verifies — old receipts must not become forgeries', () => {
  // Whoever holds a v1 receipt holds evidence about us. If a format change silently
  // invalidated it, we would have deleted proof against ourselves by shipping a new file.
  const ed = require('../lib/ed25519');
  const { canonicalize } = require('../lib/canonical');
  const body = { p: 'tape-intake', v: '1', entry_hash: 'f'.repeat(64), seq: '3',
    received_at: '2026-07-28T21:00:00.000Z' };
  const sig = ed.sign(Buffer.from('tape:v1:intake:' + canonicalize(body), 'utf8'), KEY);
  const r = run(['check-receipt',
    writeReceipt({ ...body, receipt_by: ed.publicKeyOf(KEY), receipt_sig: sig }, 'v1.json')]);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /RECEIPT VERIFIED/);
});

console.log('\n-- client refusals');

t('declare refuses a scope that is not one of the three shapes', () => {
  const r = run(['declare', '--scope', 'everything I feel like']);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /scope:all/);
});

t('declare warns that a declaration is a promise, not a proof', () => {
  assert.match(run(['declare']).out, /caught/);
});

t('usage names the read commands — a write-only tool is not adoptable', () => {
  const out = run([]).out;
  for (const c of ['record', 'tape', 'declare', 'check-receipt']) {
    assert.ok(out.includes(c), `usage must mention ${c}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
