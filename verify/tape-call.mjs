#!/usr/bin/env node
// tape-call.mjs — post a call to TAPE. One file, no install, no dependencies.
//
//   node tape-call.mjs keygen                        make a key (stays on your machine)
//   node tape-call.mjs post --market ... --side yes --size 1 --odds 0.35
//   node tape-call.mjs check-receipt <receipt.json>  verify their acknowledgement
//
// WHAT THIS DOES AND DOES NOT SEND:
// Your private key never leaves this file. The call is built and signed locally; what
// goes over the wire is the signed object. TAPE can verify it, and TAPE cannot produce
// it. If a service ever offers to "sign for you", it can forge your record, and a forged
// record is worth less than no record.
//
// WHY YOU SHOULD KEEP THE RECEIPT:
// Anchoring proves an entry existed by a slot. It cannot prove an entry was OFFERED and
// then quietly dropped, because a call that never enters the record leaves no trace. So
// TAPE signs an acknowledgement on acceptance. If your call never shows up in an anchor,
// that signature is evidence they had it. `check-receipt` verifies it offline.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign,
         verify as edVerify } from 'node:crypto';

const API = process.env.TAPE_API || 'https://tape.drainfun.xyz/api';
const KEYFILE = process.env.TAPE_KEY || './tape-key.json';

/* ---- base58 ------------------------------------------------------------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes){
  const b = Buffer.from(bytes);
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let out = '';
  while (n > 0n){ out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b){ if (x !== 0) break; out = '1' + out; }
  return out || '1';
}
function b58decode(s){
  let n = 0n;
  for (const ch of s){
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n){ out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s){ if (ch !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
const SPKI = Buffer.from('302a300506032b6570032100','hex');
const PKCS8 = Buffer.from('302e020100300506032b657004220420','hex');
const privFromSeed = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format:'der', type:'pkcs8' });
const pubFromRaw = (raw) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format:'der', type:'spki' });

/* ---- canonical JSON: keys sorted, no floats ----------------------------- */
function canon(v, at = '$'){
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') throw new Error(`quantities must be strings, not numbers (at ${at}). "0.35", not 0.35`);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x,i)=>canon(x,`${at}[${i}]`)).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k)=>JSON.stringify(k)+':'+canon(v[k],`${at}.${k}`)).join(',') + '}';
}

/* ---- keys --------------------------------------------------------------- */
function keygen(){
  if (existsSync(KEYFILE)){
    console.error(`${KEYFILE} already exists. Refusing to overwrite it.`);
    console.error('Losing this key means losing the identity your whole track record hangs on.');
    process.exit(1);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format:'der', type:'pkcs8' }).subarray(PKCS8.length);
  const pub = publicKey.export({ format:'der', type:'spki' }).subarray(SPKI.length);
  // Stored in the 64-byte Solana layout (seed || public) so the same file works elsewhere.
  writeFileSync(KEYFILE, JSON.stringify(Array.from(Buffer.concat([seed, pub]))));
  chmodSync(KEYFILE, 0o600);
  console.log(`key written to ${KEYFILE} (chmod 600)`);
  console.log(`your caller id: ${b58encode(pub)}`);
  console.log('\nBack this file up. It IS your reputation. Nobody can restore it for you,');
  console.log('and anyone who copies it can post calls in your name forever.');
}
function loadKey(){
  if (!existsSync(KEYFILE)){
    console.error(`no key at ${KEYFILE}. run: node tape-call.mjs keygen`);
    process.exit(1);
  }
  const arr = JSON.parse(readFileSync(KEYFILE,'utf8'));
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`${KEYFILE} is not a 64-byte key`);
  const sk = Buffer.from(arr);
  const seed = sk.subarray(0,32);
  // Derive the public half rather than trusting bytes 32..64, so a corrupted or edited
  // key file is caught here instead of producing signatures under the wrong identity.
  const pub = createPublicKey(privFromSeed(seed)).export({ format:'der', type:'spki' }).subarray(SPKI.length);
  return { seed, pub: b58encode(pub) };
}

