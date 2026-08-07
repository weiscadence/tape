'use strict';
/**
 * telegram-initdata.js — verify a Telegram Mini App `initData` string.
 *
 * This is the vouch. A mini-app call carries no ed25519 signature (the whole point is the
 * user does nothing but tap), so the only thing standing between "@jiggyjigsters posted this"
 * and "anyone typed jiggyjigsters into a form" is that Telegram HMAC-signs the launch data
 * with the bot token. Get this wrong and the leaderboard is back to being a diary anyone can
 * write into under someone else's name. So it is a standalone, test-first module.
 *
 * Algorithm (Telegram WebApp spec):
 *   secret_key   = HMAC_SHA256(key="WebAppData", message=bot_token)
 *   data_check   = every "k=v" pair except `hash`, sorted by k, joined with "\n"
 *   expected     = hex( HMAC_SHA256(key=secret_key, message=data_check) )
 *   valid  ⇔  expected === provided hash   (constant-time compare)
 *
 * Also enforces freshness: `auth_date` must be within maxAgeSec, so a leaked initData string
 * can't be replayed forever.
 */

const crypto = require('crypto');

function verifyInitData(initData, botToken, opts = {}) {
  const maxAgeSec = opts.maxAgeSec == null ? 24 * 3600 : opts.maxAgeSec;
  const nowSec = opts.nowSec == null ? Math.floor(Date.now() / 1000) : opts.nowSec;

  if (typeof initData !== 'string' || !initData) return { ok: false, reason: 'empty initData' };
  if (typeof botToken !== 'string' || !botToken) return { ok: false, reason: 'no bot token' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no hash' };

  // Build the data-check-string: all fields except `hash`, sorted, "k=v" joined by newline.
  const pairs = [];
  for (const [k, v] of params) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheck = pairs.join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');

  // Constant-time compare; lengths must match or timingSafeEqual throws.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'hash mismatch' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'no auth_date' };
  if (maxAgeSec > 0 && nowSec - authDate > maxAgeSec) {
    return { ok: false, reason: `stale (${nowSec - authDate}s old)` };
  }

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { /* leave null */ }

  return { ok: true, user, authDate };
}

/**
 * Build a valid initData string for tests / local drives. Mirrors exactly what Telegram
 * sends, so a round-trip through verifyInitData must pass — and any single-byte tamper
 * must fail. NEVER used in production; the server only ever verifies, never mints.
 */
function signInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const pairs = [];
  for (const [k, v] of params) { if (k === 'hash') continue; pairs.push(`${k}=${v}`); }
  pairs.sort();
  const dataCheck = pairs.join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

module.exports = { verifyInitData, signInitData };
