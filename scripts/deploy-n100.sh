#!/bin/sh
# Copy the built player, content, the supervisor and measuring tools to the N100 test rig and restart its kiosk.
#   N100=signforge-n100 sh scripts/deploy-n100.sh [--content-only]
# The rig keeps its own kiosk unit and kiosk.sh (cage on the iGPU, device/n100/README.md). It runs the Pi's supervisor
# and player-web with units of its own (device/n100/*.service), for its user, runtime directory and 4K60 mode.
#
# The layout (#628), as deploy-pi.sh's: player-web serves ~/signforge/www, a link to players/<version>/; a build deployed
# here is players/0, and a build measured beside it goes under players/0/m<something>/, which a deploy keeps. The
# content is ~/signforge/content, linked inside each version. The first full run moves the old www/ there; running it
# again changes nothing more. `--content-only` needs the new layout.
set -e
N100="${N100:-signforge-n100}"
cd "$(dirname "$0")/.."
floor=$(cat device/pi/player-release.floor)
case "$floor" in '' | *[!0-9]*) echo "device/pi/player-release.floor must be a whole number" >&2; exit 1 ;; esac
if [ "$1" = "--content-only" ]; then
  ssh "$N100" 'test -L ~/signforge/www' || { echo "the N100 has the layout before #628: run a full deploy first" >&2; exit 1; }
  rsync -az --delete dist/content/ "$N100:signforge/content/"
  echo "content deployed"
  exit 0
fi
ssh "$N100" 'set -e; cd ~/signforge; mkdir -p players/0 content
  if [ -d www ] && [ ! -L www ]; then
    if [ -d www/content ]; then cp -a www/content/. content/; fi
    for m in www/m*/; do [ -d "$m" ] && cp -a "$m" players/0/; done
    rm -rf www
  fi'
rsync -az --delete dist/content/ "$N100:signforge/content/"
rsync -az --delete --exclude content --exclude '/m*/' dist/player/ "$N100:signforge/players/0/"
ssh "$N100" 'cd ~/signforge && ln -sfn ../../content players/0/content && ln -sfn players/0 www.new && mv -T www.new www'
rsync -az device/pi/supervisor.py device/pi/updater.py device/pi/player_web.py "$N100:signforge/"
rsync -az device/pi/isolate.py device/pi/bench.py device/pi/presented.py device/pi/shots.py device/pi/trace.py device/n100/cadence.py "$N100:signforge/"
# The release key, when there is one; without it the supervisor runs with updates off.
[ -f device/pi/player-release.pub ] && rsync -az device/pi/player-release.pub "$N100:signforge/"
# The floor, raised to the one checked above, never lowered.
ssh "$N100" "f=~/signforge/player-release.floor; old=\$(cat \$f 2>/dev/null || echo 0)
  case \"\$old\" in '' | *[!0-9]*) old=0 ;; esac
  [ $floor -gt \$old ] && echo $floor > \$f.new && mv \$f.new \$f || true"
rsync -az device/n100/signforge-supervisor.service device/n100/signforge-player-web.service device/n100/signforge-supervisor.rules "$N100:signforge/"
ssh "$N100" 'set -e
  # polkit lets the supervisor restart a hung kiosk, and nothing else (signforge-supervisor.rules).
  [ -d /etc/polkit-1/rules.d ] || sudo apt-get install -y -qq polkitd >/dev/null
  sudo install -m 644 ~/signforge/signforge-supervisor.rules /etc/polkit-1/rules.d/50-signforge-supervisor.rules
  sudo cp ~/signforge/signforge-supervisor.service ~/signforge/signforge-player-web.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable -q signforge-supervisor
  sudo systemctl restart signforge-player-web signforge-supervisor signforge-kiosk
  systemctl is-active signforge-player-web signforge-supervisor signforge-kiosk'
echo "player deployed"
