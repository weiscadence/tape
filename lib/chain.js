'use strict';
/**
 * chain.js — the append-only log.
 *
 * HONEST SCOPE, STATED UP FRONT: this file gives TAMPER-EVIDENCE, not immutability.
 * We hold the file; we can rewrite it. A hash chain proves each link follows the last,
 * and it catches edits to history — but a chain rebuilt from scratch is also a valid
 * chain, and a TRUNCATED PREFIX is a valid chain too. That is precisely the "hide what
 * I just did" move.
 *
 * The chain alone therefore proves nothing to a stranger, because the operator is us.
 * What makes it binding is anchor.js: the root of each interval goes on Solana, so the
 * ordering and the timing are attested by a clock we do not control. This file is the
 * local half; it is not sufficient on its own and should never be described as if it is.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalize } = require('./canonical');
const { entryHash, verifyEntrySignature } = require('./entry');
const { isWindowRow, verifyWindowRow } = require('./windows');
const { isPledgeRow, verifyPledgeRow } = require('./pledge');
const { isAttestRow, verifyAttestRow } = require('./attest');

/**
 * Verify a row's signature under the domain of the family it belongs to.
 *
 * Kept as one function so there is exactly one place that decides "which kind of row is
 * this". Two call sites making that decision independently is how one of them ends up
 * checking the wrong domain and quietly accepting, or rejecting, everything.
 */
const verifySignatureForFamily = (entry) => {
  if (isWindowRow(entry)) return verifyWindowRow(entry);
  if (isPledgeRow(entry)) return verifyPledgeRow(entry);
  if (isAttestRow(entry)) return verifyAttestRow(entry);
  return verifyEntrySignature(entry);
};

const GENESIS = '0'.repeat(64);

/**
 * Append lock.
 *
 * WHY: `append()` reads the whole chain to find `prev` and `seq`, then writes. That is a
 * read-modify-write, and the anchoring daemon already writes this file on a timer. The
 * moment a second writer exists (a public intake endpoint), two appends can read the same
 * tail and both claim the same seq with the same prev. The result is not a lost entry, it
 * is a FORKED chain: two rows pointing at one parent, and every verifier downstream
 * reporting tamper on an honest record.
 *
 * `wx` fails if the file exists, which is the atomic primitive we need. The stale check
 * exists because a crashed writer must not wedge the tape forever, and the age threshold
 * is generous: a wrongly-stolen lock reintroduces the exact race this prevents.
 */
const LOCK_STALE_MS = 30000;

function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 15000;
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Age comes from mtime, NOT from the pid/timestamp written inside the file.
      // `wx` creates the file and the body is written a moment later, so a competing
      // process can read a lock that is still EMPTY. The first version treated an
      // unparseable body as proof of a dead holder and stole the lock on the spot,
      // which handed every writer the lock at once and forked the chain under load.
      // mtime exists from the instant of creation, so a brand-new lock reads as new.
      let ageMs;
      try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; }
      catch { continue; } // vanished between open and stat: just retry for it
      if (ageMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(lock); } catch { /* someone else cleared it first */ }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`chain: could not acquire append lock on ${file}`);
      // Busy-wait deliberately: appends are sub-millisecond, so sleeping costs more than
      // spinning, and this path is only reached under genuine contention.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** Hash that links a record to its predecessor: H(prev_link || seq || entry_hash). */
function linkHash(prevLink, seq, eHash) {
  return crypto.createHash('sha256')
    .update(canonicalize({ prev: prevLink, seq: String(seq), entry: eHash }), 'utf8')
    .digest('hex');
}

