#!/usr/bin/env node
/**
 * tape-read-canary.mjs — assert that a stranger can still pull an entry back and verify it.
 *
 * WHY THIS EXISTS. rowan-adeyemi (Colony, 2026-07-30) named the shape of a failure we had
 * already lived through and had not generalised:
 *
 *   "The write path had a witness (the anchor proves the write happened); the USEFULNESS
 *    path had none. So the system was green on every signal it bothered to emit, and
 *    silently dead on the one that mattered."
 *
 * We shipped a public record for weeks that nothing could read, and every instrument we
 * had said fine, because every instrument watched writing. Later, every one of the five
 * verifier downloads 404'd — the artifact whose entire purpose is "do not trust us" was
 * ten bytes of `not found` — and that was found by hand, not by a check.
 *
 * So this is not a health check. Uptime is a write-side signal. This performs the exact
 * round trip a real consumer performs and fails loudly when any leg of it breaks:
 *
 *   1. discover a recent entry over public HTTP, and pick one AT RANDOM
 *   2. pull its receipt from the public API
 *   3. DOWNLOAD the verifier from the public URL, as a stranger would, rather than
 *      importing the copy in this repo — a verifier that only works from inside the repo
 *      is the same blind spot in a new costume
 *   4. run it as a separate process against a public Solana RPC and require VERIFIED
 *   5. tamper with the same receipt and require the verifier to say FRAUD
 *
 * Step 5 is the part that makes the other four mean anything. A verifier that has quietly
 * degraded to "print VERIFIED" passes 1 to 4 forever. If the negative control does not
 * fail, this canary reports UNTRUSTED rather than a comfortable pass.
 *
 *   node verify/tape-read-canary.mjs [--base https://tape.drainfun.xyz] [--rpc <url>] [--quiet]
 *
 * exit 0 = round trip works · 1 = a leg is broken · 2 = UNTRUSTED (control did not fail)
 *      3 = INCONCLUSIVE (rate limited; the path was not tested, which is not a pass)
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const BASE = (flag('base', 'https://tape.drainfun.xyz')).replace(/\/$/, '');
const RPC = flag('rpc', 'https://api.mainnet-beta.solana.com');
const QUIET = argv.includes('--quiet');

// Cloudflare rejects default agent user-agents on this host, which once cost ten minutes
// of believing we had been banned. A canary that trips on that would be reporting our
// edge config, not our read path.
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; tape-read-canary/1)' };
const say = (s) => { if (!QUIET) console.log(s); };
const fail = [];

/** Thrown when we could not TEST the read path, as opposed to finding it broken. */
class Inconclusive extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, asText = false) {
  // 429 is our own edge rate limiter, not a broken read path. Reporting it as FAILED would
  // make this canary cry wolf, and a check that cries wolf gets read as noise — which is
  // the failure it exists to prevent. Back off first; only call it inconclusive if the
  // limiter is still holding after three tries.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: UA });
    if (r.status === 429) {
      if (attempt >= 2) throw new Inconclusive(`rate limited (429) after ${attempt + 1} tries on ${url}`);
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
    const body = asText ? await r.text() : await r.json();
    // A 200 carrying an error page is the failure mode that looks most like success.
    if (asText && body.length < 200) throw new Error(`${url} returned only ${body.length} bytes`);
    return body;
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'tape-canary-'));
  try {
    // 1. Discover. Random, not fixed: a pinned seq is the one an operator would notice
    //    and keep working while everything around it rotted.
    const latest = await get(`${BASE}/api/entry/latest`);
    const head = Number(latest?.receipt?.seq ?? latest?.seq);
    if (!Number.isInteger(head)) throw new Error('could not read a sequence number from /entry/latest');
    say(`head is seq ${head}`);

    let picked = null;
    const tried = [];
    for (let attempt = 0; attempt < 12 && !picked; attempt++) {
      const seq = Math.floor(Math.random() * (head + 1));
      tried.push(seq);
      const r = await get(`${BASE}/api/entry/${seq}`);
      const rec = r.receipt ?? r;
      // An unanchored entry is not a canary failure — recent rows legitimately wait for
      // the next anchor cycle. It is simply not yet verifiable, so keep looking.
      if (rec?.anchor?.signature) picked = { seq, rec };
    }
    if (!picked) throw new Error(`no anchored entry found in 12 random draws (${tried.join(', ')})`);
    say(`picked seq ${picked.seq} at random (drew ${tried.join(', ')})`);

    // 2 + 3. Fetch the verifier the way a stranger does, over HTTP.
    const src = await get(`${BASE}/tape-verify.mjs`, true);
    const verifier = join(dir, 'tape-verify.mjs');
    writeFileSync(verifier, src);
    say(`downloaded verifier, ${src.length} bytes`);

    const receiptPath = join(dir, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(picked.rec, null, 2));

    // 4. Positive leg.
    const ok = await run(process.execPath, [verifier, receiptPath, '--rpc', RPC], { timeout: 60000 })
      .then((o) => ({ code: 0, out: o.stdout }))
      .catch((e) => ({ code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    if (ok.code !== 0 || !/VERIFIED/.test(ok.out)) {
      fail.push(`seq ${picked.seq} did NOT verify (exit ${ok.code}): ${ok.out.trim().split('\n')[0]}`);
    } else {
      say(`seq ${picked.seq} VERIFIED against ${RPC}`);
    }

    // 5. Negative control. Same receipt, one field moved. If this still says VERIFIED the
    //    verifier is not checking anything and every pass above is worthless.
    const tampered = JSON.parse(JSON.stringify(picked.rec));
    const e = tampered.entry;
    if (typeof e.type === 'string') e.type = `${e.type}_tampered`;
    else throw new Error('receipt has no entry.type to tamper with');
    const badPath = join(dir, 'tampered.json');
    writeFileSync(badPath, JSON.stringify(tampered, null, 2));
    const bad = await run(process.execPath, [verifier, badPath, '--rpc', RPC], { timeout: 60000 })
      .then((o) => ({ code: 0, out: o.stdout }))
      .catch((err) => ({ code: err.code ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }));
    if (bad.code === 0 || /^VERIFIED/m.test(bad.out)) {
      console.error(`UNTRUSTED — a tampered receipt still verified. Every pass above is meaningless.`);
      console.error(bad.out.trim().slice(0, 400));
      return 2;
    }
    say(`control: tampered receipt rejected (${bad.out.trim().split('\n')[0]})`);

    if (fail.length) {
      console.error(`READ CANARY FAILED — ${fail.length} problem(s):`);
      for (const f of fail) console.error(`  - ${f}`);
      return 1;
    }
    say(`READ CANARY OK — a stranger can fetch seq ${picked.seq} and verify it against Solana`);
    return 0;
  } catch (err) {
    if (err instanceof Inconclusive) {
      console.error(`READ CANARY INCONCLUSIVE — ${err.message}. The read path was not tested; `
        + 'this is NOT evidence that it works.');
      return 3;
    }
    console.error(`READ CANARY FAILED — ${err.message}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().then((c) => { process.exitCode = c; });
