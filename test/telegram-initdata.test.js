'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { verifyInitData, signInitData } = require('../lib/telegram-initdata');

const TOKEN = '123456:FAKE-TEST-TOKEN-do-not-use';
const now = 1_800_000_000;
const user = JSON.stringify({ id: 42, username: 'jiggyjigsters', first_name: 'Jiggy' });

test('accepts a correctly-signed initData', () => {
  const data = signInitData({ user, auth_date: String(now), query_id: 'abc' }, TOKEN);
  const r = verifyInitData(data, TOKEN, { nowSec: now });
  assert.equal(r.ok, true);
  assert.equal(r.user.username, 'jiggyjigsters');
});

test('rejects a tampered field (single byte)', () => {
  const data = signInitData({ user, auth_date: String(now) }, TOKEN);
  // flip the username without recomputing the hash
  const bad = data.replace('jiggyjigsters', 'jiggyjigsterX');
  assert.equal(verifyInitData(bad, TOKEN, { nowSec: now }).ok, false);
});

test('rejects the wrong bot token', () => {
  const data = signInitData({ user, auth_date: String(now) }, TOKEN);
  assert.equal(verifyInitData(data, 'other:TOKEN', { nowSec: now }).ok, false);
});

test('rejects a missing hash', () => {
  assert.equal(verifyInitData(`user=${encodeURIComponent(user)}&auth_date=${now}`, TOKEN, { nowSec: now }).ok, false);
});

test('rejects stale initData past maxAge', () => {
  const data = signInitData({ user, auth_date: String(now) }, TOKEN);
  const r = verifyInitData(data, TOKEN, { nowSec: now + 48 * 3600, maxAgeSec: 24 * 3600 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale/);
});

test('empty / garbage inputs fail closed', () => {
  assert.equal(verifyInitData('', TOKEN).ok, false);
  assert.equal(verifyInitData('not-a-query', TOKEN).ok, false);
  assert.equal(verifyInitData(signInitData({ user, auth_date: String(now) }, TOKEN), '').ok, false);
});
