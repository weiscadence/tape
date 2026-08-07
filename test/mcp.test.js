'use strict';
/**
 * mcp.test.js — the MCP server's contract, tested WITHOUT touching the network.
 *
 * Every test here drives the real server binary over real stdio JSON-RPC. There is no
 * harness that imports the functions directly, because the bugs this file exists to catch
 * were all at the seam: an envelope shape the server did not accept, a stray write to
 * stdout corrupting the stream, a discriminator that had never run on the input it was
 * written for. Importing past the transport would have passed while the product was broken.
 *
 * WRITE PATHS ARE NOT TESTED HERE. They append to a permanent public record, and a test
 * suite that dirties production every run trains you to ignore it. They are covered by the
 * offline signing check below: if the canonical bytes and the signature are right, the only
 * thing left is the HTTP envelope, and that has its own live check in the deploy step.
 */

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SERVER = path.join(__dirname, '..', 'mcp', 'tape-mcp.mjs');

/** Drive the server over stdio and collect replies. Returns a client with rpc()/close(). */
function client(env = {}) {
  const p = spawn('node', [SERVER], {
    env: { ...process.env, TAPE_API: 'http://127.0.0.1:1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const stderr = [];
  const stray = [];
  let buf = '';
  p.stderr.on('data', (d) => stderr.push(String(d)));
  p.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      // A non-JSON line on stdout is the failure this catches: one console.log in the
      // server and every client sees a parse error instead of the bug.
      try { m = JSON.parse(line); } catch { stray.push(line); continue; }
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  return {
    rpc: (method, params) => new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    }),
    raw: (s) => p.stdin.write(s),
    stray, stderr,
    close: () => p.stdin.end(),
  };
}
async function call(c, name, args = {}) {
  const r = await c.rpc('tools/call', { name, arguments: args });
  if (r.error) return { rpcError: r.error };
  return { isError: !!r.result.isError, text: r.result.content[0].text };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('initialize echoes a protocol version the client asked for', async () => {
  const c = client();
  const r = await c.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  assert.strictEqual(r.result.protocolVersion, '2024-11-05',
    'a client that opened with an older protocol must get an answer it can parse');
  assert.strictEqual(r.result.serverInfo.name, 'tape');
  assert.ok(r.result.capabilities.tools, 'must advertise tool capability');
  c.close();
});

test('initialize falls back to a known version when the client asks for nonsense', async () => {
  const c = client();
  const r = await c.rpc('initialize', { protocolVersion: 'not-a-version', capabilities: {} });
  assert.strictEqual(r.result.protocolVersion, '2025-06-18');
  c.close();
});

test('tools/list exposes every tool with a schema, and marks writes irreversible', async () => {
  const c = client();
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await c.rpc('tools/list');
  const tools = r.result.tools;
  assert.ok(tools.length >= 14, `expected >=14 tools, got ${tools.length}`);
  for (const t of tools) {
    assert.ok(t.name && t.description, `${t.name}: needs a description`);
    assert.strictEqual(t.inputSchema.type, 'object', `${t.name}: schema must be an object`);
  }
  // A caller deciding whether to approve a tool call reads the description and nothing else.
  // If a permanent public write is not labelled there, it is not labelled anywhere.
  for (const name of ['tape_post_call', 'tape_enroll', 'tape_answer', 'tape_pass']) {
    const t = tools.find((x) => x.name === name);
    assert.match(t.description, /IRREVERSIBLE/,
      `${name} writes to an append-only anchored log and must say so in its description`);
  }
  c.close();
});

test('unknown tool is a JSON-RPC error, not a silent success', async () => {
  const c = client();
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await call(c, 'tape_not_a_real_tool');
  assert.ok(r.rpcError, 'must be a protocol error');
  assert.strictEqual(r.rpcError.code, -32602);
  c.close();
});

test('a garbage line does not kill the server or corrupt the stream', async () => {
  const c = client();
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  c.raw('{ not json at all\n');
  c.raw('\n');
  const r = await c.rpc('ping');
  assert.deepStrictEqual(r.result, {}, 'server must still answer after malformed input');
  assert.strictEqual(c.stray.length, 0, `nothing but JSON-RPC may reach stdout; saw: ${c.stray[0]}`);
  c.close();
});

test('raw JSON numbers are REFUSED, never coerced to strings', async () => {
  const c = client({ TAPE_KEY: path.join(os.tmpdir(), `tape-mcp-test-${process.pid}.json`) });
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await call(c, 'tape_keygen');
  // String(0.35) === "0.35" and passes the decimal regex, so coercion LOOKS harmless. It is
  // not: the caller's parser already destroyed precision on large values, and signing the
  // coerced result mints a valid signature over a quantity nobody meant.
  for (const [tool, args] of [
    ['tape_post_call', { market: 'm', side: 'yes', odds: 0.35 }],
    ['tape_post_call', { market: 'm', side: 'yes', odds: '1', size: 2 }],
    ['tape_answer', { question_hash: 'a'.repeat(64), side: 'yes', odds: 0.62 }],
  ]) {
    const r = await call(c, tool, args);
    assert.ok(r.isError, `${tool} must refuse a raw JSON number`);
    assert.match(r.text, /decimal STRING, not a JSON number/);
  }
  // Malformed decimal strings are refused too, before anything is signed or sent.
  for (const bad of ['.35', '0.35 ', '', 'abc', '00.5']) {
    const r = await call(c, 'tape_post_call', { market: 'm', side: 'yes', odds: bad });
    assert.ok(r.isError, `odds ${JSON.stringify(bad)} must be refused`);
  }
  c.close();
});

test('keygen refuses to overwrite an existing identity', async () => {
  const keyfile = path.join(os.tmpdir(), `tape-mcp-overwrite-${process.pid}.json`);
  fs.rmSync(keyfile, { force: true });
  const c = client({ TAPE_KEY: keyfile });
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const first = await call(c, 'tape_keygen');
  assert.ok(!first.isError, 'first keygen must succeed');
  const id = JSON.parse(first.text).caller_id;
  const second = await call(c, 'tape_keygen');
  assert.ok(second.isError, 'a second keygen must REFUSE — that key is the whole accumulated record');
  // And the refusal must not have damaged the key it was protecting.
  const who = await call(c, 'tape_whoami');
  assert.ok(who.text.includes(id) || who.isError, 'the original key must survive the refusal');
  fs.rmSync(keyfile, { force: true });
  c.close();
});

test('missing key is an actionable error, not a crash', async () => {
  const c = client({ TAPE_KEY: path.join(os.tmpdir(), `tape-mcp-absent-${process.pid}.json`) });
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await call(c, 'tape_whoami');
  assert.ok(r.isError);
  assert.match(r.text, /tape_keygen/, 'must name the tool that fixes it');
  c.close();
});

test('verify_receipt distinguishes an anchor proof from an intake receipt', async () => {
  const c = client();
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  // THE REGRESSION: handing the anchor proof (the STRONGER artifact) to this tool used to
  // return "UNSIGNED — proves nothing", a confident wrong answer aimed at someone who had
  // done everything right.
  const anchorProof = { _: 'note', entry: { v: '1' }, proof: [], anchor: { slot: 1 }, entry_hash: 'ab', seq: 3 };
  let r = await call(c, 'tape_verify_receipt', { receipt: anchorProof });
  assert.strictEqual(JSON.parse(r.text).verdict, 'NOT_AN_INTAKE_RECEIPT');

  r = await call(c, 'tape_verify_receipt', { receipt: { p: 'tape-intake', v: '2', seq: '1' } });
  assert.strictEqual(JSON.parse(r.text).verdict, 'UNSIGNED');

  // A receipt whose signature does not verify must read BAD, never VERIFIED.
  r = await call(c, 'tape_verify_receipt', {
    receipt: { p: 'tape-intake', v: '2', entry_hash: 'ab', seq: '1', received_at: 'x',
               receipt_by: '11111111111111111111111111111111', receipt_sig: '2222222222' },
  });
  assert.strictEqual(JSON.parse(r.text).verdict, 'BAD');
  c.close();
});

test('a network failure surfaces as a tool error, not a protocol error', async () => {
  // TAPE_API points at a closed port for the whole suite. A dead upstream must come back as
  // isError with a readable message; turning it into a JSON-RPC error would tell the client
  // "your request was malformed" about a request that was fine.
  const c = client();
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await call(c, 'tape_integrity');
  assert.ok(!r.rpcError, 'an unreachable API is not a protocol error');
  assert.ok(r.isError, 'it must still be reported as a failure');
  assert.match(r.text, /tape_integrity failed/);
  c.close();
});

/**
 * The feed tests run against a LOCAL STUB, not production. The behaviour under test is what
 * the tool does when a feed is hostile or malformed, and production will never serve those
 * shapes on demand. A check that can only be exercised when the real thing is already broken
 * is a check that gets written and never run.
 */
function stubFeed(payload) {
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(typeof payload === 'function' ? payload() : payload));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => srv.close(),
  })));
}