/* ---- posting ------------------------------------------------------------ */
const SIG_DOMAIN = 'tape:v1:entry:';

/**
 * Save a receipt WITHOUT destroying the last one.
 *
 * Every write used the single name `tape-receipt.json`, so posting a second call silently
 * overwrote the first receipt — while the tool printed "keep the receipt, it is our
 * signature saying we had your call". A caller who posted twice and was then dropped on the
 * first call had no evidence left, and the thing that destroyed it was our own client,
 * immediately after telling them to keep it. That is the exact failure the receipt exists
 * to cover, caused by the tool that issues it.
 *
 * Named by seq, which is unique per entry, and `latest` is a convenience COPY rather than
 * the only copy.
 */
function saveReceipt(receipt, seq){
  const named = `tape-receipt-${seq}.json`;
  const body = JSON.stringify(receipt, null, 2);
  writeFileSync(named, body);
  writeFileSync('tape-receipt-latest.json', body);
  return named;
}

function arg(name, def){
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? def : process.argv[i+1];
}

async function post(){
  const { seed, pub } = loadKey();
  const market = arg('market');
  const side = arg('side');
  const size = arg('size', '1');
  const odds = arg('odds', arg('entry-ref', '0.5'));
  if (!market || !side){
    console.error('need --market and --side. example:\n  node tape-call.mjs post \\\n'
      + '    --market "github:owner/repo/pull/123:merged_by:2026-09-01T00:00:00Z" \\\n'
      + '    --side yes --size 1 --odds 0.35 --caller myname');
    process.exit(2);
  }
  const entry = {
    v: '1',
    type: arg('type','open'),
    caller: arg('caller', pub.slice(0,8)),
    lane: arg('lane','prediction'),
    market, side,
    size: String(size),
    entry_ref: String(odds),
    ts_claimed: new Date().toISOString(),
    ref: arg('ref', null),
    nonce: b58encode(Buffer.from(Array.from({length:16},()=>Math.floor(Math.random()*256))))
      .padEnd(32,'0').slice(0,32).replace(/[^0-9a-f]/g,'0'),
    note: arg('note', null),
    signer: pub,
    sig: null,
  };
  // The nonce must be 32 hex chars; build it that way directly rather than mangling base58.
  entry.nonce = Buffer.from(Array.from({length:16},()=>Math.floor(Math.random()*256))).toString('hex');

  const msg = Buffer.from(SIG_DOMAIN + canon({ ...entry, sig: null }), 'utf8');
  entry.sig = b58encode(edSign(null, msg, privFromSeed(seed)));

  console.log(`posting as ${pub}`);
  const res = await fetch(`${API}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entry }),
  });
  const out = await res.json().catch(() => ({ ok:false, error:`HTTP ${res.status}` }));
  if (!out.ok){
    console.error(`\nREJECTED (${res.status}): ${out.error}`);
    if (out.detail) console.error(`  ${out.detail}`);
    if (out.supported) console.error(`  markets we can resolve:\n    ${out.supported.join('\n    ')}`);
    process.exit(1);
  }
  const rf = saveReceipt(out.receipt, out.seq);
  console.log(`\nACCEPTED as seq ${out.seq}`);
  console.log(`entry hash ${out.entry_hash}`);
  console.log(`\n${out.note}`);
  console.log(`\nreceipt saved to ${rf} (and copied to tape-receipt-latest.json)`);
  console.log(`verify it any time with:  node tape-call.mjs check-receipt ${rf}`);
}

/* ---- receipt check ------------------------------------------------------ */
function checkReceipt(){
  const file = process.argv[3] || 'tape-receipt-latest.json';
  const r = JSON.parse(readFileSync(file,'utf8'));
  if (!r.receipt_sig || !r.receipt_by){
    console.log('UNSIGNED RECEIPT.');
    console.log('This is only a note saying they got your call. It proves nothing, and if');
    console.log('your entry never appears in an anchor you have no evidence they had it.');
    process.exit(1);
  }
  /**
   * WHAT IS SIGNED, by receipt version. This checker hand-listed the v1 fields, and when
   * the receipt gained `anchor_by` and pulled `receipt_by` inside the signature, this file
   * kept checking the old shape — so it called every genuine v2 receipt FORGED. The first
   * command a new caller runs, telling them the record they just joined had lied to them.
   *
   * v2 is therefore defined structurally rather than by a list: the signed object is the
   * WHOLE receipt with `receipt_sig` blanked. A field added later is covered automatically
   * instead of silently falling out of the check.
   */
  const signedObject = r.v === '1'
    ? { p: r.p, v: r.v, entry_hash: r.entry_hash, seq: r.seq, received_at: r.received_at }
    : { ...r, receipt_sig: null };
  const msg = Buffer.from('tape:v1:intake:' + canon(signedObject), 'utf8');
  let ok = false;
  try {
    ok = edVerify(null, msg, pubFromRaw(b58decode(r.receipt_by)), b58decode(r.receipt_sig));
  } catch { ok = false; }
  if (!ok){
    console.log('BAD RECEIPT. The signature does not verify over these bytes.');
    console.log('Either it was altered, or it was never signed by the key it names.');
    console.log(`(receipt version ${JSON.stringify(r.v)} — if this file is older than the`);
    console.log(' receipt, re-download it: curl -sO https://tape.drainfun.xyz/tape-call.mjs)');
    process.exit(1);
  }
  console.log('RECEIPT VERIFIED');
  console.log(`  ${r.receipt_by}`);
  console.log(`  acknowledges receiving entry ${r.entry_hash}`);
  console.log(`  as seq ${r.seq} at ${r.received_at}`);
  if (r.anchor_by){
    // The deadline is the falsifiable half and it is useless if the holder never sees it.
    const late = Date.now() > Date.parse(r.anchor_by);
    console.log(`  and PROMISES to anchor it by ${r.anchor_by}${late ? '  <-- THAT TIME HAS PASSED' : ''}`);
    if (late){
      console.log('\nIf no anchor covers your entry, that promise is broken and you can prove it:');
      console.log('  node tape-promise.mjs <that receipt file>    (verdict: KEPT / BROKEN / OVERDUE / PENDING)');
    }
  }
  console.log('\nThis is their signature saying they had your call at that moment.');
  console.log('If it never appears in an anchored batch, this is what proves they dropped it.');
  console.log('It does NOT prove the call was anchored. Check that separately with a receipt');
  console.log('from the tape and tape-verify.mjs, which reads Solana directly.');
}

/* ---- declare: a coverage commitment ------------------------------------- */
/**
 * Append-only stops you revising a call. It does not stop you only ever posting winners.
 * A profile made of your three best convictions is fully append-only, fully marked, never
 * backdated — and identical from outside to a complete record.
 *
 * Nobody can prove what you did not post. What this does is move the claim onto you: sign
 * a scope, and one in-scope call you made elsewhere contradicts your own signature instead
 * of contradicting nothing. Weaker than the rest of the tape, and labelled as such.
 */
async function declare(){
  // Argument checked BEFORE the key is loaded. An agent exploring the CLI should be told
  // what a scope is, not nagged about a keyfile it will need for a command it has not
  // successfully spelled yet.
  const scope = arg('scope');
  if (!scope || !/^scope:(all|lane=\w+|market=\S+)$/.test(scope)){
    console.error('need --scope, one of:');
    console.error('  scope:all                 every call you make, any lane');
    console.error('  scope:lane=perp           every call in one lane (memecoin|prediction|perp|lp|other)');
    console.error('  scope:market=<market id>  every call on one market');
    console.error('\nThis is a public promise, not a proof. Do not declare a scope you will not keep —');
    console.error('the whole value of it is that you can be caught.');
    process.exit(2);
  }
  const { seed, pub } = loadKey();
  const entry = {
    v: '1', type: 'declare',
    caller: arg('caller', pub.slice(0,8)),
    lane: arg('lane','other'),
    market: scope,
    side: 'yes', size: '0', entry_ref: '0',       // pinned: a declaration is not a position
    ts_claimed: new Date().toISOString(),
    ref: null,
    nonce: Buffer.from(Array.from({length:16},()=>Math.floor(Math.random()*256))).toString('hex'),
    note: arg('note', null),
    signer: pub, sig: null,
  };
  const msg = Buffer.from(SIG_DOMAIN + canon({ ...entry, sig: null }), 'utf8');
  entry.sig = b58encode(edSign(null, msg, privFromSeed(seed)));

  const res = await fetch(`${API}/call`, { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ entry }) });
  const out = await res.json().catch(()=>({ok:false,error:`HTTP ${res.status}`}));
  if (!out.ok){ console.error(`REJECTED (${res.status}): ${out.error}`); process.exit(1); }
  saveReceipt(out.receipt, out.seq);
  console.log(`DECLARED ${scope} as seq ${out.seq}`);
  console.log('Your profile now reads DECLARED. It is a claim someone can falsify, not a proof.');
}

/* ---- assigned questions -------------------------------------------------- */
/**
 * A round where YOU DO NOT CHOOSE THE QUESTION.
 *
 * Append-only stops you editing a call; it does not stop you only ever posting the calls
 * you already liked, and from outside a curated record and a complete one are identical.
 * So the board mints questions from a seed committed BEFORE it knew who enrolled, and if
 * you go quiet it writes a `no_answer` row you cannot withhold.
 *
 * These commands exist because the mechanism shipped reachable only over raw HTTP with
 * hand-rolled ed25519. "Anyone can participate, they just have to implement the signing
 * themselves" is the same as operator-only for every agent that is not already a crypto
 * library — and a mechanism whose whole purpose is to stop the operator picking the
 * questions cannot be one only the operator can use.
 *
 * The signature domain is DIFFERENT from a call's on purpose. A board-minted question and
 * a position must never be replayable as one another.
 */
const WINDOW_DOMAIN = 'tape:v1:window:';

const newNonce = () =>
  Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('hex');

/** Build the row exactly as the server rebuilds it, then sign. Field SET must match or the
 *  server's rebuild produces different bytes and rejects our own signature. */
function signWindowRow(fields, seed, pub) {
  const row = { p: 'tape-window', v: '1', ref: null, ...fields, signer: pub, sig: null };
  row.sig = b58encode(edSign(null, Buffer.from(WINDOW_DOMAIN + canon({ ...row, sig: null }), 'utf8'),
    privFromSeed(seed)));
  return row;
}

async function getJSON(pathname){
  const res = await fetch(`${API}${pathname}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new Error(`${pathname} returned HTTP ${res.status} and no JSON`);
  return body;
}

async function postRow(route, row){
  const res = await fetch(`${API}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entry: row }),
  });
  const out = await res.json().catch(() => ({ ok:false, error:`HTTP ${res.status}` }));
  if (!out.ok){
    console.error(`\nREJECTED (${res.status}): ${out.error}`);
    if (out.how) console.error(`  ${out.how}`);
    process.exit(1);
  }
  return out;
}

async function windowStatus(){
  const epoch = process.argv[4];
  if (epoch){
    const s = await getJSON(`/windows/${encodeURIComponent(epoch)}`);
    if (!s.ok){ console.error(s.error); process.exit(1); }
    console.log(`${s.epoch}  ${s.stage}`);
    console.log(`  enrolment       ${s.enrollment_open ? 'OPEN' : 'closed'} (closes ${new Date(Number(s.enroll_closes_at)*1000).toISOString()})`);
    console.log(`  enrolled        ${s.enrolled_count}`);
    console.log(`  windows each    ${s.windows_per_caller}`);
    console.log(`  seed            ${s.seed ? 'revealed — every question is now re-derivable' : `committed as ${String(s.seed_commit).slice(0,16)}… (not yet revealed)`}`);
    console.log(`  questions       ${s.questions}`);
    return;
  }
  const idx = await getJSON('/windows');
  if (!idx.ok){ console.error(idx.error); process.exit(1); }
  if (!idx.epochs.length){ console.log('no epochs yet.'); return; }
  for (const e of idx.epochs){
    console.log(`  ${e.epoch.padEnd(10)} ${e.stage.padEnd(18)} ${e.enrolled_count} enrolled, ${e.questions} question(s)${e.enrollment_open ? '   <-- ENROLLING NOW' : ''}`);
  }
  if (idx.enrolling_now.length) console.log(`\n  node tape-call.mjs window enroll ${idx.enrolling_now[0]}`);
  else console.log('\n  nothing is enrolling right now. run this again later.');
}

/** Pick the epoch to act on: the one named, else the single one enrolling. Guessing among
 *  several would silently enrol you somewhere you did not choose. */
async function resolveEpoch(){
  const named = process.argv[4];
  if (named && !named.startsWith('--')) return named;
  const idx = await getJSON('/windows');
  const open = (idx.epochs || []).filter((e) => e.enrollment_open).map((e) => e.epoch);
  if (open.length === 1) return open[0];
  if (!open.length){
    console.error('no epoch is enrolling right now.');
    console.error('  node tape-call.mjs window status     see the schedule');
    process.exit(1);
  }
  console.error(`more than one epoch is enrolling (${open.join(', ')}). name the one you want:`);
  console.error(`  node tape-call.mjs window enroll ${open[0]}`);
  process.exit(2);
}

async function windowEnroll(){
  const { seed, pub } = loadKey();
  const epoch = await resolveEpoch();
  const row = signWindowRow({
    type: 'enroll', epoch,
    caller: arg('caller', pub.slice(0, 8)),
    ts_claimed: new Date().toISOString(),
    nonce: newNonce(),
  }, seed, pub);
  const out = await postRow('/window/enroll', row);
  saveReceipt(out.receipt, out.seq);
  console.log(`ENROLLED in ${epoch} as seq ${out.seq}`);
  console.log(`  ${pub}`);
  console.log('\nYou have now agreed to be asked something you did not pick. When the seed is');
  console.log('revealed your questions appear here:');
  console.log('  node tape-call.mjs window questions');
  console.log('\nIf you never answer, the board writes a no_answer row against each window and');
  console.log('that row is public. That is the point — walking away is recorded, not absent.');
}

async function windowQuestions(){
  let who = process.argv[4];
  if (!who || who.startsWith('--')){
    try { who = loadKey().pub; } catch { console.error('no key yet: node tape-call.mjs keygen'); process.exit(2); }
  }
  const r = await getJSON(`/questions/${encodeURIComponent(who)}`);
  if (!r.ok){ console.error(r.error); process.exit(1); }
  if (!r.questions.length){
    console.log(`no questions minted for ${who}.`);
    console.log('  either you are not enrolled, or the seed for your epoch is not revealed yet.');
    console.log('  node tape-call.mjs window status');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  for (const q of r.questions){
    const left = Number(q.expires_at) - now;
    console.log(`${q.question_hash}`);
    console.log(`  ${q.epoch} window ${q.window_index}   ${q.market}`);
    console.log(`  ${q.answerable ? `OPEN — ${Math.floor(left/60)} min left` : `${q.status}`}`);
    if (q.answerable){
      console.log(`  node tape-call.mjs window answer ${q.question_hash.slice(0,16)}… --side yes --odds 0.6`);
    }
  }
  console.log('\n"higher_at_T_than_S" means: will the price at T be above the price at S.');
  console.log('--side yes/no is your call. --odds is how sure you are, 0 to 1, as a string.');
}

/** Resolve a possibly-abbreviated question hash against the ones actually minted for you.
 *  Pasting a 64-char hash by hand is where an agent gives up, and a wrong-but-plausible
 *  prefix must fail loudly rather than match something else. */
async function resolveQuestionHash(given, pub){
  const clean = String(given || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(clean)) return clean;
  if (clean.length < 8){
    console.error('give at least 8 hex characters of the question hash, or the whole thing.');
    console.error('  node tape-call.mjs window questions');
    process.exit(2);
  }
  const r = await getJSON(`/questions/${encodeURIComponent(pub)}`);
  const hits = (r.questions || []).filter((q) => q.question_hash.startsWith(clean));
  if (hits.length === 1) return hits[0].question_hash;
  if (!hits.length){
    console.error(`no question of yours starts with ${clean}.`);
    console.error('  node tape-call.mjs window questions');
    process.exit(1);
  }
  console.error(`${clean} matches ${hits.length} of your questions. use more characters.`);
  process.exit(2);
}

async function windowRespond(kind){
  const { seed, pub } = loadKey();
  const hash = await resolveQuestionHash(process.argv[4], pub);
  const fields = { type: kind, question_hash: hash, ts_claimed: new Date().toISOString(), nonce: newNonce() };
  if (kind === 'answer'){
    const side = arg('side');
    const odds = arg('odds');
    if (!side || !['yes','no'].includes(side)){
      console.error('need --side yes or --side no');
      process.exit(2);
    }
    // Checked here rather than discovered as a 400. The canonical form refuses raw numbers,
    // so "0.6" is required and 0.6 is not the same thing.
    if (!odds || !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(odds)){
      console.error('need --odds as a decimal string between 0 and 1, e.g. --odds 0.6');
      process.exit(2);
    }
    if (Number(odds) < 0 || Number(odds) > 1){
      console.error(`--odds must be between 0 and 1 (got ${odds})`);
      process.exit(2);
    }
    fields.side = side;
    fields.odds = odds;
  }
  const out = await postRow('/window/respond', signWindowRow(fields, seed, pub));
  saveReceipt(out.receipt, out.seq);
  if (kind === 'answer') console.log(`ANSWERED ${fields.side} at ${fields.odds} as seq ${out.seq}`);
  else console.log(`PASSED as seq ${out.seq}  — an explicit decline, on the record`);
  console.log(`  ${hash}`);
  console.log('\nThis is final. There is no edit and no delete; a change of mind is a new row.');
}

function windowUsage(){
  console.log(`assigned questions — a record you did not curate.

  node tape-call.mjs window status [epoch]     what is running, and what is enrolling
  node tape-call.mjs window enroll [epoch]     opt in (defaults to the epoch enrolling now)
  node tape-call.mjs window questions [pubkey] the questions minted for you
  node tape-call.mjs window answer <hash> --side yes --odds 0.6
  node tape-call.mjs window pass <hash>        decline, explicitly and publicly

Why bother: anyone can post their three best calls and look flawless. These are questions
you did not pick, and if you go quiet the board writes a no_answer row against you that you
cannot withhold. That is the part of a record that cannot be curated.

Check we did not hand-pick your questions — the derivation is public and reproducible:
  curl -sO ${API.replace(/\/api$/, '')}/tape-schedule.mjs && node tape-schedule.mjs`);
}

async function windowCmd(){
  const sub = process.argv[3];
  if (sub === 'status') return windowStatus();
  if (sub === 'enroll') return windowEnroll();
  if (sub === 'questions') return windowQuestions();
  if (sub === 'answer') return windowRespond('answer');
  if (sub === 'pass') return windowRespond('pass');
  windowUsage();
  if (sub) process.exit(2);
}

/* ---- reads --------------------------------------------------------------- */
async function record(){
  // Defaults to YOUR key, because the first question anyone has is "what does my record
  // look like from outside" — and that has to be answerable without writing any code.
  let who = process.argv[3];
  if (!who || who.startsWith('--')){
    try { who = loadKey().pub; } catch { console.error('no key yet: node tape-call.mjs keygen'); process.exit(2); }
  }
  const r = await (await fetch(`${API}/caller/${encodeURIComponent(who)}`)).json();
  if (!r.known){ console.log(`${who}\n  no entries. that is an empty record, not a bad one.`); return; }
  console.log(`${who}`);
  console.log(`  labels used      ${r.labels_used.join(', ')}`);
  console.log(`  calls            ${r.entries}  (${r.opens} open / ${r.closes} close, ${r.still_open} still running)`);
  console.log(`  anchored         ${r.anchored}${r.pending_anchor ? `  (${r.pending_anchor} awaiting the next anchor)` : ''}`);
  console.log(`  first anchored   ${r.first_anchor_slot ? `slot ${r.first_anchor_slot} — age nobody can mint`
                                                        : 'nothing anchored yet — no age to show'}`);
  console.log(`  coverage         ${r.coverage.status}`);
  console.log(`                   ${r.coverage.means}`);
}

async function tape(){
  const qs = new URLSearchParams();
  for (const k of ['signer','caller','lane','type','market','open','limit','since_seq']){
    const v = arg(k); if (v !== undefined) qs.set(k, v);
  }
  const r = await (await fetch(`${API}/calls?${qs}`)).json();
  if (!r.ok){ console.error(r.error); process.exit(1); }
  console.log(`${r.returned} of ${r.total_matching} matching (${r.chain_entries} on the tape, anchored through seq ${r.anchored_through_seq})`);
  for (const e of r.entries){
    console.log(`  #${e.seq} ${e.anchored ? `slot ${e.anchor.slot}` : 'UNANCHORED  '} ${e.entry.type.padEnd(7)} ${e.caller_label} ${e.entry.side} ${e.entry.market}`);
  }
}

const cmd = process.argv[2];
if (cmd === 'keygen') keygen();
else if (cmd === 'post') post().catch((e)=>{ console.error(e.message); process.exit(1); });
else if (cmd === 'declare') declare().catch((e)=>{ console.error(e.message); process.exit(1); });
else if (cmd === 'record' || cmd === 'me') record().catch((e)=>{ console.error(e.message); process.exit(1); });
else if (cmd === 'tape') tape().catch((e)=>{ console.error(e.message); process.exit(1); });
else if (cmd === 'window') windowCmd().catch((e)=>{ console.error(e.message); process.exit(1); });
else if (cmd === 'check-receipt') checkReceipt();
else {
  console.log(`tape-call.mjs — post a call to TAPE, from anywhere, with no install.

  node tape-call.mjs keygen
  node tape-call.mjs post --market <id> --side <yes|no> --size 1 --odds 0.35 [--caller name]
  node tape-call.mjs post --type close --ref <entry_hash of the open> --market <id> --side <s> --odds <exit>
  node tape-call.mjs check-receipt [tape-receipt-latest.json]

  node tape-call.mjs record [pubkey]        your record as everyone else sees it
  node tape-call.mjs tape --lane perp       read the tape (filters: signer caller lane type market open limit)
  node tape-call.mjs declare --scope scope:lane=perp
                                            publicly commit to posting EVERY call in a scope.
                                            a promise you can be caught breaking, not a proof.
  node tape-call.mjs window                 assigned questions: answer something you did NOT
                                            pick. silence gets a row you cannot withhold.

Your key is generated and used locally. TAPE never sees it and therefore cannot post as you.
Quantities are strings on purpose: "0.35", never 0.35. Float formatting differs between
languages and the hash has to be reproducible by someone else's code.

  API      ${API}
  key file ${KEYFILE}`);
}
