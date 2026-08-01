'use strict';
/**
 * signing-policy.js — the anchor key cannot sign anything but an anchor.
 *
 * WHY THIS EXISTS. SUBMISSION.md claimed the anchor key "never holds user funds, never
 * signs a transfer... there is nothing to drain". Checking the key instead of the sentence
 * (2026-07-31, changelog #606/#607) found all three clauses false: the key holds real
 * mainnet SOL, it has signed a SOL transfer out, and it is shared with two other projects.
 * Worse, `drain`'s swap route builds a 2-SOL SystemProgram.transfer from the same keypair.
 * That path is aimed at a local validator today, so it moves play money — but the only
 * thing standing between it and real money is one environment variable and a balance that
 * happens to be too small. Safe by accident is not safe.
 *
 * A claim about what a key "never" does has to be enforced by something that can refuse.
 * So: this module is the single choke point through which the anchor key is allowed to
 * sign, and it is DENY BY DEFAULT. An instruction is rejected unless it is one of the two
 * programs an anchor is made of. There is no allowlist entry for the System program, which
 * means a lamport transfer is not "discouraged" or "unlikely" — it is unrepresentable in a
 * transaction this module will sign.
 *
 * WHAT IT DOES NOT BUY. This constrains the ONE process that imports it. Anyone with read
 * access to the keypair file can still sign whatever they like with `solana transfer`, and
 * `receipts`/`oddsline`/`drain` hold the same file and do not go through here. Custody is
 * only really fixed by giving TAPE its own key that nothing else can open; that rotation is
 * a separate change because it moves the anchor identity. This is the half that is safe to
 * ship without changing what the chain points at, and it is stated as such rather than
 * being allowed to read as more than it is.
 */

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./datadir');

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** The complete set of programs the anchor key may touch. Nothing is added at runtime. */
const ALLOWED_PROGRAMS = new Set([MEMO_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID]);

// ComputeBudget instruction discriminators. Only the two an anchor needs are permitted;
// RequestHeapFrame (1) and SetLoadedAccountsDataSizeLimit (4) are refused rather than
// ignored, because "an instruction I did not recognise" is exactly the shape of the thing
// this file is for.
const CB_SET_UNIT_LIMIT = 2;
const CB_SET_UNIT_PRICE = 3;

const SIGNATURE_FEE_LAMPORTS = 5000;

/**
 * Per-transaction and per-day ceilings, in lamports.
 *
 * The daily figure is MEASURED, not guessed: the busiest real day so far anchored 201 times
 * (data/anchors.jsonl, 2026-07-31), and an anchor's worst case is 5000 + 120000*100000/1e6
 * = 17,000 lamports. 10,000,000 is roughly 3x the busiest observed day. Loose enough that
 * normal operation never touches it, tight enough that a runaway loop burns 0.01 SOL and
 * stops instead of draining the balance.
 */
const MAX_FEE_PER_TX = Number(process.env.TAPE_MAX_FEE_LAMPORTS || 30_000);
const MAX_FEE_PER_DAY = Number(process.env.TAPE_MAX_DAILY_FEE_LAMPORTS || 10_000_000);

const ledgerFile = () => process.env.TAPE_FEE_LEDGER || dataPath('anchor-fee-ledger.jsonl');

class PolicyViolation extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyViolation';
    this.code = code;
  }
}

const idOf = (v) => (typeof v === 'string' ? v : v?.toBase58?.() ?? String(v));

/** Decode a ComputeBudget instruction to { kind, value }, or throw if it is not one we allow. */
function readComputeBudget(ix) {
  const data = Buffer.isBuffer(ix.data) ? ix.data : Buffer.from(ix.data || []);
  const tag = data[0];
  if (tag === CB_SET_UNIT_LIMIT) {
    if (data.length < 5) throw new PolicyViolation('cb_malformed', 'SetComputeUnitLimit data too short');
    return { kind: 'units', value: data.readUInt32LE(1) };
  }
  if (tag === CB_SET_UNIT_PRICE) {
    if (data.length < 9) throw new PolicyViolation('cb_malformed', 'SetComputeUnitPrice data too short');
    return { kind: 'price', value: Number(data.readBigUInt64LE(1)) };
  }
  throw new PolicyViolation(
    'cb_instruction_not_allowed',
    `ComputeBudget instruction ${tag} is not one of SetComputeUnitLimit/SetComputeUnitPrice`
  );
}

/**
 * Decide whether this transaction is an anchor. Returns the fee arithmetic on success and
 * throws PolicyViolation on anything else. Pure: no I/O, no signing, no network — so a test
 * can hand it a hostile transaction and watch it refuse without a validator anywhere.
 */
