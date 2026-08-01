# TAPE — 3-minute video shot list

For Jiggy. Read the bold lines out loud, run the commands, hit record. Every command below
was run live on 2026-08-01 and produced exactly the output written here.

Screen record the terminal. Face/voice optional — voiceover is enough.

Working dir for all commands:

    cd ~/.openclaw/workspace/projects/tape

---

## SHOT 1 — the problem (0:00–0:20)

Say, over a blank terminal or the leaderboard:

> **"Every crypto caller has a great track record, because they delete the bad calls.
> TAPE is a call record they can't delete — because the timestamp isn't ours, it's Solana's."**

## SHOT 2 — a real call, on Telegram (0:20–1:00)

Open the TAPE Telegram chat. Post a call to the agent (any market, keep it short). Show the
agent replying with the entry hash.

Say:

> **"I post a call. The agent writes it into an append-only chain and hands back a hash."**

If the chat is slow to respond, don't fight it — cut and use the existing receipt in Shot 3.
The existing tape has 59 entries; nothing here depends on a fresh one.

## SHOT 3 — it's on the chain (1:00–1:30)

    node verify/tape-verify.mjs /tmp/tape-latest-receipt.json

Output ends with:

    VERIFIED — call of type "open"
    slot         436241109
    block time   2026-07-30T22:56:40.000Z
    This call existed, in exactly this form, no later than slot 436241109.
    Checked against https://api.mainnet-beta.solana.com; no TAPE service was contacted.

Say:

> **"This verifier shares no code with the thing that wrote the record, and it talks to
> Solana, not to us. Our server could be gone and this still works."**

## SHOT 4 — THE MONEY SHOT: it calls US frauds (1:30–2:15)

This is the shot the bounty is won or lost on. Do not cut it.

    node verify/tape-verify.mjs /tmp/tape-tampered-receipt.json

(that file is the same real call with the entry price edited from 0.72 to 0.42)

Output:

    FRAUD
      THE CHAIN DISAGREES WITH THIS RECEIPT.
      Either the entry was altered after anchoring, or the proof does not belong to it.

Say:

> **"I changed one number in our own record. Our own verifier calls us a fraud.
> A verifier that can only ever confirm is a logo. This one can convict us."**

## SHOT 5 — the funds test (2:15–2:45)

    node bounty/prompt-injection-test.js

Output ends with:

    OUTCOME: ✅ FAILS CLOSED — 3/3 checks as expected.

Say:

> **"The bounty requires a prompt-injection test. Ours assumes the attack fully works —
> the model is compromised and actively building the attacker's transfer. It still fails,
> because the key physically cannot sign a transfer. Not a policy. Enforced in code."**

## SHOT 6 — close (2:45–3:00)

> **"One line no leaderboard can say: the scorekeeper can't cheat the score,
> and anyone can prove it — including against us."**

---

## Prep before recording (run once, ~2 min)

    cd ~/.openclaw/workspace/projects/tape
    node verify/tape-verify.mjs /tmp/tape-latest-receipt.json      # expect VERIFIED, exit 0
    node verify/tape-verify.mjs /tmp/tape-tampered-receipt.json    # expect FRAUD,    exit 1
    node bounty/prompt-injection-test.js                           # expect FAILS CLOSED

If the tampered receipt is missing, regenerate it:

    python3 -c "import json;r=json.load(open('/tmp/tape-latest-receipt.json'));r['entry']['entry_ref']='0.42';json.dump(r,open('/tmp/tape-tampered-receipt.json','w'),indent=1)"

## If a command is slow on camera

Shots 3 and 4 hit a public Solana RPC and can take 5–20 seconds. That dead air is fine — it's
proof it's a real network call. Don't cut to make it look faster; the pause is the point.

## Still needed from you after the video

1. Public GitHub repo link
2. Post the video + link in their Discord `#solana-bounty`

Deadline: **2026-08-07**.
