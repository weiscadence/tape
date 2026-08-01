'use strict';
/**
 * attest.js — verification counting, attested by the verifier rather than asserted by us.
 *
 * THE PROBLEM THIS SOLVES, STATED HONESTLY.
 * "Independently verified 47 times" is the single easiest number on this whole site to
 * fake, because until now the only party who could observe a verification was the party
 * being verified. Nothing stopped us printing any figure we liked. A self-reported count
 * of external checks is not weak evidence, it is zero evidence — it is exactly the class
 * of metric TAPE exists to replace, wearing the costume of the fix.
 *
 * So the count is not ours to make. A verification enters the record only as a row SIGNED
 * BY THE VERIFIER'S OWN KEY, and every such row is published raw so anyone can recount
 * from the same bytes and get their own answer. Our tally is a convenience; the rows are
 * the evidence, and if the two ever disagree the rows win.
 *
 * WHAT AN ATTESTATION PROVES, AND WHAT IT DOES NOT. Read this before quoting the number.
 *   IT PROVES: a specific key said "I checked entry X against Solana and got verdict V",
 *   non-repudiably, at a time no later than the anchoring of this row. That claim can
 *   never afterwards be quietly withdrawn or reworded.
 *   IT DOES NOT PROVE: that the signer actually ran the check. Verification is
 *   deterministic and every input is public, so anyone can sign "verified" without
 *   looking. There is no cryptographic fix for that and pretending otherwise would be
 *   the same lie in a new costume.
 *
 * WHY IT IS WORTH ANYTHING ANYWAY — the property is FALSIFIABILITY, not proof of labour.
 * Because the target entry and the chain are public, a third party can re-run the check
 * and prove an attester wrong. A signed, anchored, wrong `verified` is therefore a
 * permanent mark against that key which its holder cannot revise, cannot re-narrate and
 * cannot delete. The cost of lying is not paid at signing time; it is paid forever
 * afterwards, by anyone who cares to look. That is the whole mechanism.
 *
 * DISAGREEMENT IS FIRST CLASS. `fraud` and `mismatch` verdicts are accepted on exactly
 * the same terms as `verified`, are never filtered from any view, and are surfaced first
 * in the tally. A verification channel that only carries good news is a testimonial page.
 * We do not get to reject an attestation because it accuses us.
 *
 * TWO NUMBERS, NEVER ONE. Attestations are counted by provenance through the same
 * operator registry that grades callers, because our own verifier key signing our own
 * rows is a self-check and must never add to a figure a reader will hear as adoption.
 * Today the independent count is zero and it says so.
 */

const { canonicalize } = require('./canonical');
const ed = require('./ed25519');

/**
 * Its own signature domain, alongside `tape:v1:` (calls), `tape:v1:window:` (assigned
 * questions) and `tape:v1:pledge:` (promises). Four families, four prefixes: a signature
 * over one row shape must never be liftable onto another, even if the canonical bytes of
 * two families ever collided.
 */
const SIG_DOMAIN = 'tape:v1:attest:';

/**
 * The four verdicts, lowercased, identical in meaning to the independent verifier's exit
 * codes 0/1/3/2. They are carried through verbatim rather than collapsed, for the reason
 * given in tape-verify.mjs: folding `unknown` into either neighbour turns an outage into
 * a rubber stamp or an accusation. That bug does not become acceptable because the row
 * arrived over HTTP.
 */
const VERDICTS = new Set(['verified', 'fraud', 'unknown', 'mismatch']);

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UINT = /^(0|[1-9][0-9]*)$/;
/** Hostname only. See `rpc_host` below. */
const HOSTISH = /^[a-z0-9.-]{1,253}$/i;

const isAttestRow = (entry) => !!entry && entry.p === 'tape-attest';

