'use strict';
// Delphi Agent Arena resolver. These cases are all NETWORK-FREE by construction: grammar
// misses return at the router, and the fail-closed path returns before any fetch when no key
// is configured. The settled/open/failed branches are smoke-tested live against the running
// competition (which rotates markets hourly, so there is no stable fixture to pin here).
const { test } = require('node:test');
const assert = require('node:assert');

// Guarantee the fail-closed branch is exercised regardless of the ambient environment.
//
// This used to `delete process.env.TAPE_DELPHI_KEY_FILE`, which stopped meaning "no key" on
// 2026-08-06 when resolve.js gained a DEFAULT key path (three separate processes had each
// resolved every Delphi market as "not configured" because only the systemd unit set the env).
// Env-absence was always a PROXY for the real condition; the real condition is that no key can be
// READ. So point at a path that cannot exist. The guarantee under test is unchanged and the
// mechanism now matches it — deleting the env would silently pass through a configured box and
// test nothing, which is the failure this whole file exists to prevent.
process.env.TAPE_DELPHI_KEY_FILE = '/nonexistent/tape-delphi-key-for-tests';
const { resolveMarket, DELPHI_KEY_DEFAULT } = require('../lib/resolve.js');

test('the default key path is the documented one', () => {
  // Pinned because the default is what every unconfigured runner now silently depends on. If it
  // moves, three processes go quiet again and the board shows live calls as NOT COUNTED.
  assert.equal(DELPHI_KEY_DEFAULT, '/etc/tape/delphi-key');
});

test('malformed delphi address is REFUSED at the router (no network)', async () => {
  assert.equal((await resolveMarket('delphi:notanaddr')).supported, false);
  assert.equal((await resolveMarket('delphi:0xabc')).supported, false);
  assert.equal((await resolveMarket(`delphi:0x${'a'.repeat(41)}`)).supported, false);
});

test('a well-formed delphi market FAILS CLOSED with no key — refused, never "open"', async () => {
  const r = await resolveMarket(`delphi:0x${'1'.repeat(40)}`);
  assert.equal(r.supported, false, 'unverifiable-because-unconfigured must refuse, not wave through');
  assert.equal(r.resolved, null);
  assert.match(r.detail, /not configured/i);
});
