'use strict';
/**
 * schedule-verifier.test.js — can the schedule verifier say we cheated?
 *
 * WHY THIS FILE EXISTS. `verify/tape-schedule.mjs` printed VERIFIED against the live tape
 * on its first run. That is exactly what a verifier that checks nothing prints. A checker
 * is only evidence if it has been exercised in the state it claims to detect, and the
 * whole project has a recurring bug of the same shape: a zero that was never proven to be
 * a zero. So every detector in that file gets a hostile fixture here, and each one must
 * come back MISMATCH with a non-zero exit.
 *
 * The fixture is a REAL epoch captured from production, mutated one field at a time. Real
 * data matters: a hand-built fixture only proves the verifier rejects hand-built fixtures.
 * The unmutated copy is checked too — a suite where every case fails would also pass if the
 * verifier simply refused everything.
 *
 * The verifier is spawned as a subprocess against a throwaway HTTP server, the same way a
 * stranger runs it. Nothing here imports it, because a verifier tested through its own
 * internals is tested by the code under test.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Async on purpose. execFileSync BLOCKS THE EVENT LOOP, and the fixture server below lives
 * in this same process — so a synchronous spawn deadlocks: the verifier waits for an HTTP
 * response the blocked loop can never send. It hung for two minutes rather than failing,
 * which is the worse of the two ways to be wrong.
 */
const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, args, { encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
    resolve({ code: err ? (err.code ?? 1) : 0, out: (stdout || '') + (stderr || '') });
  });
});

const FIXTURE = require('./fixtures/window-epoch.json');
const VERIFIER = path.join(__dirname, '..', 'verify', 'tape-schedule.mjs');

let pass = 0, fail = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);
// Headers are queued alongside the cases: the cases are deferred, so a bare console.log
// here would print every section title before the first test ran.
const section = (title) => cases.push([title, null]);

const clone = () => JSON.parse(JSON.stringify(FIXTURE));
const windowRows = (fx) => fx.entries.filter((r) => r.entry && r.entry.p === 'tape-window');
const rowOf = (fx, type, i = 0) => windowRows(fx).filter((r) => r.entry.type === type)[i];

/**
 * Serve one fixture and run the verifier against it, exactly as a stranger would.
 *
 * The bind is awaited rather than spun on. An earlier version busy-waited for
 * server.address(), which can never succeed: listen() needs the event loop to turn and the
 * spin is what stops it turning. Every case failed identically, which is at least the
 * honest way for a broken harness to fail.
 */
