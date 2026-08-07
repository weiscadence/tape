# TAPE — an undeletable call record

**Post a prediction; it stays open and marks to market until you publicly close it.** Every
call is committed to a Merkle root and anchored to **Solana mainnet**, so the timestamp on it
is a slot the operator does not control. Anyone screenshots a win — here you can't hide the
losses.

- **Live:** <https://tape.drainfun.xyz> · Telegram mini-app: [@TAPEtapebotbot](https://t.me/TAPEtapebotbot?startapp)
- **Runs as a [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) agent** on a real channel;
  a ZeroClaw cron job does the anchoring. Bounty write-up, custody tier and threat model:
  **[SUBMISSION.md](SUBMISSION.md)** · [THREAT-MODEL.md](THREAT-MODEL.md)
- **Who it's for:** people tired of callers who delete their bad calls, and — the real user —
  **agents that need a reputation a stranger can verify** without trusting the host.

**TAPE places no trades.** It records them. No orders, no user funds, no token program, no
venue write API; the one key it holds can emit `{Memo, ComputeBudget}` and nothing else,
enforced in `lib/signing-policy.js`. It is a record, not a bot.

Anchoring has run unattended since 2026-07-28. Every number in this README moves, so each one
below names the command that re-derives it rather than asking you to trust the figure.

## See it work in 60 seconds

Clone, then run these three. **The first two need no `npm install`** — `verify/*.mjs` has zero
npm dependencies and imports nothing from `lib/`, on purpose: a verifier that needs our code
installed is a verifier that trusts our code.

```
node verify/tape-verify.mjs example-receipt.json          # VERIFIED, exit 0
node verify/tape-promise.mjs example-intake-receipt.json  # KEPT,     exit 0
```

The first checks a real call against **Solana mainnet** and contacts no TAPE service. The
second checks our *intake* promise — that we anchored a call we accepted, by the deadline we
signed for.

Now make us fail. Edit one number in a receipt we published and run it again:

```
python3 -c "import json;r=json.load(open('example-receipt.json'));r['entry']['entry_ref']='0.42';json.dump(r,open('/tmp/tampered.json','w'))"
node verify/tape-verify.mjs /tmp/tampered.json            # FRAUD,    exit 1
```

That is the point of the whole repo: **our own verifier convicts us, on our own published
record, with no code of ours in the trust path.** A verifier that can only confirm is a logo.

The fund-safety test is the one thing here that *does* need dependencies, because it builds
real Solana transactions:

```
npm install
node bounty/prompt-injection-test.js                      # FAILS CLOSED — 3/3
```

This directory is the **T0 spine** — the part that makes a self-reported call mean
something. Everything else (lanes, marking, leaderboard, UI) hangs off it.

```
lib/canonical.js   deterministic bytes           — two parties must hash a claim identically
lib/entry.js       the call record schema        — ts_claimed is NOT authoritative, by name
lib/chain.js       append-only hash chain        — tamper-EVIDENT, not immutable
lib/merkle.js      batch commitment + proofs     — one root per interval, flat cost
lib/anchor.js      Solana memo anchor            — the clock we do not control
test/spine.test.js 23 tests, 8 negative controls
```

Run: `node test/spine.test.js`

## The one idea

If our server assigns the timestamp, we can backdate — so the record is only as honest as
its operator, and the operator is us. **Append-only plus a clock you control is just a
diary.** The clock has to sit outside the thing being scored. That is the entire reason
`anchor.js` exists, and it is why the chain module's own docstring says it is not
sufficient alone.

## Threat model

**What TAPE proves at T0:** a claim existed at slot N, before its outcome was knowable,
and has not been altered since.
**What it does NOT prove:** that the caller took the trade. That is T1 (wallet-signed) and
T2 (wallet-derived). The badge on every T0 entry says so in those words.

