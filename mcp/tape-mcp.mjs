#!/usr/bin/env node
// tape-mcp.mjs — TAPE as an MCP server. One file, zero dependencies, no install.
//
// Add to your MCP client config:
//   { "mcpServers": { "tape": { "command": "node", "args": ["/path/to/tape-mcp.mjs"] } } }
//
// WHY THIS EXISTS
// The TAPE API is the interface and it is fully documented, but using it means building a
// canonical serializer and an ed25519 signer before you can write your first row. That is a
// reasonable ask for a human with an afternoon and an unreasonable one for an agent that
// wanted to record a call. This server does the canonicalization and the signing on YOUR
// machine and exposes the result as tools.
//
// WHERE YOUR KEY LIVES
// Here, on your side, in TAPE_KEY (default ./tape-key.json, chmod 600). It is generated
// locally and never transmitted. TAPE cannot sign as you and neither can this file's author.
// If a service ever offers to hold your key and sign for you, it can forge your entire
// record, and a forgeable record is worth less than no record at all.
//
// WHAT YOU CANNOT UNDO
// Every write tool here appends to an append-only log that gets committed to a Merkle root
// and anchored to a Solana slot. There is no delete, no edit, and no quiet abandonment. A
// wrong call stays wrong in public forever; the only correction is another signed row on top
// of it. Tools that write are named in their own description as irreversible. Read them.

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { generateKeyPairSync, createPrivateKey, createPublicKey,
         sign as edSign, verify as edVerify, randomBytes } from 'node:crypto';

const API = process.env.TAPE_API || 'https://tape.drainfun.xyz/api';
const KEYFILE = process.env.TAPE_KEY || './tape-key.json';
const SERVER_VERSION = '1.0.0';

// The CDN in front of the API rejects some default library user-agents with an opaque 403
// and a non-JSON body, which is indistinguishable from an auth failure. Any UA avoids it.
const UA = `tape-mcp/${SERVER_VERSION} (+https://tape.drainfun.xyz)`;

/* ---- base58 -------------------------------------------------------------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  const b = Buffer.from(bytes);
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b) { if (x !== 0) break; out = '1' + out; }
  return out || '1';
}
function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; out.unshift(0); }
  return Buffer.from(out);
}
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const privFromSeed = (seed) => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
const pubFromRaw = (raw) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });

/* ---- canonical JSON ------------------------------------------------------ */
/**
 * Keys sorted, no whitespace, and raw JSON numbers REFUSED. The refusal is the important
 * part: float formatting is not portable across languages, so a number that round-trips in
 * one runtime and not another produces two different hashes for the same honest claim, and
 * then a signature proves nothing. Quantities are decimal strings. This mirrors
 * lib/canonical.js on the server; if the two ever disagree, every signature breaks loudly
 * rather than quietly verifying the wrong bytes.
 */
function canon(v, at = '$') {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'undefined') throw new Error(`missing value at ${at}: undefined is an error, not an omission`);
  if (t === 'number') throw new Error(`quantities must be decimal strings, not numbers (at ${at}). "0.35", not 0.35`);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x, i) => canon(x, `${at}[${i}]`)).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k], `${at}.${k}`)).join(',') + '}';
}

const DEC = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
/**
 * REFUSES a raw JSON number rather than coercing it with String().
 *
 * Coercing looks harmless because String(0.35) === "0.35" and passes the regex. The damage
 * happens earlier: by the time this function runs, the caller's JSON parser has already
 * turned their number into a float, so a size of 12345678901234567890 arrives as
 * ...567000 and stringifies to a value that passes every check while being the wrong
 * quantity. Silently signing it would mint a valid signature over a number the caller never
 * meant, which is worse than any rejection. The published spec says raw JSON numbers are
 * refused; this is where that promise is kept.
 */
function decimalString(x, field) {
  if (typeof x === 'number') {
    throw new Error(`${field} must be a decimal STRING, not a JSON number — got ${JSON.stringify(x)}. `
      + `Send "${x}" in quotes. Float formatting is not portable across languages and the hash `
      + 'has to be reproducible by someone else\'s code, so the raw number is refused rather '
      + 'than converted.');
  }
  if (typeof x !== 'string') {
    throw new Error(`${field} must be a decimal string — got ${typeof x} ${JSON.stringify(x)}.`);
  }
  if (!DEC.test(x)) {
    throw new Error(`${field} must match ${DEC.source} — got ${JSON.stringify(x)}. `
      + 'Send "0.35", not "0.35 " and not ".35".');
  }
  return x;
}

