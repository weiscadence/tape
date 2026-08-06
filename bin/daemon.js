#!/usr/bin/env node
'use strict';
/**
 * daemon.js — the interval marking loop. This is the thing that turns TAPE from a
 * library you run by hand into a record that keeps time whether or not anyone is
 * watching, which is the only version of it that is worth trusting.
 *
 * WHAT ONE TICK DOES:
 *   1. verify the chain               — a broken chain is the ONE condition that stops us
 *   2. gate open predictions          — decides RANKING eligibility, never blocks anchoring
 *   3. auto-void already-resolved     — as a public append-only amend, never a deletion
 *   4. anchor the whole chain         — unconditionally, every entry, no exceptions
 *
 * THREE DESIGN RULES, EACH WRITTEN BECAUSE THE OBVIOUS VERSION IS WRONG:
 *
 * (a) THE GATE MUST NOT BE ABLE TO STOP THE ANCHOR. `anchor-now.js` refuses to anchor if
 *     any entry is already-resolved. As a manual command that is a useful safety catch;
 *     as a daemon it is a denial-of-service with our name on it — one bad entry and every
 *     honest call posted afterwards goes unanchored and therefore unrankable, forever.
 *     Worse, it would give us a deniable way to freeze the tape exactly when it is about
 *     to say something we dislike. Anchoring attests TIME, not validity. So the daemon
 *     anchors everything and records eligibility separately (lib/gate-log.js).
 *
 * (b) A RESOLVER OUTAGE IS NOT A VERDICT. "I could not check" must never collapse into
 *     either "fine" or "cheating". A GitHub 500 that silently passed an entry would let
 *     a caller post pre-settled predictions during an outage; a GitHub 500 that voided an
 *     entry would let an outage destroy an honest call. Both are recorded as `unknown`,
 *     excluded from ranking, and retried next tick.
 *
 * (c) IDLE GAPS ARE BOUNDED, NOT FREE. Anchoring every 60s costs ~0.0072 SOL/day even
 *     with zero activity (1440 tx x 5000 lamports) — about $1.30/day to say "nothing
 *     happened". But dropping idle anchors makes a gap ambiguous between a quiet tape and
 *     a suppressed one, which is the whole game. Compromise: anchor whenever the chain
 *     changed, and force a heartbeat anchor at least every TAPE_IDLE_HEARTBEAT intervals.
 *     A gap longer than that bound is then positive evidence of suppression or downtime,
 *     not a shrug.
 */

const fs = require('fs');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const { buildEntry, entryBytes, newNonce } = require('../lib/entry');
const { Chain } = require('../lib/chain');
const { GateLog } = require('../lib/gate-log');
const { hashLeaf, buildTree, proveInclusion, verifyEntryInclusion } = require('../lib/merkle');
const { submitAnchor, fetchAnchor } = require('../lib/anchor');
const { resolveMarket } = require('../lib/resolve');
const { recordTitle } = require('../lib/market-titles');
const W = require('../lib/windows');

const { DATA_DIR: DATA } = require('../lib/datadir');
const SECURE = path.join(require('os').homedir(), '.config/cadence-secure');

const INTERVAL_SEC = Number(process.env.TAPE_INTERVAL_SEC || 60);
const IDLE_HEARTBEAT = Number(process.env.TAPE_IDLE_HEARTBEAT || 10);

const VOID_MARK = 'VOID FOR RANKING';

/**
 * RPC endpoints, in preference order.
 *
 * WHY A LIST (2026-07-30): this was a single Helius URL, and when that key hit
 * "max usage reached" the daemon could not even read its own balance, so it anchored
 * NOTHING and kept retrying the one endpoint that was guaranteed to fail. Entries were
 * still being accepted at intake, so the tape silently accumulated unanchored rows —
 * which is the one failure this product cannot have, because an unanchored entry has no
 * time guarantee and is therefore unrankable forever.
 *
 * A single upstream is a single point of failure for the whole time guarantee. The
 * verifier already tells outsiders to use "a Solana RPC of their choosing"; the daemon
 * should hold itself to the same standard. Keyless public endpoints are the fallback, not
 * the preference — they are rate-limited, but a rate-limited anchor beats no anchor.
 */
