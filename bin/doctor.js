#!/usr/bin/env node
'use strict';
/**
 * doctor.js — "did I set this up right?", answered by the machine instead of by a document.
 *
 * WHY THIS EXISTS. The reproducibility bar we are aiming at is: another operator sets this
 * up in an evening. A setup document cannot meet that bar on its own, because a document
 * only tells you what to do — it never tells you which of the eleven things you did is the
 * one that is wrong. Every minute a stranger spends bisecting our prose is a minute the
 * write-up cost them.
 *
 * So the contract of this file: run it on a fresh box, and every line either says PASS or
 * says exactly one shell command that fixes it. No line may say "check your configuration".
 *
 * IT REPORTS, IT NEVER REPAIRS. A doctor that silently creates a keypair or writes a
 * config is a doctor you cannot trust to tell you what state you were in — and on this
 * project in particular, a tool that quietly generates a signing key is a tool that can
 * quietly replace an identity. Everything here is read-only.
 *
 * IT PRINTS NO SECRETS. Key files are reported as present/absent and by PUBLIC key only.
 * This output is meant to be pasteable into a bug report or a showcase post.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const HOME = process.env.HOME || os.homedir();
const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ reporting */

const results = [];
let hardFailures = 0;

const C = process.stdout.isTTY
  ? { pass: '\x1b[32m', fail: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[90m', off: '\x1b[0m' }
  : { pass: '', fail: '', warn: '', dim: '', off: '' };

/**
 * @param level 'PASS' | 'FAIL' | 'WARN'  — WARN never fails the run; it marks a capability
 *   that is genuinely optional (posting to Telegram, say), so an operator who only wants to
 *   read the tape is not told their install is broken.
 */
function report(level, name, detail, fix) {
  results.push({ level, name, detail, fix });
  if (level === 'FAIL') hardFailures++;
  const colour = level === 'PASS' ? C.pass : level === 'FAIL' ? C.fail : C.warn;
  console.log(`${colour}${level.padEnd(4)}${C.off}  ${name}${detail ? `  ${C.dim}${detail}${C.off}` : ''}`);
  if (fix && level !== 'PASS') console.log(`      ${C.dim}fix:${C.off} ${fix}`);
}

function section(title) { console.log(`\n${C.dim}── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}${C.off}`); }

/* ------------------------------------------------------------------ probes */

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) return report('PASS', 'node runtime', `v${process.versions.node}`);
  report('FAIL', 'node runtime', `v${process.versions.node}, need >=20`,
    'install Node 20+ (nodejs.org or nvm install 20)');
}

function checkDeps() {
  const pkgPath = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return report('FAIL', 'package.json', 'missing', 'you are not in the tape project root');
  }
  const deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies || {});
  const missing = deps.filter((d) => {
    try { require.resolve(d, { paths: [ROOT] }); return false; } catch { return true; }
  });
  if (!missing.length) return report('PASS', 'dependencies', `${deps.length} resolved`);
  report('FAIL', 'dependencies', `missing: ${missing.join(', ')}`, 'npm ci');
}

/**
 * node_modules must be a REAL directory here. It was a symlink into a sibling project for
 * a while, which meant the whole suite passed on this machine and could not run anywhere
 * else — a green test run that proved nothing about a stranger's box.
 */
function checkNodeModulesIsReal() {
  const nm = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(nm)) return; // already covered by checkDeps
  const st = fs.lstatSync(nm);
  if (!st.isSymbolicLink()) return report('PASS', 'node_modules', 'real directory');
  report('FAIL', 'node_modules', `symlink -> ${fs.readlinkSync(nm)}`,
    'rm node_modules && npm ci   # deps must be self-contained');
}

/**
 * Has the sweep left evidence that it ran?
 *
 * The rows are only worth writing if something reads them, and the reader has to be
 * somewhere that runs on its own — a checker only invoked when someone suspects a problem
 * inherits the exact weakness it was built to remove.
 *
 * WARN, never FAIL. A gap here is not misconduct: a downed box, a failed cron and a
 * deliberately skipped sweep produce the identical shape and the chain cannot separate
 * them. FAIL would assert an intent this check cannot see.
 */
