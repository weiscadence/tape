'use strict';
/**
 * gate-log.js — the ranking-eligibility record.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE CHAIN, AND NOT ANCHORED:
 *
 * The daemon's first draft conflated two different things, and the conflation is the
 * kind of bug that only shows up in production: `anchor-now.js` REFUSES to anchor at all
 * if any entry fails the T0.1 gate. That reads as strict, but it is backwards.
 *
 *   Anchoring attests TIME. It does not attest validity.
 *
 * If a bad entry can block the anchor, then one bad entry freezes the whole tape —
 * every honest call posted after it goes unanchored and therefore unrankable. That hands
 * anyone who can post a cheap denial-of-service, and it hands US a deniable way to stall
 * the record whenever it is about to say something we dislike. A record that stops when
 * inconvenient is the exact failure the external clock exists to prevent.
 *
 * So the split is:
 *   - The ANCHOR covers every entry, always, no exceptions. Time is unconditional.
 *   - The GATE decides RANKING eligibility, and lives here.
 *
 * This file is not anchored and does not need to be, because nothing in it is a claim
 * about the past that only we can see: every verdict is re-derivable by a stranger from
 * (market string, resolution source, anchor slot). If we lie here, anyone re-running the
 * resolver catches us. That is a stronger guarantee than committing our own judgement to
 * a chain, which would only prove we said it consistently.
 */

const fs = require('fs');
const path = require('path');

// `unknown` exists so a resolver outage can never be read as a pass. A GitHub 500 must
// not silently promote an unchecked entry into the rankings, and it must not permanently
// condemn an honest one either — it stays unknown and gets retried.
const VERDICTS = new Set(['eligible', 'already_resolved', 'unknown']);

class GateLog {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  }

  /** All verdicts, oldest first. Later rows supersede earlier ones for the same entry. */
  read() {
    return fs.readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  /** Latest verdict per entry_hash. */
  current() {
    const m = new Map();
    for (const r of this.read()) m.set(r.entry_hash, r);
    return m;
  }

  record({ entry_hash, verdict, detail, checked_at }) {
    if (!VERDICTS.has(verdict)) throw new TypeError(`gate-log: unknown verdict ${verdict}`);
    const row = { entry_hash, verdict, detail, checked_at: checked_at || new Date().toISOString() };
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    return row;
  }
}

module.exports = { GateLog, VERDICTS };
