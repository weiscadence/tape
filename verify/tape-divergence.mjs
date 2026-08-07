#!/usr/bin/env node
/**
 * tape-divergence.mjs — prove WHICH entry a broken root is missing.
 *
 * `tape-history.mjs` answers "has this tape been rewritten" and, when the answer is yes,
 * stops there: it names the slot, the committed root, and the root it rebuilt. That is the
 * right place for it to stop — an accusation is not supposed to also supply the excuse.
 *
 * This is the follow-up an operator owes a reader afterwards. Given a candidate row that was
 * removed from the tape, it rebuilds the tree BOTH ways and shows which reading reproduces
 * the root that is actually on Solana. That turns "we say we deleted a junk smoke-test row"
 * into something the reader confirms from published bytes and a chain they can query.
 *
 * WHY THIS IS NOT A WHITELIST. Nothing here is wired into tape-history.mjs and nothing here
 * makes it pass. tape-history.mjs still reports REWRITTEN and still exits 1, on our own
 * tape, forever. A checker taught to forgive the one failure its author caused is decoration.
 * This tool explains a failure; it cannot suppress one.
 *
 * The canonicalizer and leaf hashing are REIMPLEMENTED here rather than imported, for the
 * same reason tape-history.mjs reimplements them: a verifier that shares code with the thing
 * it verifies cannot detect a bug in the shared code.
 *
 * Usage:
 *   node verify/tape-divergence.mjs <tape.jsonl> <removed-row.jsonl> <root-hex> [--n N]
 *
 * Exit: 0 the removed row EXPLAINS the root · 1 it does not · 2 bad input.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha256 = (...bufs) => createHash('sha256').update(Buffer.concat(bufs)).digest();

/* -- canonical bytes: reimplemented, never imported (see header) ----------- */
function canonicalize(value, path = '$') {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return String(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  if (t === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k], `${path}.${k}`)).join(',') + '}';
  }
  throw new Error(`unserializable ${t} at ${path}`);
}

// Domain-separated leaf, and an odd tail is PROMOTED unchanged rather than duplicated. Both
// choices have to match lib/merkle.js exactly or every root disagrees for a reason that has
// nothing to do with the tape — the failure mode tape-history.mjs's own header records.
const hashLeaf = (buf) => sha256(Buffer.from([0x00]), buf);
const hashNode = (l, r) => sha256(Buffer.from([0x01]), l, r);
function merkleRoot(leaves) {
  if (!leaves.length) return sha256(Buffer.from('tape:empty:v1', 'utf8')).toString('hex');
  let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashNode(cur[i], cur[i + 1]) : cur[i]);
    cur = next;
  }
  return cur[0].toString('hex');
}
const leafOf = (entry) => hashLeaf(Buffer.from(canonicalize(entry), 'utf8'));

const readJsonl = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const [tapePath, removedPath, rootHex] = process.argv.slice(2);
if (!tapePath || !removedPath || !rootHex) {
  console.error('usage: tape-divergence.mjs <tape.jsonl> <removed-row.jsonl> <root-hex> [--n N]');
  process.exit(2);
}
const nFlag = process.argv.indexOf('--n');

let rows; let removed;
try {
  rows = readJsonl(tapePath).sort((a, b) => a.seq - b.seq);
  removed = readJsonl(removedPath)[0];
} catch (e) {
  console.error(`could not read input: ${e.message}`);
  process.exit(2);
}
if (!removed || typeof removed.seq !== 'number' || !removed.entry) {
  console.error('removed-row file has no row with a numeric seq and an entry');
  process.exit(2);
}

// The committed leaf count. Taken from --n when given, otherwise assumed to be "everything
// up to and including the removed row's position", which is the only reading under which a
// removal is even the candidate explanation.
const n = nFlag > -1 ? Number(process.argv[nFlag + 1]) : removed.seq + 1;
if (!Number.isInteger(n) || n < 1) { console.error(`--n must be a positive integer, got ${n}`); process.exit(2); }

// As served: the first n rows the tape currently holds.
const served = rows.slice(0, n);
// Restored: everything strictly before the removed row's seq, then the removed row, keeping
// the total at n. The removed row occupied that slot, so it displaces the tail by one.
const restored = [...rows.filter((r) => r.seq < removed.seq), removed].slice(0, n);

const rootServed = merkleRoot(served.map((r) => leafOf(r.entry)));
const rootRestored = merkleRoot(restored.map((r) => leafOf(r.entry)));
const target = String(rootHex).toLowerCase();

const label = (r) => (r === target ? 'MATCHES the anchored root' : 'does not match');
console.log(`anchored root (given)      ${target}`);
console.log(`  n (leaves committed)     ${n}`);
console.log(`rebuilt from tape as-served  ${rootServed}  ${label(rootServed)}`);
console.log(`rebuilt WITH removed seq ${String(removed.seq).padEnd(4)} ${rootRestored}  ${label(rootRestored)}`);
console.log();

if (rootRestored === target && rootServed !== target) {
  const e = removed.entry;
  console.log('EXPLAINED — the anchored root reproduces only with the removed row present.');
  console.log(`The missing entry is seq ${removed.seq}: type=${e.type ?? '?'} caller=${e.caller ?? '?'} `
    + `market=${e.market ?? '?'} ts_claimed=${e.ts_claimed ?? '?'}`);
  console.log('That row was anchored and is no longer served. The divergence is real, and this');
  console.log('names it precisely rather than asking anyone to accept a description of it.');
  process.exit(0);
}
if (rootServed === target) {
  console.log('NOT A DELETION — the tape as served already reproduces this root, so this row');
  console.log('is not what is missing from it. Look elsewhere.');
  process.exit(1);
}
console.log('UNEXPLAINED — neither reading reproduces the anchored root, so the removal of this');
console.log('row is NOT a sufficient account of the divergence. Something else changed too, or');
console.log('--n is wrong. Do not present this row as the explanation.');
process.exit(1);
