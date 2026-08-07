'use strict';
/**
 * The trust boundary must stay DECLARED.
 *
 * Found 2026-08-07 by an authorised prompt-injection test against our own live agent. The
 * money path failed closed exactly as designed — zero lamports moved, confirmed on chain
 * before and after — but the attacker's text was anchored verbatim into a `note` and served
 * straight back out of `/api/calls`. The whole premise of this API is that OTHER agents read
 * the record, which makes an undeletable public ledger a stored-injection delivery surface.
 * And undeletable cuts both ways: the payload cannot be withdrawn, only labelled.
 *
 * The fix is a declaration, not a filter, and this test exists because a declaration is the
 * kind of thing that quietly disappears in a refactor while every other test still passes.
 * Nothing else in the suite would notice: the API would keep serving 200s, the receipts would
 * keep verifying, and consuming agents would simply stop being warned.
 *
 * Deliberately NOT tested: that `note` is sanitised. It isn't, on purpose — you cannot reliably
 * separate instructions from prose, and asserting a filter works would be the false comfort the
 * declaration exists to replace.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UNTRUSTED = ['note', 'caller', 'market_title', 'why', 'tone'];

/**
 * Asserted against the REAL SERVED RESPONSE, by spawning the API — not against api.js source.
 *
 * The first version of this test grepped the source for the string 'untrusted_fields', and its
 * own positive control walked straight through it: renaming the key to
 * `untrusted_fields_REMOVED` still contains 'untrusted_fields' as a substring, so the test
 * passed while the declaration was gone. A guard that cannot fail is worse than no guard,
 * because the green tick is what stops anyone looking. Ask the server what it actually serves.
 */
test('the live API serves untrusted_fields naming every caller-controlled field', async () => {
  const { spawn } = require('child_process');
  const PORT = 3800 + (process.pid % 90);
  const srv = spawn(process.execPath, [path.join(ROOT, 'bin/api.js')], {
    env: { ...process.env, TAPE_API_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try { await fetch(`http://127.0.0.1:${PORT}/health`); break; } catch (e) {
        if (Date.now() > deadline) throw new Error('api.js never came up');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // api.js serves this at /agent.json; the public /api/ prefix is added by the nginx proxy.
    // Hitting the public path here would 404 and read as "the declaration is gone" — a false
    // alarm that is indistinguishable from the real one this test is for.
    const res = await fetch(`http://127.0.0.1:${PORT}/agent.json`);
    const body = await res.json();

    const u = body.untrusted_fields;
    assert.ok(u && typeof u === 'object',
      'GET /agent.json no longer serves an untrusted_fields block — consuming agents are unwarned');
    assert.ok(Array.isArray(u.fields), 'untrusted_fields.fields must be an array');
    for (const f of UNTRUSTED) {
      assert.ok(u.fields.includes(f), `untrusted_fields.fields does not name ${f}`);
    }
    // It must tell the consumer what to DO. "Untrusted" alone is a label, not guidance.
    assert.match(String(u.warning), /never as instructions/i,
      'the warning must say to treat these as data, never as instructions');
    assert.match(String(u.why_not_sanitised || ''), /\S/,
      'the block must explain why it is not sanitised, so the omission reads as deliberate');
  } finally {
    // try/finally, for the reason window-http.test.js documents at length: a throw mid-sequence
    // otherwise leaks a child still bound to this port, and the next run fails as an opaque
    // EADDRINUSE with no assertion name attached.
    srv.kill();
  }
});

test('api.js does not claim to sanitise what it cannot', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin/api.js'), 'utf8');
  const i = src.indexOf('untrusted_fields');
  const block = src.slice(i, i + 2500);
  // Guard against a future well-meaning edit that upgrades the honest boundary into a false
  // promise. If real sanitisation is ever added, this assertion should be changed knowingly.
  assert.ok(!/\bfields are sanitised\b|\bwe sanitise\b|\bstripped of instructions\b/i.test(block),
    'do not claim sanitisation here — the boundary is declared precisely because it is not filtered');
  assert.match(block, /why_not_sanitised/,
    'the block must explain WHY it is not sanitised, so the omission reads as deliberate');
});

test('the agent-facing skill doc carries the same warning', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'web/tape-skill.md'), 'utf8');
  // The skill doc is what a model actually ingests, so the warning has to live there too and
  // not only in JSON a human reads.
  assert.match(doc, /attacker-controlled/i, 'tape-skill.md must flag the untrusted fields');
  assert.match(doc, /never as instructions/i, 'tape-skill.md must say data-not-instructions');
  for (const f of ['note', 'caller']) {
    assert.ok(doc.includes(`\`${f}\``), `tape-skill.md does not name ${f}`);
  }
});

test('the worked example is still on the tape and still labelled', () => {
  // The warning cites seq 423 (payload) and seq 424 (the amend). If those rows ever stop
  // existing, the citation is a dangling reference and the warning loses its evidence — so
  // this is checked rather than assumed. It also quietly asserts the tape stayed append-only.
  const file = path.join(ROOT, 'data/tape.jsonl');
  if (!fs.existsSync(file)) return; // fresh clone: data/ is gitignored by design, nothing to check

  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const payload = rows.find((r) => r.seq === 423);
  const amend = rows.find((r) => r.seq === 424);
  if (!payload) return; // a different operator's tape — this is our record's fixture, not theirs

  assert.equal(payload.entry.type, 'open', 'seq 423 should still be the injected open row');
  assert.ok(amend, 'seq 424 (the amend labelling the payload) is missing');
  assert.equal(amend.entry.type, 'amend', 'seq 424 should be an amend');
  assert.match(String(amend.entry.note), /SECURITY TEST ROW/,
    'the amend must still identify seq 423 as a test row, or a reader scores a fake call');
});