function rpcCandidates() {
  const urls = [];
  try {
    const k = JSON.parse(fs.readFileSync(path.join(SECURE, 'helius.json'), 'utf8'));
    const key = k.api_key || k.key || k.apiKey || Object.values(k).find((v) => typeof v === 'string' && v.length > 20);
    if (key) urls.push(`https://mainnet.helius-rpc.com/?api-key=${key}`);
  } catch { /* no key file is survivable — the public endpoints below still work */ }
  // Order matters and is empirical: publicnode answers reads fine but did NOT land anchor
  // transactions (every send died "block height exceeded" even after the CU fix, i.e. the
  // tx was valid and simply never forwarded to a leader). Reads working is not evidence
  // that writes work — probe reads to pick an endpoint, but order by observed SEND success.
  urls.push('https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com');
  return urls;
}

/**
 * Pick the first endpoint that can actually answer. Probing with getBalance rather than
 * getHealth is deliberate: an exhausted Helius key returns a healthy `ok` to getHealth and
 * -32429 to every call that costs credits, so getHealth would have selected the dead
 * endpoint. Probe with the call the daemon actually depends on.
 */
async function pickRpc(payerPubkey) {
  const tried = [];
  for (const url of rpcCandidates()) {
    try {
      const conn = new Connection(url, 'confirmed');
      await conn.getBalance(payerPubkey);
      if (tried.length) log(`RPC failover: using ${url.replace(/\?api-key=.*/, '?api-key=REDACTED')} after ${tried.length} dead endpoint(s)`);
      return url;
    } catch (e) {
      tried.push(url);
      log(`RPC unusable (${url.replace(/\?api-key=.*/, '?api-key=REDACTED')}): ${String(e.message).slice(0, 80)}`);
    }
  }
  throw new Error(`no usable Solana RPC: all ${tried.length} candidates failed`);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * The machine-written amend that excludes an entry from ranking.
 *
 * `caller` is `tape-gate`, NOT the original caller. Attributing a machine judgement to
 * the human or agent who posted the call would be putting words in their mouth in a
 * record whose entire value is that nobody can put words in anyone's mouth. The note
 * carries the resolution detail so the verdict is re-checkable rather than trusted.
 */
function voidAmend(target, reason) {
  return buildEntry({
    type: 'amend',
    caller: 'tape-gate',
    lane: target.entry.lane,
    market: target.entry.market,
    side: target.entry.side,
    size: target.entry.size,
    entry_ref: target.entry.entry_ref,
    ts_claimed: new Date().toISOString(),
    ref: target.entry_hash,
    nonce: newNonce(),
    note: `${VOID_MARK}: T0.1 — ${reason}`,
  });
}

const voidedSet = (rows) => new Set(
  rows.filter((r) => r.entry.type === 'amend' && String(r.entry.note || '').includes(VOID_MARK))
    .map((r) => r.entry.ref)
);

/** Gate every open prediction that has not already been voided. Mutates the chain only by appending. */
async function runGate(chain, gateLog) {
  const rows = chain.read();
  const voided = voidedSet(rows);
  const verdicts = { eligible: 0, already_resolved: 0, unknown: 0 };

  for (const r of rows) {
    if (r.entry.lane !== 'prediction' || r.entry.type !== 'open') continue;
    if (voided.has(r.entry_hash)) continue;

    let res;
    try {
      res = await resolveMarket(r.entry.market);
    } catch (e) {
      // Rule (b): an outage is not a verdict.
      gateLog.record({ entry_hash: r.entry_hash, verdict: 'unknown', detail: `resolver error: ${e.message}` });
      verdicts.unknown++;
      continue;
    }

    // Cache the human question whenever the resolver hands one back, regardless of verdict — an
    // open market is exactly the case where the receipt is being read and has no title yet.
    if (res.title) { try { recordTitle(r.entry.market, res.title); } catch { /* annotation only */ } }

    if (!res.supported) {
      gateLog.record({ entry_hash: r.entry_hash, verdict: 'unknown', detail: res.detail });
      verdicts.unknown++;
      continue;
    }

    if (res.resolved) {
      // Was it resolved BEFORE we anchored it? If the entry is already covered by an
      // anchor whose slot predates resolution, this is a normal settled call, not a
      // T0.1 violation — it resolved after we committed, which is the system working.
      const covered = anchorCoveringEntry(r.entry_hash, chain);
      const settledAfterAnchor = covered && covered.blockTime && res.at
        && new Date(res.at).getTime() / 1000 > covered.blockTime;

      if (settledAfterAnchor) {
        gateLog.record({ entry_hash: r.entry_hash, verdict: 'eligible',
          detail: `settled ${res.outcome} at ${res.at}, after anchor slot ${covered.slot}` });
        verdicts.eligible++;
        continue;
      }

      gateLog.record({ entry_hash: r.entry_hash, verdict: 'already_resolved', detail: res.detail });
      verdicts.already_resolved++;
      chain.append(voidAmend(r, res.detail));
      log(`GATE VOID seq ${r.seq} ${r.entry.market} — ${res.detail}`);
      continue;
    }

    gateLog.record({ entry_hash: r.entry_hash, verdict: 'eligible', detail: res.detail });
    verdicts.eligible++;
  }
  return verdicts;
}

/**
 * The earliest anchor whose committed leaf count covers this entry's position.
 * Anchors commit `n` = the number of chain rows at anchor time, so an entry at seq S is
 * covered by the first anchor with n > S.
 */
function anchorCoveringEntry(entryHash, chain) {
  const rows = chain.read();
  const seq = rows.findIndex((r) => r.entry_hash === entryHash);
  if (seq < 0) return null;
  const anchors = readAnchors();
  return anchors.find((a) => a.count > seq) || null;
}

const ANCHORS_FILE = path.join(DATA, 'anchors.jsonl');
const readAnchors = () => (fs.existsSync(ANCHORS_FILE)
  ? fs.readFileSync(ANCHORS_FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : []);

async function anchor(chain, payer, conn, cluster) {
  const v = chain.verify();
  if (!v.ok) throw new Error(`chain does not verify: ${JSON.stringify(v.errors)}`);

  const rows = chain.read();
  const tree = buildTree(rows.map((r) => hashLeaf(entryBytes(r.entry))));
  const root = tree.root.toString('hex');

  const before = await conn.getBalance(payer.publicKey);
  const res = await submitAnchor({ root, count: tree.count, chainHead: v.head, payer, cluster });

  // Read it back FROM CHAIN. Comparing our copy to our copy proves nothing.
  const back = await fetchAnchor(res.signature, cluster);
  const match = back.found && back.parsed && back.parsed.root === root
    && back.parsed.n === tree.count && back.parsed.head === v.head && !back.logMismatch;
  if (!match) throw new Error(`round-trip mismatch: ${JSON.stringify(back)}`);

  const last = rows.length - 1;
  if (last >= 0) {
    const ok = verifyEntryInclusion(entryBytes(rows[last].entry), proveInclusion(tree, last), back.parsed.root);
    if (!ok) throw new Error('inclusion proof failed against the on-chain root');
  }

  const after = await conn.getBalance(payer.publicKey);
  const rec = {
    signature: res.signature, slot: res.slot, blockTime: res.blockTime,
    root, count: tree.count, chainHead: v.head, cluster: 'mainnet',
    lamports: before - after,
  };
  fs.appendFileSync(ANCHORS_FILE, JSON.stringify(rec) + '\n');
  log(`ANCHOR slot ${res.slot} n=${tree.count} root ${root.slice(0, 12)}… ` +
      `${(before - after) / LAMPORTS_PER_SOL} SOL  https://solscan.io/tx/${res.signature}`);
  return rec;
}

function writeState(state) {
  fs.writeFileSync(path.join(DATA, 'daemon-state.json'), JSON.stringify(state, null, 2));
}

/**
 * Write a `no_answer` row for every question window that expired untouched.
 *
 * Implemented here rather than imported from bin/windows.js on purpose: that file's
 * helpers call process.exit on a missing key, which is correct for a CLI and fatal for a
 * daemon. A missing board key must degrade to "windows are not swept this tick", never to
 * "the anchor stopped".
 */
function sweepWindows(nowUnix) {
  const keyFile = process.env.TAPE_BOARD_KEY || path.join(SECURE, 'tape-board-key.json');
  // A missing board key must not stop the anchor, but it must not be SILENT either. Moving
  // one file suppressed every no_answer row while daemon-state.json went on reporting
  // healthy — an operator could switch off the one row a caller cannot withhold and leave
  // no local trace of having done it. Externally this is still caught by
  // verify/tape-schedule.mjs (an expired window with no settlement), which is the check
  // that matters; this only makes it visible from the inside as well.
  if (!fs.existsSync(keyFile)) throw new Error(`no board key at ${keyFile} — windows are NOT being swept`);
  const boardKey = Buffer.from(JSON.parse(fs.readFileSync(keyFile, 'utf8')));
  const chain = new Chain(path.join(DATA, 'tape.jsonl'));
  const rows = chain.read().filter((r) => W.isWindowRow(r.entry));
  const settled = new Set(rows
    .filter((r) => ['answer', 'pass', 'no_answer'].includes(r.entry.type))
    .map((r) => r.entry.question_hash));
  let n = 0;
  for (const r of rows) {
    if (r.entry.type !== 'question') continue;
    if (settled.has(r.entry_hash)) continue;
    // STRICTLY past, matching the API's `now > expires_at` refusal exactly. The two used to
    // disagree at the boundary — the API accepted an answer at `now === expires_at` while
    // the sweep already counted it expired — so at that one second a caller could answer a
    // window and be marked silent for it. Two clocks deciding one fact must use one
    // comparison; where they differ, the caller pays.
    if (Number(r.entry.expires_at) >= nowUnix) continue;
    try {
      // Re-checked under the append lock. `settled` above was read before this loop began
      // and the intake API is a separate process writing the same file: between the read
      // and this append, the caller may have answered. Deciding outside the lock is how
      // both rows landed on one window.
      chain.appendIf(
        W.signWindowRow(
          W.buildWindowRow({ type: 'no_answer', question_hash: r.entry_hash, observed_at: nowUnix }),
          boardKey,
        ),
        (fresh) => (fresh.some((x) => W.isWindowRow(x.entry)
          && ['answer', 'pass', 'no_answer'].includes(x.entry.type)
          && x.entry.question_hash === r.entry_hash)
          ? 'settled while the sweep was running' : null),
      );
      n++;
    } catch (e) {
      // A window that got settled underneath us is the system working, not a failure. Any
      // other error still surfaces to the caller of sweepWindows.
      if (!e.precondition) throw e;
    }
  }
  return n;
}

async function tick(ctx) {
  const { chain, gateLog, payer, conn, cluster } = ctx;

  const v = chain.verify();
  if (!v.ok) {
    // The one refusal that IS correct. A chain that does not verify means the local log
    // was tampered with; anchoring it would launder the tamper onto Solana.
    log('HALT — chain does not verify:', JSON.stringify(v.errors));
    writeState({ ...ctx.state, healthy: false, halt: 'chain_verify_failed', errors: v.errors, at: new Date().toISOString() });
    return;
  }

  // Close out expired question windows BEFORE the gate and the anchor, so a non-answer
  // lands in the same tick it became true. This is the one row TAPE writes about a caller
  // without their participation, and it has to run on a timer for the same reason the
  // anchor does: a sweep that only runs when someone remembers produces a record where
  // "nobody declined" and "nobody checked" look identical.
  let sweepError = null;
  try {
    const swept = sweepWindows(Math.floor(Date.now() / 1000));
    if (swept) log(`swept ${swept} expired window(s) -> no_answer`);
  } catch (e) {
    // Never let the sweep block anchoring. Anchoring attests time and must not depend on
    // any other subsystem being healthy — the same reasoning that made the gate advisory.
    // But it is RECORDED in the state file rather than only logged: a subsystem that fails
    // while the health field still says true is a subsystem nobody finds out about.
    sweepError = e.message;
    log(`window sweep failed (continuing to anchor): ${e.message}`);
  }
  ctx.state.sweep_error = sweepError;

  const before = chain.read().length;
  const verdicts = await runGate(chain, gateLog);
  const after = chain.read().length;

  const changed = after !== ctx.state.lastAnchoredCount;
  const idle = ctx.state.idleTicks || 0;
  const due = changed || idle + 1 >= IDLE_HEARTBEAT;

  if (!due) {
    ctx.state.idleTicks = idle + 1;
    writeState({ ...ctx.state, healthy: true, at: new Date().toISOString(), verdicts });
    return;
  }

  const rec = await anchor(chain, payer, conn, cluster);
  ctx.state.idleTicks = 0;
  ctx.state.lastAnchoredCount = rec.count;
  ctx.state.anchors = (ctx.state.anchors || 0) + 1;
  writeState({
    ...ctx.state, healthy: true, at: new Date().toISOString(),
    verdicts, lastAnchor: rec, newEntriesThisTick: after - before,
  });
}

async function main() {
  const once = process.argv.includes('--once');
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.TAPE_KEY || path.join(SECURE, 'tape-anchor-key.json'), 'utf8')))
  );
  const cluster = await pickRpc(payer.publicKey);
  const ctx = {
    chain: new Chain(path.join(DATA, 'tape.jsonl')),
    gateLog: new GateLog(path.join(DATA, 'gate.jsonl')),
    payer, conn: new Connection(cluster, 'confirmed'), cluster,
    state: { startedAt: new Date().toISOString(), idleTicks: IDLE_HEARTBEAT, lastAnchoredCount: -1, anchors: 0 },
  };

  const anchors = readAnchors();
  if (anchors.length) ctx.state.lastAnchoredCount = anchors[anchors.length - 1].count;

  log(`tape daemon up — interval ${INTERVAL_SEC}s, idle heartbeat every ${IDLE_HEARTBEAT} intervals, ` +
      `payer ${payer.publicKey.toBase58()}`);

  const run = async () => {
    try { await tick(ctx); }
    catch (e) {
      // A failed tick must never kill the loop: a dead daemon is a silent gap, and a
      // silent gap is indistinguishable from suppression.
      log('TICK FAILED:', e.message);
      ctx.state.lastError = { message: e.message, at: new Date().toISOString() };
      writeState({ ...ctx.state, healthy: false });

      // pickRpc() used to run once, at startup, only. When the chosen endpoint died mid-run
      // (Helius key hitting "max usage reached" 2026-08-06), every later tick kept retrying
      // the same dead connection forever — anchoring stalled ~35min until a human noticed
      // the ops alert and restarted the process by hand. Re-picking here is the same
      // failover the daemon already trusts at boot, just run again on failure instead of
      // needing a restart to reach it.
      try {
        const fresh = await pickRpc(payer.publicKey);
        if (fresh !== ctx.cluster) {
          log(`RPC re-pick after tick failure: switching to ${fresh.replace(/\?api-key=.*/, '?api-key=REDACTED')}`);
          ctx.cluster = fresh;
          ctx.conn = new Connection(fresh, 'confirmed');
        }
      } catch (pickErr) {
        // All candidates still dead — nothing to switch to. Same as before: log and let
        // the next interval retry.
        log('RPC re-pick failed, all candidates still dead:', pickErr.message);
      }
    }
  };

  await run();
  if (once) return;
  setInterval(run, INTERVAL_SEC * 1000);
}

if (require.main === module) main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

module.exports = { tick, runGate, voidAmend, VOID_MARK };