| Attack | Mitigation | Residual risk |
|---|---|---|
| Caller edits a losing call after the fact | entry hash covers all fields; chain link covers (prev, seq, entry_hash) | none once anchored |
| Caller deletes a loser | no delete path; amendments are new entries referencing the old | none once anchored |
| Caller backdates an entry | authoritative time is the anchor slot, not `ts_claimed` | a call is only as early as its anchor |
| Caller backdates an *exit* to the local top | `close` must reference an earlier entry by hash, checked at write time | none |
| **Operator (us) rewrites history** | anchored root + chain head on Solana; a rewrite contradicts the on-chain bytes | **unanchored entries are rewritable — shown as `unanchored` and excluded from ranking** |
| Operator truncates the tail | anchored chain head pins the expected end | truncation *between* anchors is possible; shortens with anchor interval |
| Operator drops a call at intake | signed intake receipt commits to `(entry_hash, seq, received_at, anchor_by)` at submit time; `verify/tape-promise.mjs` returns KEPT / BROKEN / OVERDUE / PENDING from that receipt alone | a caller who never kept their receipt cannot prove a drop |
| **Caller** withholds their own losing calls | **not solved, and not solvable.** Named, not hand-waved. | see *Coverage*, below |
| Two different batches share a root | odd node promoted (not duplicated) + leaf count committed with the root | none |
| Internal node replayed as a leaf | leaf/node domain separation (0x00 / 0x01); safe API hashes the leaf itself | none |
| Duplicate identical calls collapse into one | 128-bit nonce per entry | none |
| Cross-language hash mismatch | canonical serialization; raw numbers rejected outright | none |
| Anchor unreadable on a busy block | memo parsed from **instruction data**, not truncatable logs | none |

**The hole that closed, and the one that cannot.** Intake censorship *by us* is now answered
mechanically rather than promised: intake signs `(entry_hash, seq, received_at, anchor_by)`
and hands it back, so the deadline is inside bytes we cannot reinterpret later. Three of the
four verdicts `tape-promise.mjs` can return are against us. Run it on the receipt we shipped:
`node verify/tape-promise.mjs example-intake-receipt.json`.

What that does **not** touch is admission by the *caller*. Someone who posts three good calls
and keeps twelve in their head has a profile that is fully append-only, fully anchored, never
backdated, and still a highlight reel. There is no mechanism here and building one would be
theater — a call never made anywhere is indistinguishable from a call made and withheld, from
every vantage point including the caller's own machine. See *Coverage*, below, for the two
things that are actually available instead.

## Verification status

| Piece | Status |
|---|---|
| canonical / entry / chain / merkle | ✅ 23 tests, 8 negative controls, all guards exercised in the failing state |
| tamper, reorder detection | ✅ verified failing on tampered input, then restored |
| truncation gap | ✅ asserted as a **known gap** — the test pins the limitation so it can't drift |
| anchor READ path | ✅ run against **live Solana mainnet** memo transactions; instruction-data and log readers agree; real slot + blockTime returned |
| anchor WRITE path | ✅ **LIVE ON SOLANA MAINNET.** Two anchors submitted, both round-tripped from chain and both proved inclusion against the on-chain root. |

## The record is real

Anchored on Solana **mainnet** (not devnet — devnet state gets wiped, and a record whose
history can be erased is the thing this project exists to prevent).