test('tape_feed refuses an unsigned feed rather than returning it', async () => {
  const s = await stubFeed({ ok: true, p: 'tape-feed', v: '1', signed_fields: ['p', 'v'], feed_sig: null, feed_by: null });
  const c = client({ TAPE_API: s.url });
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await call(c, 'tape_feed');
  assert.ok(r.isError, 'an unsigned feed must not be handed to the caller');
  assert.match(r.text, /unsigned/);
  c.close(); s.close();
});

test('tape_feed refuses a feed whose signature does not verify', async () => {
  // The attack this closes: a cache or a MITM rewrites chain_entries and leaves the old
  // signature. The bytes parse, the shape is right, and only the signature disagrees.
  const s = await stubFeed({
    ok: true, p: 'tape-feed', v: '1', chain_entries: '999',
    signed_fields: ['p', 'v', 'chain_entries', 'feed_by'],
    feed_by: '11111111111111111111111111111111',
    feed_sig: '3'.repeat(80),
  });
  const c = client({ TAPE_API: s.url });
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await call(c, 'tape_feed');
  assert.ok(r.isError, 'a feed that fails verification must return NO data');
  assert.match(r.text, /did NOT verify/);
  assert.ok(!r.text.includes('999'), 'the unverified payload must not leak through the error');
  c.close(); s.close();
});

