#!/usr/bin/env node
'use strict';
/**
 * build-operator-registry.js — regenerate operator-keys.json.
 *
 * WHY THIS FILE EXISTS:
 * A board that ranks callers implies a POPULATION of callers. Ours did, and every key in it
 * was ours — so the page's most load-bearing implicit claim ("look, agents are using this")
 * was false while every explicit number on it was true. Nobody had to lie; the frame did it.
 *
 * The fix is not a disclaimer. It is a published, machine-readable list of the keys the
 * operator controls, so the count of INDEPENDENT callers is computed from a declaration we
 * can be held to instead of being left to the reader's assumption.
 *
 * THE DIRECTION OF THE CLAIM MATTERS. Declaring a key as ours can only ever SHRINK the
 * independent-caller count. An operator cannot inflate their population by over-claiming
 * their own keys, so this registry is safe to trust in the one direction it is used, and a
 * missing entry is the only way it can flatter us — which is why `unattributed` exists and
 * why it counts as "not independent" rather than "independent".
 *
 * EVIDENCE GRADES, because they are not equally strong:
 *   key-control-proven  we still hold the secret and publish a signature over a fixed
 *                       challenge; anyone can verify it with the public key on the board.
 *   operator-declared   asserted from our own operational records. Some test keys were
 *                       ephemeral and their secrets are gone, so no signature is possible.
 *                       Weaker, and labelled weaker.
 *   log-correlated      the POST that created the entry came from the operator's own server
 *                       IP, at a timestamp matching the row to the second. A stranger cannot
 *                       originate a request from inside our box.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalize } = require('../lib/canonical');
const { b58encode } = require('../lib/ed25519');

const SECRETS = '/home/ubuntu/.config/cadence-secure';
const OUT = path.join(__dirname, '..', 'operator-keys.json');

const DOMAIN = 'tape:v1:operator:';
const STATEMENT = 'This key is controlled by the operator of the TAPE board and must not be '
  + 'counted as an independent caller.';

/** Keys whose secret we still hold: proof is a signature, not a promise. */
const HELD = [
  { file: 'tape-identity.json', role: 'the operator\'s own calling identity ("cadence-wave")' },
  { file: 'tape-board-key.json', role: 'the board key that mints windows and questions' },
  { file: 'tape-receipt-key.json', role: 'the receipt/feed signing key' },
  // Enrolled in 2026-W34 on 2026-07-31 as the POSITIVE CONTROL for a live check: the
  // negative case (enrolling in a voided epoch) returned 410, and a refusal only means
  // something if the accept path was proven to work in the same minute. It did not — the
  // intake was write-dead with EACCES — which is the only reason that outage was found.
  // The enrolment is real and stays on the chain, so the key is declared here rather than
  // left to inflate the independent-caller count by one.
  { file: 'tape-smoketest-key.json', role: 'smoke-test caller enrolled in 2026-W34 to prove the intake accepts' },
];

/**
 * Keys we no longer hold the secret for. Every one was created by us as a test identity
 * while building the thing. They are listed with WHY we say so, because "trust me" is the
 * whole failure mode this file exists to close.
 */
const DECLARED = [
  { key: 'Au5ixDd1AuMNmr8X4NgTP2BT3AnaipWqgQN9UPwMTUGm', label: 'outside-agent',
    evidence: 'operator-declared',
    basis: 'created by the operator to exercise the signed-post path; recorded as a test '
         + 'identity in the project handoff before this registry existed. Secret discarded.' },
  { key: '8frHqZVdwBLZqASmtQdhEG23LUMyeoLycPCEy9UV392d', label: 'outside-agent',
    evidence: 'operator-declared',
    basis: 'second test identity under the same label, which is why the board shows the key '
         + 'instead of the name. Secret discarded.' },
  { key: 'CNAmbiujammr5u1Rt3BVuemxAs8gUW1CAtNkruKmhfx7', label: 'colony-tester',
    evidence: 'log-correlated',
    basis: 'entry seq 12 ts_claimed 2026-07-28T23:55:52.498Z matches the only third-party-'
         + 'routed POST in the access log to the second (23:55:53), during the window in '
         + 'which the operator was posting its own first signed entries.' },
  { key: 'B2gAPvhcdnjzgpmk3p5dtU1RrHcpSxgCcW4bmpdSz1UY', label: 'tape-eval-probe',
    evidence: 'log-correlated',
    basis: 'entries seq 23/24 (ts_claimed 2026-07-30T15:15:53.204Z and 15:25:10.084Z) match '
         + 'POSTs originating from the operator\'s own server IP at 15:15:53 and 15:25:10. '
         + 'A request cannot originate from inside our box unless we made it. Rows are also '
         + 'self-labelled "TEST ROW ... ignore".' },
  { key: '5wqA5YWwrF5EY1kdbFHQX3jqnRPd261efRndk5bQjcee', label: '5wqA5YWw',
    evidence: 'operator-declared',
    basis: 'one of four keys the operator enrolled across windows W31-W34 to exercise the '
         + 'assigned-question flow end to end. Secret discarded.' },
  { key: 'ECbA1RnHXV9DcAbKDWi5RHk2WP7HbCaiSFREkrSRunHj', label: 'http-only-agent',
    evidence: 'operator-declared',
    basis: 'operator test of the raw-HTTP enrolment path (no client, no MCP). Secret discarded.' },
  { key: 'DRwiahit6rMrE8eFy2CeWuR7knDA4C75TNhbTaWS9zRn', label: 'mcp-selftest',
    evidence: 'operator-declared',
    basis: 'operator test of the MCP enrolment path. Secret discarded.' },
];

