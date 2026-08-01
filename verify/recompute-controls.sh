#!/bin/bash
# recompute-controls.sh — exercise tape-recompute.mjs in the states it claims to detect.
#
# A checker that has only ever seen honest input is a decoration that returns MATCH. Each
# case below mutates a real published artifact the way a dishonest scorekeeper would, and
# the checker must return MISMATCH (exit 1). The positive control at the end must still
# return MATCH, because a checker that fails everything is equally useless.
#
#   usage: bash verify/recompute-controls.sh [artifact.json]
#          (default: generates a fresh one with bin/leaderboard.js --json)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
ART="${1:-}"
# Absolutise BEFORE anything cds into $WORK. A relative artifact path silently stopped
# resolving inside the temp dir, and the positive control reported "the real artifact does
# not verify" — a file-not-found (exit 2) wearing the costume of a failed verification
# (exit 1). The control was lying about its own cause, which is worse than not running.
if [ -n "$ART" ]; then ART="$(cd "$(dirname "$ART")" && pwd)/$(basename "$ART")"; fi
if [ -z "$ART" ]; then
  ART="$WORK/board.json"
  node "$HERE/../bin/leaderboard.js" --json > "$ART" 2>/dev/null || { echo "could not build an artifact"; exit 2; }
fi
# Run from an empty dir with only the checker present: no repo, no node_modules, no install.
cp "$HERE/tape-recompute.mjs" "$WORK/"
pass=0; fail=0
ctl() {
  python3 -c "
import json,sys
d=json.load(open('$ART'))
$2
json.dump(d,open('$WORK/bad.json','w'))
" || { echo "  ! control '$1' could not be constructed"; fail=$((fail+1)); return; }
  (cd "$WORK" && node tape-recompute.mjs bad.json >out.txt 2>&1); rc=$?
  if [ "$rc" = "1" ]; then
    echo "  ✓ CAUGHT: $1"; grep -m1 '·' "$WORK/out.txt" | sed 's/^ */        /'; pass=$((pass+1))
  else
    echo "  ✗ MISSED (exit $rc): $1"; fail=$((fail+1))
  fi
}

echo; echo "arithmetic — the board must follow from the marks"
ctl "inflated PnL on a scored row" "
for p in d['positions']:
    if p['scoring']=='scored': p['pnl']='999'"
ctl "benchmark quietly zeroed, so every edge looks better" "
for p in d['positions']:
    if p['scoring']=='scored': p['benchmark_pnl']='0'; p['edge']=p['pnl']
d['board'][0]['benchmark_pnl']='0'; d['board'][0]['edge']=d['board'][0]['pnl']"
ctl "beat_hodl flipped on a caller who lost to holding" "
d['board'][0]['beat_hodl'] = not d['board'][0]['beat_hodl']"
ctl "board total inflated without touching any row" "
d['board'][0]['edge']='42'"

echo; echo "marks — the inputs must be the ones we claimed"
ctl "a mark price altered after the fact" "
for k in list(d['marks']):
    if k.startswith('price:SOL'): d['marks'][k]['price']='1.0'; break"
ctl "a mark deleted so a row cannot be re-derived" "
for k in list(d['marks']):
    if k.startswith('resolution:'): del d['marks'][k]; break"

echo; echo "eligibility — who was allowed to be ranked (the arithmetic is not the lie)"
ctl "voided entry relabelled a closed winner, every field made consistent" "
good=[p for p in d['positions'] if p['scoring']=='scored'][0]
for p in d['positions']:
    if p['scoring']=='excluded' and 'VOID' in (p.get('reason') or ''):
        p.update({'scoring':'scored','status':'closed','realized':True,'reason':None,
                  'marked_from':good['marked_from'],'marked_to':good['marked_to'],
                  'lane':'prediction','market':good['market'],'side':'yes','size':'1',
                  'claimed_ref':'0.80','pnl':'0.25',
                  'benchmark_pnl':good['benchmark_pnl'],'edge':good['edge']})
        break
b=d['board'][0]; b['pnl']=b['realized']='0.5'
b['benchmark_pnl']='-0.004147671001954014'; b['edge']='0.504147671001954014'"
ctl "a gate verdict upgraded to eligible" "
for g in d['gate']:
    if g['verdict']!='eligible': g['verdict']='eligible'; break"

echo; echo "the mark clock — WHEN the open book was priced (the arithmetic is not the lie)"
# Found by reticuli, ax7 and bytes reading the design on 2026-07-28: an external oracle
# read at an internally-chosen instant is still an internal mark. Every control below
# leaves the arithmetic, chain, anchors and signatures untouched and perfectly consistent
# — the pre-fix checker returned MATCH on exactly this artifact.
ctl "mark taken at a hand-picked instant instead of the grid" "
d['as_of'] += 407"
ctl "mark backdated a full interval to a better price, still off-grid" "
d['as_of'] -= 407"
ctl "mark dated into the future to pull an unrealised gain forward" "
d['as_of'] += 86400 + 13"
# Divisible by 900, so grid alignment alone says nothing. Only the clock check catches it.
ctl "mark a day forward but perfectly ON-grid (alignment cannot see this one)" "
d['as_of'] += 86400"

