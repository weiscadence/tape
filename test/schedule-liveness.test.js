'use strict';
/**
 * schedule-liveness.test.js — keep the liveness canary's own controls honest at dev time.
 *
 * The canary self-tests on every invocation and reports UNTRUSTED if a control misbehaves,
 * so production is already guarded. But that guard only fires ONCE THE DRIFT HAS SHIPPED,
 * an hour later, in the cron channel. If lib/windows.js changes a row schema — which is
 * exactly what broke two of these controls while they were being written — the suite
 * should say so before the commit lands, not after.
 *
 * Deliberately thin: it asserts the controls behave, not what they assert. Restating their
 * expectations here would give us two definitions of liveness and one of them would rot.
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const CANARY = path.join(__dirname, '..', 'verify', 'schedule-liveness-canary.mjs');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};

console.log('\nthe liveness canary is exercised, not merely present');

t('every control behaves — positives shout, negatives stay quiet', () => {
  // --self-test never touches the real chain, so this is safe in any environment.
  const out = execFileSync(process.execPath, [CANARY, '--self-test'], { encoding: 'utf8' });
  assert.ok(/controls behaved/.test(out), `controls did not all behave:\n${out}`);
  assert.ok(!/UNTRUSTED/.test(out), `canary reported UNTRUSTED:\n${out}`);
});

t('a misbehaving control is reported as UNTRUSTED, not as a clean pass', () => {
  // The failure mode this whole file exists for: if the controls break, the canary must
  // refuse to answer rather than answer comfortably. Forced here by making the grace
  // period absurd, which breaks the "shouts when callers are waiting" positive control.
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [CANARY, '--self-test', '--grace-hours', '100000'],
      { encoding: 'utf8', env: { ...process.env, TAPE_GRACE_HOURS: '100000' } });
  } catch (err) { out = `${err.stdout || ''}${err.stderr || ''}`; code = err.status; }
  assert.strictEqual(code, 2, `expected exit 2 UNTRUSTED, got ${code}:\n${out}`);
  assert.ok(/UNTRUSTED/.test(out), `expected an UNTRUSTED report:\n${out}`);
  assert.ok(/NOT checked/.test(out), `UNTRUSTED must say the schedule was not checked:\n${out}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