async function verdictFor(fixture) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fixture));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await run([VERIFIER, '--api', `http://127.0.0.1:${port}`]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const expectMismatch = async (fixture, matcher) => {
  const r = await verdictFor(fixture);
  assert.strictEqual(r.code, 1, `expected exit 1 (MISMATCH), got ${r.code}:\n${r.out}`);
  assert.match(r.out, /MISMATCH/, r.out);
  if (matcher) assert.match(r.out, matcher, r.out);
};

section('-- CONTROL: the untouched record must pass');

t('the real captured epoch verifies', async () => {
  const r = await verdictFor(clone());
  assert.strictEqual(r.code, 0, `expected VERIFIED, got exit ${r.code}:\n${r.out}`);
  assert.match(r.out, /VERIFIED/);
});

section('-- each detector, exercised in its firing state');

t('a question swapped for a different asset is caught', async () => {
  // The headline cheat: ask the caller something easier than the derivation says.
  const fx = clone();
  const q = rowOf(fx, 'question');
  const p = /^pyth:([A-Z]+\/[A-Z]+):higher_at_(\d+)_than_(\d+)$/.exec(q.entry.market);
  const other = p[1] === 'SOL/USD' ? 'BTC/USD' : 'SOL/USD';
  q.entry.market = `pyth:${other}:higher_at_${p[2]}_than_${p[3]}`;
  await expectMismatch(fx, /WAS NOT DERIVED, IT WAS CHOSEN/);
});

t('a question with a different horizon than derived is caught', async () => {
  const fx = clone();
  const q = rowOf(fx, 'question');
  const p = /^pyth:([A-Z]+\/[A-Z]+):higher_at_(\d+)_than_(\d+)$/.exec(q.entry.market);
  const opens = Number(p[3]);
  const horizon = Number(p[2]) - opens;
  const flipped = horizon === 86400 ? 604800 : 86400;
  q.entry.market = `pyth:${p[1]}:higher_at_${opens + flipped}_than_${opens}`;
  await expectMismatch(fx, /WAS NOT DERIVED, IT WAS CHOSEN/);
});

t('a seed that does not open the commitment is caught', async () => {
  const fx = clone();
  rowOf(fx, 'seed_reveal').entry.seed = 'a'.repeat(64);
  await expectMismatch(fx, /does not open the commitment/);
});

t('a caller who is silently spared a window is caught', async () => {
  // Completeness. This passes every per-question derivation check ever written, because
  // the questions that remain are all genuine — it is the missing one that is the cheat.
  const fx = clone();
  const drop = rowOf(fx, 'question', 1).entry_hash;
  fx.entries = fx.entries.filter((r) => r.entry_hash !== drop);
  fx.chain_entries -= 1;
  await expectMismatch(fx, /minted unevenly/);
});

t('an enrolment slipped in after the set was frozen is caught', async () => {
  const fx = clone();
  const enroll = rowOf(fx, 'enroll');
  // Moved past every existing row rather than to close.seq + 1: seqs are unique on a real
  // chain, and colliding two of them makes the pager see one row fewer than the tape claims
  // and correctly refuse the whole read. The mutation has to stay a plausible chain.
  enroll.seq = Math.max(...fx.entries.map((r) => r.seq)) + 1;
  await expectMismatch(fx, /AFTER enrolment closed/);
});

t('a seed revealed before the enrolled set was frozen is caught', async () => {
  const fx = clone();
  const close = rowOf(fx, 'enrollment_close');
  const reveal = rowOf(fx, 'seed_reveal');
  [close.seq, reveal.seq] = [reveal.seq, close.seq];
  await expectMismatch(fx, /out of order/);
});

t('an enrolled_root that does not match the enroll rows is caught', async () => {
  const fx = clone();
  rowOf(fx, 'enrollment_close').entry.enrolled_root = 'b'.repeat(64);
  await expectMismatch(fx, /does not match the enroll rows/);
});

t('a second schedule_commit for one epoch is caught', async () => {
  // Reissuing the commitment means picking whichever seed produced nicer questions.
  const fx = clone();
  const commit = rowOf(fx, 'schedule_commit');
  const dupe = JSON.parse(JSON.stringify(commit));
  dupe.seq = commit.seq + 1000;
  dupe.entry_hash = 'c'.repeat(64);
  fx.entries.push(dupe);
  fx.chain_entries += 1;
  await expectMismatch(fx, /not a commitment/);
});

t('an expired window the board never settled is caught', async () => {
  // The no_answer row is the one a caller cannot withhold. If the board withholds it
  // instead, the silence leaves no trace and the record looks clean.
  const fx = clone();
  const settled = windowRows(fx).filter((r) => r.entry.type === 'no_answer').map((r) => r.entry_hash);
  assert.ok(settled.length, 'fixture must contain a no_answer row for this case to mean anything');
  fx.entries = fx.entries.filter((r) => r.entry_hash !== settled[0]);
  fx.chain_entries -= 1;
  await expectMismatch(fx, /did not write the row the caller cannot withhold/);
});

t('a no_answer forged by someone other than the board is caught', async () => {
  const fx = clone();
  const na = windowRows(fx).find((r) => r.entry.type === 'no_answer');
  na.entry.signer = rowOf(fx, 'question').entry.caller_key;   // the caller writing their own silence
  await expectMismatch(fx, /has standing to write it|does not verify/);
});

t('a tampered signature is caught', async () => {
  const fx = clone();
  const q = rowOf(fx, 'question');
  q.entry.expires_at = String(Number(q.entry.expires_at) + 3600);   // signed field, moved
  await expectMismatch(fx, /does not verify/);
});

t('a settlement row for a question that is not on the tape is caught', async () => {
  const fx = clone();
  const na = windowRows(fx).find((r) => r.entry.type === 'no_answer');
  na.entry.question_hash = 'd'.repeat(64);
  await expectMismatch(fx, /never published/);
});

section('-- UNKNOWN is not VERIFIED');

t('a truncated tape is UNKNOWN, not a pass', async () => {
  // The silent-zero failure in its purest form: a verdict over a subset that reads as a
  // verdict over the record.
  const fx = clone();
  fx.chain_entries = fx.entries.length + 50;
  const r = await verdictFor(fx);
  assert.strictEqual(r.code, 2, `expected exit 2 (UNKNOWN), got ${r.code}:\n${r.out}`);
  assert.match(r.out, /UNKNOWN/);
  assert.match(r.out, /paging stalled|could not be walked/);
});

t('a question minted after its own window shut is caught', async () => {
  // W1: the cheat that survives every derivation check. The asset and horizon are exactly
  // what the seed derives; only the clock is a lie, and the clock is not derived from
  // anything. Caught by the anchor block time, which comes from validators we do not run.
  const fx = clone();
  const q = rowOf(fx, 'question');
  assert.ok(q.anchor && q.anchor.block_time, 'fixture question must be anchored for this to mean anything');
  const p = /^pyth:([A-Z]+\/[A-Z]+):higher_at_(\d+)_than_(\d+)$/.exec(q.entry.market);
  const opens = q.anchor.block_time - 7 * 86400;
  q.entry.opens_at = String(opens);
  q.entry.expires_at = String(opens + 3600);
  q.entry.market = `pyth:${p[1]}:higher_at_${opens + (Number(p[2]) - Number(p[3]))}_than_${opens}`;
  await expectMismatch(fx, /minted already dead|already knowable/);
});

t('an unreachable API is UNKNOWN, not a pass', async () => {
  const r = await run([VERIFIER, '--api', 'http://127.0.0.1:1']);
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /UNKNOWN/);
});

t('an epoch with no minted questions is UNKNOWN, not VERIFIED', async () => {
  const fx = clone();
  const qs = windowRows(fx).filter((r) => ['question', 'no_answer'].includes(r.entry.type))
    .map((r) => r.entry_hash);
  fx.entries = fx.entries.filter((r) => !qs.includes(r.entry_hash));
  fx.chain_entries -= qs.length;
  const r = await verdictFor(fx);
  assert.strictEqual(r.code, 2, `expected UNKNOWN, got ${r.code}:\n${r.out}`);
  assert.match(r.out, /nothing was re-derived/);
});

(async () => {
  for (const [name, fn] of cases) {
    if (!fn) { console.log(`\n${name}`); continue; }
    try { await fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
