#!/usr/bin/env bash
# Auto-close resolved prediction positions from the market's own resolution. Locked so runs
# never overlap, timed out so a slow RPC can't wedge it, silent on success.
cd /home/ubuntu/.openclaw/workspace/projects/tape || exit 0
flock -n /tmp/tape-settle.lock timeout 200 node bin/settle.js >> data/settle.log 2>&1
