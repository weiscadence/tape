'use strict';
/**
 * receipt-plain.js — the same receipt, said in words a person can read.
 *
 * WHY. Receipt #386 rendered its headline as `polymarket:0xa5144d487f22937f5bc46c655ab3cf1063
 * edebefef327fa08ffeed421e60688f`, then "entry reference: 0.8200 · size 1", then three cards
 * about ed25519 and Merkle paths. Every word of that is true and Jiggy's reaction to his own
 * receipt was "the receipt is unreadable to a human, idk what it's claiming" (2026-08-07).
 * A proof nobody can read is not proof to them; it is a wall of hashes they are being asked to
 * take on faith — which is the exact posture this project exists to replace.
 *
 * THE SPLIT. `receipt-page.js` stays the technical artifact: the signed bytes, the JSON, the
 * copy-paste verifier. This file is the FIRST layer — what was claimed, by whom, at what price,
 * and what each proof would catch if someone tried to cheat. Same receipt, two registers.
 *
 * TWO RULES IT DOES NOT BREAK:
 *   1. Nothing here invents a fact. Every sentence is derived from the signed entry or the
 *      anchor. The question text is the one exception and it is FLAGGED as looked-up, because
 *      it is not in the signed bytes and the venue can edit it (same reason receipt-page.js
 *      keeps it in a dimmer band).
 *   2. It says what the receipt does NOT prove, in the same breath and the same size type as
 *      what it does. A summary that only carries the impressive half is marketing.
 */

const { describeMarket } = require('./receipt-page');

/** 0.8200 → "82¢". The signed value stays available; this is only how it reads. */
function cents(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return `${Math.round(n * 100)}¢`;
}

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/**
 * @param {object} receipt  buildReceipt() output
 * @param {object} opts     { titles: market-titles.json contents, operatorKeys }
 */
function plainReceipt(receipt, opts = {}) {
  const r = receipt || {};
  const e = r.entry || {};
  const a = r.anchor || null;
  const titles = opts.titles || {};

  const hit = titles[String(e.market)];
  const question = hit && hit.title ? String(hit.title) : null;
  const d = describeMarket(e.market);
  // Headline preference: the looked-up question (readable, unsigned) → a market string we can
  // parse into English → the raw signed string. Never a guess at an unparsed format.
  const headline = question || d.text || String(e.market || e.type || 'row');

  const side = e.side ? String(e.side).toUpperCase() : null;
  const price = cents(e.entry_ref);
  const size = e.size != null ? `${e.size}u` : null;
  const who = e.caller || e.signer || 'a caller';
  const isOpen = e.type === 'open';
  const isClose = e.type === 'close';

  // The one-sentence claim. This is the line that answers "what is this receipt saying".
  let claim;
  if (isOpen && side && price) claim = `${who} called ${side} at ${price}${size ? `, ${size} of conviction` : ''}.`;
  else if (isClose && price) claim = `${who} closed this position at ${price}.`;
  else claim = `${who} posted a ${String(e.type || 'row').replace(/_/g, ' ')}.`;

  // What has to happen for it to have been right. Stated as a condition, never as a prediction
  // of the outcome — the receipt has no opinion about who wins.
  const stake = isOpen && side && price
    ? `For this to score as a win, the market has to resolve ${side}. ${who} is on record against everyone who took the other side at ${price} — and that price is the bar, not 50/50.`
    : null;

  const proofLen = Array.isArray(r.proof) ? r.proof.length : 0;
  const proves = [
    // The unsigned branch is not a softer wording of the signed one — it is a DIFFERENT claim.
    // A mini-app row carries no ed25519 signature at all (bin/miniapp.js appends vouched-unsigned
    // by design, because a human tapping a button has no key), so telling its owner "change a
    // character and the signature breaks" would describe a signature that does not exist. What
    // actually holds for these rows is the hash chain and the anchor, which is plenty — and
    // saying only that is what keeps the wallet-verified badge worth anything.
    e.signer ? {
      t: 'Only they could have written it',
      plain: 'Signed with their own key, on their own machine. Change one character — the side, '
        + 'the price, the timestamp — and the signature stops matching. Nobody can edit this row '
        + 'after the fact, including us.',
    } : {
      t: 'It is locked, but it is not key-signed',
      plain: 'This row was posted from Telegram, so there is no wallet signature on it — Telegram '
        + 'vouched for the handle when it was written, and it renders as unsigned everywhere so it '
        + 'can never pass for wallet-verified. What locks it is the two below: the row is hashed '
        + 'into the chain and anchored, so it cannot be altered or backdated. Connect a wallet and '
        + 'future calls get the signature too.',
    },
    {
      t: 'It was in the batch, not slipped in later',
      plain: `Your call was hashed together with every other call into one fingerprint. The ${proofLen} `
        + 'hashes in this receipt are the path from your row to that fingerprint. Recompute them and '
        + 'you get the same answer, or the receipt is fake.',
    },
    {
      t: 'Solana stamped the time, not us',
      plain: a
        ? `That fingerprint was written to Solana at slot ${a.slot}. Slots only move forward and we `
          + "don't control them, so this call cannot be backdated — it existed before that block did."
        : 'Not anchored yet. Anchors are written at least every 15 minutes; until then the row is '
          + 'signed and in the chain but has no external timestamp.',
    },
  ];

  return {
    seq: r.seq,
    headline,
    question,                       // present only when we have a looked-up question
    questionLookedUp: Boolean(question),
    questionFetchedAt: hit && hit.fetched_at ? hit.fetched_at : null,
    market: e.market || null,
    claim,
    stake,
    side,
    price,
    size,
    caller: who,
    signedAt: e.ts_claimed ? when(e.ts_claimed) : null,
    anchored: Boolean(a),
    slot: a ? a.slot : null,
    explorer: a ? a.explorer : null,
    proves,
    // Deliberately the same prominence as `proves` in every renderer that consumes this.
    notProves: 'It does not prove the call was right. Nothing about a signature makes a bet correct — '
      + 'being right is settled later by the market itself, and the record keeps the loss just as '
      + 'permanently as the win.',
    url: `https://tape.drainfun.xyz/r/${r.seq}`,
  };
}

module.exports = { plainReceipt, cents };