echo; echo "the record — chain and anchors"
ctl "an entry's odds edited after the fact" "
for r in d['chain']:
    if r['entry']['type']=='open' and r['entry']['lane']=='prediction':
        r['entry']['entry_ref']='0.01'; break"
ctl "the amend that voided an entry deleted from the chain" "
d['chain']=[r for r in d['chain'] if r['entry']['type']!='amend']
for i,r in enumerate(d['chain']): r['seq']=i"
ctl "anchor count inflated BEYOND the chain (cheap bound catches this)" "
d['anchors'][0]['count']=99"
ctl "anchor count inflated WITHIN the chain (only the Merkle root catches this)" "
d['anchors'][0]['count']=5"
ctl "anchor count shrunk, de-ranking a call by understatement" "
d['anchors'][-1]['count']=1"

echo; echo "identity — a signature must not be forgeable or strippable"
ctl "a signature stripped from a signed entry (downgrade to anonymous)" "
for r in d['chain']:
    if r['entry'].get('sig'): r['entry']['sig']=None; break"
ctl "a signed entry reattributed to a different key" "
for r in d['chain']:
    if r['entry'].get('signer'):
        r['entry']['signer']='11111111111111111111111111111112'; break"
ctl "one character flipped in a real signature" "
for r in d['chain']:
    if r['entry'].get('sig'):
        s=r['entry']['sig']; c='2' if s[5]!='2' else '3'
        r['entry']['sig']=s[:5]+c+s[6:]; break"
ctl "a signed entry replayed (duplicated) further down the chain" "
import copy
row=None
for r in d['chain']:
    if r['entry'].get('sig'): row=copy.deepcopy(r); break
if row is None: raise SystemExit('no signed entry to replay')
row['seq']=len(d['chain']); d['chain'].append(row)"

echo; echo "identity, ISOLATED — chain and anchors re-sealed, so ONLY the signature can catch it"
sealed() {
  python3 -c "
import json,sys
d=json.load(open('$ART'))
$2
json.dump(d,open('$WORK/raw.json','w'))
" || { echo "  ! control '$1' could not be constructed"; fail=$((fail+1)); return; }
  node "$HERE/reseal.js" "$WORK/raw.json" > "$WORK/bad.json"
  (cd "$WORK" && node tape-recompute.mjs bad.json >out.txt 2>&1); rc=$?
  # Match a FINDING line (they start with ·), never the summary header — the header once
  # said "all verified independently" for a record with a blanked signature, and grepping
  # it made this control pass while the thing it tests was broken.
  if [ "$rc" = "1" ] && grep -E '^ +· .*(signature|signer)' "$WORK/out.txt" >/dev/null; then
    echo "  ✓ CAUGHT BY THE SIGNATURE: $1"; grep -m1 -E '^ +· .*(signature|signer)' "$WORK/out.txt" | sed 's/^ */        /'; pass=$((pass+1))
  elif [ "$rc" = "1" ]; then
    echo "  ~ caught, but NOT by the signature check: $1"; grep -m1 '·' "$WORK/out.txt" | sed 's/^ */        /'; fail=$((fail+1))
  else
    echo "  ✗ MISSED (exit $rc): $1"; fail=$((fail+1))
  fi
}
sealed "signed call's odds rewritten, then the whole record re-sealed" "
for r in d['chain']:
    if r['entry'].get('sig'): r['entry']['entry_ref']='0.01'; break"
sealed "signed call reattributed to another key, then re-sealed" "
for r in d['chain']:
    if r['entry'].get('signer'):
        r['entry']['signer']='11111111111111111111111111111112'; break"
sealed "signature blanked but signer kept, then re-sealed" "
for r in d['chain']:
    if r['entry'].get('sig'): r['entry']['sig']=None; break"

echo; echo "positive control — an untampered artifact must still MATCH"
(cd "$WORK" && node tape-recompute.mjs "$ART" >"$WORK/pos.txt" 2>&1); rc=$?
if [ "$rc" = 0 ]; then echo "  ✓ MATCH on the real artifact"; pass=$((pass+1));
elif [ "$rc" = 2 ]; then
  # Never let an unreadable input read as a failed verification: the two need different
  # fixes and only one of them is about the tape.
  echo "  ! UNUSABLE input, control did not run (exit 2) — not a verification failure"
  sed 's/^/        /' "$WORK/pos.txt"; fail=$((fail+1))
else echo "  ✗ the real artifact does not verify (exit $rc)"; sed 's/^/        /' "$WORK/pos.txt"; fail=$((fail+1)); fi

echo; echo "  $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
