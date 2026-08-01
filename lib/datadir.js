'use strict';
/**
 * datadir.js — ONE answer to "where is the tape".
 *
 * WHY THIS FILE EXISTS. Six files resolved the data directory independently. Five hardcoded
 * `<repo>/data`; `bin/api.js` alone honoured `TAPE_DATA`. So a process started with
 * `TAPE_DATA=/tmp/whatever` wrote its calls to the temp chain while `GET /calls`,
 * `GET /caller/...` and every receipt kept reading production — one process, two tapes,
 * both reporting success. A staging instance was a live mirror of the real record, the
 * read assertions in any test against it were vacuous, and `verify/tape-schedule.mjs`
 * could not be aimed at a non-production instance at all, because it reads `/calls`.
 *
 * `lib/readmodel.js` argued against an env override on exactly these grounds — that the
 * writer and reader could be pointed at different directories by a stray variable. The
 * reasoning was right and the conclusion was already false, because the override existed
 * anyway one layer up. The fix that honours the argument is not to remove the override but
 * to make it impossible for two components to disagree about it: resolved once, here, and
 * imported everywhere.
 */

const path = require('path');

/** The directory holding tape.jsonl, anchors.jsonl and the caches beside them. */
const DATA_DIR = process.env.TAPE_DATA
  ? path.resolve(process.env.TAPE_DATA)
  : path.join(__dirname, '..', 'data');

const dataPath = (...parts) => path.join(DATA_DIR, ...parts);

module.exports = { DATA_DIR, dataPath };
