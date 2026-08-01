'use strict';
/**
 * canonical.js — deterministic serialization.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS STRICT:
 * A hash commitment is only meaningful if two honest parties independently produce the
 * SAME bytes for the same claim. `JSON.stringify` does not guarantee that: key order
 * follows insertion order, and float formatting is a well-known cross-language footgun
 * (0.1+0.2, 1e21, -0). If the bytes can differ, a caller can later argue "that isn't
 * what I posted" and the whole record collapses into a he-said-she-said — which is the
 * exact failure TAPE exists to remove.
 *
 * So: keys sorted, no whitespace, and NUMBERS ARE REJECTED OUTRIGHT. Every quantity
 * (size, price, odds) must arrive as a decimal STRING. That is deliberately annoying at
 * the call site and it is the correct trade: the alternative is a leaderboard whose
 * hashes depend on which language wrote them.
 */

const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Recursively canonicalize a JSON-ish value into a deterministic string. */
function canonicalize(value, path = '$') {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'number') {
    throw new TypeError(
      `canonical: raw number at ${path}. Quantities must be decimal strings ` +
      `(got ${value}). Float formatting is not portable; see the header comment.`
    );
  }
  if (t === 'undefined') throw new TypeError(`canonical: undefined at ${path}`);
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new TypeError(`canonical: unsupported type ${t} at ${path}`);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value); // JSON string escaping is well-defined

  if (Array.isArray(value)) {
    return '[' + value.map((v, i) => canonicalize(v, `${path}[${i}]`)).join(',') + ']';
  }

  if (t === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError(`canonical: non-plain object at ${path}`);
    }
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
      // An explicit `undefined` value is dropped by JSON.stringify silently, which would
      // let two different objects canonicalize identically. Refuse instead.
      if (value[k] === undefined) throw new TypeError(`canonical: undefined value at ${path}.${k}`);
      parts.push(JSON.stringify(k) + ':' + canonicalize(value[k], `${path}.${k}`));
    }
    return '{' + parts.join(',') + '}';
  }

  throw new TypeError(`canonical: unhandled value at ${path}`);
}

/** Validate a decimal-string quantity. Returns the string unchanged, or throws. */
function requireDecimalString(v, field) {
  if (typeof v !== 'string' || !DECIMAL_RE.test(v)) {
    throw new TypeError(
      `${field} must be a decimal string like "12.34" (got ${JSON.stringify(v)})`
    );
  }
  return v;
}

module.exports = { canonicalize, requireDecimalString, DECIMAL_RE };
