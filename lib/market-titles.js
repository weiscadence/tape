// MARKET-TITLES — a cache of the human question behind an opaque market id.
//
// WHY IT IS A CACHE AND NOT A FETCH. A Delphi market id (`delphi:0x54932e…`) is opaque: the
// question lives on Delphi, not in the string we signed. Receipt #326 rendered the bare address
// as its headline, which was accurate and unreadable (Jiggy, 2026-08-06). Fetching the question
// when someone loads the page would make every receipt depend on a third party's latency and
// uptime, and would render differently depending on whether that fetch happened to succeed. The
// gate already talks to Delphi on its own schedule, so it writes down what it saw and the page
// reads the record.
//
// WHY THE FETCH TIME IS STORED WITH IT. This string is NOT part of the signed entry and the venue
// can edit it after the fact. A receipt page whose whole claim is "these bytes are fixed" must not
// display a mutable external string as though it carried the same weight. Storing `fetched_at`
// lets the page say exactly when we saw it and mark it as unsigned; without the timestamp the
// annotation would be indistinguishable from signed content.
//
// Absence is fine. No entry means the page shows only what was signed, which is the correct
// failure — a missing annotation costs readability, a guessed one costs the integrity claim.
'use strict';
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./datadir');

// dataPath, not a hardcoded join: bin/post.js and three others shipped a junk row into the
// PRODUCTION tape on 2026-08-06 by ignoring TAPE_DATA, which is the bug datadir.js exists to end.
const FILE = () => dataPath('market-titles.json');

function readTitles() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; }
}

/**
 * Record the question we saw for a market. No-ops on a falsy title rather than writing an empty
 * string — an empty annotation would suppress the raw identifier on the page and show nothing.
 *
 * Last-write-wins by design: if Delphi edits a question, the newest observation is the honest one
 * to show, and `fetched_at` moves with it so the page reports when we looked.
 */
function recordTitle(market, title) {
  if (!market || !title || !String(title).trim()) return false;
  const all = readTitles();
  const key = String(market);
  const clean = String(title).trim().slice(0, 300);
  if (all[key] && all[key].title === clean) return false;      // unchanged, skip the write
  all[key] = { title: clean, fetched_at: new Date().toISOString() };
  const f = FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(all, null, 2));
  fs.renameSync(f + '.tmp', f);                                 // atomic: the web reader never sees a partial file
  return true;
}

module.exports = { readTitles, recordTitle, TITLES_FILE: FILE };
