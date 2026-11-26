#!/bin/sh
# Copy the built player and content to the test Pi and (re)start the kiosk.
#   PI=alex@signforge-pi.local sh scripts/deploy-pi.sh [--content-only]
set -e
PI="${PI:-alex@signforge-pi.local}"
cd "$(dirname "$0")/.."
ssh "$PI" 'mkdir -p ~/signforge/www/content'
# Static content's live data is what `sf feeds` wrote into dist/content/data; from the API it comes on sync.
rsync -az --delete dist/content/ "$PI:signforge/www/content/"
[ "$1" = "--content-only" ] && { echo "content deployed"; exit 0; }
rsync -az --delete --exclude content dist/player/ "$PI:signforge/www/"
# The supervisor's tests stay here: they run on a development machine against a faked wlr-randr.
rsync -az --exclude 'test_*.py' device/pi/kiosk.sh device/pi/tune.sh device/pi/bench.sh device/pi/*.py "$PI:signforge/"
rsync -az device/pi/*.service device/pi/*.rules "$PI:signforge/"
ssh "$PI" 'touch ~/signforge/kiosk.env
  # datad, the feed stand-in, retired with the API poller (M3-23).
  sudo systemctl disable -q --now signforge-datad 2>/dev/null || true
  sudo rm -f /etc/systemd/system/signforge-datad.service ~/signforge/signforge-datad.service ~/signforge/datad.py
  sudo cp ~/signforge/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
  # Lets the supervisor restart a hung kiosk; polkit reloads rules on its own.
  sudo install -m 644 ~/signforge/signforge-supervisor.rules /etc/polkit-1/rules.d/50-signforge-supervisor.rules
  sudo systemctl enable -q signforge-player-web signforge-kiosk signforge-supervisor
  sudo systemctl restart signforge-player-web signforge-kiosk signforge-supervisor
  systemctl is-active signforge-player-web signforge-kiosk'
echo "player deployed"
