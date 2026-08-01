'use strict';
/**
 * ed25519.js — base58 and signing, with no dependencies.
 *
 * WHY NO DEPENDENCIES WHEN bs58 AND tweetnacl ARE RIGHT THERE:
 * The independent verifier has to check signatures, and it has to run from an empty
 * directory with no install — that is the property that makes it a check on us rather
 * than a component of us. If signature verification needed npm, the verifier would need
 * npm, and "anyone can check this" would quietly become "anyone with our lockfile can".
 * Node ships Ed25519 in `crypto`; it just needs the raw 32-byte key wrapped in the DER
 * envelope the API expects, which is a fixed prefix and nothing more.
 *
 * The library IS used — in the tests, as an independent oracle. A signature routine that
 * only ever verifies its own signatures is a self-consistent way to be wrong, so every
 * signature this file makes is also checked by tweetnacl, and vice versa.
 */

const crypto = require('crypto');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58encode(bytes) {
  const b = Buffer.from(bytes);
  let n = 0n;
  for (const byte of b) n = n * 256n + BigInt(byte);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  // Leading zero bytes are not representable in the numeric conversion and must be
  // re-added as '1's, or two different key byte-strings can encode to one string.
  for (const byte of b) { if (byte !== 0) break; out = '1' + out; }
  return out || '1';
}

function b58decode(str) {
  if (typeof str !== 'string' || !str.length) throw new TypeError('base58: empty');
  let n = 0n;
  for (const ch of str) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new TypeError(`base58: invalid character ${JSON.stringify(ch)}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of str) { if (ch !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

// DER envelopes for raw Ed25519 keys. These are constants, not a format we invented.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');   // 32-byte public key
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex'); // 32-byte seed

function publicKeyFromRaw(raw) {
  if (raw.length !== 32) throw new TypeError(`ed25519: public key must be 32 bytes, got ${raw.length}`);
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function privateKeyFromSeed(seed) {
  if (seed.length !== 32) throw new TypeError(`ed25519: seed must be 32 bytes, got ${seed.length}`);
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/**
 * Sign `message` (Buffer) with a Solana-style 64-byte secret key (32 seed || 32 public).
 * Returns a base58 signature.
 */
function sign(message, secretKey64) {
  const sk = Buffer.from(secretKey64);
  if (sk.length !== 64) throw new TypeError(`ed25519: secret key must be 64 bytes, got ${sk.length}`);
  return b58encode(crypto.sign(null, message, privateKeyFromSeed(sk.subarray(0, 32))));
}

/**
 * Verify a base58 signature against a base58 public key.
 * Returns a boolean and NEVER throws on bad input — malformed keys, wrong lengths and
 * corrupt base58 all mean "this did not verify", and a caller that has to wrap every
 * check in try/catch eventually forgets one and treats a crash as a pass.
 */
function verify(message, sigB58, pubkeyB58) {
  try {
    const sig = b58decode(sigB58);
    const pub = b58decode(pubkeyB58);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return crypto.verify(null, message, publicKeyFromRaw(pub), sig);
  } catch {
    return false;
  }
}

/** Public key (base58) for a 64-byte secret key, derived rather than trusted. */
function publicKeyOf(secretKey64) {
  const sk = Buffer.from(secretKey64);
  const der = privateKeyFromSeed(sk.subarray(0, 32))
    .export({ format: 'der', type: 'pkcs8' });
  // Re-derive from the private key instead of reading bytes 32..64, so a secret key file
  // whose stored public half does not match its seed is caught rather than believed.
  const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }))
    .export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
  return b58encode(pub);
}

const isBase58Key = (s) => {
  try { return typeof s === 'string' && b58decode(s).length === 32; } catch { return false; }
};

module.exports = { b58encode, b58decode, sign, verify, publicKeyOf, isBase58Key, publicKeyFromRaw };
