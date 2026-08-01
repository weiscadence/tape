'use strict';
/**
 * promise.test.js — the intake's own signature, used against the intake.
 *
 * tape-promise.mjs exists to answer "did TAPE put in the call it told me it had?". A tool
 * that can only ever say KEPT is a sticker. So four of the six cases below are us being
 * caught: a dropped call, a stolen index, a missed deadline, and a forged receipt. Each is
 * constructed from a REAL signed receipt and a REAL published artifact, then mutated by
 * exactly one thing, so a pass cannot come from the input being malformed.
 */

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const ed = require('../lib/ed25519');
const { canonicalize } = require('../lib/canonical');

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const mkKey = () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  return Buffer.concat([
    kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]);
};

/**
 * Receipts are signed BY THE PRODUCER, loaded from bin/api.js.
 *
 * The first version of this file rebuilt the receipt by hand, which meant it tested my
 * assumption about the signing bytes against itself. Eight controls went green and the
 * very first real receipt from the live intake failed to verify, because the producer
 * signed a different object. A control that shares the assumption under test is not a
 * control. So: write the key to a temp file, point the producer's env at it, require it.
 */
const intakeKey = mkKey();
const INTAKE_PUB = ed.publicKeyOf(intakeKey);
const keyPath = path.join(require('os').tmpdir(), `tape-test-receipt-key-${process.pid}.json`);
require('fs').writeFileSync(keyPath, JSON.stringify([...intakeKey]));
process.env.TAPE_RECEIPT_KEY = keyPath;
const { intakeReceipt } = require('../bin/api.js');
process.on('exit', () => { try { require('fs').unlinkSync(keyPath); } catch {} });

function makeReceipt({ entry_hash, seq, anchor_by }) {
  const r = intakeReceipt(entry_hash, seq);
  // The producer stamps its own clock. Overriding the deadline is how the OVERDUE and
  // PENDING branches get exercised without sleeping for half an hour — and it has to be
  // re-signed, or the test would be checking a receipt nobody issued.
  if (anchor_by && anchor_by !== r.anchor_by) {
    const body = { ...r, anchor_by, receipt_sig: null };
    const msg = Buffer.from('tape:v1:intake:' + canonicalize(body), 'utf8');
    return { ...body, receipt_sig: ed.sign(msg, intakeKey) };
  }
  return r;
}

const MINE = 'a'.repeat(64);
const THEIRS = 'b'.repeat(64);
const artifact = (chain, anchors) => ({ chain, anchors });

/** Serve an artifact over a throwaway loopback server; the tool only speaks HTTP. */
const http = require('http');
function serve(obj) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const b = JSON.stringify(obj);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
      res.end(b);
    });
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() }));
  });
}

