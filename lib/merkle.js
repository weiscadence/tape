'use strict';
/**
 * merkle.js — batch commitment.
 *
 * WHY A TREE AND NOT ONE TX PER CALL:
 * T0.3 says a claim must be anchored before its outcome can be known. A memecoin
 * round-trips in seconds, so anchoring has to be fast — but one Solana transaction per
 * call makes cost scale with traffic and gives a spammer a way to price us out. One
 * root per short interval makes cost flat in traffic, and each entry carries an
 * inclusion proof against a root whose slot precedes the outcome.
 *
 * TWO KNOWN MERKLE FOOTGUNS, BOTH CLOSED HERE:
 *
 * 1. Second-preimage / leaf-vs-node confusion. If leaves and internal nodes are hashed
 *    the same way, an internal node can be replayed as a leaf, so a proof for a value
 *    that was never submitted can validate. Fixed by domain separation: leaves are
 *    hashed with a 0x00 prefix, internal nodes with 0x01.
 *
 * 2. Odd-node duplication (the Bitcoin CVE-2012-2459 shape). Duplicating the last node
 *    to pad a level means two DIFFERENT leaf sets can produce the SAME root, which
 *    would let someone claim membership in a batch they were never in. Fixed twice
 *    over: an odd node is PROMOTED unchanged rather than duplicated, and the leaf
 *    COUNT is committed alongside the root in the anchored payload, so a root is only
 *    ever interpreted against one tree shape.
 */

const crypto = require('crypto');

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

const sha256 = (...bufs) => crypto.createHash('sha256').update(Buffer.concat(bufs)).digest();

/** Hash one leaf payload (a Buffer or hex string) into a domain-separated leaf digest. */
function hashLeaf(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return sha256(LEAF, buf);
}

/** Hash two child digests into a parent digest. */
function hashNode(left, right) {
  return sha256(NODE, left, right);
}

/**
 * Build a Merkle tree from an ordered array of leaf digests (Buffers).
 * Returns { root: Buffer, levels: Buffer[][], count: number }.
 * The empty tree has a distinct, fixed root so "no calls this interval" is still a
 * statement we anchored rather than a gap in the record.
 */
function buildTree(leafDigests) {
  const count = leafDigests.length;
  if (count === 0) {
    return { root: sha256(Buffer.from('tape:empty:v1', 'utf8')), levels: [[]], count: 0 };
  }
  const levels = [leafDigests.slice()];
  let cur = levels[0];
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      // Odd tail: promote unchanged. Do NOT duplicate — see footgun 2 above.
      next.push(i + 1 < cur.length ? hashNode(cur[i], cur[i + 1]) : cur[i]);
    }
    levels.push(next);
    cur = next;
  }
  return { root: cur[0], levels, count };
}

/**
 * Inclusion proof for leaf `index`: the sibling digests needed to recompute the root,
 * each tagged with the side it sits on.
 */
function proveInclusion(tree, index) {
  if (!Number.isInteger(index) || index < 0 || index >= tree.count) {
    throw new RangeError(`proveInclusion: index ${index} out of range (count ${tree.count})`);
  }
  const proof = [];
  let idx = index;
  for (let l = 0; l < tree.levels.length - 1; l++) {
    const level = tree.levels[l];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    // No sibling means this node was promoted unchanged; nothing to record at this level.
    if (siblingIdx < level.length) {
      proof.push({ side: isRight ? 'left' : 'right', hash: level[siblingIdx].toString('hex') });
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify that a PAYLOAD is in the batch. This is the entry point callers should use.
 *
 * It hashes the leaf itself, which is the whole point: the digest-level primitive below
 * will happily accept an internal node digest in a leaf position, and a proof path for
 * an internal node does recompute the root — that is just what a Merkle path is. Domain
 * separation is what makes it unexploitable (finding a payload whose 0x00-prefixed hash
 * equals some 0x01-prefixed node digest is a SHA-256 preimage break), but relying on
 * every caller to remember that is a footgun. So the safe API does not let a caller
 * supply a digest at all. Found by the second-preimage negative control, which failed
 * against the digest-level function on the first run.
 */
function verifyEntryInclusion(payload, proof, expectedRootHex) {
  return verifyInclusion(hashLeaf(payload), proof, expectedRootHex);
}

/**
 * Recompute a root from a leaf DIGEST and its proof. Low-level primitive.
 * Prefer `verifyEntryInclusion` — see the note above about digests in leaf position.
 */
function verifyInclusion(leafDigest, proof, expectedRootHex) {
  let acc = Buffer.isBuffer(leafDigest) ? leafDigest : Buffer.from(leafDigest, 'hex');
  for (const step of proof) {
    const sib = Buffer.from(step.hash, 'hex');
    acc = step.side === 'left' ? hashNode(sib, acc) : hashNode(acc, sib);
  }
  return acc.toString('hex') === expectedRootHex;
}

module.exports = {
  hashLeaf, hashNode, buildTree, proveInclusion,
  verifyEntryInclusion, verifyInclusion, sha256,
};