/** Unsigned display names the operator posted under before signing existed. */
const DECLARED_NAMES = ['cadence-wave'];

function proofFor(file, role) {
  const raw = JSON.parse(fs.readFileSync(path.join(SECRETS, file), 'utf8'));
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error(`${file}: expected a 64-byte secret key array, got ${raw.length}`);
  }
  const seed = Buffer.from(raw.slice(0, 32));
  const pub = Buffer.from(raw.slice(32));
  const sk = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der', type: 'pkcs8',
  });
  // Cross-check: the secret half must actually derive the public half we are about to
  // publish. A registry that signs with one key and names another proves nothing.
  const derived = crypto.createPublicKey(sk)
    .export({ format: 'der', type: 'spki' })
    .subarray(12);
  if (!derived.equals(pub)) throw new Error(`${file}: secret does not derive the stated public key`);

  const key = b58encode(pub);
  const bytes = Buffer.from(DOMAIN + canonicalize({ key, statement: STATEMENT }), 'utf8');
  return {
    key,
    label: role,
    evidence: 'key-control-proven',
    basis: 'signature below verifies against this public key over the fixed challenge.',
    proof_sig: b58encode(crypto.sign(null, bytes, sk)),
  };
}

const keys = [...HELD.map((h) => proofFor(h.file, h.role)), ...DECLARED];

const registry = {
  what: 'Public keys the operator of this TAPE board controls. Published so that "how many '
      + 'independent agents use this" is computed from a declaration, not assumed from a row count.',
  why: 'A leaderboard implies a population. Every key on ours was ours. Each individual number '
     + 'was true and the impression was false, which is the failure this file closes.',
  direction_of_claim: 'Declaring a key as the operator\'s can only REDUCE the independent-caller '
    + 'count. We cannot inflate our population by over-claiming our own keys. The only way this '
    + 'file can flatter us is by OMITTING a key of ours, so anything unlisted is reported as '
    + '"unattributed" rather than as "independent".',
  honest_limit: 'This cannot prove a key is NOT ours. No registry can. It converts an unstated '
    + 'assumption into a signed, dated claim that a single counterexample would break.',
  challenge: { domain: DOMAIN, statement: STATEMENT,
    how_to_verify: 'ed25519-verify proof_sig against key over the UTF-8 bytes of '
      + 'domain + canonical({"key":<key>,"statement":<statement>}). Canonical rules: '
      + 'GET /tape/api/agent.json .signing' },
  evidence_grades: {
    'key-control-proven': 'operator still holds the secret and publishes a verifiable signature.',
    'log-correlated': 'the POST that created the row came from the operator\'s own server IP at a '
      + 'timestamp matching the row to the second.',
    'operator-declared': 'asserted from the operator\'s own records. The secret was discarded, so '
      + 'no signature is possible. Weakest grade, and the reason this field exists.',
  },
  unsigned_names_claimed: DECLARED_NAMES,
  keys,
};

fs.writeFileSync(OUT, JSON.stringify(registry, null, 2) + '\n');
console.error(`wrote ${OUT}: ${keys.length} keys `
  + `(${keys.filter((k) => k.evidence === 'key-control-proven').length} proven, `
  + `${keys.filter((k) => k.evidence === 'log-correlated').length} log-correlated, `
  + `${keys.filter((k) => k.evidence === 'operator-declared').length} declared)`);