function checkSweepCoverage() {
  const { DATA_DIR } = require('../lib/datadir');
  const W = require('../lib/windows');
  const { Chain } = require('../lib/chain');
  const tape = path.join(DATA_DIR, 'tape.jsonl');
  if (!fs.existsSync(tape)) return report('WARN', 'sweep coverage', 'no chain yet');
  const c = W.sweepCoverage(new Chain(tape).read(),
    { interval_sec: 3600, now: Math.floor(Date.now() / 1000) });
  if (!c.covered) {
    return report('WARN', 'sweep coverage', 'no sweep_report row yet — liveness unproven, not disproven',
      'node bin/windows.js sweep');
  }
  if (c.ok) return report('PASS', 'sweep coverage', `${c.reports} report(s), no gap since ${c.from}`);
  const g = c.gaps[c.gaps.length - 1];
  report('WARN', 'sweep coverage',
    `${c.gaps.length} gap(s); latest ${g.from} → ${g.to} (~${g.missed} missed run(s))`,
    'check the tape-window-drive-cmd cron; the gap stays on the record either way');
}

function checkDataDir() {
  const { DATA_DIR } = require('../lib/datadir');
  if (!fs.existsSync(DATA_DIR)) {
    return report('FAIL', 'data directory', DATA_DIR, `mkdir -p ${DATA_DIR}`);
  }
  try {
    const probe = path.join(DATA_DIR, '.doctor-write-probe');
    fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe);
    const tape = path.join(DATA_DIR, 'tape.jsonl');
    const entries = fs.existsSync(tape)
      ? fs.readFileSync(tape, 'utf8').split('\n').filter(Boolean).length : 0;
    report('PASS', 'data directory', `${DATA_DIR} (${entries} entries, writable)`);
  } catch (e) {
    report('FAIL', 'data directory', `${DATA_DIR} not writable: ${e.code}`,
      `chown -R $USER ${DATA_DIR}`);
  }
}

/**
 * Can the process that accepts PUBLIC writes actually write?
 *
 * checkDataDir above probes as whoever ran the doctor. That is the wrong user. The intake
 * runs sandboxed under its own account (see /etc/systemd/system/tape-api.service), and on
 * 2026-07-31 the chain file ended up group `ubuntu` instead of group `tapesvc` after the
 * operator restored it from a backup with a copy that carried its own group. Everything
 * kept returning 200 to the operator, whose own writes went through the CLI as `ubuntu`.
 * From outside, every enrolment and every posted call came back
 * `EACCES: permission denied` — the intake was up, reachable, correctly signed, and
 * silently write-dead. The only thing that found it was a POSITIVE CONTROL: enrolling in a
 * live epoch from an empty directory, as a stranger, right after checking that the negative
 * case was refused.
 *
 * So this check asks the question in the user that matters, and reports rather than fixes.
 */
