#!/usr/bin/env bash
# install-skill.sh — put the TAPE skill bundle where ZeroClaw will find it.
#
# The bundle cannot be committed with working paths, because a ZeroClaw `kind = "shell"`
# tool needs an ABSOLUTE command and the absolute path is different on every machine. The
# version in the repo therefore carries `__TAPE_ROOT__`, and this script is the one place
# that turns it into a real path. Doing that by hand is how you end up with four tools that
# all point at someone else's home directory.
#
# Idempotent: re-running it re-installs from the repo copy, so editing the repo bundle and
# running this again is the whole edit loop.
#
# usage: ./zeroclaw/install-skill.sh [zeroclaw-shared-dir]
#        default shared dir: ~/.zeroclaw/shared

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED="${1:-$HOME/.zeroclaw/shared}"

# The double `tape/tape` is not a typo: ZeroClaw resolves <skills-dir>/<bundle>/<skill>.
DEST="$SHARED/skills/tape/tape"
SRC="$ROOT/zeroclaw/skills/tape"

[ -f "$SRC/SKILL.toml" ] || { echo "no bundle at $SRC — wrong directory?" >&2; exit 1; }

mkdir -p "$DEST"
for f in SKILL.toml SKILL.md; do
  sed "s|__TAPE_ROOT__|$ROOT|g" "$SRC/$f" > "$DEST/$f"
done

# Verify rather than announce. An installer that prints "done" without checking is the
# same failure mode as a test that never runs the branch it claims to cover.
if grep -q "__TAPE_ROOT__" "$DEST/SKILL.toml"; then
  echo "FAILED: placeholders survived substitution in $DEST/SKILL.toml" >&2
  exit 1
fi
if ! grep -q "$ROOT/bin/post.js" "$DEST/SKILL.toml"; then
  echo "FAILED: installed bundle does not point at $ROOT" >&2
  exit 1
fi

echo "installed -> $DEST"
echo "           $(grep -c '^\[\[tools\]\]' "$DEST/SKILL.toml") tools, rooted at $ROOT"
echo
echo "next:  zeroclaw skills audit      # confirm ZeroClaw accepts the bundle"

# The SOP ships in the repo too, for the same reason the skill bundle does: `sop validate`
# is quoted in the write-up, and a command a reader cannot run is not evidence. Same
# __TAPE_ROOT__ substitution, same idempotent re-install.
SOPS_DEST="${SOPS_DEST:-$HOME/.zeroclaw/data/sops}"
if [ -d "$ROOT/zeroclaw/sops" ]; then
  for sop in "$ROOT"/zeroclaw/sops/*/; do
    name="$(basename "$sop")"
    mkdir -p "$SOPS_DEST/$name"
    for f in SOP.toml SOP.md; do
      [ -f "$sop/$f" ] && sed "s|__TAPE_ROOT__|$ROOT|g" "$sop/$f" > "$SOPS_DEST/$name/$f"
    done
    echo "installed SOP -> $SOPS_DEST/$name"
  done
fi
