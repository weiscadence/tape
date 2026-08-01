'use strict';
/**
 * scorer-version.js — pin WHICH code produced a published mark hash.
 *
 * WHY THIS EXISTS. On 2026-07-31 I ran the marks-grid reconstruction tool 2clawz asked for
 * against my own published series. It found 0 holes, and it also found that 187 of 257
 * published hashes do not reproduce under today's code. The cause was legible — a single
 * clean flip at 2026-07-30T22:15Z, the signature of one scorer change rather than tampering
 * smeared across the timeline — but "legible" is not "verifiable". Nothing published pinned
 * which scorer version made a given hash, so an auditor holding an older mark had no way to
 * reproduce it and no way to tell a code change from a lie. I traded "you must model my
 * outages" for "you must trust my code did not change." This closes that.
 *
 * TWO PARTS, AND THE SECOND IS THE ONE THAT MATTERS.
 *   1. scorerId(): a fingerprint DERIVED FROM THE SOURCE of every module that can change a
 *      markset hash or a score. Derived, not hand-typed — a version string I bump by hand
 *      is a string I will eventually forget to bump, and a provenance tag that silently
 *      goes stale is worse than none because it looks like evidence.
 *   2. sourceBundle(): the actual source text of those modules, published under the id.
 *      A tag alone still requires trusting me to hand over the old code when asked. This
 *      repo has no git remote, so "check the commit" is not available to a stranger. The
 *      bundle is what makes an old hash independently reproducible instead of merely
 *      labelled.
 *
 * WHAT IT DOES NOT PROVE, stated so it is not read as more.
 *   - It does not prove the code was not changed BETWEEN publishes. It proves which code a
 *     hash claims to come from, and lets a reader re-run that code and check the claim.
 *     A board that swapped code and republished everything would still be self-consistent;
 *     what defeats that is the Solana anchors, which fix the timeline independently.
 *   - It covers the modules listed in SOURCES. A change to node itself, or to a dependency
 *     outside this list, moves a hash without moving the id. There are no npm deps in the
 *     scoring path today, which is what makes the list tractable; if that changes this
 *     comment is a lie and the list must grow.
 *   - Marks come from an oracle over the network. Identical code plus a different Hermes
 *     answer still yields a different hash. That is why the mark set is hashed separately.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Every module whose text can change a markset hash or a scored row.
 *
 * Derived by reading the require graph of score.js (decimal, canonical, entry, windows,
 * price) plus marks.js, which builds the mark set that score.js hashes. Kept explicit
 * rather than walked automatically: an automatic walk would silently widen to anything a
 * refactor happens to pull in, and the id would churn for reasons unrelated to scoring.
 */
const SOURCES = [
  'score.js',
  'marks.js',
  'decimal.js',
  'canonical.js',
  'entry.js',
  'windows.js',
  'price.js',
];

const LIB = __dirname;

/** Read the scoring sources as { name: text }, sorted by name for a stable digest. */
function readSources() {
  const out = {};
  for (const name of [...SOURCES].sort()) {
    out[name] = fs.readFileSync(path.join(LIB, name), 'utf8');
  }
  return out;
}

/**
 * Fingerprint of the scoring code. Hashing per-file digests keyed by filename (rather than
 * a raw concatenation) means no pair of files can be re-cut to collide with a different
 * pair, and the framing is a JSON object instead of a separator convention.
 */
function scorerId(sources = readSources()) {
  // Per-file digests in a plain sorted object, then sha256 over its JSON. Deliberately
  // boring: an auditor reproduces this with two lines of any language and no framing rules
  // to get wrong. The first version of this function used NUL-separated length prefixes,
  // the published instruction described spaces, and the two disagreed — a provenance id
  // nobody else can recompute is worse than none, because it looks like proof.
  const digests = {};
  for (const name of Object.keys(sources).sort()) {
    digests[name] = crypto.createHash('sha256').update(sources[name], 'utf8').digest('hex');
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(digests), 'utf8').digest('hex');
}


/**
 * The publishable bundle: the id plus the source that produced it, so a reader can
 * recompute the id from the text and then re-run the text against an old mark set.
 */
function sourceBundle() {
  const sources = readSources();
  return {
    scorer_id: scorerId(sources),
    generated_at: new Date().toISOString(),
    note: 'Source of every module that can change a markset hash. Recompute scorer_id: '
        + 'sha256(utf8) each file text -> hex; build an object of {filename: hexdigest} with '
        + 'keys in ascending order; scorer_id = sha256(utf8) of JSON.stringify of that object.',
    file_digests: Object.fromEntries(Object.keys(sources).sort()
      .map((n) => [n, crypto.createHash('sha256').update(sources[n], 'utf8').digest('hex')])),
    files: sources,
  };
}

module.exports = { scorerId, sourceBundle, readSources, SOURCES };
