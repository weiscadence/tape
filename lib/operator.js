'use strict';
/**
 * operator.js — who on this board is the operator, and who is genuinely somebody else.
 *
 * A ranked list of callers reads as a population. Ours was six rows and all six were keys we
 * controlled, so the page's loudest implicit claim was false while every printed number was
 * true. This module is what makes that claim explicit and checkable instead of assumed.
 *
 * It classifies every identity into exactly one of three buckets:
 *
 *   operator      declared in operator-keys.json, with an evidence grade attached.
 *   unattributed  not declared, and we have no proof it is a stranger either. Counted as
 *                 NOT independent, because a missing registry entry is the one direction in
 *                 which this whole scheme could flatter us.
 *   independent   currently unreachable, and deliberately so — see below.
 *
 * WHY `independent` IS UNREACHABLE RIGHT NOW:
 * There is no signal that proves a key is not ours. IP does not do it: the site sits behind
 * a CDN, so a stranger's POST and our own POST through the public domain arrive from the
 * same edge address. Rather than invent a threshold that would let us promote our own keys
 * into "independent" the moment it flattered us, the promotion is manual and evidenced —
 * `independent_keys` in the registry, added only when there is a reason a sceptic would
 * accept. Today that list is empty and the honest headline is zero.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY = path.join(__dirname, '..', 'operator-keys.json');

function load(file = REGISTRY) {
  if (!fs.existsSync(file)) {
    // Fail loud rather than silently classifying everything as independent. A missing
    // registry that defaults to "all strangers" is exactly the flattering-zero bug.
    throw new Error(`operator registry missing at ${file}; refusing to guess provenance`);
  }
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byKey = new Map();
  for (const k of r.keys || []) byKey.set(k.key, k);
  return {
    raw: r,
    byKey,
    names: new Set(r.unsigned_names_claimed || []),
    independent: new Set(r.independent_keys || []),
  };
}

/**
 * Classify one scored identity.
 * `identity` is score.js's identity string: `key:<base58>` or `name:<label>`.
 */
function classify(identity, reg) {
  if (typeof identity === 'string' && identity.startsWith('key:')) {
    const key = identity.slice(4);
    const hit = reg.byKey.get(key);
    if (hit) {
      return { provenance: 'operator', evidence: hit.evidence, basis: hit.basis };
    }
    if (reg.independent.has(key)) {
      return { provenance: 'independent', evidence: 'operator-attested-not-ours', basis: null };
    }
    return { provenance: 'unattributed', evidence: null, basis: null };
  }
  // An unsigned row is a typed name, not an identity. If the operator has claimed that name,
  // say so; otherwise it is unattributed, because anyone at all could have typed it.
  const name = typeof identity === 'string' && identity.startsWith('name:')
    ? identity.slice(5) : null;
  if (name && reg.names.has(name)) {
    return { provenance: 'operator', evidence: 'operator-declared',
      basis: 'unsigned rows posted under a display name the operator has claimed. An unsigned '
           + 'name proves nothing about who typed it, in either direction.' };
  }
  return { provenance: 'unattributed', evidence: null, basis: null };
}

/**
 * Population summary for a set of classified caller rows.
 *
 * `independent` is the only number a reader should take as "agents other than us", and it is
 * reported alongside `unattributed` rather than absorbing it, so an unproven key can never
 * quietly graduate into evidence of adoption.
 */
function population(callers) {
  const n = { total: callers.length, operator: 0, independent: 0, unattributed: 0 };
  for (const c of callers) {
    if (c.provenance === 'operator') n.operator++;
    else if (c.provenance === 'independent') n.independent++;
    else n.unattributed++;
  }
  return n;
}

/** True when every row from this identity is self-labelled a test. */
function isSelfDeclaredTest(rows, identity) {
  const mine = rows.filter((r) => {
    const e = r.entry || r;
    const id = e.signer ? `key:${e.signer}` : `name:${e.caller}`;
    return id === identity && ['open', 'close', 'amend'].includes(e.type);
  });
  if (!mine.length) return false;
  return mine.every((r) => /\btest\b/i.test((r.entry || r).note || ''));
}

module.exports = { load, classify, population, isSelfDeclaredTest, REGISTRY };