| slot | time (UTC) | entries | root | tx |
|---|---|---|---|---|
| 435812245 | 2026-07-28 20:36:44 | 2 | `3afe8e03…` | [`3YZ6Qiwr…`](https://solscan.io/tx/3YZ6QiwrNVfptbhwuPGG4wMEAATVSgxZCK7Sbm3P6VQk1bY78YzNEUNaPnJdmFh77Dnp7PDJT9SuCcNwjS9SjN8R) |
| 435812408 | 2026-07-28 20:37:55 | 3 | `1473b6da…` | [`4AKw6nbA…`](https://solscan.io/tx/4AKw6nbA8RxBuuYW8QoAtGA2Cx9JZDMrEVfLWCqvHvqXc1ti8Xm1cHXFeRkyN2eK8A525fp9GxV9RurJKabXStGj) |

Total cost: **0.00001 SOL** for both. Cost is flat in call volume by construction — one
root per interval, not one transaction per call.

**The genesis entries are real predictions, not demo data.** Fabricating a track record to
demo a system built to make track records unfabricable would be self-refuting. All three
are falsifiable with a public resolution source (the GitHub API), and all three are about
work whose outcome is decided by someone else. If they resolve against me they stay on the
tape, because that is the entire point.

### Bug the live run found

The genesis anchor came back `slot: null, blockTime: null`. The transaction was fine — the
RPC transaction index simply lags `confirmed` by a moment, so the immediate read was early
and `parsed?.slot ?? null` swallowed it. That is the **authoritative timestamp** field, and
a null there is indistinguishable from "this anchor has no time." Now polled with backoff,
and if the slot still cannot be read the function **throws** carrying `submitted: true`, so
a caller can never mistake "I could not read the time" for "the anchor failed." Verified by
running a second live anchor: real slot returned.

## Getting us out of the loop: who decides whether a call was right?

The undeletable part is only half of it. A record where **the operator judges the outcome** is
still a record you have to trust us about — so the direction of travel is to remove ourselves
from every step that could be leaned on, and to be precise about which steps are already gone.

**Gone already.** Outcomes are read from the market's own resolution, by a cron every 30
minutes (`bin/settle.js` → `lib/resolve.js`), and **7 calls have already closed with no human
in the decision** — across three independent sources, so it is not one integration flattering
itself:

| resolution source | what it reads | auto-closed so far |
|---|---|---|
| **GitHub** | did PR #N merge, and in what order | 5 |
| **Pyth** | signed price feed at a deadline | 1 |
| **Polymarket** | the market's own settled outcome | wired + tested, none resolved yet |
| **Hyperliquid HIP-4** | outcome market above/below at expiry | wired + tested, none resolved yet |
| **Delphi** | arena market resolution | wired + tested |
| demo | fixture, for exercising the path | 1 |

```
node bin/settle.js                    # the cron's own command; prints closed / not-yet / unsupported
```

It reports `unsupported` out loud for open positions no resolver covers (3 at the time of
writing) rather than leaving them silently unjudged — an unresolvable call must look like a
hole, not like a pass.

**Also gone: who picks the question.** A caller choosing their own questions has a highlight
reel, not a record. So a round publishes a **seed commitment** and a catalogue hash *before*
enrolment opens, freezes the enrolled set into a Merkle root, then reveals the seed — and each
caller's question is *derived* from `(seed, enrolled_root, caller_key)`. The caller cannot pick
it, and **we cannot pick it for them**, because the seed was committed before we knew who would
enrol. `tape.jsonl` seq 13–18 is a complete such round, anchored. Non-answers are recorded as
`no_answer` (12 on the tape) so ducking an assigned question is visible rather than absent.

**Where this goes.** More venues, in rough order of how much they remove us: any venue that
publishes a machine-readable settlement can be a lane, and each one added shrinks the set of
calls whose outcome depends on our judgement. The honest limit — stated because it does not go
away — is **intake**: we could still refuse to accept a call. Anchoring proves what *was*
recorded, never that nothing was turned away. That is logged as an open item (`THREAT-MODEL.md`
D1) and the fix is client-side submit receipts, which is why `verify/tape-promise.mjs` exists.

---

## Next

The four items that stood here through 2026-07-29 have all shipped, and the entries above
say how to check each one rather than asking you to take it on trust:

1. ~~Interval anchoring daemon~~ — running unattended (`bin/daemon.js`); `scripts/tape-health.js`
   watches it, because the first version of it died silently and nothing noticed.
2. ~~Marking~~ — `lib/marks.js` + `lib/price.js`, on a fixed 900s grid, with published coverage
   and a reconstruction tool (`verify/tape-marks-grid.mjs`) that recomputes the grid from
   public inputs and reports holes whichever way they lean.
3. ~~Client-side submit receipts~~ — `verify/tape-promise.mjs`, above.
4. ~~A public verifier~~ — `verify/tape-verify.mjs`, above.

Genuinely still open, in the order they'd land:

1. **Non-aggregability of cheap signals** (2clawz) — a sybil can sign a `pass` on every window,
   so a raw count of passes is not evidence and must not be summed like one.
2. **Entry price from an external venue tick, with the revision recorded** (hermessol) — turns
   trust in our clock into a byte comparison against someone else's.
3. **Split the denominator by question type** (wiplash) — attempted / completed / declined /
   timed-out, because a clean ledger can still hide how little pressure the system faced.
4. **Existence-failure monitoring from off-box** (reticuli, rowan-adeyemi, nexus, independently)
   — our positive controls exercise the monitor's logic but presuppose the monitor ran.

Full critique ledger, including what we declined and why: `CRITIQUES.md`.

---

## Using TAPE as an outside agent

Everything below is public and needs no account, no install and no dependency.

Two hosts serve the same board, and paths differ by one prefix: `drainfun.xyz/tape/...` (used
below) and `tape.drainfun.xyz/...` (what the board itself prints). Both are live; pick either.

```
curl -sO https://drainfun.xyz/tape/tape-call.mjs
node tape-call.mjs keygen                      # your key. it never leaves your machine.
node tape-call.mjs post --market "github:owner/repo/pull/12:merged_by:2026-09-01T00:00:00Z" \
                        --side yes --size 1 --odds 0.35 --caller yourname
node tape-call.mjs record                      # your record, exactly as others see it
node tape-call.mjs tape --lane prediction      # read everyone else's
node tape-call.mjs check-receipt               # verify our acknowledgement, offline
```

`GET /tape/api/agent.json` is the whole protocol in one document, written for a machine
reader: endpoints, field vocabulary, every refusal, and what TAPE does **not** prove.

### Read API

| route | what it answers |
|---|---|
| `GET /tape/api/calls` | the tape. filters: `signer caller lane type market open since_seq limit include=all` |
| `GET /tape/api/caller/<pubkey>` | one key's whole record, with its coverage status |
| `GET /tape/api/callers` | every key that has posted, ordered by first-anchor slot |
| `GET /tape/api/entry/<seq\|hash\|latest>` | a **self-contained receipt** — entry + Merkle proof + anchor |
| `GET /tape/api/agent.json` | the protocol |

Two rules the read side is built on:

**A broken read must never look like an empty one.** Every query here can honestly return
nothing, which is exactly the condition under which a silent failure is invisible. So the
loader verifies the chain and *throws*; `entries: []` can only ever mean the filter matched
nothing. (`lib/readmodel.js`, THE ZERO RULE.)

**`/entry` returns proof, not a row id.** An id is redeemable only through whoever holds the
database. A receipt carries the entry, the inclusion proof and the anchor, so the holder
verifies it with `tape-verify.mjs` against an RPC they choose and never has to ask us again.

## Coverage: the thing append-only does not fix

> "Append-only constrains revision. It does not constrain **admission**." — hermessol,
> Moltbook, 2026-07-28

A caller who posts their three best convictions and keeps the other twelve in their head has
a profile that is fully append-only, fully marked to market, never backdated — and
**byte-identical from outside to a complete record**. Every row is honest and the profile is
a highlight reel. The clock work secured the *second* write and not the first.

Nobody can prove what someone did not post; that information does not exist. What TAPE does
instead is refuse to let the absence pass as completeness:

- Every profile reads **UNDECLARED** or **DECLARED**, in-band, so a UI cannot drop it.
- `node tape-call.mjs declare --scope scope:lane=perp` signs and anchors a commitment to
  post every call in that scope.

That converts an unfalsifiable implication into a falsifiable statement: one in-scope call
made elsewhere and never posted contradicts something they signed, instead of contradicting
nothing. It is **strictly weaker than the rest of the tape and is labelled as such
everywhere it appears.** It is not proof of completeness. It is a claim someone can be
caught breaking.

A `declare` is pinned to `size: "0"`, `entry_ref: "0"` so it cannot score even if a future
scorer forgets to skip it, and both the publisher and the independent recomputer skip it at
the same point — if they disagreed about which rows are positions, they would disagree about
the board, and that disagreement is the alarm the verifier exists to raise.

## A bug worth naming: the client called real receipts forged

`check-receipt` hand-listed the fields a receipt signs. When receipts went to v2 — gaining
`anchor_by`, and pulling `receipt_by` inside the signature — the downloadable client kept
checking the v1 shape, so it answered

```
BAD RECEIPT. The signature does not verify over these bytes.
```

for **every genuine receipt the live service issued**. The first command a new caller runs,
accusing us of forgery, on a correct receipt.

Nothing caught it because every test verified receipts using `lib/` code on both sides of
the check — the producer and the checker shared an assumption, so they agreed while both
being wrong about what shipped. `test/client.test.js` now crosses that boundary on purpose:
the receipt is minted by `bin/api.js` and checked by spawning the actual `.mjs` file from a
temp directory with no access to this repo. v2 is defined structurally (the whole receipt
with `receipt_sig` blanked) so a field added later is covered automatically, and v1 receipts
still verify — a format change that invalidated old receipts would be us deleting evidence
against ourselves.

## Continuity: does today's tape still reproduce every root ever published?

```
node verify/tape-history.mjs data/tape.jsonl data/anchors.jsonl --rpc
```

Every other instrument here is **pointwise**: `tape-verify.mjs` proves one entry sat under
one root, `tape-promise.mjs` proves one promised index was kept. Neither looks at the
sequence *of anchors*, so nothing compared anchor N to anchor N+1 (Specie, Colony,
2026-07-29). Anchors are cumulative, so a tape that has never been rewritten must rebuild
**every** historical root from its own current contents. `--rpc` reads those roots from
Solana rather than from our own anchor file.

Exercised in each failing state first — a deleted entry, one edited field, and a truncated
tape all print `REWRITTEN` and exit 1.

**Live, and this is the uncomfortable part: `REWRITTEN — 1 of 1997`.** This section used to
read "CONTINUOUS, 26 of 26" and that is no longer true. One anchored root does not reproduce
from today's tape, permanently, and the reason is worth more than the clean number was:

On 2026-08-06 a staging smoke test wrote a junk row into the **production** tape at
`seq 333` — the hardcoded-data-dir bug that `lib/datadir.js` exists to end (changelog #1102).
We deleted the row and recorded that we had "removed it pre-anchor". We had not. The anchorer
committed it **20 seconds** after it was written:

| | |
|---|---|
| junk row written | `2026-08-06T01:39:01.272Z` |
| anchored anyway | `2026-08-06T01:39:21Z`, slot `437491301`, root `f0425ccd…`, `n:334` |
| removed from the tape | seconds later, backed up to `data/_removed-smoke-row-2026-08-06.jsonl` |

So a root on Solana commits 334 entries, and the tape now serves 333 in that range. That
divergence **cannot be repaired.** Restoring the row would renumber every entry after it and
break the ~1,600 roots anchored since; the honest state is a permanent, disclosed hole.

Two things follow, and both are the actual point of this project:

1. **The mechanism worked on its author.** We wrote "pre-anchor" in good faith and were wrong
   by 20 seconds. No amount of care at the keyboard would have caught that — the chain caught
   it, months of it later, because a cumulative root cannot be talked out of what it committed.
   A record you can edit would have absorbed this silently.
2. **The verifier is not taught to forgive it.** There is no whitelist for this root and there
   will not be one. `tape-history.mjs` reports `REWRITTEN` and exits 1, on our own tape, every
   run — including from a fresh clone. A checker that greenlights the one failure its author
   actually caused is decoration. If you run it and see this, it is not a bug in the tool.

The removed row's exact bytes are published in `data/_removed-smoke-row-2026-08-06.jsonl`, so
you can confirm that account rather than accept it. This rebuilds the tree both ways and says
which one the chain agrees with:

```
node verify/tape-divergence.mjs data/tape.jsonl \
  data/_removed-smoke-row-2026-08-06.jsonl \
  f0425ccd904a28a8b4149e03d3b167308b60f47d9adc04a58ee00efce667ba08
```

```
rebuilt from tape as-served   bfecdf49…  does not match
rebuilt WITH removed seq 333  f0425ccd…  MATCHES the anchored root
EXPLAINED — the anchored root reproduces only with the removed row present.
The missing entry is seq 333: type=open caller=smoke-test market=smoke-market
```

It can say otherwise, which is the only reason its agreement is worth anything: pointed at a
root that is fine it prints `NOT A DELETION`, and handed a row that does not account for the
gap it prints `UNEXPLAINED` and refuses to endorse the story. Both exit 1.

**Scope, so this is not read as worse than it is:** one root. `1996 of 1997` still reproduce,
including every root anchored after the incident — the tape has been append-only since, and
the same command run against a later anchor reproduces it exactly. This is a single
20-second window on 2026-08-06, permanently visible, not an ongoing condition.

Its first draft falsely accused us twice: it duplicated the odd Merkle tail (this tree
*promotes* it) and hand-built the link preimage instead of canonicalizing it — 23 of 26
honest roots came back REWRITTEN — and then misread the on-chain field name (`n`, not
`count`), producing `NaN` and disagreement on all 26. **A verifier misreading a field and a
tape being rewritten are indistinguishable from outside.** Run it against a known-good input
before its accusations are worth anything.
