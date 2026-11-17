'use strict';
/**
 * anchor.js — the external clock.
 *
 * THIS IS THE LOAD-BEARING FILE. Everything else in TAPE is a hash chain we control,
 * and a record whose operator controls the clock proves nothing: if our server stamps
 * the time, we can backdate, so the leaderboard is only as honest as us. Append-only
 * plus a clock you control is a diary.
 *
 * So the ordering and timing are attested by Solana. Each interval we publish one memo
 * transaction carrying the Merkle root of the calls in that interval, the leaf count,
 * and the chain head. The SLOT of that transaction is the authoritative timestamp, and
 * a claim only counts against an outcome if its anchoring slot came first.
 *
 * WHAT THIS DOES AND DOES NOT BUY:
 *  - Buys: we cannot backdate, reorder, or silently drop a call that was anchored.
 *  - Does NOT buy: proof the caller actually took the trade (that is T1/T2), nor proof
 *    that we ACCEPTED every call submitted to us. Censorship at intake is a separate
 *    problem and is named in the threat model rather than hand-waved.
 */

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram,
  sendAndConfirmTransaction } = require('@solana/web3.js');
const { signAndSendCertified } = require('./signing-policy');

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const DEFAULT_CLUSTER = process.env.TAPE_CLUSTER || 'https://api.devnet.solana.com';

/**
 * The exact bytes committed on chain. Compact because memo data costs money per byte,
 * and versioned because an unversioned on-chain format can never be changed safely.
 * `n` (the leaf count) is committed alongside the root so a root is only ever
 * interpreted against one tree shape — see the odd-node footgun in merkle.js.
 */
function anchorPayload({ root, count, chainHead }) {
  return JSON.stringify({ p: 'tape', v: 1, root, n: count, head: chainHead });
}

/** Submit an anchor. Returns { signature, slot, blockTime, cluster, payload }. */
async function submitAnchor({ root, count, chainHead, payer, cluster = DEFAULT_CLUSTER }) {
  const conn = new Connection(cluster, 'confirmed');
  const payload = anchorPayload({ root, count, chainHead });

  // PRIORITY FEE (added 2026-07-30). The anchor tx carried none, which was survivable only
  // because Helius forwards through staked connections. The moment that key hit its quota
  // and the daemon failed over to a keyless public RPC, every anchor died with
  // "block height exceeded" — the tx was never dropped for being invalid, it was simply
  // never picked up, and the blockhash aged out. A zero-fee transaction is a request, not
  // an instruction. The cost here is ~0.000017 SOL per anchor (5,000 lamports base fee
  // + 120,000 CU x 100,000 microlamports/CU = 12,000 lamports priority fee). The daemon
  // ticks every 60s but only anchors when the tape changed (plus an idle heartbeat), so the
  // ceiling at one anchor every tick is 43,200 x 0.000017 = ~0.73 SOL a month, and the real
  // bill is lower. That is the price of the single guarantee this system sells.
  const PRIORITY_MICROLAMPORTS = Number(process.env.TAPE_PRIORITY_MICROLAMPORTS || 100_000);
  const tx = new Transaction()
    // MEASURED, not guessed: a 173-byte anchor payload consumes 76,187 CU (simulated on
    // mainnet). 20k and 60k both failed with "exceeded CUs meter at BPF instruction" —
    // the memo program's cost scales with payload length. 120k leaves headroom for a
    // longer payload without being so loose that the priority fee (units x price) inflates.
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }))
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }))
    .add(new TransactionInstruction({
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(payload, 'utf8'),
    }));

  // DENY BY DEFAULT. The key does not sign here — signing-policy.js does, and only after
  // certifying that what it is about to sign is {ComputeBudget, Memo} over the payer alone,
  // with no System program and no second account, inside a per-tx and per-day fee cap. A
  // PolicyViolation thrown here means nothing was sent: see lib/signing-policy.js for why
  // the claim "this key never signs a transfer" needed something that can refuse.
  const { signature } = await signAndSendCertified({
    conn, tx, payer, note: 'anchor',
    send: (c, t, signers) => sendAndConfirmTransaction(c, t, signers, {
      commitment: 'confirmed', preflightCommitment: 'confirmed', maxRetries: 5,
    }),
  });

  // THE SLOT IS THE AUTHORITATIVE TIMESTAMP. Everything in TAPE rests on it, so it is the
  // one field that must never come back empty and unremarked.
  //
  // sendAndConfirmTransaction returns as soon as the tx is CONFIRMED, but the RPC's
  // transaction index lags that by a moment — so an immediate getTransaction returns
  // null, and `parsed?.slot ?? null` quietly produced `slot: null, blockTime: null` on
  // the genesis anchor. The transaction was perfectly fine; the reader was early. A null
  // there is indistinguishable from "this anchor has no time", which would silently
  // undermine the only claim the anchor exists to make. So: poll, then fail loudly.
  let parsed = null;
  const delays = [400, 800, 1600, 3000, 5000, 8000];
  for (let i = 0; i <= delays.length; i++) {
    parsed = await conn.getTransaction(signature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    if (parsed && typeof parsed.slot === 'number') break;
    if (i < delays.length) await new Promise((r) => setTimeout(r, delays[i]));
  }

  if (!parsed || typeof parsed.slot !== 'number') {
    const e = new Error(
      `anchor ${signature} was submitted and confirmed, but its slot could not be read back ` +
      `after ${delays.length + 1} attempts. The transaction is on chain — re-read it with ` +
      `fetchAnchor() before treating this anchor as timed.`
    );
    e.signature = signature;
    e.submitted = true; // do NOT let a caller read this as "the anchor failed"
    throw e;
  }

  return {
    signature,
    slot: parsed.slot,
    blockTime: parsed.blockTime ?? null,
    cluster,
    payload,
  };
}

