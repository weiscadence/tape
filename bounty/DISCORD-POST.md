# Discord showcase post — `#solana-bounty`

Paste the block below, attach `tape-demo.mp4`. Nothing in it is a claim the repo
can't back; every number is reproducible from the commands in the README.

---

**TAPE — an undeletable call record, running on ZeroClaw + Solana**

Every crypto caller has a great track record, because they delete the bad calls. TAPE is a
call record they can't delete — the timestamp isn't ours, it's Solana's.

A ZeroClaw agent takes trading/prediction calls on a real channel, commits each one into a
Merkle root, and anchors that root to Solana mainnet. One rule: **post a position and it
stays open and marks to market until you publicly close it.** No delete, no edit, no quiet
abandonment. A 90% win rate with one −$400k open bag ranks below 55% with clean books.

**Live on mainnet, not a testnet demo.** Six anchors, real lamports. The call in the video
is verified against slot `436241109`.

**What I'd actually like you to look at — the verifier can convict us.**
It shares no code with the thing that writes the records and it talks to Solana, not to our
server. In the video I edit one number in our own receipt (entry price 0.72 → 0.42) and run
it: our own tool prints `FRAUD` and exits 1. A verifier that can only ever confirm is a logo.

**Fund-safety / prompt-injection test.** Ours assumes the attack has already fully
succeeded — the model is compromised and actively assembling the attacker's transfer. It
still fails, because the anchor key cannot express a transfer: `lib/signing-policy.js` is a
deny-by-default gate certifying the serialized transaction against intent
(`{ComputeBudget, Memo}`, payer-only) *before the signer is reached*. So "refused" is
distinguishable from "sent and failed". 3/3, fails closed.

**Honest about custody.** This is tier T1 and the README says exactly what that does and
doesn't buy — including a correction where we checked the key instead of our own sentence
and found an earlier claim of ours was wrong. The blast radius today is the key's balance,
not zero, and a dedicated TAPE-only key is the real fix.

Repo: https://github.com/weiscadence/tape
Reproduce it in under a minute — "See it work in 60 seconds" at the top of the README. The two
verifier commands need no `npm install`: `verify/*.mjs` has zero npm dependencies and imports
nothing from our `lib/`, because a verifier that needs our code installed is one that trusts
our code.

One line no leaderboard can say: **the scorekeeper can't cheat the score, and anyone can
prove it — including against us.**

---

## Before posting, check

- [ ] Video attached (`bounty/tape-demo.mp4`, 2:05, under the 3:00 limit)
- [ ] Repo is public and the link resolves in an incognito window
- [ ] Posted in `#solana-bounty` (the bounty listing requires the showcase post)
- [ ] Superteam listing submission filed: `earn.superteam.fun/listing/zeroclaw`

Deadline **2026-08-07 02:59 UTC**. Rewards 1st $1800 · 2nd $1200 · 3rd $1000 · 4 × $250.
