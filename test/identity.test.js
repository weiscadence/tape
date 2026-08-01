'use strict';
/**
 * identity.test.js — who said it.
 *
 * The failure this file is written against is a signature check that returns true for
 * the wrong reasons: verifies its own signatures and nothing else, accepts a stripped
 * signature as "unsigned", or lets a display name carry standing that only a key earns.
 *
 * Two things make the crypto tests here worth more than self-consistency:
 *   - every signature is cross-checked against tweetnacl, a DIFFERENT implementation, in
 *     both directions. A routine that only verifies its own output is a self-consistent
 *     way to be wrong.
 *   - the mutation tests walk EVERY field of a signed entry, rather than picking one and
 *     assuming the rest are covered.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nacl = require('tweetnacl');
const bs58lib = require('bs58');
const bs58 = bs58lib.default || bs58lib;

const ed = require('../lib/ed25519');
const { canonicalize } = require('../lib/canonical');
const { buildEntry, entryHash, newNonce, signEntry, verifyEntrySignature, signingBytes, identityOf, SIG_DOMAIN } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { resolveNames, leaderboard } = require('../lib/score');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const kp = () => {
  const k = nacl.sign.keyPair();
  return { sk: Buffer.from(k.secretKey), pk: bs58.encode(k.publicKey), raw: k };
};
const A = kp(), B = kp();

const call = (over = {}) => buildEntry({
  type: 'open', caller: 'alice', lane: 'memecoin',
  market: 'So11111111111111111111111111111111111111112', side: 'long',
  size: '100.00', entry_ref: '0.00042', ts_claimed: '2026-07-28T20:30:00Z',
  nonce: newNonce(), ...over,
});

console.log('\nbase58 (no dependency, so it must be right)');
t('round-trips arbitrary bytes', () => {
  for (let i = 0; i < 50; i++) {
    const b = Buffer.from(nacl.randomBytes(1 + (i % 40)));
    assert.strictEqual(ed.b58decode(ed.b58encode(b)).toString('hex'), b.toString('hex'));
  }
});
t('agrees with the bs58 library on every sample', () => {
  for (let i = 0; i < 50; i++) {
    const b = Buffer.from(nacl.randomBytes(1 + (i % 40)));
    assert.strictEqual(ed.b58encode(b), bs58.encode(b));
  }
});
t('NEGATIVE CONTROL: leading zero bytes survive the round trip', () => {
  // The numeric conversion cannot represent leading zeros, so they must be re-added as
  // '1's. Without that, two different keys can encode to the same string.
  const z = Buffer.from([0, 0, 0, 7, 9]);
  assert.strictEqual(ed.b58encode(z), bs58.encode(z));
  assert.strictEqual(ed.b58decode(ed.b58encode(z)).toString('hex'), '0000000709');
  assert.notStrictEqual(ed.b58encode(z), ed.b58encode(Buffer.from([7, 9])));
});
t('invalid characters are rejected, not skipped', () => {
  assert.ok(throws(() => ed.b58decode('0OIl')));   // the four excluded look-alikes
  assert.ok(throws(() => ed.b58decode('')));
});

console.log('\ned25519 against an independent implementation');
t('our signature verifies under tweetnacl', () => {
  const msg = Buffer.from('tape:v1:cross-check');
  assert.ok(nacl.sign.detached.verify(msg, ed.b58decode(ed.sign(msg, A.sk)), A.raw.publicKey));
});
t('tweetnacl`s signature verifies under ours', () => {
  const msg = Buffer.from('tape:v1:cross-check');
  assert.strictEqual(ed.verify(msg, bs58.encode(nacl.sign.detached(msg, A.sk)), A.pk), true);
});
t('the two produce byte-identical signatures', () => {
  const msg = Buffer.from('tape:v1:cross-check');
  assert.strictEqual(ed.sign(msg, A.sk), bs58.encode(nacl.sign.detached(msg, A.sk)));
});
t('the public key is DERIVED from the seed, not read from the file', () => {
  assert.strictEqual(ed.publicKeyOf(A.sk), A.pk);
  // A secret key whose stored public half has been swapped must not be believed.
  const lying = Buffer.concat([A.sk.subarray(0, 32), ed.b58decode(B.pk)]);
  assert.strictEqual(ed.publicKeyOf(lying), A.pk);
});
t('NEGATIVE CONTROL: verify returns false, never throws, on junk', () => {
  const msg = Buffer.from('x');
  for (const bad of ['', '!!!', 'zzz', '1', A.pk /* 32 bytes, not 64 */]) {
    assert.strictEqual(ed.verify(msg, bad, A.pk), false, `sig ${JSON.stringify(bad)}`);
  }
  for (const bad of ['', '!!!', ed.sign(msg, A.sk) /* 64 bytes, not 32 */]) {
    assert.strictEqual(ed.verify(msg, ed.sign(msg, A.sk), bad), false, `key ${JSON.stringify(bad)}`);
  }
});