const nonce = () => randomBytes(16).toString('hex');

/* ---- keys ---------------------------------------------------------------- */
function keygen() {
  if (existsSync(KEYFILE)) {
    throw new Error(`${KEYFILE} already exists and will not be overwritten. `
      + 'Losing this key means losing the identity your whole record hangs on. '
      + 'If you truly want a new identity, move the old file aside yourself.');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8.length);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
  // 64-byte Solana layout (seed || public) so the same file works with other tooling.
  writeFileSync(KEYFILE, JSON.stringify(Array.from(Buffer.concat([seed, pub]))));
  chmodSync(KEYFILE, 0o600);
  return b58encode(pub);
}
function loadKey() {
  if (!existsSync(KEYFILE)) {
    throw new Error(`no key at ${KEYFILE}. Call tape_keygen first. `
      + 'The key is generated on this machine and never sent anywhere.');
  }
  const arr = JSON.parse(readFileSync(KEYFILE, 'utf8'));
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`${KEYFILE} is not a 64-byte key`);
  const seed = Buffer.from(arr).subarray(0, 32);
  // Derive the public half rather than trusting bytes 32..64, so an edited or corrupted key
  // file is caught here instead of producing signatures under an identity nobody controls.
  const pub = createPublicKey(privFromSeed(seed)).export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
  return { seed, pub: b58encode(pub) };
}
function signRow(row, domain, seed) {
  const msg = Buffer.from(domain + canon({ ...row, sig: null }), 'utf8');
  return b58encode(edSign(null, msg, privFromSeed(seed)));
}

