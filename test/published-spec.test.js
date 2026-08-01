'use strict';
/**
 * published-spec.test.js — the instructions we publish must reproduce the numbers we publish.
 *
 * WHY THIS EXISTS (2026-07-31). Building scorer-version.js I shipped two bugs that reading
 * could not catch and running caught immediately:
 *
 *   1. The source file contained literal NUL bytes. `file` called it `data`, and `grep`
 *      therefore matched NOTHING in it while `sed` and `require` worked normally. A silent
 *      zero living inside the provenance module — any later grep audit of that file would
 *      have come back clean for the wrong reason.
 *   2. The published recompute instruction described SPACE separators while the code used
 *      NUL separators. The scorer_id was not reproducible by anyone outside this machine.
 *      That is the precise failure the feature exists to prevent: a verifier a stranger
 *      cannot reproduce is indistinguishable from proof, and reads as proof.
 *
 * Both are the same root cause — I trusted a reading instead of a run. A rule in a file did
 * not stop it (I have that rule, twice over). A test does, because it fails.
 *
 * These are deliberately cheap and total. They do not check that the scheme is GOOD; they
 * check that what we tell the world is what the code does.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const BIN = path.join(ROOT, 'bin');
const VERIFY = path.join(ROOT, 'verify');

/**
 * Every source file we ship must be text. A NUL byte silently turns grep into a machine that
 * reports zero matches for everything, which is the worst possible failure mode for a project
 * whose whole claim is auditability.
 */
test('no shipped source file contains a NUL byte', () => {
  const dirs = [LIB, BIN, VERIFY];
  const offenders = [];
  let checked = 0;
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(js|mjs)$/.test(name)) continue;
      checked += 1;
      const buf = fs.readFileSync(path.join(dir, name));
      if (buf.includes(0x00)) offenders.push(path.join(path.basename(dir), name));
    }
  }
  // Positive control: if this suite ever stops finding files, the zero above is meaningless.
  assert.ok(checked > 10, `expected to scan >10 source files, scanned ${checked}`);
  assert.deepStrictEqual(offenders, [], `NUL bytes in: ${offenders.join(', ')}`);
});

/**
 * The scorer_id instruction we publish inside every bundle must actually recompute the id.
 * Implemented here FROM THE PUBLISHED WORDING, not by calling scorerId() — calling the
 * function under test to verify the function under test is how the first version passed.
 */
test('published scorer_id instruction reproduces the id it ships with', () => {
  const { sourceBundle } = require('../lib/scorer-version');
  const bundle = sourceBundle();

  // Per the note: sha256(utf8) each file text -> hex; object keyed by filename in ascending
  // order; scorer_id = sha256(utf8) of JSON.stringify of that object.
  const digests = {};
  for (const name of Object.keys(bundle.files).sort()) {
    digests[name] = crypto.createHash('sha256').update(bundle.files[name], 'utf8').digest('hex');
  }
  const recomputed = crypto.createHash('sha256')
    .update(JSON.stringify(digests), 'utf8').digest('hex');

  assert.strictEqual(recomputed, bundle.scorer_id,
    'the published instruction does not reproduce scorer_id — an outside auditor cannot verify us');
  assert.deepStrictEqual(digests, bundle.file_digests,
    'published file_digests disagree with the digests the instruction produces');
});

/**
 * Negative control. The test above can only be trusted if it FAILS when the bundle is wrong,
 * so mutate a byte and require the comparison to break. Without this, a future refactor that
 * made both sides call the same helper would leave a test that passes unconditionally.
 */
test('scorer_id check fails when a source byte changes (negative control)', () => {
  const { sourceBundle } = require('../lib/scorer-version');
  const bundle = sourceBundle();
  const names = Object.keys(bundle.files).sort();
  const tampered = { ...bundle.files, [names[0]]: `${bundle.files[names[0]]}\n// tamper` };

  const digests = {};
  for (const name of Object.keys(tampered).sort()) {
    digests[name] = crypto.createHash('sha256').update(tampered[name], 'utf8').digest('hex');
  }
  const recomputed = crypto.createHash('sha256')
    .update(JSON.stringify(digests), 'utf8').digest('hex');

  assert.notStrictEqual(recomputed, bundle.scorer_id,
    'a modified source produced the same scorer_id — the fingerprint is not sensitive to code');
});

/**
 * The bundle must name every module that can move a markset hash. If score.js grows a new
 * require into ./lib and SOURCES does not know about it, the id stops covering the code and
 * silently goes stale — the hand-maintained-list failure this module exists to avoid.
 */
test('SOURCES covers every lib/ module score.js requires', () => {
  const { SOURCES } = require('../lib/scorer-version');
  const text = fs.readFileSync(path.join(LIB, 'score.js'), 'utf8');
  const required = [...text.matchAll(/require\('\.\/([a-z0-9-]+)'\)/g)].map((m) => `${m[1]}.js`);
  assert.ok(required.length > 0, 'parsed 0 requires from score.js — the regex is broken, not the code');
  const missing = required.filter((f) => !SOURCES.includes(f));
  assert.deepStrictEqual(missing, [],
    `score.js requires ${missing.join(', ')} but scorer-version SOURCES omits them`);
});
