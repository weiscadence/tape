# Lane 1 build spec — TAPE prediction leaderboard + caller accounts

The narrowest honest version of the miniapp. Structured like the Drain swipe app: Telegram
mini app → connect wallet → account saved → the account *is* the badge of trust.

## What already exists (VERIFIED 2026-08-06 — do NOT rebuild)
- **The anchored record.** `data/tape.jsonl` entries carry `caller`, `lane:"prediction"`,
  `market`, `side`, `entry_ref`, `ts_claimed`, hash-chained + Solana-anchored (377 entries,
  1805 anchors live). A call is already a first-class object.
- **The whole scoring engine.** `bin/leaderboard.js` + `lib/score.js` already: verify the chain
  before scoring, build positions, fetch marks, score **vs holding SOL** (the real benchmark),
  handle voids/exclusions/unscored-with-reason, and emit a reproducible JSON artifact with a
  markset hash so anyone can recompute. This is more complete than a v1 leaderboard needs —
  running it today ranks 7 scored callers across the real anchored data.
- **The badge already has a foothold.** The engine distinguishes `unsigned:<handle>` from a
  signed wallet caller (`8frH…392d`). Signed-wallet identity is *already a stronger caller* in
  the data model — the badge-of-trust mechanic is a UI surface over a distinction that exists.
- **The resolver inputs.** `data/market-titles.json` resolves `polymarket:` / `delphi:` / `pyth:`
  markets to titles; `lib/marks.js` fetches marks. Unresolved binaries are shown *unscored with
  a reason*, never guessed.
- **The anchor path + verifier.** `bin/anchor-stats.js`, `verify/*.mjs` (zero-dep, convicts us).

## What's actually new (the real build — much smaller than it looked)
1. **Miniapp shell** — Telegram Mini App, Drain-style: markets list, call button, my-record,
   leaderboard view. The leaderboard *data* is already produced by `bin/leaderboard.js --json`.
2. **Account save + wallet-connect** — persist `{tg_id ↔ wallet}` so a caller keeps one signed
   identity; promotes them from `unsigned:<handle>` to a signed-wallet caller (the badge).
3. **Button → ZeroClaw SOP** — call/close buttons post through the agent, not direct to disk.
4. **`settle` cron SOP** — auto-close + score when a market resolves (extends the anchor-cron
   pattern). Today resolution is manual `close` entries; this automates it.
5. **Market population** — pull high-volume Polymarket markets into the markets list.

---

## 1. Accounts (the badge of trust)

- Telegram Mini App opens → `initData` gives us the verified Telegram user (HMAC-signed by
  Telegram's bot token; verify server-side, never trust the client claim).
- **Connect wallet** = the user signs a one-time nonce (`solana signMessage`), proving key
  control. We store `{ tg_id, handle, wallet, linked_at, sig }`. This is **identity only** —
  signing a nonce grants zero spend authority. Consistent with T1.
- The account is a stable `caller` id on every future call. Because calls are anchored and
  never deletable, the account's *entire history is tamper-evident* — that's the badge. Profile
  page = shareable proof-of-record (the thing a human links instead of a screenshot).
- Storage: `data/accounts.jsonl` (append-only, same discipline as the tape — a re-link is a new
  row, never an edit).

## 2. Data model — NOTE: scoring store already exists
```
data/accounts.jsonl   {tg_id, handle, wallet, linked_at, nonce, sig}
data/calls  ──────────► already exists as tape.jsonl (open/close entries)
```
No new call store — a leaderboard call IS a tape entry. The miniapp writes through the ZeroClaw
agent so anchor-first / no-delete always holds.

## 3. Scoring (prediction lane)
- A call: `open {market, side, entry_ref=price_at_call}` → `close {exit_ref}` OR market settles.
- Per call: `pnl = (settle==side ? 1 : 0) − entry_ref` for a $1 unit → i.e. did you beat the
  price you took. Beating the market price, not just being right, is the rank metric.
- Caller score: sum of realized pnl over **settled** calls only; open calls shown but unscored
  (mark-to-market displayed, not counted). Wilson lower-bound on win rate as the tiebreak so a
  3-for-3 doesn't outrank a 40-for-55 (same gate as `signal-optimizer.js`).
- **Open bags count against you** the moment they settle — no quiet abandonment, the TAPE rule.

## 4. Screens (Telegram Mini App, Drain-style)
- **Markets** — high-volume Polymarket markets, numbered, `edge` shown next to each. Button:
  *Call YES / Call NO*.
- **My record** — my open + settled calls, my rank, my wallet badge.
- **Leaderboard** — callers ranked by realized "beat the price", distinct-settled-count shown
  so nobody games it with one lucky call.
- **A call button → ZeroClaw.** Button press = a channel-trigger message to the agent
  (`call market#12 yes 0.55`), the agent runs the post→anchor SOP, returns the Solscan link.
  The app never writes the chain itself; the agent's rules do.

## 5. ZeroClaw wiring (Tier 1, no compiled code)
- Existing `tape` skill bundle (markets/post/anchor/receipt/verify) already covers the verbs.
- New SOP: `call` (post + anchor) and `settle` (cron poll of market resolution → auto-close +
  score). `settle` is a `*/N` cron SOP, same pattern as the anchor cron.
- Approval checkpoint not needed (T1, no funds move). Keep the narrow `tape` risk profile.

## 6. Build order (each shippable alone)
1. `accounts.jsonl` + nonce-verify endpoint + "connect wallet" — the badge, standalone.
2. Read-only leaderboard from existing `tape.jsonl` prediction entries — proves scoring on real
   anchored data before any new call is posted.
3. Miniapp shell (markets list + call button) wired to the agent SOP.
4. `settle` cron SOP → auto-scoring.
Lanes 2–4 slot in behind the same account + leaderboard frame once their oracles exist.

## Custody line (non-negotiable)
The app posts calls and proves identity. **It never signs a transfer.** Wallet-connect is a
signed nonce, not spend authority. If a future button ever moves funds it's a T2 feature with
its own caps/allowlist/approval gate — not smuggled into a leaderboard.

---

## The funnel (Jiggy's architecture question, 2026-08-06)

**landing → bot → mini app → login → in.** Concretely:

1. **Landing page** = `tape.drainfun.xyz` (already live, the stylized one). Add one CTA:
   **"Open in Telegram"** → `https://t.me/TAPEtapebotbot?startapp` (the bot exists:
   `@TAPEtapebotbot`, id 8603489891, token in `~/.config/cadence-secure/tape-bot.json`).
2. **The bot** (`@TAPEtapebotbot`) — currently **bare** (default menu button, no `/start`,
   no description). To wire: `setChatMenuButton` → a `web_app` button pointing at the mini-app
   URL; set `/start` to a short welcome + a "Launch TAPE" web_app button; set description.
   All doable via the Bot API in one pass — additive, reversible.
3. **Mini app opens** inside Telegram. `initData` (Telegram's signed identity) logs the user
   in with **zero taps**. First run shows the **welcome/login gate** (built v4).
4. **In.** Markets / Leaderboard / My Record.

**The one blocker to wiring it for real:** a Telegram mini app URL **cannot sit behind basic
auth** — Telegram loads it in its in-app browser and the user can't pass an auth prompt. So
the app has to be served at a **public** URL (e.g. `tape.drainfun.xyz/app`, no auth) before
the bot's menu button can point at it. That's a "make the prototype public" decision — not
doing it unilaterally while taps are still mocked. Once the real call path is wired (Telegram
login + one live anchor), publishing it and flipping the bot's menu button is ~20 minutes.