class Chain {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  }

  read() {
    const raw = fs.readFileSync(this.file, 'utf8');
    return raw.split('\n').filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { throw new Error(`chain: line ${i + 1} is not valid JSON: ${e.message}`); }
    });
  }

  head() {
    const rows = this.read();
    return rows.length ? rows[rows.length - 1] : null;
  }

  /** Append an entry. Returns the stored record. Serialised against other writers. */
  append(entry) {
    return withLock(this.file, () => this._appendLocked(entry));
  }

  /**
   * Append only if `check(rows)` still agrees, evaluated INSIDE the lock against a fresh
   * read. Returns the record, or throws whatever `check` returns as a reason string.
   *
   * WHY THIS EXISTS. `append()` is atomic; the DECISION to append was not. Every caller
   * did the same thing: read the chain, decide, then append. Two writers in different
   * processes both read a window as unsettled, both decided, and both appended — so a
   * caller's `answer` and the daemon's `no_answer` landed on the same window. The chain
   * verified perfectly, because a fork is a link problem and this is a semantic one. The
   * public tally then said the caller went silent while they were holding our signed
   * receipt for the answer. That is the worst class of bug this project can have: the
   * record accusing an honest participant, with our own signature on the accusation.
   *
   * A predicate under the lock is the only shape that closes it, because the two writers
   * are separate OS processes and no in-process guard can see across them.
   */
  appendIf(entry, check) {
    return withLock(this.file, () => {
      const reason = check(this.read());
      if (reason) { const e = new Error(reason); e.precondition = true; throw e; }
      return this._appendLocked(entry);
    });
  }

  _appendLocked(entry) {
    const rows = this.read();
    const prev = rows.length ? rows[rows.length - 1].link : GENESIS;
    const seq = rows.length;
    const eHash = entryHash(entry);

    // A signature that does not verify must never enter the record. Storing it and
    // marking it invalid later would put a forged attribution on the tape permanently,
    // and the tape is the thing that cannot be edited.
    //
    // Two row families share this chain — calls and board-minted window rows — and they
    // sign under DIFFERENT domain prefixes on purpose, so that neither can be replayed as
    // the other. That means the check has to dispatch on family: verifying a window row
    // with the call verifier fails every honest signature, which is how this was found.
    const sigCheck = verifySignatureForFamily(entry);
    if (sigCheck.signed && !sigCheck.ok) throw new Error(`chain: ${sigCheck.reason}`);

    // Replay: an identical entry re-posted by anyone produces an identical hash, so the
    // second copy would be indistinguishable from the first and one of them would be
    // silently unaddressable. Refusing the duplicate also stops a third party lifting
    // someone's signed call and re-posting it as their own — the signature would still
    // verify, because it is a real signature over real bytes.
    if (rows.some((r) => r.entry_hash === eHash)) {
      throw new Error(`chain: entry ${eHash.slice(0, 12)}… is already at seq ${rows.find((r) => r.entry_hash === eHash).seq}`);
    }

    // A close/amend must reference an entry that already exists AND is earlier. Checking
    // this at write time is what stops an exit from being pointed at a position that was
    // opened afterwards — backdating an entry by reordering rather than by clock.
    if (entry.ref !== null) {
      const target = rows.find((r) => r.entry_hash === entry.ref);
      if (!target) throw new Error(`chain: ref ${entry.ref.slice(0, 12)}… not found in chain`);
      if (target.seq >= seq) throw new Error('chain: ref must point backwards');
    }

    const rec = { seq, entry_hash: eHash, prev, link: linkHash(prev, seq, eHash), entry };
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    return rec;
  }

  /**
   * Recompute the whole chain. Returns { ok, count, head, errors[] }.
   * Deliberately reports EVERY broken link rather than stopping at the first, so a
   * tamper report shows the blast radius instead of one symptom.
   */
  verify() {
    const rows = this.read();
    const errors = [];
    let prev = GENESIS;
    rows.forEach((r, i) => {
      if (r.seq !== i) errors.push({ seq: i, error: `seq mismatch: stored ${r.seq}` });
      if (r.prev !== prev) errors.push({ seq: i, error: 'prev does not match previous link' });
      let eHash;
      try {
        eHash = entryHash(r.entry);
      } catch (e) {
        errors.push({ seq: i, error: `entry does not canonicalize: ${e.message}` });
        prev = r.link;
        return;
      }
      if (eHash !== r.entry_hash) errors.push({ seq: i, error: 'entry_hash does not match entry content' });
      const sig = verifySignatureForFamily(r.entry);
      if (sig.signed && !sig.ok) errors.push({ seq: i, error: `signature invalid: ${sig.reason}` });
      if (linkHash(r.prev, r.seq, r.entry_hash) !== r.link) {
        errors.push({ seq: i, error: 'link hash does not match (prev, seq, entry_hash)' });
      }
      prev = r.link;
    });
    return { ok: errors.length === 0, count: rows.length, head: rows.length ? rows[rows.length - 1].link : GENESIS, errors };
  }
}

module.exports = { Chain, linkHash, GENESIS, withLock };
