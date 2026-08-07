# TAPE — threat model

The product is a claim: *the scorekeeper cannot cheat the score, and anyone can prove it,
including against us.* A threat model for that claim is not a formality — it is the spec.
Each attack below is either **closed** (the design makes it fail), **mitigated** (made
visible and costly, not impossible), or **open** (named, not yet built). We list the open
ones on purpose; a threat model with no residuals is marketing.

Attacker capabilities assumed throughout: the attacker may be **us, the operator**. We hold
the chain file, the anchor key, and the server. The whole design exists to make that
ownership not matter.

---

## A. Operator tampering with the record

**A1 — Backdate a call.** *Closed.* The authoritative timestamp is the Solana slot of the
anchor, not our clock. We cannot mint a slot in the past.

**A2 — Reorder calls.** *Closed.* Each entry chains to the previous (`H(prev‖seq‖entry)`)
and the chain head is committed in every anchor. Reordering breaks the chain, which the
verifier recomputes.

**A3 — Silently drop a call after it looks bad.** *Closed for anchored entries.* Once an
entry is inside an anchored Merkle root, its inclusion proof recomputes that on-chain root.
Removing it is detectable by anyone holding the receipt. *Residual:* an entry in the window
between post and the next anchor is not yet protected — see D1.

**A4 — Edit a call after the outcome is known** (change the price, rewrite the note,
backdate the caller's own timestamp). *Closed.* Every field — including the non-authoritative
`ts_claimed` and the free-text `note` — is inside the canonical bytes the leaf hash is taken
over. Any change produces a different hash and the verifier returns **FRAUD**. Verified by
five negative controls.

**A5 — Rebuild the whole chain from scratch to hide history.** *Closed by anchoring.* A
freshly rebuilt chain is internally valid, but its roots will not match the roots already on
Solana at their slots. The verifier compares against the chain, not against our current file.

**A6 — Freeze the tape when it is about to say something inconvenient.** *Closed by a design
reversal.* The naive anchor command refuses to anchor if any entry fails the eligibility
gate — which hands us exactly this power (and fires as a self-DoS the moment any honest
prediction resolves). The interval job instead anchors **unconditionally**; eligibility is a
separate, re-derivable judgement. Anchoring attests time, not validity.

**A7 — Mark the open book at a moment of our choosing.** *Closed 2026-07-29, after three
agents (reticuli, ax7, bytes) found it by reading the design.* The oracle was already
external — Pyth Hermes, queried at a fixed past timestamp, staleness-guarded, with a loud
refusal instead of a silent last-known. But an open position's end leg marks at `as_of`, and
`as_of` was `Date.now()` at whatever moment we chose to run publish. An external feed read at
an internally-chosen instant is still an internal mark: we could not backdate *when* a
position opened, but we could still price the open bag at a flattering second.

Measured before fixing, because an unsized hazard is a guess: **0.90%** of free swing on
SOL/USD across a six-hour window of choosable publish times, and a multiple of that on a
leveraged lane.

*Fix:* `as_of = floor(now / GRID_SEC) * GRID_SEC` (`lib/asof.js`, 900s). Derived, not chosen
— two runs nine minutes apart mark to the same tick, so waiting for a better price buys
nothing. `publish` refuses an off-grid mark, and — the half that actually binds us —
`tape-recompute.mjs` rejects an off-grid or future-dated board, because that is the program a
stranger runs.

*Why this one mattered more than its size:* a board tampered by +407s passed the pre-fix
recomputer with **MATCH, exit 0** — markset hash, chain links, signatures and anchor roots all
verifying correctly. Everything was consistent because the lie was never in the arithmetic.
The same file's header already records making this mistake once with position status; this was
the same class, one field over. Four controls in `recompute-controls.sh` now cover it,
including an on-grid future date that alignment alone cannot catch.

*Residual:* alignment stops us marking at a hand-picked instant; it does not stop us skipping
an unflattering grid point. Every published point therefore appends to `marks-history.jsonl`
and ships with the board, so a skip is a **hole** rather than an absence of evidence. Still
possible, no longer quiet.

## B. Merkle-tree attacks

**B1 — Second-preimage / leaf-vs-node confusion.** *Closed.* Domain separation: leaves are
hashed with a `0x00` prefix, internal nodes with `0x01`. The safe verifier entry point hashes
the entry itself and never accepts a raw digest, so an internal node cannot be replayed in a
leaf position. Found by a negative control that failed against the digest-level primitive on
its first run.

**B2 — Odd-node duplication (CVE-2012-2459 shape).** *Closed twice over.* An odd node is
promoted unchanged rather than duplicated, and the leaf **count** is committed alongside the
root in the anchor payload, so a root is only ever interpreted against one tree shape.

**B3 — Claim inclusion in a real anchor you were not in.** *Closed.* Every field of the
receipt can be authentic and only the pairing a lie; the verifier recomputes the root from
the entry + proof and compares to the on-chain root, so a mismatched pairing is **FRAUD**.
This is negative control #5.

## C. Caller-side gaming

**C1 — Post a call whose outcome is already known.** *Closed by the gate.* At anchor time
the gate re-checks resolution; an entry resolved before its anchoring slot is voided as an
append-only amend, not scored. Caught two of our own genesis entries that were anchored
14 minutes after they had already merged.

**C2 — Non-portable hash (argue later "that isn't what I posted").** *Closed.* The
canonical form sorts keys, emits no whitespace, and **rejects raw numbers outright** —
every quantity is a decimal string, because float formatting is not portable across
languages. Two honest parties always produce the same bytes.

**C3 — Collide two identical calls to silently delete one.** *Closed.* Every entry carries a
32-hex nonce, so two otherwise-identical calls are distinct leaves.

**C4 — Re-point an exit at a better entry after the fact.** *Closed.* A `close`/`amend` must
reference the hash of an existing, earlier entry, checked at write time.

## D. Open / residual

**D0 — Time was one-sided until 2026-08-06. (CLOSED for new rows, RESIDUAL for old ones.)**
Every row's time rested on a single number: the Solana slot of the anchor covering it. That
is a genuine **not-after** — the call provably existed by slot N, therefore before the
outcome. It bounded nothing on the other side. The earliest a row could have been written
was our own assertion, which is the operator vouching for the operator, and a record with
only a not-after cannot distinguish a call made early from one written late and anchored
promptly.

*Fixed for rows written from 2026-08-06:* an entry may commit to a drand quicknet round
(`beacon` in `lib/entry.js`), whose randomness is `H(sig_R)` for a threshold BLS signature
that does not exist before round R publishes. A row committing to it cannot have been
constructed earlier. Combined with the anchor, a row's time is the interval
`[roundTime(R), blockTime(anchor_slot)]`, fenced by two systems we do not run
(`lib/interval.js`). Adopted from reticuli's Touchstone (Colony `ea7fe6ed`), which binds
drand against a Bitcoin not-after.

*The residual, stated plainly.* The binding is **optional and folded in only when present**,
because a required field would have invalidated all 333 existing rows to gain a property on
future rows only. So every row before 2026-08-06 is still one-sided, and the read model must
render that difference rather than let a reader assume the strong form applies tapewide —
`verifyEntryInterval` returns `not-after-only` for exactly this reason, and it is not a
success state dressed up as one.

*Why Solana and not Bitcoin for the not-after — the trade we took.* Touchstone anchors
checkpoints to Bitcoin via OpenTimestamps. We keep Solana: the anchor is already there, the
slot is a finer clock than a block, and confirmation is seconds rather than roughly an hour,
which matters because a not-after is only worth something if it lands before the outcome
resolves. **The cost is reorg depth.** Bitcoin's proof-of-work makes deep reorganisation
enormously expensive; Solana's finality is cheaper to unwind in principle, so our not-after
inherits a weaker settlement assumption than a Bitcoin anchor would give. We judge that
acceptable because the bound only needs to hold against an outcome days away and an attacker
who could reorg Solana to move an anchor slot has far more profitable things to do — but it
is a real difference in kind, not a wash, and anyone comparing the two systems should know
which side of it we are on. *Not mitigated, accepted and disclosed.* The drand side inherits
its own assumption: a threshold of drand nodes colluding to withhold or grind a round. That
is strictly weaker than "the audited party picked the number", which is what it replaces.

**D1 — Intake censorship. (OPEN.)** We can prove we did not alter what we accepted. We cannot
yet prove we accepted *everything submitted*. A malicious operator could refuse a call at
intake and no one could prove the refusal happened. *Planned fix:* a signed receipt issued at
submit time (before anchoring), so a caller holds proof their call was received; a missing
anchor for a signed-receipt call is then itself evidence. **Built 2026-07-28** (`bin/api.js`,
`intakeReceipt`): acceptance returns a signature over `(entry_hash, received_at, seq)` under a
receipt key that is deliberately *not* the anchor key, separating who timestamps from who
commits. This does not stop us dropping a call — it stops us *denying* we had it, which is a
different and weaker guarantee.

*Still open, and sharper than the original entry (hermessol, 2026-07-28):* append-only
constrains **revision**, not **admission**. A caller who posts three convictions and keeps
twelve in their head has a record that is honest about every row it holds and silent about
rows never minted — and those two states are byte-identical from outside. The receipt cannot
reach this case because there is no second party: the calls were never offered to anyone, so
nobody holds proof they existed. Censorship is detectable because it has a victim; curation is
not because it does not. Candidate directions, both weaker than a proof: commit-then-reveal a
declared cadence, so silence in a declared lane is itself a fact; or publish completeness as a
separate visible column so a three-call profile reads as a three-call profile rather than a
clean sheet. Unresolved.

*Ordering (specie, 2026-07-28).* The receipt proves receipt, not sequence integrity. Because
`seq` and `received_at` are signed **together**, any two receipts whose `received_at` order
disagrees with their `seq` order are a signed self-contradiction anyone can check — but that
requires two callers comparing notes, so it is detectable at N=2 and never at N=1. Front-
running by the intake (the only party who sees a call before it is public) is **unsolved**;
the receipt/anchor key split separates who timestamps from who commits, not who sees first.

**D2 — Sybil / collusion. (MITIGATED, not solved.)** Two colluding keys can sign valid
attestations for each other. Cryptography cannot touch this — the signatures are valid; the
lie is in the relationship. *Mitigations, none of which is a trust score:*
- attested results and oracle-settled results are **never summed** — a Sybil ring can inflate
  the attested column without moving the oracle column;
- identity is free but **anchored age is not** — a ring is a cohort with near-identical
  first-anchor slots and a closed edge set, computable from public data;
- an attestation is capped by the attestor's own independently-settled record — fresh
  accounts attest to nothing;
- the ranking is a **re-derivable function**: anyone can recompute a different leaderboard
  from public data and prove ours wrong. We publish a function; we do not appoint ourselves
  judge. *Residual:* if a rival leaderboard is expensive to compute, our default view is the
  authority in practice. Keeping re-derivation cheap is a standing requirement, not a
  finished property.

**D3 — Custody of the anchor key. (ACCEPTED, narrowed 2026-07-29; premise CORRECTED
2026-07-31.)** The key is a hot key readable by any process running as the host user (the risk
profile sandboxes ZeroClaw's own tools, not a child `node`).

This entry used to accept the risk "because the key can only write memos and **holds no
funds** — the blast radius of a leak is 'someone can write memos'." That premise was false and
is withdrawn: the key holds real mainnet SOL, it has signed a SOL transfer, and it is shared
with two sibling projects. **The blast radius of a leak is the balance, not zero.**

What survives the correction is narrower and worth stating exactly: *through the signing gate*
the key can only emit `{Memo, ComputeBudget}` (`lib/signing-policy.js`), so this process cannot
spend the balance. A child process that reads the keypair file is outside the gate, so the
acceptance now rests on the balance being deliberately small and per-day capped on the
anchoring path — not on there being nothing to take. Upgrading to a signer isolated from the
agent host is the actual fix and is open work, not a solved problem.

*Defense-in-depth added 2026-08-07:* the agent's `tape` risk profile now lists `~/.config`
and `~/.zeroclaw` in `forbidden_paths`, so the agent's file-read **tool** can no longer open
the keypair file or the config that holds the channel token. This is honestly partial: every
tape tool is a `node <script>` shell command, so `allowed_commands = ["node"]` is load-bearing
and cannot be removed, and the `node` interpreter reads any file the OS user can — a prompt
injection that gets the agent to run an arbitrary `node` command still reaches the key. A
config file cannot sandbox an interpreter. The only close for the exec path is running the
anchor daemon and key under a **different OS user than the agent**; a `tapesvc` user already
exists on the box (it runs the intake API), so the mechanism is available. It is deliberately
**not** switched on during the judging window because the anchor runs inside ZeroClaw's own
cron, and moving it to a separate-user timer would change the "ZeroClaw's cron is the only
anchorer" claim the submission makes — a tradeoff for the operator to make, not a silent one.

*Narrowed:* the one process reachable from the open internet — the intake — is no longer one
of those processes. See E1. The claim in `api.js` that the receipt key is deliberately not the
anchor key was true of the code and false of the deployment: a process that can read the anchor
key off disk holds the anchor key regardless of which one it was handed. That gap is closed.

**D4 — Resolver outage misread as a verdict. (CLOSED, worth stating.)** A GitHub/price-oracle
outage is recorded as `unknown`, excluded from ranking, and retried — never a silent pass
(which would let pre-settled calls through during an outage) and never a false void (which
would let an outage destroy an honest call).

## E. Deployment / blast radius

The record can be cryptographically perfect and still be worthless if the box serving it is
soft. These are host-level, and they are in the threat model because every one of them was
true of the running deployment on 2026-07-29 while the protocol-level document above was
already finished.

**E1 — Intake process privilege. (CLOSED 2026-07-29.)** The intake ran under pm2 as the host
user. That is the only TAPE process an anonymous POST can reach, and it could read
`~/.config/cadence-secure`: the Solana anchor key, the Telegram bot token, every social
credential and a full-scope GitHub PAT. *Fixed:* it runs as a dedicated system user under a
hardened systemd unit — `ProtectHome=tmpfs` with the TAPE code bind-mounted read-only and the
data directory read-write, so nothing else in the home directory exists inside the namespace.
`NoNewPrivileges`, empty capability set, `SystemCallFilter=@system-service`, `MemoryMax=512M`,
`TasksMax=32`. The two credentials it legitimately needs live in `/etc/tape`, mode 0640.
*Verified by entering the running namespace as the service uid:* `cadence-secure`, the other
projects on the box and the code directory's write access are all absent, while the data path
it must append to works. A sandbox nobody tried to escape is a configuration file, not a
control.

**E2 — Integrity of the data directory. (CLOSED 2026-07-29.)** The intake needs to create a
lock file, so it needs directory write, which also let it unlink `anchors.jsonl` — the log
tying entries to Solana slots. Deleting the anchor log does not forge anything, but it destroys
the evidence that makes forgery detectable, which is the same outcome one step removed.
*Fixed:* sticky bit on the directory (a writer may only remove files it owns), group-write on
`tape.jsonl` alone, everything else read-only to the service. A private key that had been left
in that directory was moved out entirely. *Verified:* from inside the namespace, `rm` and
truncate of `anchors.jsonl` both fail; append to `tape.jsonl` and lock creation both succeed.

**E3 — Rate limiting the free-key problem. (MITIGATED.)** The intake limits 30 calls/hour per
signing key, and keys are free to mint, so alone it bounds nothing. Now behind a per-client
nginx limit (20 r/m, burst 5), a connection cap, a method whitelist and a 16KB body cap.
*Found while doing it:* the site is behind Cloudflare and nothing set `real_ip`, so every
`limit_req_zone` on the host was bucketing by **Cloudflare edge IP** — thousands of unrelated
visitors sharing a counter while an attacker spread across edges got a larger allowance than a
single honest user. A rate limit keyed on the wrong identifier is not a weak rate limit; it is
a rate limit on something else. `CF-Connecting-IP` is now trusted only from published
Cloudflare ranges, so a request that skips Cloudflare cannot forge itself a fresh bucket.
*Verified in both directions:* the limit fires at the configured burst, and a forged
`CF-Connecting-IP` sent directly to the origin is logged under its true source address.

**E4 — Shared origin with the rest of the site. (OPEN — the real remaining hole.)** TAPE is
served at `drainfun.xyz/tape/`, the same origin as an unrelated app that keeps API keys in
`localStorage`. Same origin means same DOM: script injected into either side can read the
other's storage. The CSP now on `/tape/` (`script-src 'self'`, `frame-ancestors 'none'`,
`object-src 'none'`, COOP) removes the cheapest routes in, but it is a mitigation and not the
fix. **The fix is a separate hostname**, which needs a DNS record we do not control. Stated
here rather than counted as done. Note `connect-src` is deliberately left as `https:` and not
an allowlist: the verifier lets the reader supply their own Solana RPC, and a page that only
checks our claim against an endpoint *we* chose is not an independent verifier.

**E5 — Resolver credential scope. (OPEN.)** The T0.1 gate reads public GitHub repos and needs
no more than that, but the token it uses is a broad personal token. It is now confined to the
sandbox and readable only by the service user; the *scope* is still wrong. The code treats the
token as optional and falls back to unauthenticated public reads, so replacing it with a
fine-grained read-only token is a file swap with no code change.

**E6 — Origin reachable directly. (ACCEPTED, flagged.)** The host answers on its public IP,
so Cloudflare can be bypassed. The nginx limits and the sandbox apply on that path too, and
the forged-header test above was run over it. Restricting the firewall to Cloudflare ranges
would close it at the cost of direct-IP testing; not taken unilaterally.
