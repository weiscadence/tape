'use strict';
/**
 * history.js — the published series of mark times.
 *
 * Grid alignment (asof.js) removes the operator's freedom to pick a flattering INSTANT.
 * It leaves the freedom to pick a flattering GRID POINT by simply not publishing at the
 * unflattering ones. Nothing in a single overwritten `board.json` can show that: each
 * publish clobbers the last, so the artifact has no series in which a gap could appear.
 * Absence of a mark and absence of evidence were byte-identical, which is the exact shape
 * hermessol named on the admission side of the same design.
 *
 * So every publish appends `(as_of, markset_hash, chain_head, entries)` here, and the file
 * ships with the board. A stranger enumerates the grid between the first and last rows and
 * sees immediately which points we skipped. We can still skip — but not quietly, and a run
 * of skips that correlates with a drawdown is now a thing someone can point at.
 *
 * Append-only in the same sense as the tape itself: rewriting history to hide a gap means
 * rewriting a file whose rows carry the chain head they were published against, so a
 * doctored series disagrees with the chain it claims to describe.
 */

const fs = require('fs');
const path = require('path');
const { GRID_SEC } = require('./asof');

/** Append one published mark point. Idempotent: republishing the same grid point is a no-op. */
function record(file, row) {
  const rows = read(file);
  if (rows.some((r) => r.as_of === row.as_of)) return { appended: false, rows };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return { appended: true, rows: rows.concat([row]) };
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

/**
 * Which grid points between the first and last published mark are missing?
 *
 * Returns { published, expected, missing[], coverage }. `missing` is the honest number:
 * gaps caused by the box being down and gaps caused by us not liking the price look
 * identical here, and this function deliberately does not guess which. It reports the
 * hole; a reader decides what it means.
 */
function gaps(rows, grid = GRID_SEC) {
  const times = rows.map((r) => r.as_of).filter(Number.isInteger).sort((a, b) => a - b);
  if (times.length < 2) return { published: times.length, expected: times.length, missing: [], coverage: 1 };
  const have = new Set(times);
  const missing = [];
  for (let t = times[0]; t <= times[times.length - 1]; t += grid) if (!have.has(t)) missing.push(t);
  const expected = (times[times.length - 1] - times[0]) / grid + 1;
  return { published: times.length, expected, missing,
    coverage: expected ? times.length / expected : 1 };
}

module.exports = { record, read, gaps };
