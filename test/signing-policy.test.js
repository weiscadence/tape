'use strict';
/**
 * signing-policy.test.js — proving the refusal, not the happy path.
 *
 * SUBMISSION.md asserted the anchor key "never signs a transfer". An assertion in a document
 * is not a control, and when the key was actually inspected (changelog #606) it HAD signed a
 * transfer. So the test that matters here is not "an anchor still works" — it is:
 *
 *   - is a transfer REFUSED, and refused *before* anything reached the sender?
 *   - is "refused" distinguishable from "sent and happened to fail"?
 *   - does a spend cap that cannot read its own ledger refuse rather than assume zero?
 *
 * Every refusal case is paired with a positive control that must PASS, because a policy that
 * rejects everything passes a refusal suite perfectly while breaking the product. Two of the
 * bugs shipped this week were green instruments over absent work; a deny-by-default gate with
 * no positive control is that same shape waiting to happen.
 *
 * ISOLATION: every fee-ledger test writes to a scratch file via TAPE_FEE_LEDGER. Per the
 * seq-48 rule — before running a failure test, ask what the code does if it does NOT refuse.
 * Here the answer is "appends a spend row", so it is pointed at /tmp, never at data/.
 */

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram,
} = require('@solana/web3.js');

const P = require('../lib/signing-policy');

const PAYER = Keypair.generate();
const OTHER = Keypair.generate();
const MEMO = new PublicKey(P.MEMO_PROGRAM_ID);

const anchorMemo = (payload = { p: 'tape', v: 1, root: 'ab'.repeat(32), n: 3, head: 'cd'.repeat(32) }) =>
  new TransactionInstruction({
    keys: [{ pubkey: PAYER.publicKey, isSigner: true, isWritable: true }],
    programId: MEMO,
    data: Buffer.from(JSON.stringify(payload), 'utf8'),
  });

/** Built exactly as lib/anchor.js builds it, so the control tracks the real transaction. */
function realAnchorTx() {
  return new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }))
    .add(anchorMemo());
}

const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tape-fee-')), 'ledger.jsonl');

function refuses(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.strictEqual(e.name, 'PolicyViolation', `expected PolicyViolation, got ${e.name}: ${e.message}`);
    assert.strictEqual(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
    return e;
  }
  assert.fail(`expected PolicyViolation ${code}, but the transaction was CERTIFIED`);
}

// ---------------------------------------------------------------- positive controls

test('POSITIVE CONTROL: a real anchor certifies, with the fee arithmetic we expect', () => {
  const cert = P.certifyAnchorTx(realAnchorTx(), { payer: PAYER });
  assert.strictEqual(cert.units, 120_000);
  assert.strictEqual(cert.microLamports, 100_000);
  // 5000 signature + ceil(120000 * 100000 / 1e6) = 5000 + 12000
  assert.strictEqual(cert.maxFeeLamports, 17_000);
});

test('POSITIVE CONTROL: an anchor with no ComputeBudget instructions still certifies', () => {
  const tx = new Transaction().add(anchorMemo());
  const cert = P.certifyAnchorTx(tx, { payer: PAYER });
  assert.strictEqual(cert.maxFeeLamports, 5000, 'absent priority fee must read as 0, not as unbounded');
});

// ---------------------------------------------------------------- the claim under test

test('a SOL transfer is REFUSED — the claim SUBMISSION.md made, now enforced', () => {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: PAYER.publicKey, toPubkey: OTHER.publicKey, lamports: 2_000_000_000,
  }));
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'system_program_forbidden');
});

test('a transfer SMUGGLED INTO a valid anchor is refused', () => {
  // The realistic attack is not a bare transfer, it is a transfer riding along with a
  // legitimate-looking anchor so the memo still reads correctly on an explorer.
  const tx = realAnchorTx().add(SystemProgram.transfer({
    fromPubkey: PAYER.publicKey, toPubkey: OTHER.publicKey, lamports: 1,
  }));
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'system_program_forbidden');
});

test('an unknown program is refused, not ignored', () => {
  const tx = realAnchorTx().add(new TransactionInstruction({
    keys: [], programId: Keypair.generate().publicKey, data: Buffer.alloc(0),
  }));
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'program_not_allowed');
});

test('a second account is refused even under an allowed program', () => {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }))
    .add(new TransactionInstruction({
      keys: [
        { pubkey: PAYER.publicKey, isSigner: true, isWritable: true },
        { pubkey: OTHER.publicKey, isSigner: false, isWritable: true },
      ],
      programId: MEMO,
      data: Buffer.from(JSON.stringify({ p: 'tape', v: 1 }), 'utf8'),
    }));
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'foreign_account');
});

test('a memo that is not a TAPE anchor is refused — fail closed on unparseable payloads', () => {
  const tx = new Transaction().add(new TransactionInstruction({
    keys: [{ pubkey: PAYER.publicKey, isSigner: true, isWritable: true }],
    programId: MEMO,
    data: Buffer.from('gm', 'utf8'),
  }));
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'memo_not_anchor');
});

test('two memos are refused — one anchor per transaction', () => {
  const tx = realAnchorTx().add(anchorMemo());
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'memo_count');
});

test('an unrecognised ComputeBudget instruction is refused', () => {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.requestHeapFrame({ bytes: 33 * 1024 }))
    .add(anchorMemo());
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'cb_instruction_not_allowed');
});

test('an empty transaction is refused', () => {
  refuses(() => P.certifyAnchorTx(new Transaction(), { payer: PAYER }), 'empty_tx');
});