console.log('\nsigning an entry');
t('a signed entry verifies', () => {
  const e = signEntry(call(), A.sk);
  const v = verifyEntrySignature(e);
  assert.strictEqual(v.signed, true);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.signer, A.pk);
});
t('an unsigned entry is `signed:false, ok:true` — a supported state, not a failure', () => {
  const v = verifyEntrySignature(call());
  assert.strictEqual(v.signed, false);
  assert.strictEqual(v.ok, true);
});
t('NEGATIVE CONTROL: mutating ANY signed field breaks the signature', () => {
  const e = signEntry(call({ note: 'hello' }), A.sk);
  const mutations = {
    type: 'close', caller: 'mallory', lane: 'prediction', market: 'OTHER', side: 'short',
    size: '999', entry_ref: '0.99', ts_claimed: '2020-01-01T00:00:00Z',
    nonce: 'f'.repeat(32), note: 'goodbye', signer: B.pk,
  };
  for (const [field, value] of Object.entries(mutations)) {
    const tampered = { ...e, [field]: value };
    assert.strictEqual(verifyEntrySignature(tampered).ok, false, `mutating ${field} was NOT caught`);
  }
  // and the untouched original still verifies, so the loop is not passing vacuously
  assert.strictEqual(verifyEntrySignature(e).ok, true);
});
t('an entry written before signing existed (no fields at all) is unsigned, not forged', () => {
  // Caught on the live tape: comparing against `null` only meant `undefined` fell through
  // to verifying a signature that was not there, and all ten real entries read as forged.
  // Backfilling `signer: null` is NOT the fix — it changes their hashes and orphans every
  // anchor that already commits to them.
  const legacy = { ...call() };
  delete legacy.signer; delete legacy.sig;
  const v = verifyEntrySignature(legacy);
  assert.strictEqual(v.signed, false);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(identityOf(legacy), 'name:alice');
});
t('NEGATIVE CONTROL: a stripped signature is INVALID, not "unsigned"', () => {
  // The downgrade attack: remove the sig and the entry silently becomes an anonymous T0
  // call that still names its signer. It must be neither valid nor treated as unsigned.
  const e = signEntry(call(), A.sk);
  const v = verifyEntrySignature({ ...e, sig: null });
  assert.strictEqual(v.signed, true);
  assert.strictEqual(v.ok, false);
});
t('NEGATIVE CONTROL: a signature from another key does not verify', () => {
  const e = signEntry(call(), A.sk);
  assert.strictEqual(verifyEntrySignature({ ...e, signer: B.pk }).ok, false);
  assert.strictEqual(verifyEntrySignature({ ...e, sig: signEntry(call(), B.sk).sig }).ok, false);
});
t('NEGATIVE CONTROL: domain separation — a bare signature over the JSON does not verify', () => {
  // Without the "tape:v1:entry:" prefix, any signature this key ever made over matching
  // JSON in another protocol could be lifted and pasted in here.
  const e = { ...call(), signer: A.pk, sig: null };
  const bare = ed.sign(Buffer.from(canonicalize({ ...e, sig: null }), 'utf8'), A.sk);
  assert.strictEqual(verifyEntrySignature({ ...e, sig: bare }).ok, false);
  // the same bytes WITH the prefix do verify, proving the failure above is the prefix
  const proper = ed.sign(Buffer.concat([Buffer.from(SIG_DOMAIN), Buffer.from(canonicalize({ ...e, sig: null }))]), A.sk);
  assert.strictEqual(verifyEntrySignature({ ...e, sig: proper }).ok, true);
});
t('signing bytes blank the sig rather than omitting it', () => {
  const e = { ...call(), signer: A.pk, sig: null };
  assert.ok(signingBytes(e).toString().includes('"sig":null'));
});
t('the schema refuses a sig with no signer, and a bad key or signature', () => {
  assert.ok(throws(() => call({ sig: ed.sign(Buffer.from('x'), A.sk) })));
  assert.ok(throws(() => call({ signer: 'not-a-key' })));
  assert.ok(throws(() => call({ signer: A.pk, sig: 'not-a-signature' })));
});
t('signEntry refuses to sign for a signer it is not', () => {
  assert.ok(throws(() => signEntry(call({ signer: B.pk }), A.sk)));
});
t('the signature is inside the entry hash, so it cannot be swapped off-record', () => {
  const e = signEntry(call(), A.sk);
  assert.notStrictEqual(entryHash(e), entryHash({ ...e, sig: null }));
});