const str = (name, v, re, maxLen) => {
  if (typeof v !== 'string') throw new TypeError(`attest row: ${name} must be a string`);
  if (maxLen && v.length > maxLen) throw new TypeError(`attest row: ${name} longer than ${maxLen}`);
  if (re && !re.test(v)) throw new TypeError(`attest row: ${name} is malformed (${JSON.stringify(v.slice(0, 40))})`);
  return v;
};
const nullable = (name, v, re, maxLen) => (v === undefined || v === null ? null : str(name, v, re, maxLen));

/**
 * Build a canonical attestation row from loose input.
 *
 * Strict in the same way buildWindowRow is strict: unknown fields are REFUSED, never
 * dropped. A silently-ignored field is one the signer believed the hash covered, and that
 * gap is where a row that verifies but does not mean what its author meant comes from.
 */
function buildAttestRow(input) {
  if (!input || typeof input !== 'object') throw new TypeError('attest row: expected an object');

  const known = new Set(['p', 'v', 'type', 'ref', 'verdict', 'merkle_root', 'anchor_sig',
    'slot', 'rpc_host', 'note', 'attested_at', 'signer', 'sig']);
  for (const k of Object.keys(input)) {
    if (!known.has(k)) throw new TypeError(`attest row: unknown field ${JSON.stringify(k)}`);
  }
  if (input.p !== undefined && input.p !== 'tape-attest') {
    throw new TypeError(`attest row: p must be "tape-attest" (got ${JSON.stringify(input.p)})`);
  }
  if (input.v !== undefined && input.v !== '1') throw new TypeError('attest row: v must be "1"');
  if (input.type !== undefined && input.type !== 'attest') throw new TypeError('attest row: type must be "attest"');

  const verdict = str('verdict', input.verdict);
  if (!VERDICTS.has(verdict)) {
    throw new TypeError(`attest row: verdict must be one of ${[...VERDICTS].join('|')}, got ${JSON.stringify(verdict)}`);
  }

  const out = {
    p: 'tape-attest',
    v: '1',
    type: 'attest',
    // The entry being attested, carried in `ref` rather than a field of our own so that
    // chain.js enforces it: an attestation whose target is absent from the tape, or which
    // points forward at a row written later, is refused at append time by the same code
    // that stops a close pointing at a position opened after it. Reusing that check is
    // worth more than a prettier field name.
    ref: str('ref', input.ref, HEX64),
    verdict,
    // What the verifier RECOMPUTED and what it READ. Present for a verdict reached against
    // the chain, null for one that never got that far — `unknown` from an unreachable RPC
    // has no root and no slot, and inventing placeholders would make an outage look like
    // an inspection.
    merkle_root: nullable('merkle_root', input.merkle_root, HEX64),
    anchor_sig: nullable('anchor_sig', input.anchor_sig, /^[1-9A-HJ-NP-Za-km-z]{64,120}$/),
    slot: nullable('slot', input.slot, UINT, 24),
    // HOSTNAME ONLY, never the full URL. Verifiers are told to bring their own RPC and a
    // lot of them are paid endpoints with the API key in the path; storing the URL would
    // publish that key on a public append-only chain that we then anchor to Solana. A
    // host is enough to answer "did two attesters use different sources", which is the
    // only thing this field is for.
    rpc_host: str('rpc_host', input.rpc_host, HOSTISH, 253),
    note: nullable('note', input.note, null, 280),
    attested_at: str('attested_at', input.attested_at, ISO_Z),
  };

  // A verdict of `verified` without the two things a verification produces is not a
  // verification, it is an opinion. Refused at build time so it can never be signed.
  if (verdict === 'verified' && (!out.merkle_root || !out.slot)) {
    throw new TypeError('attest row: a "verified" verdict must carry the merkle_root it recomputed '
      + 'and the slot it read; without them there is nothing for a third party to re-check');
  }

  out.signer = input.signer === undefined ? null : input.signer;
  out.sig = input.sig === undefined ? null : input.sig;
  if (out.signer !== null && !ed.isBase58Key(out.signer)) {
    throw new TypeError('attest row: signer must be a base58 ed25519 public key');
  }
  return out;
}

const attestSigningBytes = (row) => Buffer.from(SIG_DOMAIN + canonicalize({ ...row, sig: null }), 'utf8');