// ---------------------------------------------------------------- fee caps

test('a fee above the per-tx cap is refused', () => {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }))
    .add(anchorMemo());
  refuses(() => P.certifyAnchorTx(tx, { payer: PAYER }), 'fee_cap_tx');
});

test('the daily cap refuses once the ledger says the day is spent', () => {
  const file = scratch();
  const now = Date.parse('2026-08-01T12:00:00Z');
  // POSITIVE CONTROL first: an empty day must allow the spend, otherwise the refusal below
  // proves nothing about the cap — only that reserveFee always throws.
  const ok = P.reserveFee({ maxFeeLamports: 17_000, now, file });
  assert.strictEqual(ok.spent_today, 17_000);

  fs.appendFileSync(file, JSON.stringify({
    ts: new Date(now).toISOString(), date: '2026-08-01',
    max_fee_lamports: P.MAX_FEE_PER_DAY - 17_000, note: 'seed',
  }) + '\n');

  refuses(() => P.reserveFee({ maxFeeLamports: 17_000, now, file }), 'fee_cap_day');
});

test("yesterday's spend does not count against today", () => {
  const file = scratch();
  fs.appendFileSync(file, JSON.stringify({
    ts: '2026-07-31T23:59:00Z', date: '2026-07-31', max_fee_lamports: P.MAX_FEE_PER_DAY, note: 'seed',
  }) + '\n');
  assert.strictEqual(P.spentToday(Date.parse('2026-08-01T00:01:00Z'), file), 0);
});

test('an unreadable ledger REFUSES rather than reading as zero spent', () => {
  const file = scratch();
  fs.writeFileSync(file, '{not json\n');
  // The dangerous version of this bug returns 0 and silently lifts the cap — the same
  // broken-zero shape as the NUL-byte and marks-grid incidents. It must throw.
  assert.throws(() => P.spentToday(Date.now(), file));
});

// ---------------------------------------------------------------- refused != sent

test('REFUSED MEANS NEVER SENT: the sender is not reached and no fee is reserved', async () => {
  const file = scratch();
  process.env.TAPE_FEE_LEDGER = file;
  let sendCalls = 0;
  const tx = realAnchorTx().add(SystemProgram.transfer({
    fromPubkey: PAYER.publicKey, toPubkey: OTHER.publicKey, lamports: 1,
  }));
  await assert.rejects(
    () => P.signAndSendCertified({ conn: null, tx, payer: PAYER, send: async () => { sendCalls += 1; return 'sig'; } }),
    (e) => e.name === 'PolicyViolation' && e.code === 'system_program_forbidden'
  );
  assert.strictEqual(sendCalls, 0, 'the transfer reached the sender — this is "sent and failed", not "refused"');
  assert.strictEqual(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '', '',
    'a refused transaction must not consume budget');
  delete process.env.TAPE_FEE_LEDGER;
});

test('POSITIVE CONTROL: a real anchor does reach the sender, and books its fee first', async () => {
  const file = scratch();
  process.env.TAPE_FEE_LEDGER = file;
  let seen = null;
  const out = await P.signAndSendCertified({
    conn: 'CONN', tx: realAnchorTx(), payer: PAYER,
    send: async (c, t, signers) => { seen = { c, signers }; return 'SIGNATURE'; },
  });
  assert.strictEqual(out.signature, 'SIGNATURE');
  assert.strictEqual(seen.c, 'CONN');
  assert.strictEqual(seen.signers[0], PAYER);
  assert.strictEqual(P.spentToday(Date.now(), file), 17_000, 'the spend must be booked before the send');
  delete process.env.TAPE_FEE_LEDGER;
});

test('a send that throws still leaves the fee booked — reserving after the fact loses spend', async () => {
  const file = scratch();
  process.env.TAPE_FEE_LEDGER = file;
  await assert.rejects(() => P.signAndSendCertified({
    conn: null, tx: realAnchorTx(), payer: PAYER,
    send: async () => { throw new Error('blockhash not found'); },
  }));
  assert.strictEqual(P.spentToday(Date.now(), file), 17_000,
    'a failed send can still have paid — the cap must count it');
  delete process.env.TAPE_FEE_LEDGER;
});

test('fee ledger: concurrent processes cannot jointly exceed the daily cap', async () => {
  const { spawn } = require('child_process');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tape-fee-race-')), 'ledger.jsonl');
  const each = Math.floor(P.MAX_FEE_PER_DAY / 3) + 1; // any 3 together exceed the cap, so at most 2 may land
  const code = `const P=require(${JSON.stringify(path.resolve(__dirname, '../lib/signing-policy'))});` +
    `const t=+process.argv[1];while(Date.now()<t){}` +
    `try{P.reserveFee({maxFeeLamports:${each},file:${JSON.stringify(file)}});process.exit(0)}catch(e){process.exit(e.code==='fee_cap_day'||/daily fee cap/.test(e.message)?3:1)}`;
  // Every child spins until a shared start time, so the read-check-append windows actually overlap.
  const start = String(Date.now() + 1500);
  const run = () => new Promise((r) => spawn(process.execPath, ['-e', code, start]).on('exit', r));
  const codes = await Promise.all(Array.from({ length: 16 }, run));
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  assert.ok(rows * each <= P.MAX_FEE_PER_DAY, `rows=${rows} each=${each} cap=${P.MAX_FEE_PER_DAY} codes=${codes}`);
  assert.ok(!codes.includes(1), `unexpected failure codes ${codes}`);
});
