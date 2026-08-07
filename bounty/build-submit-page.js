#!/usr/bin/env node
// Builds the private submission page. The two Discord pastes contain backticks,
// asterisks and quotes that must survive verbatim into Jiggy's clipboard, so they
// are injected as JSON string literals rather than interpolated into HTML.
// Usage: node build-submit-page.js [outfile]

const fs = require('fs');
const path = require('path');

const here = __dirname;
const out = process.argv[2] || path.join(here, 'dist-submit-page.html');

const p1 = fs.readFileSync(path.join(here, 'DISCORD-PASTE-1.txt'), 'utf8').trimEnd();
const p2 = fs.readFileSync(path.join(here, 'DISCORD-PASTE-2.txt'), 'utf8').trimEnd();

// Discord hard-caps a message at 2000 characters. A silently truncated paste is
// worse than a build failure, so refuse to ship one.
for (const [name, body] of [['DISCORD-PASTE-1', p1], ['DISCORD-PASTE-2', p2]]) {
  if (body.length > 2000) {
    console.error(`FAIL ${name}: ${body.length} chars, over Discord's 2000 limit`);
    process.exit(1);
  }
  console.log(`${name}: ${body.length} chars — ok`);
}

let html = fs.readFileSync(path.join(here, 'submit-page.html'), 'utf8');

const decl = `const PASTE1 = ${JSON.stringify(p1)};\nconst PASTE2 = ${JSON.stringify(p2)};\n`;
const anchor = 'const DEADLINE =';
if (!html.includes(anchor)) {
  console.error('FAIL: template anchor not found — did submit-page.html change?');
  process.exit(1);
}
html = html.replace(anchor, decl + anchor);

// </script> anywhere inside a JS string literal would close the block early.
if (/<\/script/i.test(decl)) {
  console.error('FAIL: paste body contains a closing script tag');
  process.exit(1);
}

fs.writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
