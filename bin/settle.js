#!/usr/bin/env node
'use strict';
/**
 * settle.js — auto-close prediction positions from the market's OWN resolution.
 *
 * The point Jiggy asked for: settlement is out of our hands. The outcome comes from
 * Polymarket/UMA (or Pyth for price markets) via lib/resolve.js; we only transcribe it into an
 * anchored `close`. That transcription is verifiable — a wrong settle is provably wrong against
 * the source, and the score engine takes only the FIRST close per position (double_close is an
 * anomaly), so an honest close posted here can't be overwritten by a fake one later.
 *
 * A close references the open by entry_hash (`ref`), so it attaches to the position regardless
 * of who signs it; that is what lets an automated settler close a human's miniapp call without
 * holding their key. `entry_ref` carries the resolved YES-price: 1.00 if YES happened, 0.00 if
 * not. Anchoring is left to the existing anchor cron.
 *
 *   node bin/settle.js --dry-run   # print what WOULD close, write nothing
 *   node bin/settle.js             # post the closes
 */

const path = require('path');
const { Chain } = require('../lib/chain');
const { resolveMarket } = require('../lib/resolve');
const { buildEntry, newNonce } = require('../lib/entry');
const { DATA_DIR: DATA } = require('../lib/datadir');

const DRY = process.argv.includes('--dry-run');
const chain = new Chain(path.join(DATA, 'tape.jsonl'));

async function main() {
  const rows = chain.read();
  const closedRefs = new Set(rows.filter((r) => r.entry && r.entry.type === 'close' && r.entry.ref).map((r) => r.entry.ref));
  // A row was amended => VOID FOR RANKING (lib/score.js). Closing a voided open would
  // resurrect a claim its own author already withdrew, so amended opens are skipped.
  const amendedRefs = new Set(rows.filter((r) => r.entry && r.entry.type === 'amend' && r.entry.ref).map((r) => r.entry.ref));

  // SELECT BY RESOLVABILITY, NOT BY LANE (fixed 2026-08-19).
  // This used to require `lane === 'prediction'`. But `lane` is a CLASSIFICATION the poster
  // chooses, while resolvability is a property of the MARKET ID — and the two disagree in
  // practice: the alpha bridge tags a Polymarket sports market `memecoin` (it came from a
  // volume-spike scanner), so 5 perfectly settleable binary markets were invisible to the
  // settler and would have sat open forever. An open that cannot close never records a loss;
  // filtering on a human-chosen label rather than the machine-checkable id is exactly how that
  // happens quietly. resolveMarket() is already the authority on what it can read — ask it, and
  // let `unsupported` (not a lane guess) be the thing that excludes a row.
  const opens = rows.filter((r) => r.entry && r.entry.type === 'open'
    && !closedRefs.has(r.entry_hash) && !amendedRefs.has(r.entry_hash));

  let checked = 0; let closed = 0; let unresolved = 0; let unsupported = 0;
  for (const r of opens) {
    const e = r.entry; checked++;
    let res;
    try { res = await resolveMarket(e.market); } catch (err) { unresolved++; continue; }
    if (!res || !res.supported) { unsupported++; continue; }
    if (!res.resolved) { unresolved++; continue; }

    const settle = res.outcome === 'yes' ? '1.00' : '0.00';
    if (DRY) { console.log(`WOULD CLOSE seq ${r.seq}  ${e.caller}  ${e.side}  ${e.market.slice(0, 46)} → ${res.outcome} (settle ${settle})`); closed++; continue; }
    try {
      const close = buildEntry({
        // Carry the OPEN's own lane. Hardcoding 'prediction' here would make the close
        // disagree with the open it references — one position described two ways.
        type: 'close', caller: e.caller, lane: e.lane, market: e.market, side: e.side,
        size: e.size, entry_ref: settle, ts_claimed: new Date().toISOString(),
        ref: r.entry_hash, nonce: newNonce(),
        note: `auto-closed from market resolution (${res.outcome})`,
      });
      chain.append(close);
      closed++;
      console.log(`CLOSED seq ${r.seq}  ${e.caller} → ${res.outcome}`);
    } catch (err) { console.error(`close failed seq ${r.seq}: ${err.message}`); }
  }
  console.log(`settle: ${checked} open checked · ${closed} ${DRY ? 'would close' : 'closed'} · ${unresolved} not-yet-resolved · ${unsupported} unsupported`);
}

main().catch((e) => { console.error('settle failed:', e.message); process.exit(1); });
