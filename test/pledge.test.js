'use strict';
/**
 * pledge.test.js — the reliability half, and the ways it could flatter people.
 *
 * A reliability score is much easier to fake than a P&L, because the thing being scored is
 * whatever the scored party says happened. So the tests that matter here are not "does a
 * kept pledge read as kept". They are:
 *
 *   - does going quiet cost exactly as much as failing?
 *   - does an agent that has done nothing read as undefined rather than as perfect?
 *   - when the agent's own claim disagrees with the chain, does the chain win?
 *   - can a pledge be satisfied by work done before the pledge was made?
 *
 * Each of those has a control that constructs the flattering version and requires it to be
 * caught.
 */

const assert = require('assert');
const crypto = require('crypto');
const ed = require('../lib/ed25519');
const P = require('../lib/pledge');
const { entryHash } = require('../lib/entry');
const { buildEntry, signEntry } = require('../lib/entry');
const W = require('../lib/windows');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

const mkKey = () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  return Buffer.concat([
    kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
    kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  ]);
};

const AGENT = mkKey();
const AGENT_PUB = ed.publicKeyOf(AGENT);
const T0 = 1785600000;              // pledge made
const DUE = T0 + 86400;             // deadline
const NOW = DUE + 60;               // settling time
const iso = (u) => new Date(u * 1000).toISOString();
const nonce = () => crypto.randomBytes(16).toString('hex');

const row = (e) => ({ entry_hash: entryHash(e), entry: e });
const mkPledge = (over = {}) => P.signPledgeRow(P.buildPledgeRow({
  type: 'pledge', text: 'I will post at least two calls before tomorrow',
  due_at: DUE, check: 'none', ts_claimed: iso(T0), nonce: nonce(), ...over,
}), AGENT);
const mkReport = (hash, outcome, at = DUE - 60) => P.signPledgeRow(P.buildPledgeRow({
  type: 'pledge_report', pledge_hash: hash, outcome, ts_claimed: iso(at), nonce: nonce(),
}), AGENT);

console.log('\nSHAPE — a pledge you cannot wriggle out of');

t('a well-formed pledge round-trips and verifies', () => {
  const p = mkPledge();
  assert.ok(P.isPledgeRow(p));
  assert.deepStrictEqual(P.verifyPledgeRow(p).ok, true);
});

t('CONTROL: one edited byte after signing reads as invalid', () => {
  const p = { ...mkPledge(), text: 'I will post at least three calls before tomorrow' };
  assert.strictEqual(P.verifyPledgeRow(p).ok, false);
});

t('a pledge signature cannot be lifted onto a call or a window row', () => {
  const p = mkPledge();
  // Same bytes, different domain prefix: the whole reason each family has its own.
  const { verifyEntrySignature } = require('../lib/entry');
  assert.strictEqual(verifyEntrySignature(p).ok, false);
  assert.strictEqual(W.verifyWindowRow(p).ok, false);
});

