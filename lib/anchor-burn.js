'use strict';
/**
 * How fast the anchor payer is spending, and how long it has left.
 *
 * WHY THIS IS A LIBRARY AND NOT TWO COPIES. This logic used to live only inside
 * `bin/doctor.js`, which is a PULL: it answers only when a human chooses to ask. The
 * scheduled watcher (`scripts/tape-health.js`, every 10 min) asserted four things —
 * unanchored backlog, anchor staleness, the supervised process, the daemon's self-report —
 * and none of them was the balance. So the one failure with a KNOWN date on it, the payer
 * running dry, was the one failure nothing was watching for. It would have surfaced as a
 * stale-anchor alert some minutes AFTER anchoring had already stopped, which for a project
 * whose central claim is "the tape is still being anchored right now" is too late: the
 * claim is already false by the time the alarm fires.
 *
 * The fix is a warning with lead time, and the reason it lives here rather than being
 * reimplemented in the watcher is the bug `bin/doctor.js` documents at length: the burn
 * constant was once hardcoded at ~5000 lamports, drifted 2.8x when the daemon started
 * paying a priority fee, and the threshold picked against the wrong constant turned an
 * urgent balance into a soft warning. Two implementations of "what does an anchor cost"
 * is that bug with a second place to hide. One measured implementation, two callers.
 *
 * Everything here is MEASURED from `anchors.jsonl` and the chain. Nothing is assumed. When
 * there is nothing to measure these functions return null, because a runway computed from
 * no data is a guess wearing a number's clothes and the caller must say so out loud.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

/** The RPC every caller should use, so a private endpoint is honoured consistently. */
function rpcUrl() {
  return process.env.SOLANA_RPC_URL || DEFAULT_RPC;
}

function postRpc(url, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function anchorsFile() {
  const { DATA_DIR } = require('./datadir');
  return path.join(DATA_DIR, 'anchors.jsonl');
}

/**
 * What an anchor actually costs, and how fast we spend them — read off the anchor log
 * rather than assumed. Returns null when there is nothing to measure.
 *
 * `lamports` is the MEDIAN, not the mean: one retried or congested anchor at 10x should not
 * move the runway estimate an operator is about to make a funding decision on.
 */
function observedAnchorBurn(windowHours = 24) {
  const file = anchorsFile();
  if (!fs.existsSync(file)) return null;
  const cutoff = Date.now() / 1000 - windowHours * 3600;
  const costs = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!(r.blockTime > cutoff) || !(r.lamports > 0)) continue;
    costs.push(r.lamports);
  }
  if (!costs.length) return null;
  costs.sort((a, b) => a - b);
  return {
    lamports: costs[Math.floor(costs.length / 2)],
    perHour: costs.length / windowHours,
    n: costs.length,
  };
}

/**
 * Who paid for the most recent anchor, according to Solana. Account 0 of a transaction's
 * message is the fee payer, so this is the chain's own answer to "which wallet is funding
 * this tape", independent of whatever key the asking process happened to resolve.
 *
 * This exists because the configured key and the paying key once disagreed silently for
 * days: the doctor reported the balance of a wallet that had been swept empty while the
 * daemon paid from a different one. That produced a confident alarm about a decommissioned
 * wallet — and, in the dangerous direction, meant a genuinely draining payer could not
 * have been reported at all. Check the key that ACTED, not the key that is labelled.
 *
 * Returns null when it cannot tell. A null means "unknown" and must never read as "matches".
 */
async function observedAnchorPayer(url = rpcUrl()) {
  const file = anchorsFile();
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0 && i > lines.length - 5; i--) {
    let sig; try { sig = JSON.parse(lines[i]).signature; } catch { continue; }
    if (!sig) continue;
    try {
      const r = await postRpc(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }],
      });
      const keys = r.result && r.result.transaction && r.result.transaction.message.accountKeys;
      if (keys && keys.length) return keys[0];
    } catch { /* try the one before it */ }
  }
  return null;
}

/**
 * The whole runway question in one call, for a caller that just wants to know whether to
 * shout: who is paying, what they hold, and how many hours that buys at the measured rate.
 *
 * Throws on RPC failure rather than returning a comfortable default. A runway we could not
 * read is UNKNOWN, and the caller must treat unknown as "cannot claim healthy" — the same
 * raw-vs-kept rule the rest of this project runs on. Returning `hours: Infinity` on an RPC
 * error would be the exact shape of a broken zero.
 */
async function anchorRunway(url = rpcUrl()) {
  const payer = await observedAnchorPayer(url);
  if (!payer) {
    // CAREFUL: observedAnchorPayer returns null for two completely different situations,
    // and collapsing them is an unreachable alarm. "No anchors have ever been written" is
    // genuinely nothing to check. "We have anchor signatures but the RPC would not resolve
    // any of them" is UNKNOWN, and a caller that reads unknown as nothing gets a clean bill
    // of health from a dead endpoint.
    //
    // Caught by the negative control on 2026-08-07: pointed at an unroutable RPC, the
    // scheduled watcher printed "TAPE HEALTH OK" and exited 0. The alarm this whole module
    // was added for could not have fired. Distinguish by asking the local log, which needs
    // no network, whether there was anything to resolve in the first place.
    const file = anchorsFile();
    const hasAnchors = fs.existsSync(file)
      && fs.readFileSync(file, 'utf8').split('\n').some((l) => l.trim());
    if (hasAnchors) throw new Error(`RPC would not resolve the payer of any recent anchor (${new URL(url).host})`);
    return null; // nothing anchored yet — the other assertions cover that far more directly
  }

  const r = await postRpc(url, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [payer] });
  const lamports = r.result && r.result.value;
  if (!Number.isFinite(lamports)) {
    throw new Error(`getBalance gave no value: ${JSON.stringify(r.error || r).slice(0, 120)}`);
  }

  const burn = observedAnchorBurn();
  if (!burn) return { payer, lamports, sol: lamports / 1e9, burn: null, anchorsLeft: null, hours: null };

  const anchorsLeft = Math.floor(lamports / burn.lamports);
  // perHour of 0 cannot happen alongside a non-null burn (it is derived from a non-empty
  // sample), but guard anyway rather than emit an Infinity that a threshold would read as fine.
  const hours = burn.perHour > 0 ? anchorsLeft / burn.perHour : null;
  return { payer, lamports, sol: lamports / 1e9, burn, anchorsLeft, hours };
}

module.exports = { rpcUrl, postRpc, observedAnchorBurn, observedAnchorPayer, anchorRunway, DEFAULT_RPC };
