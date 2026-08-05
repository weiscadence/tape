#!/usr/bin/env node
/**
 * schedule-liveness-canary.mjs — is the schedule actually serving the callers inside it?
 *
 * WHY THIS EXISTS. On 2026-08-02 the window driver crashed with rc=1 and the cron wrapper
 * shouted, correctly. But the crash was the END of the failure, not the failure. For the
 * 46 hours before it, the driver had adopted a RETRACTED epoch as the current round and
 * exited 0 every single hour, while the real round sat frozen with two callers enrolled
 * and six questions owed. Every instrument we had was green:
 *
 *   - the chain verified (it was a valid chain; the rows were honestly signed)
 *   - `windows.js check` said SCHEDULE OK (every minted question re-derived correctly —
 *      it audits the questions that EXIST, and cannot miss the ones never minted)
 *   - the driver exited 0 (it did exactly what it was told, on the wrong round)
 *   - the cron wrapper stayed silent (it only speaks on nonzero exit)
 *
 * Not one of them asked the only question a caller cares about: I enrolled, is anything
 * going to happen? That is the gap this closes. It is a READ-SIDE check on the schedule,
 * the same lesson tape-read-canary.mjs learned about receipts — every existing signal
 * watched us writing, none watched whether the thing was any use to the person waiting.
 *
 * WHAT IT ASSERTS
 *   1. the active round is not one that was retracted by a schedule_void
 *   2. no enrolled caller has been waiting past the grace period for their questions
 *   3. the driver is still running at all (sweep_report freshness) — a stopped cron
 *      leaves a perfectly healthy-looking chain behind it
 *
 * THE CONTROL IS THE POINT. A liveness check that has quietly degraded to `exit 0` passes
 * every one of the above forever, which is precisely the failure mode it was written to
 * catch. So --self-test builds the broken chains in memory and requires this checker to
 * SHOUT at each one, plus a healthy chain it must stay quiet about. The self-test runs on
 * EVERY invocation: if a control misbehaves the result is UNTRUSTED (exit 2), never a
 * comfortable pass. An unexercised check is not evidence.
 *
 *   node verify/schedule-liveness-canary.mjs [--grace-hours 6] [--stale-hours 3] [--quiet]
 *   node verify/schedule-liveness-canary.mjs --self-test    # controls only, no real chain
 *
 * exit 0 = schedule is live and serving · 1 = FINDING · 2 = UNTRUSTED (control misbehaved)
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const { Chain } = require(join(HERE, '..', 'lib', 'chain.js'));
const W = require(join(HERE, '..', 'lib', 'windows.js'));
const ed = require(join(HERE, '..', 'lib', 'ed25519.js'));

const HOUR = 3600;

/**
 * The whole check, as a pure function of rows + now. Pure on purpose: the self-test drives
 * this exact function over synthetic chains, so the controls exercise the real logic rather
 * than a re-implementation of it that could drift green while this one rots.
 *
 * Returns an array of findings. Empty means live.
 */
function inspect(rows, now) {
  const w = rows.filter((r) => W.isWindowRow(r.entry)).map((r) => r.entry);
  const findings = [];

  const commits = w.filter((e) => e.type === 'schedule_commit');
  const voided = new Set(w.filter((e) => e.type === 'schedule_void').map((e) => e.epoch));
  const live = commits.filter((e) => !voided.has(e.epoch));

  if (!commits.length) return findings; // nothing has ever been committed; not a liveness claim

  // 1. THE BUG ITSELF. The driver takes the newest commit as the active round. If that
  //    newest commit has been retracted, the driver is steering a round that does not
  //    exist and every real round behind it is frozen.
  const newest = commits[commits.length - 1];
  if (voided.has(newest.epoch)) {
    findings.push(`ACTIVE ROUND IS VOIDED — newest schedule_commit is ${newest.epoch}, `
      + 'which has a schedule_void. The driver will steer this dead round and freeze every live one.');
  }

  // 2. THE HARM. A caller enrolled and enrollment closed. Something is owed to them.
  //    Grace is generous on purpose — the driver advances one phase per hourly run, so a
  //    healthy round legitimately takes a few hours to walk close -> reveal -> ask.
  const graceH = Number(process.env.TAPE_GRACE_HOURS || inspect.graceHours || 6);
  for (const c of live) {
    const closesAt = Number(c.enroll_closes_at);
    if (!Number.isFinite(closesAt) || now <= closesAt) continue; // still open, nothing owed yet
    const of = (type) => w.filter((e) => e.type === type && e.epoch === c.epoch);
    const enrolled = of('enroll').length;
    if (!enrolled) continue; // an empty round owes nobody anything; the driver hands it off

    const minted = of('question').length;
    const expected = enrolled * Number(c.windows_per_caller || 0);
    const waitedH = (now - closesAt) / HOUR;
    if (minted < expected && waitedH > graceH) {
      findings.push(`${c.epoch}: ${enrolled} caller(s) enrolled and waiting ${waitedH.toFixed(1)}h `
        + `past enrollment close — ${minted} of ${expected} question(s) minted. The round is stalled.`);
    }
  }

  // 3. IS THE DRIVER EVEN RUNNING. A cron that stopped leaves a chain that verifies
  //    perfectly, forever. Absence of new evidence is the one thing a chain cannot show
  //    you by looking at what is in it, so it has to be checked against the clock.
  const staleH = Number(process.env.TAPE_STALE_HOURS || inspect.staleHours || 3);
  const sweeps = w.filter((e) => e.type === 'sweep_report');
  if (sweeps.length) {
    const last = Math.max(...sweeps.map((e) => Number(e.swept_at) || 0));
    const agoH = (now - last) / HOUR;
    if (agoH > staleH) {
      findings.push(`DRIVER SILENT — last sweep_report was ${agoH.toFixed(1)}h ago `
        + `(threshold ${staleH}h). The schedule is not being driven.`);
    }
  }

  return findings;
}