function signAttestRow(row, secretKey64) {
  const signer = ed.publicKeyOf(secretKey64);
  if (row.signer !== null && row.signer !== undefined && row.signer !== signer) {
    throw new TypeError(`attest row: signer is ${row.signer} but this key is ${signer}`);
  }
  const withSigner = { ...row, signer, sig: null };
  return { ...withSigner, sig: ed.sign(attestSigningBytes(withSigner), secretKey64) };
}

/**
 * Verify an attestation's signature.
 *
 * UNLIKE every other family on this chain, an UNSIGNED attestation is invalid rather than
 * merely unattributed. An unsigned call is still a call somebody typed; an unsigned
 * attestation is a verification claim with nobody behind it, which is precisely the
 * self-reported number this module exists to abolish. There is no anonymous mode.
 */
function verifyAttestRow(row) {
  const signer = row.signer ?? null;
  const sig = row.sig ?? null;
  if (signer === null || sig === null) {
    return { signed: true, ok: false, signer, reason: 'attestations must be signed: an unsigned '
      + 'verification claim is exactly the self-reported number this replaces' };
  }
  const ok = ed.verify(attestSigningBytes(row), sig, signer);
  return { signed: true, ok, signer, reason: ok ? 'signature verified' : 'signature does not verify' };
}

/**
 * Tally attestations for publication.
 *
 * `classifyKey` is injected (normally operator.classify bound to the loaded registry) so
 * this module does not decide who is a stranger — that judgement lives in one place, with
 * its evidence grades, and is not re-implemented here where it could drift into being
 * kinder to us.
 *
 * Returns counts and the raw rows. Never a single headline ratio: "N verifications" with
 * our own key folded in is the flattering aggregate, and the split is the whole point.
 */
function tallyAttestations(rows, classifyKey, signerOfTarget = () => null) {
  const entries = rows
    .map((r) => ({ rec: r, e: r.entry ?? r }))
    .filter(({ e }) => isAttestRow(e) && e.type === 'attest');

  const blank = () => ({ verified: 0, fraud: 0, unknown: 0, mismatch: 0 });
  const out = {
    total: entries.length,
    by_verdict: blank(),
    independent: { total: 0, ...blank(), keys: [] },
    operator: { total: 0, ...blank(), keys: [] },
    unattributed: { total: 0, ...blank(), keys: [] },
    // Disagreements listed explicitly rather than left to be noticed in a count: any
    // attestation that is not `verified` is a third party saying we are wrong somewhere,
    // and that belongs at the top of the summary, not inside a bucket.
    disputes: [],
    distinct_verifiers: 0,
    targets_attested: 0,
    // A caller attesting their OWN row. Legal, never hidden, and counted apart from
    // everything else: it is a reference somebody wrote for themselves, and letting it sit
    // inside `independent` would rebuild the self-reported number one indirection out.
    self_attested: 0,
  };

  const keys = new Map();
  const targets = new Set();
  for (const { rec, e } of entries) {
    const bucket = classifyKey(`key:${e.signer}`).provenance;
    const b = out[bucket] || out.unattributed;
    b.total++; b[e.verdict]++;
    out.by_verdict[e.verdict]++;
    targets.add(e.ref);
    if (!keys.has(e.signer)) { keys.set(e.signer, bucket); b.keys.push(e.signer); }
    const self = signerOfTarget(e.ref) === e.signer;
    if (self) out.self_attested++;
    if (e.verdict !== 'verified') {
      out.disputes.push({
        seq: rec.seq ?? null, target: e.ref, verdict: e.verdict,
        verifier: e.signer, provenance: bucket, note: e.note,
        attested_at: e.attested_at, self_attested: self,
      });
    }
  }
  out.distinct_verifiers = keys.size;
  out.targets_attested = targets.size;
  return out;
}

module.exports = {
  SIG_DOMAIN, VERDICTS, isAttestRow, buildAttestRow,
  attestSigningBytes, signAttestRow, verifyAttestRow, tallyAttestations,
};
