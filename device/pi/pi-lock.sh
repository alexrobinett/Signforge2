#!/bin/sh
# One agent (or person) on the Pi test rig at a time.
#
#   sh device/pi/pi-lock.sh take "<who>" "<what for>" [minutes, default 60]
#   sh device/pi/pi-lock.sh release "<who>"
#   sh device/pi/pi-lock.sh status
#
# The lock is a directory on the Pi (mkdir is atomic), holding who took it, why, and when it
# expires. `take` fails while someone else's lock is live; an expired lock may be taken over,
# and the takeover is logged. A lock made by hand (`mkdir`, no expiry) is never taken over. Whoever holds the lock restores the rig when done: the original
# player files, credential and `kiosk.env` = `kiosk.env.cloud`.
set -eu
PI="${SF_PI:-alex@signforge-pi.local}"
# ssh joins its arguments into one remote command line, so each is quoted for the remote shell.
q() { printf "'%s' " "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }
cmd="${1:-status}"
who="${2:-}"
case "$cmd" in
  take)
    what="${3:?what for}"; mins="${4:-60}"
    ssh "$PI" "sh -s $(q "$who")$(q "$what")$(q "$mins")" <<'EOF'
set -eu
L=~/signforge/.agent-lock; now=$(date +%s)
if ! mkdir "$L" 2>/dev/null; then
  # A lock without an expiry (taken by hand with mkdir) is never taken over: its holder may still be working.
  exp=$(cat "$L/expires" 2>/dev/null || echo 9999999999)
  if [ "$now" -lt "$exp" ]; then echo "held by $(cat "$L/who" 2>/dev/null): $(cat "$L/what" 2>/dev/null), until $(date -d "@$exp" +%H:%M)"; exit 1; fi
  echo "$(date -Is) $1 took over an expired lock from $(cat "$L/who" 2>/dev/null || echo unknown)" >> ~/signforge/agent-lock.log
fi
echo "$1" > "$L/who"; echo "$2" > "$L/what"; echo $((now + $3 * 60)) > "$L/expires"
echo "$(date -Is) $1 took the lock: $2" >> ~/signforge/agent-lock.log
echo "taken until $(date -d "@$((now + $3 * 60))" +%H:%M)"
EOF
    ;;
  release)
    ssh "$PI" "sh -s $(q "$who")" <<'EOF'
set -eu
L=~/signforge/.agent-lock
[ -d "$L" ] || { echo "not held"; exit 0; }
if [ "$(cat "$L/who" 2>/dev/null)" != "$1" ]; then echo "held by $(cat "$L/who" 2>/dev/null), not $1"; exit 1; fi
rm -rf "$L"; echo "$(date -Is) $1 released the lock" >> ~/signforge/agent-lock.log; echo released
EOF
    ;;
  status)
    ssh "$PI" 'L=~/signforge/.agent-lock; if [ -d "$L" ]; then echo "held by $(cat $L/who 2>/dev/null || echo "unknown (old-style lock)"): $(cat $L/what 2>/dev/null), until $( [ -f $L/expires ] && date -d "@$(cat $L/expires)" +%H:%M || echo "released by hand (no expiry)")"; else echo free; fi; tail -3 ~/signforge/agent-lock.log 2>/dev/null; grep -q . ~/signforge/kiosk.env && cmp -s ~/signforge/kiosk.env ~/signforge/kiosk.env.cloud && echo "kiosk: cloud config" || echo "kiosk: NOT on the cloud config"'
    ;;
  *) echo "usage: pi-lock.sh take|release|status" >&2; exit 2 ;;
esac
