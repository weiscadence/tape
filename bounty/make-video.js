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

const SCENES = [
  { kind: 'title', big: 'TAPE',
    sub: 'an undeletable call record, running on ZeroClaw + Solana',
    foot: 'ZeroClaw × Solana bounty submission', sec: 5 },

  { kind: 'card', big: 'Every crypto caller has a great track record,<br>because they delete the bad calls.',
    sub: 'TAPE is a call record they can&rsquo;t delete &mdash; because the timestamp isn&rsquo;t ours, it&rsquo;s Solana&rsquo;s.', sec: 8 },

  { kind: 'term', cmd: 'node verify/tape-verify.mjs /tmp/tape-latest-receipt.json',
    body: verified,
    caption: 'A real call, checked against the chain. Exit code 0.', sec: 13 },

  { kind: 'card', big: 'This verifier shares no code<br>with the thing that wrote the record.',
    sub: 'It talks to Solana, not to us. Our server could be gone and this still works.', sec: 9 },

  { kind: 'term', cmd: 'node verify/tape-verify.mjs /tmp/tape-tampered-receipt.json',
    body: fraud,
    caption: 'Same real call — with the entry price edited from 0.72 to 0.42. Exit code 1.', sec: 13 },

  { kind: 'card', big: 'I changed one number in our own record.<br>Our own verifier calls us a fraud.',
    sub: 'A verifier that can only ever confirm is a logo. This one can convict us.', sec: 10 },

  { kind: 'term', cmd: 'node bounty/prompt-injection-test.js',
    body: injectAttack,
    caption: 'The attack is assumed to have already won — the model is building the transfer.', sec: 15 },

  { kind: 'term', cmd: 'node bounty/prompt-injection-test.js   # verdict',
    body: injectOutcome,
    caption: 'The required fund-safety test — 3 of 3, fails closed.', sec: 14 },

  { kind: 'card', big: 'The defence never depends on<br>the model refusing.',
    sub: 'The key physically cannot express a transfer. Not a policy &mdash; enforced in code, in lib/signing-policy.js, before the signer is ever reached.', sec: 11 },

  { kind: 'card', big: 'Live on Solana mainnet.',
    sub: 'Six anchors, real lamports, independently checkable. Slot 435812245 · 435813695 · 435816043 · 435824647 · 435825732 &mdash; and the one verified above, 436241109.', sec: 9 },

  { kind: 'title', big: 'The scorekeeper can&rsquo;t cheat the score.',
    sub: 'And anyone can prove it &mdash; including against us.',
    foot: 'github.com/weiscadence/tape', sec: 9 },
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

// ffmpeg concat list — each PNG held for its scene's duration
const list = SCENES.map((s, i) => {
  const n = String(i + 1).padStart(2, '0');
  return `file 'scene-${n}.png'\nduration ${s.sec}`;
}).join('\n');
const lastN = String(SCENES.length).padStart(2, '0');
fs.writeFileSync(path.join(OUT, 'concat.txt'), `${list}\nfile 'scene-${lastN}.png'\n`);

const total = SCENES.reduce((a, s) => a + s.sec, 0);
console.log(`${SCENES.length} scenes written to ${OUT}`);
console.log(`runtime ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} (limit 3:00)`);
if (total > 180) { console.error('OVER THE 3-MINUTE LIMIT'); process.exit(1); }
