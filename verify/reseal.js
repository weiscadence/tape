#!/usr/bin/env node
'use strict';
/**
 * reseal.js — TEST HELPER. Re-seal a tampered artifact so it is internally consistent.
 *
 * WHY THIS EXISTS: the identity controls were all being caught by the entry-hash check
 * before the signature check ever ran, so they proved nothing about signature
 * verification — it could have been dead code and every control would still pass. That is
 * the "control that passes for the wrong reason" failure, and it is worse than a missing
 * control because it reads as coverage.
 *
 * This models the REAL threat, which is us. We hold the chain file and we run the
 * anchoring, so we can rewrite history and re-anchor it into a perfectly consistent
 * record. What we cannot do is forge a signature over the rewritten bytes without the
 * caller's key. Re-sealing strips away every check except that one, and asks whether the
 * last line of defence actually holds.
 *
 * (The on-chain slot times would also betray a rewrite — that is tape-verify.mjs's job.)
 */
const { entryHash } = require('../lib/entry');
const { linkHash, GENESIS } = require('../lib/chain');
const { hashLeaf, buildTree } = require('../lib/merkle');
const { entryBytes } = require('../lib/entry');

const art = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));

let prev = GENESIS;
art.chain.forEach((r, i) => {
  r.seq = i;
  r.entry_hash = entryHash(r.entry);
  r.prev = prev;
  r.link = linkHash(r.prev, r.seq, r.entry_hash);
  prev = r.link;
});
for (const a of art.anchors) {
  if (a.count > art.chain.length) a.count = art.chain.length;
  a.root = buildTree(art.chain.slice(0, a.count).map((r) => hashLeaf(entryBytes(r.entry)))).root.toString('hex');
}
process.stdout.write(JSON.stringify(art));