test('tape_feed refuses a feed that names a signed field it did not send', async () => {
  // Otherwise a server could shrink the signed body by omission and still verify.
  const s = await stubFeed({
    ok: true, p: 'tape-feed', v: '1',
    signed_fields: ['p', 'v', 'chain_entries'],
    feed_by: '11111111111111111111111111111111', feed_sig: '3'.repeat(80),
  });
  const c = client({ TAPE_API: s.url });
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await call(c, 'tape_feed');
  assert.ok(r.isError);
  assert.match(r.text, /signed_fields but did not send it/);
  c.close(); s.close();
});

test('tape_feed refuses a feed that publishes no signed_fields at all', async () => {
  const s = await stubFeed({ ok: true, p: 'tape-feed', v: '1', feed_by: 'x', feed_sig: 'y' });
  const c = client({ TAPE_API: s.url });
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const r = await call(c, 'tape_feed');
  assert.ok(r.isError);
  assert.match(r.text, /signed_fields/);
  c.close(); s.close();
});

(async () => {
  let pass = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); pass++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
  }
  // Printed as "N passed, M failed" to match every other file in this suite. The aggregate
  // counter greps for that exact phrase, so a file with its own format is silently counted
  // as ZERO — the suite total stays plausible while the new tests are invisible to it. A
  // number that cannot see its own newest input is the failure mode this project is about.
  console.log(`\n${pass} passed, ${tests.length - pass} failed`);
})();

// ---------------------------------------------------------------------------------------------
// agent.json's MCP tool list must match the SERVER, not a memory of it.
//
// agent.json publishes `mcp.tools` as the index an agent reads to decide what this server can do.
// That list was maintained by hand, which makes it a copy of another file's contents — and a copy
// drifts the first time someone adds a tool without thinking to come back. The failure is quiet in
// the worst direction: a tool that exists but is unadvertised is a capability nobody uses, and an
// advertised tool that does not exist is a call that errors after an agent planned around it.
//
// This reads the real server over the real transport and compares. Sync is now a test result
// rather than a discipline.
test('agent.json advertises exactly the tools the MCP server implements', async () => {
  const { agentDoc } = require('../bin/api.js');
  const advertised = agentDoc().mcp.tools;

  const c = client();
  const r = await c.rpc('tools/list');
  c.close();
  const actual = r.result.tools.map((t) => t.name);

  const missing = actual.filter((n) => !advertised.includes(n));
  const phantom = advertised.filter((n) => !actual.includes(n));
  assert.deepEqual(missing, [], `implemented but not advertised in agent.json: ${missing.join(', ')}`);
  assert.deepEqual(phantom, [], `advertised in agent.json but not implemented: ${phantom.join(', ')}`);
});

// NEGATIVE CONTROL: the comparison above is only meaningful if the server actually reports a
// non-trivial tool list. Two empty arrays are deepEqual, and a broken transport would produce
// exactly that while the assertion above went green.
test('the tool list used for the sync check is non-empty and includes the new read tools', async () => {
  const c = client();
  const r = await c.rpc('tools/list');
  c.close();
  const actual = r.result.tools.map((t) => t.name);
  assert.ok(actual.length >= 15, `expected a real tool list, got ${actual.length}`);
  assert.ok(actual.includes('tape_markets'), 'tape_markets missing from the server');
  assert.ok(actual.includes('tape_scoring'), 'tape_scoring missing from the server');
});