(async () => {
  const { checkPromise, KEPT, BROKEN, OVERDUE, PENDING, UNKNOWN } =
    await import(path.join(__dirname, '..', 'verify', 'tape-promise.mjs'));

  const past = new Date(Date.now() - 3600e3).toISOString();
  const future = new Date(Date.now() + 3600e3).toISOString();

  console.log('\nthe promise was kept');
  await t('entry sits at the promised index inside an anchored root -> KEPT', async () => {
    const srv = await serve(artifact(
      [{ seq: 0, entry_hash: THEIRS }, { seq: 1, entry_hash: MINE }],
      [{ slot: 999, count: 2 }],
    ));
    const r = await checkPromise(makeReceipt({ entry_hash: MINE, seq: 1, anchor_by: future }), { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, KEPT, JSON.stringify(r.notes));
  });

  console.log('\nCONTROLS — the tool must convict the operator');
  await t('CONTROL: our index was given to someone else -> BROKEN', async () => {
    const srv = await serve(artifact(
      [{ seq: 0, entry_hash: THEIRS }, { seq: 1, entry_hash: THEIRS }],
      [{ slot: 999, count: 2 }],
    ));
    const r = await checkPromise(makeReceipt({ entry_hash: MINE, seq: 1, anchor_by: future }), { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, BROKEN, JSON.stringify(r.notes));
    assert.match(r.notes.join(' '), /DIFFERENT entry/);
  });
  await t('CONTROL: call dropped and the deadline passed -> OVERDUE', async () => {
    const srv = await serve(artifact([{ seq: 0, entry_hash: THEIRS }], [{ slot: 999, count: 1 }]));
    const r = await checkPromise(makeReceipt({ entry_hash: MINE, seq: 1, anchor_by: past }), { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, OVERDUE, JSON.stringify(r.notes));
  });
  await t('CONTROL: published but NO anchor reaches it, deadline passed -> OVERDUE', async () => {
    // The half that is easy to miss: being in the file is not being on the chain. An
    // anchor whose count stops one short leaves the entry attested by nobody.
    const srv = await serve(artifact(
      [{ seq: 0, entry_hash: THEIRS }, { seq: 1, entry_hash: MINE }],
      [{ slot: 999, count: 1 }],
    ));
    const r = await checkPromise(makeReceipt({ entry_hash: MINE, seq: 1, anchor_by: past }), { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, OVERDUE, JSON.stringify(r.notes));
    assert.match(r.notes.join(' '), /NO anchor covers it/);
  });
  await t('CONTROL: a forged receipt is not evidence -> UNKNOWN, never BROKEN', async () => {
    // Someone could otherwise mint a receipt we never issued and "prove" we dropped them.
    const stranger = mkKey();
    const good = makeReceipt({ entry_hash: MINE, seq: 1, anchor_by: past });
    const forged = { ...good, receipt_by: ed.publicKeyOf(stranger) };
    const srv = await serve(artifact([{ seq: 0, entry_hash: THEIRS }], [{ slot: 999, count: 1 }]));
    const r = await checkPromise(forged, { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, UNKNOWN, JSON.stringify(r.notes));
    assert.match(r.notes.join(' '), /signature does not verify/);
  });

  console.log('\nnot yet due is not a failure');
  await t('inside the deadline with nothing published -> PENDING', async () => {
    const srv = await serve(artifact([{ seq: 0, entry_hash: THEIRS }], [{ slot: 999, count: 1 }]));
    const r = await checkPromise(makeReceipt({ entry_hash: MINE, seq: 1, anchor_by: future }), { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, PENDING, JSON.stringify(r.notes));
  });
  await t('a v1 receipt (no committed deadline) cannot be called late', async () => {
    // Inventing a deadline for a receipt that never promised one would be us grading
    // ourselves against a rule written after the fact — in our own favour or against it.
    // Signed the way v1 ACTUALLY signed: over the body alone, with the signing key
    // outside the signature. Using the v2 shape here would test a receipt that never
    // existed, which is the same mistake this file was rewritten to stop making.
    const body = { p: 'tape-intake', v: '1', entry_hash: MINE, seq: '1', received_at: past };
    const msg = Buffer.from('tape:v1:intake:' + canonicalize(body), 'utf8');
    const v1 = { ...body, receipt_by: INTAKE_PUB, receipt_sig: ed.sign(msg, intakeKey) };
    const srv = await serve(artifact([{ seq: 0, entry_hash: THEIRS }], [{ slot: 999, count: 1 }]));
    const r = await checkPromise(v1, { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, UNKNOWN);
    assert.match(r.notes.join(' '), /committed no deadline/);
  });
  await t('pointing at the summary artifact says so instead of answering UNKNOWN forever', async () => {
    const srv = await serve({ entries: 13, anchors: 21 });
    const r = await checkPromise(makeReceipt({ entry_hash: MINE, seq: 1, anchor_by: future }), { url: srv.url });
    srv.close();
    assert.strictEqual(r.verdict, UNKNOWN);
    assert.match(r.notes.join(' '), /board\.json/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