function checkIntakeWritable() {
  const { DATA_DIR } = require('../lib/datadir');
  const tape = path.join(DATA_DIR, 'tape.jsonl');
  const unit = '/etc/systemd/system/tape-api.service';
  if (!fs.existsSync(unit)) {
    return report('WARN', 'intake write access', 'no systemd unit found — assuming the intake runs as this user');
  }
  let svcUser = null;
  try { svcUser = (/^\s*User=(\S+)/m.exec(fs.readFileSync(unit, 'utf8')) || [])[1] || null; }
  catch (e) { return report('WARN', 'intake write access', `could not read ${unit}: ${e.code}`); }
  if (!svcUser) return report('WARN', 'intake write access', `${unit} names no User=`);
  if (!fs.existsSync(tape)) return report('WARN', 'intake write access', 'no chain file yet');

  const { execFileSync } = require('child_process');
  let uid, gids;
  try {
    uid = Number(execFileSync('id', ['-u', svcUser], { encoding: 'utf8' }).trim());
    gids = execFileSync('id', ['-G', svcUser], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  } catch (e) {
    return report('WARN', 'intake write access', `no such user ${svcUser}`);
  }
  const st = fs.statSync(tape);
  const writable = uid === 0
    || (st.uid === uid && (st.mode & 0o200))
    || (gids.includes(st.gid) && (st.mode & 0o020))
    || (st.mode & 0o002);
  if (writable) {
    return report('PASS', 'intake write access', `${svcUser} can append to tape.jsonl `
      + `(${(st.mode & 0o777).toString(8)}, gid ${st.gid})`);
  }
  report('FAIL', 'intake write access',
    `${svcUser} CANNOT write ${tape} (mode ${(st.mode & 0o777).toString(8)}, uid ${st.uid}, gid ${st.gid}) `
    + '— the public intake is up but every external call and enrolment will be refused with EACCES',
    `sudo chgrp ${svcUser} ${tape} && chmod 664 ${tape}`);
}

/** Report a keypair file by PUBLIC key only. Never echoes bytes. */
function describeKeypair(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const secret = Uint8Array.from(Array.isArray(raw) ? raw : raw.secretKey || []);
  if (secret.length !== 64) throw new Error(`expected a 64-byte secret key array, got ${secret.length}`);
  const { Keypair } = require('@solana/web3.js');
  return Keypair.fromSecretKey(secret).publicKey.toBase58();
}

function checkAnchorKey() {
  const file = process.env.TAPE_KEY || path.join(HOME, '.config/cadence-secure/faucet-wallet.json');
  if (!fs.existsSync(file)) {
    return report('FAIL', 'anchor key', `not found at ${file}`,
      `solana-keygen new -o ${file}   # or set TAPE_KEY=/path/to/keypair.json`);
  }
  try {
    const pub = describeKeypair(file);
    report('PASS', 'anchor key', `${pub}  (${file})`);
    return pub;
  } catch (e) {
    report('FAIL', 'anchor key', `unreadable: ${e.message}`,
      `check ${file} is a solana-keygen JSON array`);
  }
  return null;
}

function checkReceiptKey() {
  const file = process.env.TAPE_RECEIPT_KEY || path.join(HOME, '.config/cadence-secure/tape-receipt-key.json');
  if (!fs.existsSync(file)) {
    return report('WARN', 'receipt key', `not found at ${file} — receipts will be unsigned`,
      `solana-keygen new -o ${file}   # or set TAPE_RECEIPT_KEY`);
  }
  try { report('PASS', 'receipt key', describeKeypair(file)); }
  catch (e) { report('WARN', 'receipt key', `unreadable: ${e.message}`, `regenerate ${file}`); }
}

function getJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'tape-doctor' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function postRpc(url, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ host: u.host, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function checkRpcAndBalance(anchorPub) {
  const url = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  let slot;
  try {
    const r = await postRpc(url, { jsonrpc: '2.0', id: 1, method: 'getSlot' });
    slot = r.result;
    if (!Number.isInteger(slot)) throw new Error(JSON.stringify(r.error || r).slice(0, 120));
    report('PASS', 'solana rpc', `${new URL(url).host} at slot ${slot}`);
  } catch (e) {
    return report('FAIL', 'solana rpc', `${url}: ${e.message}`,
      'export SOLANA_RPC_URL=https://your-provider   # public mainnet endpoint is rate-limited');
  }

  if (!anchorPub) return;
  try {
    const r = await postRpc(url, { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [anchorPub] });
    const lamports = r.result && r.result.value;
    const sol = (lamports || 0) / 1e9;
    // One anchor costs ~0.000006 SOL. Under 0.001 is roughly 150 anchors of runway, which
    // is days, not months — worth saying out loud before it fails at 3am.
    if (sol >= 0.001) report('PASS', 'anchor balance', `${sol.toFixed(6)} SOL`);
    else report('WARN', 'anchor balance', `${sol.toFixed(6)} SOL — low, anchoring stops when it hits zero`,
      `send SOL to ${anchorPub}   # ~0.000006 SOL per anchor`);
  } catch (e) {
    report('WARN', 'anchor balance', `could not read: ${e.message}`, 'retry, or use a private RPC');
  }
}

/**
 * The price chain is the piece most likely to be broken by something outside the operator's
 * control, so it is probed source by source rather than as a single yes/no. Knowing that
 * three of four answered is a completely different situation from none answering.
 */
async function checkPriceSources() {
  const { SOURCES } = require('../lib/price-sources');
  const at = Math.floor(Date.now() / 1000) - 3600;
  let alive = 0;
  for (const s of SOURCES) {
    try {
      const r = await s.fetch('SOL/USD', at, { latest: false });
      alive++;
      report('PASS', `price source: ${s.name}`, `SOL/USD ${r.price}${s.primary ? '  (primary)' : ''}`);
    } catch (e) {
      report('WARN', `price source: ${s.name}`, e.message.slice(0, 80),
        `curl a request by hand to see if it is you or them`);
    }
  }
  if (!alive) {
    report('FAIL', 'price chain', 'no source answered — nothing can be marked or settled',
      'check outbound https from this host');
  }
}

async function checkApi() {
  const port = process.env.TAPE_API_PORT || 3218;
  const http = require('http');
  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(b);
          report('PASS', 'local api', `127.0.0.1:${port} — ${j.entries} entries, head ${String(j.head).slice(0, 12)}…`);
        } catch { report('WARN', 'local api', `port ${port} answered but not with JSON`, 'npm run api'); }
        resolve();
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => {
      report('WARN', 'local api', `nothing listening on 127.0.0.1:${port}`,
        'npm run api   # needed only if you serve your own tape; readers can use TAPE_API');
      resolve();
    });
  });
}

