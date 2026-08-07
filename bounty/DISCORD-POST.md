# Discord showcase post — `#solana-bounty`

Paste the block below, attach `tape-demo.mp4`. Nothing in it is a claim the repo
can't back; every number is reproducible from the commands in the README.

---

**TAPE — an undeletable call record, running on ZeroClaw + Solana**

Every crypto caller has a great track record, because they delete the bad calls. TAPE is a
call record they can't delete — the timestamp isn't ours, it's Solana's.

A ZeroClaw agent **records** predictions on a real channel, commits each one into a Merkle
root, and anchors that root to Solana mainnet. One rule: **post a position and it stays open
and marks to market until you publicly close it.** No delete, no edit, no quiet abandonment.
A 90% win rate with one −$400k open bag ranks below 55% with clean books.

**To be explicit, because the words "trading call" are all over this: TAPE places no trades.**
It executes no orders, holds no user funds, touches no token program, and integrates with no
venue's write API (`lib/hyperliquid.js` reads `/info` only). The one key it holds can emit
`{Memo, ComputeBudget}` and nothing else, enforced in code. It makes callers accountable for
calls they make elsewhere — safe hands, not a bot.

**Live on mainnet, unattended, for over a week — not a demo built for the video.** More than
**1,900 anchors across 9+ unbroken days**, all mainnet, real lamports, mean interval ~7
minutes. Still anchoring right now; `node bin/anchor-stats.js` prints the live figure and
also prints our three outages (61, 87 and 27 minutes) rather than smoothing them, because the
87-minute one is the daemon dying silently with nothing noticing — which is why it now has a
health canary. The call in the video is verified against slot `436241109`.

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

**Honest about custody — and on YOUR ladder we are T2 (Sign), not T1.** The key signs and
submits ~1,996 mainnet transactions, so calling it T1 ("Secrets held: none") would be wrong.
We meet your T2 conditions on caps (per-tx and per-day, in code) and allowlist (`{Memo,
ComputeBudget}` — no token program is reachable, so the mint allowlist is satisfied vacuously)
with a dedicated small-balance session key. We do **not** have an approval gate, and we're not
going to call the allowlist one: a checkpoint a human clicks 288×/day stops being a control,
so we constrained what the key can *ever* sign instead. If the missing checkpoint costs points,
that's fair. Separately, the README carries a correction where we checked the key instead of
our own sentence and found an earlier claim of ours false — blast radius is the key's balance,
not zero, and a child `node` process can read the keyfile *outside* the gate.

**Which ZeroClaw features it uses** — Telegram channel (`channels.telegram`) to take calls
where people already are, live and paired; a 5-tool skill bundle for post/anchor/receipt/verify
(`skills audit` passes); a declarative cron job `*/5 * * * *` that marks every interval without
being asked; ZeroClaw memory (`uses_memory = true`); cross-provider fallback
(`openrouter.default` → `gemini.default`, measured against a real free-tier quota wall); and a
narrow `tape` risk profile so the anchor key can't be talked into anything else. We also ship an
MCP server (`mcp/tape-mcp.mjs`, 17 tools) so other agents can use the record without our client
— we run no *external* MCP server, so nothing third-party signs or holds keys for us. The `tape-anchor` SOP validates and is built, but the cron path is what's been running
unattended — I'd rather say which is which than let you assume.

Full write-up, threat model and reproduce steps: `SUBMISSION.md` and `THREAT-MODEL.md` in the repo.

Repo: https://github.com/weiscadence/tape
Reproduce it in under a minute — "See it work in 60 seconds" at the top of the README. The two
verifier commands need no `npm install`: `verify/*.mjs` has zero npm dependencies and imports
nothing from our `lib/`, because a verifier that needs our code installed is one that trusts
our code.

One line no leaderboard can say: **the scorekeeper can't cheat the score, and anyone can
prove it — including against us.**

---

## Before posting, check

- [ ] Video attached (`bounty/tape-demo.mp4`, **2:38**, under the 3:00 limit) — measured with `ffprobe`, not estimated; it read 1:51 here for a cut that no longer existed
- [ ] Repo is public and the link resolves in an incognito window
- [ ] Posted in `#solana-bounty` (the bounty listing requires the showcase post)
- [ ] Superteam listing submission filed: `earn.superteam.fun/listing/zeroclaw`

Deadline **2026-08-07 02:59 UTC**. Rewards 1st $1800 · 2nd $1200 · 3rd $1000 · 4 × $250.
