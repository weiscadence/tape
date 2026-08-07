'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the engine at a throwaway chain and a throwaway bot token BEFORE requiring the
// server — a test that writes to the production tape is a test nobody runs twice.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-mini-'));
const TOKEN = '999:MINIAPP-TEST-TOKEN';
const keyfile = path.join(TMP, 'bot.json');
fs.writeFileSync(keyfile, JSON.stringify({ bot_token: TOKEN }));
process.env.TAPE_DATA = TMP;
process.env.TAPE_BOT_KEYFILE = keyfile;

const { handleCall } = require('../bin/miniapp');
const { signInitData } = require('../lib/telegram-initdata');
const { Chain } = require('../lib/chain');

const MARKET = 'polymarket:0x' + 'a'.repeat(64);
const goodInit = signInitData(
  { user: JSON.stringify({ id: 7, username: 'jiggyjigsters' }), auth_date: String(Math.floor(Date.now() / 1000)) },
  TOKEN,
);

function drive(body) {
  return new Promise((resolve) => {
    const req = { method: 'POST', on(ev, cb) { if (ev === 'data') cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb(); } };
    let code, payload;
    const res = { writeHead(c) { code = c; }, end(b) { payload = JSON.parse(b); resolve({ code, payload }); } };
    handleCall(req, res);
  });
}

test('a verified tap appends a real unsigned entry with size', async () => {
  const { code, payload } = await drive({ initData: goodInit, market: MARKET, side: 'yes', price: 0.55, size: 5 });
  assert.equal(code, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.equal(payload.caller, 'unsigned:jiggyjigsters');
  // the row is really on the throwaway chain, unsigned, with our fields
  const rows = new Chain(path.join(TMP, 'tape.jsonl')).read();
  const mine = rows.find((r) => r.entry.market === MARKET);
  assert.ok(mine, 'entry present on chain');
  assert.equal(mine.entry.caller, 'jiggyjigsters');
  assert.equal(mine.entry.side, 'yes');
  assert.equal(mine.entry.entry_ref, '0.5500');
  assert.equal(mine.entry.size, '5');
  assert.ok(!mine.entry.signer, 'unsigned');
});

test('size is required and bounded', async () => {
  for (const size of [undefined, 0, -1, 1001, 'x']) {
    const { code } = await drive({ initData: goodInit, market: MARKET, side: 'no', price: 0.4, size });
    assert.equal(code, 400, `size ${size} should be refused`);
  }
});

test('an unverified initData is refused (401), nothing appended', async () => {
  const before = new Chain(path.join(TMP, 'tape.jsonl')).read().length;
  const { code } = await drive({ initData: goodInit.replace('jiggyjigsters', 'someoneElse'), market: MARKET, side: 'no', price: 0.4 });
  assert.equal(code, 401);
  assert.equal(new Chain(path.join(TMP, 'tape.jsonl')).read().length, before);
});

test('a malformed market is refused (400)', async () => {
  const { code } = await drive({ initData: goodInit, market: 'polymarket:not-a-hash', side: 'yes', price: 0.5 });
  assert.equal(code, 400);
});

test('an out-of-range price is refused (400)', async () => {
  for (const price of [0, 1, 1.4, -0.1, 'x']) {
    const { code } = await drive({ initData: goodInit, market: MARKET, side: 'yes', price });
    assert.equal(code, 400, `price ${price} should be refused`);
  }
});

test('cleanup', () => { fs.rmSync(TMP, { recursive: true, force: true }); });