function certifyAnchorTx(tx, { payer }) {
  const payerId = idOf(payer?.publicKey ?? payer);
  if (!payerId || payerId === 'undefined') {
    throw new PolicyViolation('no_payer', 'certifyAnchorTx requires the payer');
  }

  const instructions = tx?.instructions;
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new PolicyViolation('empty_tx', 'transaction carries no instructions');
  }

  let memos = 0;
  let units = null;
  let microLamports = null;

  for (const ix of instructions) {
    const pid = idOf(ix.programId);

    // Named explicitly so the refusal message says the true reason. The generic branch
    // below would already catch it, but "System program is never permitted" is the
    // sentence a reader of an incident report needs to see.
    if (pid === SYSTEM_PROGRAM_ID) {
      throw new PolicyViolation(
        'system_program_forbidden',
        'System program instruction refused: the anchor key may not move lamports'
      );
    }
    if (!ALLOWED_PROGRAMS.has(pid)) {
      throw new PolicyViolation('program_not_allowed', `program ${pid} is not in the anchor allowlist`);
    }

    // No account other than the payer may appear anywhere. An anchor touches exactly one
    // account: the fee payer. Any second account is a counterparty, and a counterparty is
    // the beginning of a transfer even when the program looks harmless.
    for (const k of ix.keys || []) {
      const kid = idOf(k.pubkey);
      if (kid !== payerId) {
        throw new PolicyViolation('foreign_account', `instruction references non-payer account ${kid}`);
      }
    }

    if (pid === COMPUTE_BUDGET_PROGRAM_ID) {
      const { kind, value } = readComputeBudget(ix);
      if (kind === 'units') units = value;
      else microLamports = value;
    } else {
      memos += 1;
      const payload = Buffer.isBuffer(ix.data) ? ix.data.toString('utf8') : String(ix.data ?? '');
      let parsed = null;
      try { parsed = JSON.parse(payload); } catch { parsed = null; }
      // Fail closed on a memo we cannot read. The memo is the only free-form field in the
      // transaction, so "I could not parse it" must mean refuse, not shrug.
      if (!parsed || parsed.p !== 'tape') {
        throw new PolicyViolation('memo_not_anchor', 'memo payload is not a TAPE anchor payload');
      }
    }
  }

  if (memos !== 1) {
    throw new PolicyViolation('memo_count', `expected exactly 1 anchor memo, found ${memos}`);
  }

  // Missing ComputeBudget instructions are treated as the network defaults rather than as
  // zero, because reading an absent limit as 0 would make an unbounded transaction look
  // like the cheapest one on the ledger.
  const effUnits = units == null ? 200_000 : units;
  const effPrice = microLamports == null ? 0 : microLamports;
  const priorityLamports = Math.ceil((effUnits * effPrice) / 1_000_000);
  const maxFeeLamports = SIGNATURE_FEE_LAMPORTS + priorityLamports;

  if (maxFeeLamports > MAX_FEE_PER_TX) {
    throw new PolicyViolation(
      'fee_cap_tx',
      `max fee ${maxFeeLamports} lamports exceeds per-tx cap ${MAX_FEE_PER_TX}`
    );
  }

  return { maxFeeLamports, units: effUnits, microLamports: effPrice, memos };
}

const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every row ever written, or throw. Unreadable ledger means refuse, never "assume zero". */
function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Lamports already committed today. Counts FAILED attempts too — a tx can fail after paying. */
function spentToday(now = Date.now(), file = ledgerFile()) {
  const day = utcDate(now);
  return readLedger(file)
    .filter((r) => r.date === day)
    .reduce((a, r) => a + (r.max_fee_lamports || 0), 0);
}

/**
 * Commit the spend BEFORE the transaction is sent, not after.
 *
 * If the process dies between signing and recording, an after-the-fact ledger loses the
 * spend and the cap silently rises. Reserving first can only ever overcount, and a cap that
 * errs toward refusing is the only direction a spend cap is allowed to err in.
 */
function reserveFee({ maxFeeLamports, now = Date.now(), file = ledgerFile(), note }) {
  const already = spentToday(now, file);
  if (already + maxFeeLamports > MAX_FEE_PER_DAY) {
    throw new PolicyViolation(
      'fee_cap_day',
      `daily fee cap reached: ${already} + ${maxFeeLamports} > ${MAX_FEE_PER_DAY} lamports`
    );
  }
  const row = {
    ts: new Date(now).toISOString(),
    date: utcDate(now),
    max_fee_lamports: maxFeeLamports,
    note: note || null,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return { reserved: maxFeeLamports, spent_today: already + maxFeeLamports, cap: MAX_FEE_PER_DAY };
}

/**
 * The ONLY sanctioned way for the anchor key to sign. `send` is injected so the refusal
 * path can be tested without a validator — and so a test can assert the sender was never
 * reached, which is the actual claim ("refused" is not "sent and failed").
 */
async function signAndSendCertified({ conn, tx, payer, send, now = Date.now(), note }) {
  const cert = certifyAnchorTx(tx, { payer });
  const budget = reserveFee({ maxFeeLamports: cert.maxFeeLamports, now, note });
  const signature = await send(conn, tx, [payer]);
  return { signature, cert, budget };
}

module.exports = {
  certifyAnchorTx, reserveFee, spentToday, signAndSendCertified, PolicyViolation,
  ALLOWED_PROGRAMS, MEMO_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID, SYSTEM_PROGRAM_ID,
  MAX_FEE_PER_TX, MAX_FEE_PER_DAY, ledgerFile,
};