/* ---------------------------------------------------------------------------------------
 * CONTROLS. Each builds a chain in a scratch dir and asserts what inspect() must say.
 * A control that does not behave means the checker cannot be trusted about the real chain.
 * ------------------------------------------------------------------------------------ */

const mkKey = () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  const sk = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pk = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Buffer.concat([sk, pk]);
};
const boardKey = mkKey();

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'tape-liveness-'));
  const chain = new Chain(join(dir, 'tape.jsonl'));
  return {
    dir,
    chain,
    put: (row, key = boardKey) => chain.append(W.signWindowRow(W.buildWindowRow(row), key)),
  };
}

const commitRow = (epoch, closesAt) => ({
  type: 'schedule_commit',
  epoch,
  seed_commit: crypto.randomBytes(32).toString('hex'),
  catalog_hash: crypto.randomBytes(32).toString('hex'),
  enroll_closes_at: closesAt,
  windows_per_caller: 3,
});

const enrollRow = (epoch) => ({
  type: 'enroll',
  epoch,
  caller: 'canary-control',
  ts_claimed: new Date().toISOString(),
  nonce: crypto.randomBytes(16).toString('hex'),
});

function selfTest(quiet) {
  const now = Math.floor(Date.now() / 1000);
  const say = (...a) => { if (!quiet) console.log(...a); };
  const results = [];
  const control = (name, build, expect) => {
    const s = scratch();
    try {
      build(s, now);
      const found = inspect(s.chain.read(), now);
      const ok = expect(found);
      results.push({ name, ok, found });
      say(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      got: ${JSON.stringify(found)}`}`);
    } catch (err) {
      // A control that cannot even be BUILT is the loudest possible UNTRUSTED signal — it
      // means this file's idea of a chain row has drifted from lib/windows.js and the
      // "passing" controls above may be testing a shape that no longer exists. Letting the
      // throw escape would have exited nonzero with a stack trace, which reads like a real
      // finding about the schedule. It is not; it is the checker being broken.
      results.push({ name, ok: false, found: [`control threw: ${err.message}`] });
      say(`  ✗ ${name}\n      control threw: ${err.message}`);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  };

  // POSITIVE: the exact 2026-08-02 shape. A live round frozen behind a voided newer commit.
  control('shouts when the newest commit is voided', (s, n) => {
    s.put(commitRow('2026-W34', n - 30 * HOUR));
    s.put(enrollRow('2026-W34'), mkKey());
    s.put(commitRow('BOGUS-EPOCH-XX', n - 2 * HOUR));
    s.put({ type: 'schedule_void', epoch: 'BOGUS-EPOCH-XX', reason: 'control: retracted by appending' });
    s.put({ type: 'sweep_report', swept_at: n - 60, questions_seen: 0, expired_written: 0, open_now: 0 });
  }, (f) => f.some((x) => /ACTIVE ROUND IS VOIDED/.test(x)));

  // POSITIVE: callers left waiting. Stated separately because a checker could catch the
  // voided epoch by luck while being blind to the harm that made it matter.
  control('shouts when enrolled callers are waiting past grace', (s, n) => {
    s.put(commitRow('2026-W34', n - 30 * HOUR));
    s.put(enrollRow('2026-W34'), mkKey());
    s.put({ type: 'sweep_report', swept_at: n - 60, questions_seen: 0, expired_written: 0, open_now: 0 });
  }, (f) => f.some((x) => /waiting .*past enrollment close/.test(x)));

  // POSITIVE: the cron stopped. The chain is still perfectly valid.
  control('shouts when the driver has gone silent', (s, n) => {
    s.put(commitRow('2026-W35', n + 10 * HOUR));
    s.put({ type: 'sweep_report', swept_at: n - 9 * HOUR, questions_seen: 0, expired_written: 0, open_now: 0 });
  }, (f) => f.some((x) => /DRIVER SILENT/.test(x)));

  // NEGATIVE: a healthy schedule must be quiet. Without this every assertion above is
  // satisfied by a checker that simply complains about everything.
  control('stays quiet on a healthy open round', (s, n) => {
    s.put(commitRow('2026-W35', n + 10 * HOUR));
    s.put(enrollRow('2026-W35'), mkKey());
    s.put({ type: 'sweep_report', swept_at: n - 60, questions_seen: 0, expired_written: 0, open_now: 0 });
  }, (f) => f.length === 0);

  // NEGATIVE: a round with zero enrollees owes nobody. Flagging it would train us to
  // ignore this canary, which is the same as not having one.
  control('stays quiet on an expired round nobody enrolled in', (s, n) => {
    s.put(commitRow('2026-W35', n - 30 * HOUR));
    s.put({ type: 'sweep_report', swept_at: n - 60, questions_seen: 0, expired_written: 0, open_now: 0 });
  }, (f) => f.length === 0);

  // NEGATIVE: a served round is not a stalled one, however long ago it closed.
  control('stays quiet once the owed questions are minted', (s, n) => {
    s.put(commitRow('2026-W34', n - 30 * HOUR));
    s.put(enrollRow('2026-W34'), mkKey());
    s.put({ type: 'enrollment_close', epoch: '2026-W34', enrolled_root: crypto.randomBytes(32).toString('hex'), enrolled_count: 1 });
    for (let i = 0; i < 3; i += 1) {
      s.put({
        type: 'question', epoch: '2026-W34', caller_key: ed.publicKeyOf(mkKey()),
        window_index: i, market: `pyth:ETH/USD:higher_at_${n + 10 * HOUR}_than_${n - HOUR}`,
        opens_at: n - HOUR, expires_at: n + 10 * HOUR,
      });
    }
    s.put({ type: 'sweep_report', swept_at: n - 60, questions_seen: 3, expired_written: 0, open_now: 3 });
  }, (f) => f.length === 0);

  return results;
}

function main(argv) {
  const quiet = argv.includes('--quiet');
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : Number(argv[i + 1]); };
  inspect.graceHours = flag('grace-hours', 6);
  inspect.staleHours = flag('stale-hours', 3);

  if (!quiet) console.log('\ncontrols (a check that cannot fail is not a check)');
  const controls = selfTest(quiet);
  const broken = controls.filter((c) => !c.ok);
  if (broken.length) {
    console.log(`\n🟡 UNTRUSTED — ${broken.length} control(s) misbehaved: ${broken.map((c) => c.name).join('; ')}`);
    console.log('   The schedule was NOT checked. This is not a pass.');
    return 2;
  }
  if (argv.includes('--self-test')) {
    if (!quiet) console.log(`\n${controls.length} controls behaved. Checker is exercised.`);
    return 0;
  }

  const CHAIN = process.env.TAPE_CHAIN || join(HERE, '..', 'data', 'tape.jsonl');
  const rows = new Chain(CHAIN).read();
  // --now replays a past state. This is how the canary was shown to catch the real
  // 2026-08-02 incident rather than only the synthetic version of it in the controls:
  // point it at a chain prefix and the wall clock of the hours it stayed silent.
  const findings = inspect(rows, flag('now', Math.floor(Date.now() / 1000)));

  if (findings.length) {
    console.log(`\n🔴 TAPE schedule liveness: ${findings.length} finding(s)`);
    for (const f of findings) console.log(`  - ${f}`);
    return 1;
  }
  if (!quiet) console.log('\n🟢 schedule is live — active round stands, nobody is waiting past grace, driver is running.');
  return 0;
}

process.exitCode = main(process.argv.slice(2));