console.log('\nthe chain refuses what it cannot attribute');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tape-id-')), 'chain.jsonl');
t('a valid signed entry appends', () => {
  const c = new Chain(tmp());
  assert.strictEqual(c.append(signEntry(call(), A.sk)).seq, 0);
});
t('NEGATIVE CONTROL: an entry with a broken signature is refused at append', () => {
  const c = new Chain(tmp());
  const e = signEntry(call(), A.sk);
  assert.ok(throws(() => c.append({ ...e, size: '999' })));
  assert.strictEqual(c.read().length, 0, 'nothing may be written when the signature fails');
});
t('NEGATIVE CONTROL: replaying an identical entry is refused', () => {
  // A third party lifting someone`s signed call and re-posting it verbatim: the signature
  // is genuine, so only duplicate detection can stop it.
  const c = new Chain(tmp());
  const e = signEntry(call(), A.sk);
  c.append(e);
  assert.ok(throws(() => c.append(e)));
  assert.strictEqual(c.read().length, 1);
});
t('verify() reports a signature that went bad after it was written', () => {
  const file = tmp();
  const c = new Chain(file);
  c.append(signEntry(call(), A.sk));
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  row.entry.size = '999';
  row.entry_hash = entryHash(row.entry);
  row.link = require('../lib/chain').linkHash(row.prev, row.seq, row.entry_hash);
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  const v = new Chain(file).verify();
  assert.strictEqual(v.ok, false, 'a re-hashed forgery must still fail on the signature');
  assert.ok(v.errors.some((e) => /signature invalid/.test(e.error)));
});

console.log('\nidentity is never a name');
t('signed and unsigned callers with the same name are different identities', () => {
  assert.notStrictEqual(identityOf(signEntry(call(), A.sk)), identityOf(call()));
  assert.strictEqual(identityOf(call()), 'name:alice');
  assert.strictEqual(identityOf(signEntry(call(), A.sk)), `key:${A.pk}`);
});
const row = (identity, caller) => ({ identity, caller, scoring: 'scored', realized: true,
  pnl: '1', benchmark_pnl: '0', edge: '1' });
t('a unique, uncontested name is displayed', () => {
  const n = resolveNames([row(`key:${A.pk}`, 'alice')]);
  assert.strictEqual(n.get(`key:${A.pk}`).display, 'alice');
  assert.strictEqual(n.get(`key:${A.pk}`).name_contested, false);
});
t('NEGATIVE CONTROL: impersonation collapses BOTH parties to raw keys', () => {
  // B signs with their own key but types A`s display name. Neither may show it.
  const n = resolveNames([row(`key:${A.pk}`, 'alice'), row(`key:${B.pk}`, 'alice')]);
  assert.strictEqual(n.get(`key:${A.pk}`).name_contested, true);
  assert.strictEqual(n.get(`key:${B.pk}`).name_contested, true);
  assert.notStrictEqual(n.get(`key:${A.pk}`).display, 'alice');
  assert.notStrictEqual(n.get(`key:${B.pk}`).display, 'alice');
  assert.notStrictEqual(n.get(`key:${A.pk}`).display, n.get(`key:${B.pk}`).display);
});
t('an unsigned name is labelled unsigned, so it cannot borrow a key`s standing', () => {
  const n = resolveNames([row(`key:${A.pk}`, 'alice'), row('name:alice', 'alice')]);
  assert.match(n.get('name:alice').display, /^unsigned:/);
  assert.strictEqual(n.get('name:alice').signed, false);
  assert.strictEqual(n.get('name:alice').tier, 'T0');
});
t('NEGATIVE CONTROL: an unsigned entry cannot grief a signed key out of its name', () => {
  // Found by running the live board: an unsigned "cadence-wave" stripped the signed key
  // of its label. Generalised, that is a free, permanent name-poisoning attack on anyone.
  // Only a SIGNED identity may contest a name.
  const n = resolveNames([row(`key:${A.pk}`, 'alice'), row('name:alice', 'alice')]);
  assert.strictEqual(n.get(`key:${A.pk}`).display, 'alice', 'the key keeps its name');
  assert.strictEqual(n.get(`key:${A.pk}`).name_contested, false);
  // ...but a second SIGNED key using it still costs them both.
  const m = resolveNames([row(`key:${A.pk}`, 'alice'), row(`key:${B.pk}`, 'alice')]);
  assert.strictEqual(m.get(`key:${A.pk}`).name_contested, true);
});
t('two flags, not one tier word: signing proves WHO, never that the fill happened', () => {
  const n = resolveNames([row(`key:${A.pk}`, 'alice')]).get(`key:${A.pk}`);
  assert.strictEqual(n.identity_verified, true);
  assert.strictEqual(n.fill_verified, false, 'a signature must never imply custody');
  assert.strictEqual(n.tier, 'T1-signed');
});
t('NEGATIVE CONTROL: the leaderboard does not merge two keys sharing a name', () => {
  const board = leaderboard({ scored: [row(`key:${A.pk}`, 'alice'), row(`key:${B.pk}`, 'alice')] });
  assert.strictEqual(board.length, 2, 'two identities must stay two rows');
  assert.strictEqual(new Set(board.map((b) => b.caller)).size, 2);
  board.forEach((b) => assert.strictEqual(b.pnl, '1', 'and neither inherits the other`s record'));
});
t('the board ties break on identity, so ranking is stable under a name collision', () => {
  const rows = [row(`key:${A.pk}`, 'alice'), row(`key:${B.pk}`, 'alice')];
  assert.deepStrictEqual(
    leaderboard({ scored: rows }).map((b) => b.identity),
    leaderboard({ scored: [...rows].reverse() }).map((b) => b.identity),
  );
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
