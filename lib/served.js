'use strict';
/**
 * served.js — the single list of files the web server will hand out.
 *
 * Extracted from bin/web.js so a TEST can ask "what is actually served?" instead of being
 * told. test/client.test.js downloaded the client from a hardcoded `web/tape-call.mjs`; when
 * that copy was deleted in favour of verify/, the test broke — but it had been WORSE than
 * broken for as long as both files existed, because it exercised a file the router did not
 * serve and reported the real client green. Reading the map means the test cannot again test
 * one file while users download another.
 *
 * bin/web.js binds a port at require time, so it cannot be required from a test. That is the
 * whole reason this file exists as its own module.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..', 'web');
const VERIFY = path.join(__dirname, '..', 'verify');
const MCP = path.join(__dirname, '..', 'mcp');

/**
 * Everything the public may read, mapped name -> directory. Anything else is 404.
 *
 * THE VERIFIERS ARE THE POINT AND THEY WERE NOT SERVED. Every receipt this service emits
 * says "verify it with tape-verify.mjs". agent.json names tape-promise.mjs as the proof we
 * can be caught dropping a call, and tape-schedule.mjs as the proof we did not hand-pick a
 * caller's questions. All four were 404 under every name the documentation used. A stranger
 * following our own instructions got `not found` from the one tool that reads Solana without
 * us in the path — so the entire "don't trust us, check it yourself" claim was, from outside,
 * a claim with no tool attached. The independence argument in those files is worth nothing
 * if the files cannot be downloaded.
 *
 * They are served from verify/ rather than copied into web/, because a copy is a thing that
 * drifts: web/tape-call.mjs and verify/tape-call.mjs had already diverged once.
 *
 * AND THEN DID IT AGAIN. tape-call.mjs was the one client still mapped to web/ while the
 * comment above described the rule it was breaking. The two copies diverged in both
 * directions: web/ had a real bug fix (receipts named per-seq instead of overwriting each
 * other) that verify/ never got, and an edit made to verify/ never reached anyone, because
 * verify/ was not the file being downloaded. Editing the source and shipping the copy is
 * indistinguishable from editing nothing. It is served from verify/ now, like the rest, and
 * web/tape-call.mjs is deleted rather than left as a tempting stale twin.
 */
const ALLOWED = new Map([
  ['index.html', ROOT],
  // The marketing landing served at "/". The app/board it links to moves to "/app" (see bin/web.js).
  ['landing.html', ROOT],
  ['verify.html', ROOT],
  ['tape-call.mjs', VERIFY],
  ['tape.json', ROOT],
  ['board.json', ROOT],
  ['marks-history.json', ROOT],
  // The provenance registry. The page states "no independent callers yet" and links here for
  // the evidence; an unreachable registry would turn that link into the same unbacked claim
  // the registry exists to replace.
  ['operator-keys.json', ROOT],
  ['tape-verify.mjs', VERIFY],
  ['tape-schedule.mjs', VERIFY],
  ['tape-promise.mjs', VERIFY],
  ['tape-history.mjs', VERIFY],
  ['tape-recompute.mjs', VERIFY],
  // Served so a reader can run our own read-path check against us rather than taking our
  // word that we run it. It found the domain-separation bug that made every window row
  // read as FRAUD; a check that only we can run is a check only we can quietly stop running.
  ['tape-read-canary.mjs', VERIFY],
  // Verification counting. This one is load-bearing in a way the others are not: the board
  // prints a count of independent verifications, and that count is only not-self-reported
  // because outsiders can sign their own verdicts with this file. Unserved, the number goes
  // back to being ours to assert — the same failure this list already documents twice.
  ['tape-attest.mjs', VERIFY],
  // Shipped 2026-07-31 with a public Moltbook post pointing at it, and it was never in this
  // map. Third time. The pattern is not "we forget files", it is that adding a tool and
  // exposing a tool are two separate acts and only one of them is satisfying.
  ['tape-marks-grid.mjs', VERIFY],
  // The MCP server. Served for the same reason as the verifiers: the API is the interface,
  // but "build a canonical serializer and an ed25519 signer first" is a real wall, and a
  // lowered wall nobody can download is not lowered. Signing still happens on the caller's
  // machine — this file never sees a key and neither do we.
  ['tape-mcp.mjs', MCP],
  // The agent skill — the short version of the protocol, written to be dropped into an agent's
  // skill directory. Fourth entry in this map added because "we shipped a tool and never exposed
  // it" is the pattern the comments above document three separate times; adding the file and
  // serving the file are two acts and only one of them feels like progress. The landing page
  // links to it, and test/published-urls.test.js fetches every URL the site advertises, so a
  // missing map entry here fails a test rather than 404ing a reader.
  ['tape-skill.md', ROOT],
  // llms.txt — the file agent crawlers probe by convention before reading anything else. It was
  // a 404, which is the discovery-layer version of the bug this map documents four times above:
  // the surfaces existed and could not be found. Cheap to serve, and it is the only entry here
  // whose job is to point at the other entries.
  ['llms.txt', ROOT],
]);

module.exports = { ALLOWED, ROOT, VERIFY, MCP };