/**
 * The skill bundle is what makes this a ZeroClaw agent rather than a web service, and it is
 * the piece a stranger is most likely to skip — it lives outside the repo once installed.
 */
function checkSkillBundle() {
  const dir = path.join(HOME, '.zeroclaw/shared/skills/tape/tape');
  const local = path.join(ROOT, 'zeroclaw/skills/tape');
  if (!fs.existsSync(local)) {
    return report('WARN', 'skill bundle (source)', 'not in repo at zeroclaw/skills/tape',
      'this checkout predates the bundle being shipped in-repo');
  }
  if (fs.existsSync(path.join(dir, 'SKILL.toml'))) {
    return report('PASS', 'skill bundle', `installed at ${dir}`);
  }
  report('WARN', 'skill bundle', 'in repo but not installed for zeroclaw',
    './zeroclaw/install-skill.sh');
}

/* ------------------------------------------------------------------ main */

(async () => {
  console.log(`\n${C.dim}tape doctor${C.off} — reports, never repairs. No secrets are printed.\n`
    + `${C.dim}project: ${ROOT}${C.off}`);

  section('runtime');
  checkNode();
  checkNodeModulesIsReal();
  checkDeps();

  section('storage');
  checkDataDir();
  checkSweepCoverage();
  checkIntakeWritable();

  section('keys  (public keys only)');
  const anchorPub = checkAnchorKey();
  checkReceiptKey();

  section('network');
  await checkRpcAndBalance(anchorPub);
  await checkPriceSources();

  section('services');
  await checkApi();
  checkSkillBundle();

  const pass = results.filter((r) => r.level === 'PASS').length;
  const warn = results.filter((r) => r.level === 'WARN').length;
  console.log(`\n${pass} pass  ${warn} warn  ${hardFailures} fail`);

  if (hardFailures) {
    console.log(`\n${C.fail}Not ready.${C.off} Fix the FAIL lines above, then run this again.`);
    process.exit(1);
  }
  console.log(`\n${C.pass}Ready.${C.off} Warnings are optional capabilities, not breakage.`);
})().catch((e) => { console.error('doctor crashed:', e); process.exit(2); });
