#!/bin/sh
# Rebuild, deploy and measure steady-state playback on the test Pi.
#   sh scripts/pi-measure.sh [seconds]
set -e
PI="${PI:-alex@signforge-pi.local}"
SECS="${1:-52}"
cd "$(dirname "$0")/.."
pnpm -s build >/dev/null
sh scripts/deploy-pi.sh >/dev/null
scp -q device/pi/probe.py "$PI:signforge/probe.py"
ssh "$PI" "for i in \$(seq 1 30); do curl -sf localhost:9222/json/version >/dev/null && break; read -t 1 < /dev/zero; done
read -t 15 < /dev/zero; python3 ~/signforge/probe.py --reset >/dev/null; read -t $SECS < /dev/zero
python3 ~/signforge/probe.py | python3 -c '
import sys, json
s = json.load(sys.stdin)
print(s[\"frames\"], \"played\", s[\"played\"], \"skipped\", s[\"skipped\"], s[\"lastError\"])
for x in s[\"stalls\"]: print(\"  stall\", x)'"