/**
 * Read an anchor back FROM THE CHAIN and return what it actually says.
 *
 * The verifier must call this rather than trusting our own stored copy of the payload.
 * Checking our local record against our local record is the tautology this whole design
 * exists to avoid; the point is to fetch the bytes from a source we do not control.
 */
async function fetchAnchor(signature, cluster = DEFAULT_CLUSTER) {
  const conn = new Connection(cluster, 'confirmed');
  const tx = await conn.getTransaction(signature, {
    commitment: 'confirmed', maxSupportedTransactionVersion: 0,
  });
  if (!tx) return { found: false, signature };

  // READ THE INSTRUCTION DATA, NOT THE LOGS.
  //
  // The obvious implementation scrapes `Program log: Memo (len N): "..."` out of
  // meta.logMessages, and it works — until it doesn't. Validator logs are capped and get
  // TRUNCATED on busy transactions, and a truncated log is indistinguishable from "no
  // memo here". That failure mode is silent and it would land on exactly the anchors we
  // most need to read. Instruction data is part of consensus and is never truncated, so
  // that is what we parse. Logs are used only as a cross-check.
  const msg = tx.transaction?.message;
  const keys = (msg?.staticAccountKeys || msg?.accountKeys || []).map((k) => k.toBase58?.() ?? String(k));
  const instrs = msg?.compiledInstructions || msg?.instructions || [];

  let payload = null;
  for (const ix of instrs) {
    const pidIdx = ix.programIdIndex;
    if (keys[pidIdx] !== MEMO_PROGRAM_ID.toBase58()) continue;
    const data = ix.data;
    const buf = Buffer.isBuffer(data) ? data
      : data instanceof Uint8Array ? Buffer.from(data)
      : Buffer.from(require('bs58').decode(String(data))); // legacy txs carry base58 data
    payload = buf.toString('utf8');
    break;
  }

  // Cross-check against the log form when it is present and untruncated. A mismatch means
  // one of the two readers is wrong, and guessing which would defeat the purpose.
  const logLine = (tx.meta?.logMessages || []).find((l) => /Memo \(len \d+\): "/.test(l));
  let logPayload = null;
  if (logLine) {
    const m = logLine.match(/Memo \(len \d+\): "(.*)"$/);
    if (m) logPayload = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  const logMismatch = logPayload !== null && payload !== null && logPayload !== payload;

  let parsed = null;
  try { parsed = payload ? JSON.parse(payload) : null; } catch { parsed = null; }

  return {
    found: true, signature, slot: tx.slot, blockTime: tx.blockTime,
    payload, parsed, logPayload, logMismatch,
  };
}

function loadKeypair(secretKeyJsonPath) {
  const arr = JSON.parse(require('fs').readFileSync(secretKeyJsonPath, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

module.exports = { submitAnchor, fetchAnchor, anchorPayload, loadKeypair, MEMO_PROGRAM_ID, DEFAULT_CLUSTER };
