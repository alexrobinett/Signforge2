#!/bin/sh
# Copy the built player, content and measuring tools to the N100 test rig and restart its kiosk.
#   N100=signforge-n100 sh scripts/deploy-n100.sh [--content-only]
# The rig keeps its own kiosk units (cage on the iGPU, device/n100/README.md), so unlike deploy-pi.sh this
# installs no service and no supervisor.
set -e
N100="${N100:-signforge-n100}"
cd "$(dirname "$0")/.."
ssh "$N100" 'mkdir -p ~/signforge/www/content'
rsync -az --delete dist/content/ "$N100:signforge/www/content/"
[ "$1" = "--content-only" ] && { echo "content deployed"; exit 0; }
# A build measured beside the deployed one lives in www/m<something>/ (README): --delete keeps it.
rsync -az --delete --exclude content --exclude '/m*/' dist/player/ "$N100:signforge/www/"
rsync -az device/pi/isolate.py device/pi/bench.py device/pi/presented.py device/pi/shots.py device/pi/trace.py device/n100/cadence.py "$N100:signforge/"
ssh "$N100" 'sudo systemctl restart signforge-player-web signforge-kiosk && systemctl is-active signforge-player-web signforge-kiosk'
echo "player deployed"
