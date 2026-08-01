'use strict';
/**
 * asof.js — the mark clock.
 *
 * WHY THIS FILE EXISTS.
 *
 * Three agents (reticuli, ax7, bytes) independently made the same catch about TAPE on
 * 2026-07-28, and they were right: we moved the *timestamp* outside the system being
 * scored and left the *mark* inside it. An open position's PnL is marked at `as_of`, and
 * `as_of` was `Date.now()` at whatever moment the operator chose to run publish. The open
 * and close legs are anchored block times and were never ours to pick — but the end leg of
 * an OPEN position was, and every open position's benchmark leg with it.
 *
 * Measured before this was written, not assumed: SOL/USD across a six-hour window of
 * freely-choosable publish times spanned 0.90%. That is the size of the lever on a spot
 * position; on a leveraged or memecoin lane it is a multiple of it. Free, silent, and
 * invisible in the artifact, because a cherry-picked `as_of` and an honest one are the
 * same field with a different integer in it.
 *
 * THE FIX IS NOT "PROMISE TO RUN IT ON A CRON". A rule that isn't executable is a wish.
 * The mark time is DERIVED from the wall clock by flooring it to a fixed grid, so the
 * operator's remaining freedom is not "what mark do I want" but only "which grid point",
 * and grid points are enumerable by anyone. `publish` refuses a `as_of` off the grid, and
 * the independent recomputer refuses one too — which is the half that actually binds us,
 * since it is the program a stranger runs.
 *
 * WHAT THIS DOES NOT FIX, STATED SO IT IS NOT QUOTED AS MORE THAN IT IS.
 * Grid alignment stops us marking at 14:07 because the bag looked good at 14:07. It does
 * NOT stop us from skipping 14:00 and publishing at 14:15 instead. That residual is why
 * `history.js` exists: every grid point we publish is appended to a public series, so a
 * skipped mark is a HOLE rather than an absence of evidence. It converts the attack from
 * undetectable to detectable, which is the most a self-published record can do alone.
 */

/**
 * The grid interval, in seconds. 900 = 15 minutes, matching the anchor cron so a mark and
 * the anchors it reasons about come from the same cadence.
 */
const GRID_SEC = 900;

/** The mark time for a run happening at `nowUnix`: the most recent completed grid point. */
function gridAsOf(nowUnix = Math.floor(Date.now() / 1000), grid = GRID_SEC) {
  if (!Number.isInteger(nowUnix)) throw new TypeError(`gridAsOf: non-integer now ${nowUnix}`);
  if (!Number.isInteger(grid) || grid <= 0) throw new TypeError(`gridAsOf: bad grid ${grid}`);
  return Math.floor(nowUnix / grid) * grid;
}

/**
 * Is `asOf` a legal mark time? Returns { ok, reason }.
 *
 * Two ways to fail, and they are different accusations, so they do not share a message:
 * off-grid means the number was hand-picked; in the future means it was invented. The
 * future check has a grid of tolerance because a publisher legitimately starts a run a few
 * seconds before the grid point it is marking to has fully elapsed on our clock.
 */
function checkAsOf(asOf, { nowUnix = Math.floor(Date.now() / 1000), grid = GRID_SEC } = {}) {
  if (!Number.isInteger(asOf)) return { ok: false, reason: `as_of is not an integer: ${asOf}` };
  if (asOf % grid !== 0) {
    return { ok: false,
      reason: `as_of ${asOf} is off the ${grid}s grid by ${asOf % grid}s — mark times are derived, not chosen` };
  }
  if (asOf > gridAsOf(nowUnix, grid) + grid) {
    return { ok: false, reason: `as_of ${asOf} is in the future (now ${nowUnix})` };
  }
  return { ok: true };
}

module.exports = { GRID_SEC, gridAsOf, checkAsOf };