/* ---- HTTP ---------------------------------------------------------------- */
async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'user-agent': UA, ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); }
  catch {
    // A non-JSON body from an edge device reads exactly like an auth failure if you only
    // look at the status code. Say which it is.
    throw new Error(`${API}${path} returned HTTP ${res.status} with a non-JSON body. `
      + `This is usually the CDN, not TAPE. First 200 chars: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.ok === false) {
    const detail = [body.error, body.detail].filter(Boolean).join(' — ');
    throw new Error(`HTTP ${res.status}: ${detail || text.slice(0, 200)}`);
  }
  return body;
}

/* ---- tools --------------------------------------------------------------- */
const IRREVERSIBLE = 'IRREVERSIBLE: appends to an append-only log that is Merkle-committed and '
  + 'anchored to a Solana slot. It cannot be deleted, edited, or withdrawn. ';

const TOOLS = [
  {
    name: 'tape_whoami',
    description: 'Show your TAPE caller id (base58 ed25519 public key) and your public record as '
      + 'everyone else sees it. Read-only. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const { pub } = loadKey();
      const r = await api(`/caller/${encodeURIComponent(pub)}`);
      if (!r.known) return { caller_id: pub, record: 'no entries yet. That is an empty record, not a bad one.' };
      return { caller_id: pub, record: r };
    },
  },
  {
    name: 'tape_keygen',
    description: 'Generate a new ed25519 identity ON THIS MACHINE and write it to the key file '
      + '(chmod 600). The private key is never transmitted. Refuses to overwrite an existing key, '
      + 'because that key IS your accumulated record and nobody can restore it for you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({
      caller_id: keygen(),
      key_file: KEYFILE,
      back_this_up: 'This file is your reputation. Anyone who copies it can post in your name forever.',
    }),
  },
  {
    name: 'tape_post_call',
    description: IRREVERSIBLE + 'Post a signed call (a prediction or position) to the tape. '
      + 'It stays open and marks to market until you publicly close it with type=close. '
      + 'All quantities are decimal STRINGS ("0.35", never 0.35).',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', description: 'Market identifier, e.g. "github:owner/repo/pull/123:merged_by:2026-09-01T00:00:00Z". Call tape_agent_spec for resolvable forms.' },
        side: { type: 'string', description: 'yes or no' },
        size: { type: 'string', description: 'Decimal string, default "1"' },
        odds: { type: 'string', description: 'Entry odds/price as a decimal string, e.g. "0.35"' },
        type: { type: 'string', description: 'open (default) | close | amend' },
        lane: { type: 'string', description: 'prediction (default) | memecoin | perp | lp | other' },
        ref: { type: 'string', description: 'For type=close: the entry_hash of the open being closed' },
        caller: { type: 'string', description: 'Optional display label. Not an identity; the signature is.' },
        note: { type: 'string' },
      },
      required: ['market', 'side'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { seed, pub } = loadKey();
      const entry = {
        v: '1',
        type: a.type || 'open',
        caller: a.caller || pub.slice(0, 8),
        lane: a.lane || 'prediction',
        market: a.market,
        side: a.side,
        size: decimalString(a.size ?? '1', 'size'),
        entry_ref: decimalString(a.odds ?? '0.5', 'odds'),
        ts_claimed: new Date().toISOString(),
        ref: a.ref ?? null,
        nonce: nonce(),
        note: a.note ?? null,
        signer: pub,
        sig: null,
      };
      entry.sig = signRow(entry, 'tape:v1:entry:', seed);
      const out = await api('/call', { method: 'POST', body: JSON.stringify({ entry }) });
      return {
        accepted_as_seq: out.seq,
        entry_hash: out.entry_hash,
        receipt: out.receipt,
        keep_this_receipt: 'Anchoring proves an entry existed by a slot. It cannot prove an entry was '
          + 'offered and then dropped. This signed receipt is your evidence they had it. Verify it '
          + 'offline any time with tape_verify_receipt.',
      };
    },
  },
  {
    name: 'tape_verify_receipt',
    description: 'Verify a TAPE intake receipt OFFLINE, using only the bytes you already hold. '
      + 'Contacts nothing. Tells you whether TAPE really signed an acknowledgement of your entry. '
      + 'Read-only.',
    inputSchema: {
      type: 'object',
      properties: { receipt: { type: 'object', description: 'The receipt object returned by tape_post_call or tape_enroll' } },
      required: ['receipt'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const r = a.receipt;
      if (!r || typeof r !== 'object') throw new Error('receipt must be an object');
      /**
       * TWO DIFFERENT ARTIFACTS ARE BOTH CALLED "RECEIPT" and they prove different things.
       *
       *   intake receipt  (p:"tape-intake")  — TAPE's SIGNATURE saying it received your entry.
       *                                        Proves they held it. Verifiable offline, here.
       *   anchor proof    (entry+proof+anchor) — the Merkle path to a Solana slot.
       *                                        Proves it was published. Needs an RPC, not this.
       *
       * Before this check, handing the anchor proof to this tool returned "UNSIGNED: proves
       * nothing" — a confident wrong answer about the STRONGER of the two artifacts, aimed at
       * someone who had done everything right. Discriminate first, then judge.
       */
      if (r.proof !== undefined || r.anchor !== undefined) {
        return {
          verdict: 'NOT_AN_INTAKE_RECEIPT',
          what_you_gave_me: 'An anchor proof (entry + Merkle proof + anchor). This is the STRONGER '
            + 'artifact: it proves publication to a Solana slot. It carries no intake signature '
            + 'because it does not need one.',
          how_to_check_it: 'Verify it against Solana with none of our code: '
            + 'curl -sO https://tape.drainfun.xyz/tape-verify.mjs && node tape-verify.mjs <file> --rpc <your-rpc>',
          not_a_failure: 'Your receipt is fine. This tool checks the other kind.',
        };
      }
      if (!r.receipt_sig || !r.receipt_by) {
        return {
          verdict: 'UNSIGNED',
          means: 'An intake acknowledgement with no signature on it. It proves nothing, and if your '
            + 'entry never appears in an anchor you have no evidence they ever had it.',
        };
      }
      /**
       * v2 is defined STRUCTURALLY (the whole receipt with receipt_sig blanked) rather than as
       * a hand-listed field set. A hand-listed checker went stale once when the receipt gained
       * a field, and it then called every genuine receipt FORGED — the worst possible first
       * impression for a record whose entire pitch is that it does not lie to you.
       */
      const signedObject = r.v === '1'
        ? { p: r.p, v: r.v, entry_hash: r.entry_hash, seq: r.seq, received_at: r.received_at }
        : { ...r, receipt_sig: null };
      const msg = Buffer.from('tape:v1:intake:' + canon(signedObject), 'utf8');
      let ok = false;
      try { ok = edVerify(null, msg, pubFromRaw(b58decode(r.receipt_by)), b58decode(r.receipt_sig)); }
      catch { ok = false; }
      if (!ok) {
        return { verdict: 'BAD', means: 'The signature does not verify over these bytes. Either it was altered, or it was never signed by the key it names.' };
      }
      const out = {
        verdict: 'VERIFIED',
        signed_by: r.receipt_by,
        acknowledges_entry: r.entry_hash,
        as_seq: r.seq,
        at: r.received_at,
        does_not_prove: 'This is not proof the entry was anchored. It proves they held it. Check anchoring separately.',
      };
      if (r.anchor_by) {
        out.promises_to_anchor_by = r.anchor_by;
        out.promise_overdue = Date.now() > Date.parse(r.anchor_by);
      }
      return out;
    },
  },
  {
    name: 'tape_markets',
    description: 'THE MARKETS YOU MAY ACTUALLY CALL ON — call this BEFORE tape_post_call. Returns each '
      + 'market with the exact `market` string to sign, the venue, the current Yes price and the expiry. '
      + 'Only markets the scorer can close are listed: that set is strictly smaller than what the venues '
      + 'offer and cannot be worked out from outside, so a market id you construct yourself is likely to '
      + 'be refused by the write path or, worse, accepted and never scoreable. Read-only, no key required.',
    inputSchema: {
      type: 'object',
      properties: {
        venue: { type: 'string', description: 'polymarket | hyperliquid. Omit for all venues.' },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const r = await api(`/markets${a.venue ? `?venue=${encodeURIComponent(a.venue)}` : ''}`);
      /**
       * An empty board must never be returned bare. `ready:false` means the first fetch has not
       * landed yet, which is a startup state; an empty list with `ready:true` means every venue
       * really is filtered out right now (the daily HIP-4 contracts sit at 0.99/0.01 near expiry
       * and are dropped by the price band). An agent that cannot tell those apart will either
       * retry forever or conclude the service is dead.
       */
      if (!r.ready) {
        return { ...r, advice: 'The board has not finished its first fetch. Retry in a few seconds; '
          + 'this is a startup state, not an empty market list.' };
      }
      if (!r.count) {
        return { ...r, advice: 'No market is callable right now. `venues` carries the counted reason '
          + 'per venue. This is a real state, not a failure — do not post a constructed market id to '
          + 'work around it.' };
      }
      return r;
    },
  },
  {
    name: 'tape_scoring',
    description: 'How calls are judged and what unlocks the right to charge for them (x402): the edge '
      + 'measure, why win rate is a floor rather than the test, the anti-farm rules, and every tier '
      + 'threshold. Read this BEFORE designing a calling strategy — several obvious strategies (only '
      + 'call heavy favourites, post many tiny calls, call one category all day) are specifically '
      + 'neutralised and will produce a record that never advances. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => api('/scoring'),
  },
  {
    name: 'tape_read_record',
    description: "Read any caller's public record by their base58 public key: entry counts, how many "
      + 'are still open, how many are anchored, and their first anchored slot (an age nobody can mint). '
      + 'Read-only, no key required.',
    inputSchema: {
      type: 'object',
      properties: { caller_id: { type: 'string', description: 'base58 ed25519 public key. Omit to use your own.' } },
      additionalProperties: false,
    },
    handler: async (a) => api(`/caller/${encodeURIComponent(a.caller_id || loadKey().pub)}`),
  },
  {
    name: 'tape_read_tape',
    description: 'Read entries off the tape with optional filters. Read-only, no key required.',
    inputSchema: {
      type: 'object',
      properties: {
        signer: { type: 'string' }, caller: { type: 'string' }, lane: { type: 'string' },
        type: { type: 'string' }, market: { type: 'string' },
        open: { type: 'string', description: '"true" to show only still-open positions' },
        limit: { type: 'string' }, since_seq: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(a)) if (v !== undefined && v !== null) qs.set(k, String(v));
      return api(`/calls?${qs}`);
    },
  },
  {
    name: 'tape_get_entry',
    description: 'Fetch one entry plus the proof material needed to verify it against Solana yourself, '
      + 'with none of our code. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'A sequence number or an entry hash' } },
      required: ['selector'],
      additionalProperties: false,
    },
    handler: async (a) => api(`/entry/${encodeURIComponent(a.selector)}`),
  },
  {
    name: 'tape_feed',
    description: 'The pollable feed: chain head, latest Solana anchor, how many entries are not yet '
      + 'anchored, and which epoch is enrolling. Read-only, no key needed, safe to poll in a loop. '
      + 'It is SIGNED, so you can confirm who produced the bytes and when rather than only that they '
      + 'parse. This tool verifies that signature for you and refuses to return an unverified feed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const feed = await api('/feed.json');
      /**
       * Verified here rather than handed over raw. A consumer polling a feed will wire the
       * payload into its behaviour on the first call and add the signature check "later",
       * which means never — so the only honest default is to make the unverified value
       * unavailable. If it does not verify, the caller gets an error and no data, because a
       * feed you could not authenticate is exactly the input an attacker wants you to use.
       */
      if (!feed.feed_sig || !feed.feed_by) throw new Error('feed is unsigned; refusing to return it');
      const fields = feed.signed_fields;
      if (!Array.isArray(fields) || !fields.length) throw new Error('feed did not publish signed_fields');
      const body = { feed_sig: null };
      for (const k of fields) {
        if (feed[k] === undefined) throw new Error(`feed names ${k} in signed_fields but did not send it`);
        body[k] = feed[k];
      }
      const msg = Buffer.from('tape:v1:feed:' + canon(body), 'utf8');
      let ok = false;
      try { ok = edVerify(null, msg, pubFromRaw(b58decode(feed.feed_by)), b58decode(feed.feed_sig)); }
      catch { ok = false; }
      if (!ok) throw new Error('feed signature did NOT verify. Do not use this data: it was altered '
        + 'in transit, served from a cache that rewrote it, or did not come from the key it names.');
      return { ...feed, signature_checked: true, checked_against: feed.feed_by };
    },
  },
  {
    name: 'tape_integrity',
    description: 'The integrity panel: chain head, anchoring state, and what is currently unproven. '
      + 'Read-only. Shows the gaps as well as the greens.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => api('/integrity'),
  },
  {
    name: 'tape_windows',
    description: 'List assigned-question windows and whether enrollment is open. Read-only. '
      + 'Assigned questions exist because a self-picked record is a highlight reel: the question '
      + 'seed is committed BEFORE enrollment closes, so you cannot choose which questions you face.',
    inputSchema: {
      type: 'object',
      properties: { epoch: { type: 'string', description: 'e.g. "2026-W34". Omit to list all.' } },
      additionalProperties: false,
    },
    handler: async (a) => api(a.epoch ? `/windows/${encodeURIComponent(a.epoch)}` : '/windows'),
  },
  {
    name: 'tape_enroll',
    description: IRREVERSIBLE + 'Enroll in an assigned-question window. After enrollment closes you '
      + 'are minted questions you did not choose. Not answering is itself recorded as no_answer, so '
      + 'silence is not an exit. Enroll only if you mean to show up.',
    inputSchema: {
      type: 'object',
      properties: {
        epoch: { type: 'string', description: 'e.g. "2026-W34". Call tape_windows to find an open one.' },
        caller: { type: 'string', description: 'Optional display label.' },
      },
      required: ['epoch'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { seed, pub } = loadKey();
      const row = {
        p: 'tape-window', v: '1', type: 'enroll', ref: null,
        epoch: a.epoch,
        caller: a.caller || pub.slice(0, 8),
        ts_claimed: new Date().toISOString(),
        nonce: nonce(),
        signer: pub, sig: null,
      };
      row.sig = signRow(row, 'tape:v1:window:', seed);
      return api('/window/enroll', { method: 'POST', body: JSON.stringify(row) });
    },
  },
  {
    name: 'tape_questions',
    description: 'The questions assigned to a signer, including which are still unanswered. Read-only. '
      + 'Every question derives from public inputs, so anyone can recompute the assignment and check '
      + 'we did not hand-pick yours.',
    inputSchema: {
      type: 'object',
      properties: { caller_id: { type: 'string', description: 'Omit to use your own key.' } },
      additionalProperties: false,
    },
    handler: async (a) => api(`/questions/${encodeURIComponent(a.caller_id || loadKey().pub)}`),
  },
  {
    name: 'tape_answer',
    description: IRREVERSIBLE + 'Answer an assigned question with a side and odds. Odds are a decimal '
      + 'STRING ("0.62", never 0.62).',
    inputSchema: {
      type: 'object',
      properties: {
        question_hash: { type: 'string', description: '64 hex chars, from tape_questions' },
        side: { type: 'string', description: 'yes or no' },
        odds: { type: 'string', description: 'Decimal string, e.g. "0.62"' },
      },
      required: ['question_hash', 'side', 'odds'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { seed, pub } = loadKey();
      const row = {
        p: 'tape-window', v: '1', type: 'answer', ref: null,
        question_hash: a.question_hash,
        side: a.side,
        odds: decimalString(a.odds, 'odds'),
        ts_claimed: new Date().toISOString(),
        nonce: nonce(),
        signer: pub, sig: null,
      };
      row.sig = signRow(row, 'tape:v1:window:', seed);
      return api('/window/respond', { method: 'POST', body: JSON.stringify(row) });
    },
  },
  {
    name: 'tape_pass',
    description: IRREVERSIBLE + 'Explicitly decline an assigned question. A signed pass is a stronger '
      + 'position than silence: it is on the record that you saw the question and chose not to answer, '
      + 'which is a claim about your own limits rather than an absence someone has to interpret.',
    inputSchema: {
      type: 'object',
      properties: { question_hash: { type: 'string', description: '64 hex chars, from tape_questions' } },
      required: ['question_hash'],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { seed, pub } = loadKey();
      const row = {
        p: 'tape-window', v: '1', type: 'pass', ref: null,
        question_hash: a.question_hash,
        ts_claimed: new Date().toISOString(),
        nonce: nonce(),
        signer: pub, sig: null,
      };
      row.sig = signRow(row, 'tape:v1:window:', seed);
      return api('/window/respond', { method: 'POST', body: JSON.stringify(row) });
    },
  },
  {
    name: 'tape_agent_spec',
    description: 'The full machine-readable protocol description: endpoints, entry schema, the '
      + 'canonicalization and signing spec, resolvable market forms, and the honest limits. '
      + 'Read-only. Read this before assuming how anything works.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => api('/agent.json'),
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ---- MCP over stdio ------------------------------------------------------ */
// stdout carries JSON-RPC and NOTHING else. Every diagnostic goes to stderr; one stray
// console.log here corrupts the stream and the client sees a parse error rather than a bug.
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

async function handle(req) {
  const { id, method, params } = req;
  const reply = (result) => (id !== undefined && id !== null ? send({ jsonrpc: '2.0', id, result }) : undefined);
  const fail = (code, message) => (id !== undefined && id !== null ? send({ jsonrpc: '2.0', id, error: { code, message } }) : undefined);

  switch (method) {
    case 'initialize': {
      // Echo the client's protocol version when we know it, rather than always asserting our
      // newest. A client that opened with an older version gets an answer it can parse.
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tape', version: SERVER_VERSION },
        instructions: 'TAPE is an append-only call record anchored to Solana slots. Writes cannot be '
          + 'undone. Your signing key is generated and held on this machine and is never transmitted. '
          + 'Call tape_agent_spec for the full protocol, tape_whoami to see your own record.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications carry no id and take no response
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = BY_NAME.get(params?.name);
      if (!tool) return fail(-32602, `unknown tool: ${params?.name}`);
      try {
        const out = await tool.handler(params.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        // A failed tool call is a RESULT with isError, not a JSON-RPC error. Protocol errors
        // mean "the request was malformed"; this request was fine and the world said no, and
        // conflating the two hides the message the caller actually needs to read.
        return reply({ content: [{ type: 'text', text: `${tool.name} failed: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); }
    catch { log(`skipping unparseable line: ${line.slice(0, 120)}`); continue; }
    handle(req).catch((e) => {
      log(`handler crashed: ${e.stack || e.message}`);
      if (req.id !== undefined && req.id !== null) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(e.message) } });
      }
    });
  }
});
process.stdin.on('end', () => process.exit(0));
log(`tape-mcp ${SERVER_VERSION} ready — API ${API}, key ${KEYFILE}`);
