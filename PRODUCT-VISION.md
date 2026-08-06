# TAPE as a product — miniapp direction (Jiggy, 2026-08-06)

Captured from Jiggy's brainstorm the night of the ZeroClaw submission. This is the **v2 after
the bounty**, not part of the bounty submission (see "Not this submission" below). Recording it
so the idea doesn't evaporate.

## The one rule that decides everything

**A lane gets a leaderboard only if its outcome is objectively resolvable without trusting us.**

TAPE's entire pitch is "the scorekeeper can't cheat the score." A lane whose result is a
judgment call reintroduces the diary we exist to kill. So lanes are ranked by how cheaply a
stranger can check the outcome against ground truth — not by how interesting they are.

This is the same wormhole from the ALFALFA dive: prediction markets resolve to ground truth,
token lanes mostly never resolve. Jiggy independently arrived at it ("since you can easily see
if it's yes or no"). It's the correct instinct and it orders the whole roadmap.

## Lanes, ordered by verifiability (my recommended build order)

1. **Prediction-market calls (Polymarket yes/no).** Gold standard. The market itself resolves
   to 0 or 1 on-chain; we already have poly_trader data, swisstony copy history, and 258/261
   real closePrices. A call is "post market #X: YES @ 0.55", anchored to Solana, and the
   outcome is the market's own settlement. Zero adjudication on our side. **This is lane one.**
2. **The call record (what TAPE already is).** Any timestamped call — token, macro, sports —
   anchored so the clock isn't ours. Ranks on "did you beat holding SOL", closes must be
   public. Already live.
3. **Memecoin entry/exit tracking.** Real but *fuzzier*: the fills are on-chain (verifiable),
   but "did they exit" and unrealized-vs-realized is a modeling choice. Rank only realized,
   wallet-attributed, on-chain-confirmed round-trips. Later, because the resolution rule needs
   care.
4. **Open submissions — "here's another way I make money."** The frontier and the hard part.
   Anyone (human or agent) submits a lane. **It only earns a rank if it ships with a resolution
   oracle** — a mechanical, re-runnable check that says who was right. No oracle → it can live
   as a *claim* on the board but never scores. That rule *is* the anti-diary stance applied to
   the whole platform, and it's what stops the open door from becoming a spam firehose.

## The account layer = the badge of trust (Jiggy, 2026-08-06)

Same shape as the Drain swipe app: Telegram mini app → connect wallet → account saved. But
here the account is the *product*, not a convenience. A caller links a wallet + Telegram once,
and from then on **every call they post is anchored under that identity and can't be edited or
deleted.** Their leaderboard standing becomes a portable credential: "this person's track
record is on Solana's clock, not their own." That's the badge — not a cosmetic checkmark, a
*provable* one. A human caller can screenshot or link their TAPE profile as proof-of-record the
same way a trader flexes a PnL, except this one can't be doctored.

Wallet-connect stays **read-only / signing-for-identity only** — connecting proves you control
the key (a signed nonce), it does NOT grant the app spend authority. Consistent with T1: the
badge is about *identity + record*, never custody.

## The four lanes (Jiggy asked me to re-list them)

1. **Prediction markets (yes/no)** — resolves on-chain, zero adjudication. **Build first.**
2. **The call record** — any timestamped call, anchored; what TAPE already is.
3. **Memecoin entry/exit** — on-chain fills are verifiable; rank realized round-trips only.
4. **Open submissions** — anyone submits a lane; it scores only if it ships a resolution oracle.

## Answering Jiggy's specific questions

- **Is a miniapp still "in the ZeroClaw realm"?** Yes. The rubric literally rewards "one use
  case someone runs every day." Buttons that run commands map to ZeroClaw **channel triggers +
  SOPs** — a button press is an inbound message that starts a procedure. That's Tier 1, no
  compiled code. The miniapp is a front-end; ZeroClaw stays the engine that takes the call,
  commits it, and anchors it.
- **Humans and agents both get accounts.** Same rule for both: post a call, it's open until you
  publicly close it. No delete. Identity can be a wallet (agents) or Telegram (humans).
- **Do the buttons run code to ZeroClaw?** Yes — that's the clean version. Button → channel
  trigger → SOP → anchored result. Not the app reaching into a database directly; the app
  speaks to the agent, so the agent's rules (no delete, anchor-first) always hold.
- **Populate high-volume markets.** Pull the top-liquidity Polymarket markets so there's always
  something live to call. `fundamentals-scan.js` output already computes `edge = your_prob −
  price`, which is exactly the number a caller wants shown next to each market.

## Custody — keep it T1, hard line

The miniapp **posts calls; it never signs a transfer.** Humans and agents put predictions on
record; the app anchors them. No button moves funds. The moment a button places a real trade
it's T2 and needs the whole apparatus (spend caps, mint allowlist, approval gate) — don't cross
that line to ship a leaderboard. The value is the *provable record*, not custody of anyone's
money.

## Not this submission

The ZeroClaw bounty we're submitting tonight wins on "one thing, done well, provably running."
A half-built miniapp would *dilute* that, and there's no time. The submission stays TAPE-the-
receipt. This doc is TAPE-the-product, built after the paste lands. The bounty judging even
helps us here: whatever the judges probe becomes the v2 punch list.

## First concrete slice (when we start)

Lane 1 only: Polymarket prediction calls, humans + agents, one leaderboard, "beat the market
price" scoring, calls anchored via the existing ZeroClaw path. Everything already exists except
the account layer and the miniapp shell — the resolver, the anchor, the copy data are built.
Ship the narrowest honest version, then add lanes 2–4 as their oracles get built.
