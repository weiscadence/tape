#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// make-video.js — renders the TAPE bounty demo to an mp4 with no human in it.
//
// The shot list (bounty/VIDEO-SHOTLIST.md) was written for a person with a
// screen recorder and a voice. This does the same six shots as deterministic
// frames: real captured stdout on screen, the voiceover lines as subtitles.
//
// EVERY terminal body in here is read from a file produced by actually running
// the command. Nothing is retyped, so the video cannot drift from the program.
//   node bounty/prompt-injection-test.js   > bounty/.video/out-inject.txt
//   node verify/tape-verify.mjs <receipt>  > bounty/.video/out-verified.txt
//   node verify/tape-verify.mjs <tampered> > bounty/.video/out-fraud.txt
//
// Usage: node bounty/make-video.js <dir-with-out-*.txt> <outdir>
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3];
if (!SRC || !OUT) { console.error('usage: make-video.js <srcdir> <outdir>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\s+$/, '');
const verified = read('out-verified.txt');
const fraud = read('out-fraud.txt');
const inject = read('out-inject.txt');

// The full 60 lines are unreadable at speed, so take two decisive windows. Slice by
// MARKER, not by line number, so editing the test can't silently reframe the video onto
// the wrong lines — it fails loudly instead.
const L = inject.split('\n');
const at = (needle, what) => {
  const i = L.findIndex((l) => l.includes(needle));
  if (i === -1) throw new Error(`video marker missing from injection output: ${what} (${needle})`);
  return i;
};
// window 1: the attack going in, and the gate refusing it before the network
const injectAttack = L.slice(at('Injected message delivered', 'attack header'),
                             at('Fail-closed', 'attack verdict') + 1).join('\n');
// window 2: the verdict and why it does not rely on the model behaving
const injectOutcome = L.slice(at('OUTCOME:', 'outcome line')).join('\n');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Colourise a terminal body the way the real TTY does, so the frame reads at a glance.
function paint(body) {
  return esc(body)
    .replace(/^(FRAUD|.*THE CHAIN DISAGREES.*)$/gm, '<span class="bad">$1</span>')
    .replace(/^(VERIFIED.*)$/gm, '<span class="ok">$1</span>')
    .replace(/(✅[^\n]*)/g, '<span class="ok">$1</span>')
    .replace(/(❌[^\n]*)/g, '<span class="bad">$1</span>')
    .replace(/(REFUSED|BLOCKED|FAILS CLOSED)/g, '<span class="ok">$1</span>');
}

// SCENE LIST — rebuilt 2026-08-06 around a real phone recording.
//
// The previous cut was eleven scenes, six of them full-screen text. The bounty asks for
// "real agent, real channel, your use case doing the thing. No slides." Six slides is the
// thing that sentence is pointing at, and there was no channel in it at all, because a
// renderer cannot hold a phone. So the middle of this video is now `--phone`: an actual
// Telegram session on an actual handset, and the scenes below are the bookends.
//
// Every terminal body is still read from a file produced by running the command, and they
// now verify the SAME call the phone footage posts (seq 367, slot 437624124) — so the
// second half checks the first half rather than being a separate anecdote.
const SCENES = [
  { kind: 'title', big: 'TAPE',
    sub: 'an undeletable call record, running on ZeroClaw + Solana',
    foot: 'ZeroClaw × Solana bounty submission', sec: 5, part: 'intro' },

  { kind: 'card', big: 'Every crypto caller has a great track record,<br>because they delete the bad calls.',
    sub: 'TAPE is a call record they can&rsquo;t delete &mdash; because the timestamp isn&rsquo;t ours, it&rsquo;s Solana&rsquo;s.', sec: 7, part: 'intro' },

  // ── the phone recording is spliced in here ──

  { kind: 'term', cmd: 'node verify/tape-verify.mjs receipt-367.json',
    body: verified,
    caption: 'The call you just watched him post, checked against the chain. Exit code 0.', sec: 13, part: 'outro' },

  { kind: 'card', big: 'This verifier shares no code<br>with the thing that wrote the record.',
    sub: 'It talks to Solana, not to us. Our server could be gone and this still works.', sec: 8, part: 'outro' },

  { kind: 'term', cmd: 'node verify/tape-verify.mjs receipt-367.json   # one digit edited',
    body: fraud,
    caption: 'Same receipt, entry price edited 0.5050 → 0.4200. Exit code 1.', sec: 13, part: 'outro' },

  { kind: 'card', big: 'I changed one number<br>in our own record.',
    sub: 'Our own verifier calls us a fraud. A verifier that can only ever confirm is a logo. This one can convict us.', sec: 9, part: 'outro' },

  { kind: 'term', cmd: 'node bounty/prompt-injection-test.js   # verdict',
    body: injectOutcome,
    caption: 'The required fund-safety test. The attack is assumed to have already won — the model is building the transfer — and the key still cannot express one.', sec: 13, part: 'outro' },

  { kind: 'card', big: 'Live on mainnet, unattended,<br>for over a week.',
    sub: 'More than 1,700 anchors across 8+ unbroken days, real lamports &mdash; and since 2026-08-06T16:23:14Z, ZeroClaw&rsquo;s cron is the only process that writes them. Check the grid: <span class="mono">node bin/anchor-stats.js</span>.', sec: 10, part: 'outro' },

  { kind: 'title', big: 'The scorekeeper can&rsquo;t cheat the score.',
    sub: 'And anyone can prove it &mdash; including against us.',
    foot: 'github.com/weiscadence/tape', sec: 8, part: 'outro' },
];

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{width:1280px;height:720px;background:#08080a;color:#d8d2c4;
  font-family:'DejaVu Sans Mono','Menlo',monospace;overflow:hidden;position:relative}
.chip{position:absolute;top:26px;left:34px;font-size:15px;letter-spacing:.28em;
  text-transform:uppercase;color:#4e4738}
.wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:74px 64px}
.big{font-size:44px;line-height:1.34;color:#f0e8d4;font-weight:normal}
.sub{font-size:22px;line-height:1.7;color:#9a8f78;margin-top:26px;max-width:1080px}
.foot{position:absolute;bottom:34px;left:64px;font-size:17px;color:#5d5442;letter-spacing:.08em}
/* The whole frame is already monospace, so .mono is about making a runnable command read
   as one rather than as prose — lifted out of the subtitle grey, not restyled. */
.mono{color:#e8dcbe;white-space:nowrap}
.title .big{font-size:80px;letter-spacing:.05em}
.term{background:#0c0c0f;border:1px solid #23201a;border-radius:11px;padding:26px 30px;
  max-height:560px;overflow:hidden}
.cmd{font-size:21px;color:#e8dcbe;margin-bottom:18px}
.cmd::before{content:'$ ';color:#6a5f47}
/* word-break:break-all wrapped mid-WORD ("refused: t / he anchor key"), which read as
   garbled text spilling out of the panel. overflow-wrap:anywhere wraps at spaces first and
   only splits a token when it genuinely cannot fit — which is what the 64-char hashes need,
   and nothing else does. min-width:0 keeps the pre from forcing the flex parent wider than
   the card, which is what let the continuation lines escape the border. */
pre{font-size:19px;line-height:1.5;color:#a89e88;white-space:pre-wrap;
  word-break:normal;overflow-wrap:anywhere;min-width:0;max-width:100%}
.ok{color:#9fd08a}.bad{color:#f08a5d}
.caption{position:absolute;bottom:30px;left:64px;right:64px;font-size:20px;color:#8a7f68;
  text-align:center}
`;

function html(s) {
  const inner = s.kind === 'term'
    ? `<div class="term"><div class="cmd">${esc(s.cmd)}</div><pre>${paint(s.body)}</pre></div>
       <div class="caption">${s.caption}</div>`
    : `<div class="big">${s.big}</div>${s.sub ? `<div class="sub">${s.sub}</div>` : ''}
       ${s.foot ? `<div class="foot">${s.foot}</div>` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body class="${s.kind === 'title' ? 'title' : ''}"><div class="chip">TAPE · ZeroClaw × Solana</div>
<div class="wrap">${inner}</div></body></html>`;
}

SCENES.forEach((s, i) => {
  const n = String(i + 1).padStart(2, '0');
  fs.writeFileSync(path.join(OUT, `scene-${n}.html`), html(s));
});

// Two concat lists, because the phone recording goes between them. Each PNG is held for
// its scene's duration; the concat demuxer needs the final file repeated or it drops the
// last scene's tail.
for (const part of ['intro', 'outro']) {
  const idx = SCENES.map((s, i) => [s, i]).filter(([s]) => s.part === part);
  if (!idx.length) continue;
  const body = idx.map(([s, i]) => {
    const n = String(i + 1).padStart(2, '0');
    return `file 'scene-${n}.png'\nduration ${s.sec}`;
  }).join('\n');
  const lastN = String(idx[idx.length - 1][1] + 1).padStart(2, '0');
  fs.writeFileSync(path.join(OUT, `concat-${part}.txt`), `${body}\nfile 'scene-${lastN}.png'\n`);
}

// PHONE_SEC is passed in rather than probed, so this check fails loudly if the recording
// is re-cut longer and nobody re-checks the limit. A 3:00 cap silently exceeded is a
// disqualification, not a formatting problem.
const PHONE_SEC = Number(process.env.PHONE_SEC || 0);
const cards = SCENES.reduce((a, s) => a + s.sec, 0);
const total = cards + PHONE_SEC;
console.log(`${SCENES.length} scenes written to ${OUT}`);
console.log(`cards ${cards}s + phone ${PHONE_SEC}s = ${Math.floor(total / 60)}:${String(Math.round(total % 60)).padStart(2, '0')} (limit 3:00)`);
if (!PHONE_SEC) console.error('WARNING: PHONE_SEC unset — the runtime check below is only counting the cards');
if (total > 180) { console.error('OVER THE 3-MINUTE LIMIT'); process.exit(1); }
