'use strict';
/**
 * post-enums.test.js — the write path refuses a malformed call instead of recording it.
 *
 * Written against a real failure, not a hypothetical one. The ZeroClaw agent fills
 * tape_post's arguments from a sentence a human typed into Telegram, and on 2026-08-06 it
 * mapped "NO on polymarket 0x5dc… at 0.5945" onto market="polymarket" and
 * entry_ref="0x5dc…@0.5945" — the market id folded into the price field. Nothing on the
 * write path objected. The tape is append-only, so that row would have been permanent.
 *
 * Every check below is paired with its positive: it is not enough that the bad value is
 * refused, the good value has to still get through, or the guard is just an outage.
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POST = path.join(__dirname, '..', 'bin', 'post.js');

// The positive controls have to get PAST the guard, which means they reach the append.
// TAPE_DATA (lib/datadir.js) sends that append to a throwaway chain — a test suite that
// writes test rows into the real append-only record could never be un-run.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-post-enums-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`ok - ${name}`); pass++; }
  catch (e) { console.log(`not ok - ${name}\n  ${e.message}`); fail++; }
};

// Runs the real CLI against the throwaway chain, so the cases that legitimately pass the
// guard can append without touching the real record.
function run(args) {
  const env = { ...process.env, TAPE_DATA: TMP };
  try {
    return { out: execFileSync('node', [POST, ...args], { encoding: 'utf8', stdio: 'pipe', env }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}

const base = ['--caller', 'test-suite', '--lane', 'prediction', '--market', 'test:enum-guard',
  '--side', 'no', '--size', '1', '--entry_ref', '0.5'];
const swap = (flag, value) => {
  const a = base.slice();
  a[a.indexOf(flag) + 1] = value;
  return a;
};

t('lane outside the closed set is refused, by name', () => {
  const r = run(swap('--lane', 'prediction lane'));
  assert.match(r.out, /refusing to post: lane "prediction lane"/);
  assert.notStrictEqual(r.code, 0, 'a refused post must exit non-zero');
});

t('side outside the closed set is refused, by name', () => {
  const r = run(swap('--side', 'NOPE'));
  assert.match(r.out, /refusing to post: side "NOPE"/);
});

t('entry_ref carrying a market id is refused', () => {
  const r = run(swap('--entry_ref', '0x5dc212b7@0.5945'));
  assert.match(r.out, /entry_ref .* is not a bare decimal string/);
});

// The negative controls. If these ever start matching, the guard has stopped
// discriminating and is refusing everything — which reads identically to "safe".
t('a valid lane is NOT caught by the lane guard', () => {
  const r = run(swap('--market', 'test:enum-guard-lane-ok'));
  assert.doesNotMatch(r.out, /refusing to post: lane/);
});

t('an uppercase side is accepted, not refused — it is normalised, not rejected', () => {
  const r = run(swap('--side', 'NO'));
  assert.doesNotMatch(r.out, /refusing to post: side/);
});

t('a bare decimal entry_ref is NOT caught by the price guard', () => {
  const r = run(swap('--entry_ref', '0.5945'));
  assert.doesNotMatch(r.out, /is not a bare decimal string/);
});

console.log(`1..${pass + fail}\n# pass ${pass}\n# fail ${fail}`);
if (fail) process.exit(1);
