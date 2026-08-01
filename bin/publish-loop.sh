#!/bin/bash
# Republish the website data. Safe on a timer: publish.js refuses to write when the chain
# does not verify, so a broken record yields a STALE page rather than a confidently wrong one.
cd "$(dirname "$0")/.." || exit 1
exec node bin/publish.js
