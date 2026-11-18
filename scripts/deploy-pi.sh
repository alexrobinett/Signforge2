#!/bin/sh
# Copy the built player and content to the test Pi and (re)start the kiosk.
#   PI=alex@signforge-pi.local sh scripts/deploy-pi.sh [--content-only]
set -e
PI="${PI:-alex@signforge-pi.local}"
cd "$(dirname "$0")/.."
ssh "$PI" 'mkdir -p ~/signforge/www/content'
# data/ holds live snapshots written on the device; leave it alone.
rsync -az --delete --exclude data/ dist/content/ "$PI:signforge/www/content/"
[ "$1" = "--content-only" ] && { echo "content deployed"; exit 0; }
rsync -az --delete --exclude content dist/player/ "$PI:signforge/www/"
rsync -az device/pi/kiosk.sh device/pi/tune.sh device/pi/bench.sh device/pi/*.py "$PI:signforge/"
rsync -az device/pi/*.service "$PI:signforge/"
ssh "$PI" 'touch ~/signforge/kiosk.env
  sudo cp ~/signforge/*.service /etc/systemd/system/ && sudo systemctl daemon-reload
  sudo systemctl enable -q signforge-player-web signforge-kiosk signforge-datad signforge-supervisor
  sudo systemctl restart signforge-player-web signforge-kiosk signforge-datad signforge-supervisor
  systemctl is-active signforge-player-web signforge-kiosk'
echo "player deployed"