// THE ONE THAT MATTERS. verifyPledgeRow first returned a plain boolean, and chain.js gates
// on `sigCheck.signed && !sigCheck.ok`. `undefined && …` is falsy, so the signature check
// never ran and the chain accepted forged pledge rows in silence. Asserting on the verdict
// shape alone would not have caught it; this drives the real append path.
t('a forged pledge row is REFUSED by the chain, not just by the verifier', () => {
  const { Chain } = require('../lib/chain');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pledge-chain-'));
  const chain = new Chain(path.join(dir, 'tape.jsonl'));
  const good = mkPledge();
  chain.append(good); // positive control: an honest row goes in
  const forged = { ...good, text: 'I will do something much more impressive than that' };
  assert.throws(() => chain.append(forged), /does not verify/,
    'a signature check that silently does not run is worse than none');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('unknown fields are refused, never dropped', () => {
  assert.throws(() => P.buildPledgeRow({
    type: 'pledge', text: 'I will do the thing properly', due_at: DUE, check: 'none',
    ts_claimed: iso(T0), nonce: nonce(), exempt: true,
  }), /unknown field/);
});

t('a pledge must actually say something', () => {
  assert.throws(() => mkPledge({ text: 'stuff' }), /what you will actually do/);
});

t('a checkable pledge must carry its argument, and an unchecked one must not', () => {
  assert.throws(() => mkPledge({ check: 'post_call' }), /requires a check_arg/);
  assert.throws(() => mkPledge({ check: 'none', check_arg: '2' }), /takes no check_arg/);
  assert.throws(() => mkPledge({ check: 'post_call', check_arg: '0' }), /positive integer/);
  assert.throws(() => mkPledge({ check: 'close_ref', check_arg: 'not-a-hash' }), /entry_hash/);
});

t('an agent cannot report "unreported" about itself', () => {
  assert.throws(() => mkReport('a'.repeat(64), 'unreported'), /kept\|broken/);
});

t('a settlement must state contradicted explicitly, never by omission', () => {
  assert.throws(() => P.buildPledgeRow({
    type: 'pledge_settle', pledge_hash: 'a'.repeat(64), outcome: 'kept',
    basis: 'self_reported', observed_at: NOW,
  }), /required/);
});

console.log('\nSILENCE — the rule the whole thing rests on');

t('a deadline that passes with no report settles as unreported', () => {
  const p = mkPledge();
  const [s] = P.pendingSettlements([row(p)], NOW);
  assert.strictEqual(s.outcome, 'unreported');
  assert.strictEqual(s.basis, 'no_report');
});

t('unreported costs exactly as much as broken', () => {
  const quiet = mkPledge({ text: 'I will handle the thing and say nothing' });
  const admitted = mkPledge({ text: 'I will handle the other thing and admit it' });
  const rows = [row(quiet), row(admitted), row(mkReport(entryHash(admitted), 'broken'))];
  for (const s of P.pendingSettlements(rows, NOW)) {
    rows.push(row(P.signPledgeRow(P.buildPledgeRow({ type: 'pledge_settle', ...s }), AGENT)));
  }
  const rec = P.keptRecord(rows).find((r) => r.signer === AGENT_PUB);
  assert.strictEqual(rec.kept, 0);
  assert.strictEqual(rec.broken, 1);
  assert.strictEqual(rec.unreported, 1);
  assert.strictEqual(rec.rate, 0, 'if hiding scored better than admitting, everyone would hide');
});

t('...but the record still tells them apart', () => {
  // The rate treats them the same; the row does not. Same shape as pass vs no_answer.
  const quiet = mkPledge();
  const [s] = P.pendingSettlements([row(quiet)], NOW);
  assert.strictEqual(s.outcome, 'unreported');
  assert.notStrictEqual(s.outcome, 'broken');
});

t('a report filed AFTER the deadline does not count', () => {
  const p = mkPledge();
  const late = mkReport(entryHash(p), 'kept', DUE + 30);
  const [s] = P.pendingSettlements([row(p), row(late)], NOW);
  assert.strictEqual(s.outcome, 'unreported',
    'a claim made once the answer is visible is what the deadline exists to prevent');
});

t('a pledge that is not due yet is not settled at all', () => {
  assert.strictEqual(P.pendingSettlements([row(mkPledge())], DUE - 1).length, 0);
});

console.log('\nNOTHING SETTLED IS NOT PERFECT');

t('an agent with no settled pledges has a null rate, never 1', () => {
  const rec = P.keptRecord([row(mkPledge())]).find((r) => r.signer === AGENT_PUB);
  assert.strictEqual(rec.made, 1);
  assert.strictEqual(rec.settled, 0);
  assert.strictEqual(rec.open, 1);
  assert.strictEqual(rec.rate, null);
  assert.match(rec.basis, /not perfect/);
});

console.log('\nTHE CHAIN OVERRIDES THE CLAIM');

const call = (at, type = 'open', over = {}) => signEntry(buildEntry({
  type, caller: 'agent', lane: 'perp', market: 'SOL/USD', side: 'yes', size: '1', entry_ref: '70.00',
  ts_claimed: iso(at), nonce: nonce(), ...over,
}), AGENT);

t('post_call is kept when the calls are actually there', () => {
  const p = mkPledge({ check: 'post_call', check_arg: '2' });
  const rows = [row(p), row(call(T0 + 100)), row(call(T0 + 200))];
  const [s] = P.pendingSettlements(rows, NOW);
  assert.strictEqual(s.outcome, 'kept');
  assert.strictEqual(s.basis, 'chain_checked');
});

t('CONTROL — claiming kept when the chain says broken is caught AND flagged', () => {
  const p = mkPledge({ check: 'post_call', check_arg: '2' });
  const rows = [row(p), row(call(T0 + 100)), row(mkReport(entryHash(p), 'kept'))];
  const [s] = P.pendingSettlements(rows, NOW);
  assert.strictEqual(s.outcome, 'broken', 'the chain wins over what the agent says about itself');
  assert.strictEqual(s.basis, 'chain_checked');
  assert.strictEqual(s.contradicted, true, 'the flag is worth more than the outcome it corrects');
});

t('an honest self-report agreeing with the chain is NOT flagged as contradicted', () => {
  const p = mkPledge({ check: 'post_call', check_arg: '1' });
  const rows = [row(p), row(call(T0 + 100)), row(mkReport(entryHash(p), 'kept'))];
  assert.strictEqual(P.pendingSettlements(rows, NOW)[0].contradicted, false,
    'flagging every checked pledge would make the flag mean nothing');
});

t('CONTROL — calls posted BEFORE the pledge do not satisfy it', () => {
  const p = mkPledge({ check: 'post_call', check_arg: '2' });
  const rows = [row(p), row(call(T0 - 5000)), row(call(T0 - 4000))];
  assert.strictEqual(P.pendingSettlements(rows, NOW)[0].outcome, 'broken',
    'otherwise a pledge about the past is free');
});

t('CONTROL — another agent\'s calls do not satisfy my pledge', () => {
  const other = mkKey();
  const theirs = signEntry(buildEntry({
    type: 'open', caller: 'other', lane: 'perp', market: 'SOL/USD', side: 'yes', size: '1', entry_ref: '70.00',
    ts_claimed: iso(T0 + 100), nonce: nonce(),
  }), other);
  const p = mkPledge({ check: 'post_call', check_arg: '1' });
  assert.strictEqual(P.pendingSettlements([row(p), row(theirs)], NOW)[0].outcome, 'broken');
});

t('close_ref is kept only by closing THAT position', () => {
  const open = call(T0 - 100);
  const p = mkPledge({ check: 'close_ref', check_arg: entryHash(open) });
  const wrong = call(T0 + 100, 'close', { ref: 'b'.repeat(64) });
  assert.strictEqual(P.pendingSettlements([row(p), row(open), row(wrong)], NOW)[0].outcome, 'broken');
  const right = call(T0 + 100, 'close', { ref: entryHash(open) });
  assert.strictEqual(P.pendingSettlements([row(p), row(open), row(right)], NOW)[0].outcome, 'kept');
});

t('CONTROL — pledging to answer windows you were never asked is BROKEN, not vacuously kept', () => {
  const p = mkPledge({ check: 'answer_windows', check_arg: '2026-W99' });
  assert.strictEqual(P.pendingSettlements([row(p)], NOW)[0].outcome, 'broken',
    'you cannot earn reliability from a test that never ran');
});

console.log('\nSETTLEMENT IS BINDING');

t('a second settlement does not overwrite the first', () => {
  const p = mkPledge();
  const h = entryHash(p);
  const bad = P.signPledgeRow(P.buildPledgeRow({
    type: 'pledge_settle', pledge_hash: h, outcome: 'unreported', basis: 'no_report',
    contradicted: false, observed_at: NOW,
  }), AGENT);
  const revised = P.signPledgeRow(P.buildPledgeRow({
    type: 'pledge_settle', pledge_hash: h, outcome: 'kept', basis: 'self_reported',
    contradicted: false, observed_at: NOW + 10,
  }), AGENT);
  const rec = P.keptRecord([row(p), row(bad), row(revised)]).find((r) => r.signer === AGENT_PUB);
  assert.strictEqual(rec.unreported, 1);
  assert.strictEqual(rec.kept, 0, 're-settling would make every bad outcome temporary');
});

t('an already-settled pledge is not re-settled', () => {
  const p = mkPledge();
  const s = P.signPledgeRow(P.buildPledgeRow({
    type: 'pledge_settle', pledge_hash: entryHash(p), outcome: 'unreported',
    basis: 'no_report', contradicted: false, observed_at: NOW,
  }), AGENT);
  assert.strictEqual(P.pendingSettlements([row(p), row(s)], NOW + 999).length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
