# Voiceover script — `tape-demo-voiceover-base.mp4` (158s, caption-free cut)

Read against the caption-free base. The captioned cut (`tape-demo.mp4`) already carries
this narrative as burned-in text — **you only need one of the two**, not both.

Timings are the real scene durations from `make-video.js`. Pace is ~2.4 words/sec, which
is unhurried; every block below is written short so a slow read still fits. Silence at the
end of a block is fine and reads as confidence — do not rush to fill it.

**Don't read the bracketed notes.**

---

### 0:00 – 0:05 — title card (5s)
> TAPE. An undeletable call record, running on ZeroClaw and Solana.

### 0:05 – 0:12 — hook card (7s)
> Every crypto caller has a great track record — because they delete the bad calls.
> This is one they can't delete. The timestamp isn't ours. It's Solana's.

### 0:12 – 1:24 — phone recording (~72s)
[Let the footage breathe. Four short lines across seventy seconds, then stop talking.]

> That's a real Telegram channel, on a real phone, not a mockup.

[~0:22, as the market menu appears]
> He asks what he can call, and the agent gives him a numbered menu — so nobody has to
> paste a sixty-six character market id into a chat.

[~0:40, as he replies]
> He replies "three, no, fifty and a half cents." That's the whole interface.

[~0:58, as the anchor confirmation returns]
> And it comes back anchored to mainnet, with a Solscan link. Sequence three sixty-seven,
> slot four three seven six two four one two four. That call is now outside our control.

[silence to 1:24]

### 1:24 – 1:37 — verify terminal, exit 0 (13s)
> Here's that same call, checked against the chain. Not a call we prepared earlier — the
> one you just watched him make. Exit code zero.

### 1:37 – 1:45 — card, no shared code (8s)
> That verifier shares no code with the thing that writes the records. It talks to Solana,
> not to us. Our server could be gone and it would still work.

### 1:45 – 1:58 — fraud terminal, exit 1 (13s)
> Same receipt. I edited one number — the entry price, fifty and a half cents to forty-two.
> Exit code one. Fraud.

### 1:58 – 2:07 — card, "I changed one number" (9s)
> I changed one number in our own record, and our own tool convicted us. A verifier that
> can only ever confirm is a logo. This one can be pointed at us.

### 2:07 – 2:20 — injection test (13s)
> The required fund-safety test, run the hard way: we assume the attack already won. The
> model is compromised and is assembling the attacker's transfer. It still fails — because
> the anchor key cannot express a transfer at all. Refused, not sent-and-bounced.

### 2:20 – 2:30 — card, live on mainnet (10s)
> None of this was built for the video. Over seventeen hundred anchors, eight unbroken days
> on mainnet, real lamports. And since this afternoon, ZeroClaw's cron is the only process
> that writes them — you can check that on the grid without trusting a word I've said.

### 2:30 – 2:38 — closing title (8s)
> The scorekeeper can't cheat the score. And anyone can prove it — including against us.
> github dot com, slash weiscadence, slash tape.

---

## If you'd rather not record

`bounty/tape-demo.mp4` is finished, submittable, and says all of the above in captions.
The voiceover is polish, not a gap.

## To assemble a recorded track
```bash
cd ~/.openclaw/workspace/projects/tape
ffmpeg -i bounty/tape-demo-voiceover-base.mp4 -i /path/to/vo.wav \
  -c:v copy -map 0:v:0 -map 1:a:0 -shortest bounty/tape-demo-vo.mp4
```
