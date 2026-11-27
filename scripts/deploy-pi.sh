#!/bin/sh
# Copy the built player and content to the test Pi and (re)start the kiosk.
#   PI=alex@signforge-pi.local sh scripts/deploy-pi.sh [--content-only]
#
# The layout (#628): player-web serves ~/signforge/www, a link to players/<version>/, which the supervisor's update
# channel switches; a build deployed here is players/0. The content the player is sent is ~/signforge/content, beside
# the players, each of which links to it. Before #628, www was the player's files with content/ inside: the first run
# moves content beside it. Running it again changes nothing more. `--content-only` needs the new layout: it moves
# nothing, and says to run a full deploy first.
set -e
PI="${PI:-alex@signforge-pi.local}"
cd "$(dirname "$0")/.."
# The release floor (#628), checked before anything is copied: a screen installs no release at or below it, so a
# freshly imaged one is not offered a release older than the newest when it was set up. Raised, never lowered, when a
# release is promoted.
floor=$(cat device/pi/player-release.floor)
case "$floor" in '' | *[!0-9]*) echo "device/pi/player-release.floor must be a whole number" >&2; exit 1 ;; esac
# Static content's live data is what `sf feeds` wrote into dist/content/data; from the API it comes on sync.
if [ "$1" = "--content-only" ]; then
  ssh "$PI" 'test -L ~/signforge/www' || { echo "the Pi has the layout before #628: run a full deploy first" >&2; exit 1; }
  rsync -az --delete dist/content/ "$PI:signforge/content/"
  echo "content deployed"
  exit 0
fi
ssh "$PI" 'set -e; cd ~/signforge; mkdir -p players/0 content
  if [ -d www ] && [ ! -L www ]; then
    if [ -d www/content ]; then cp -a www/content/. content/; fi
    rm -rf www
  fi'
rsync -az --delete dist/content/ "$PI:signforge/content/"
rsync -az --delete --exclude content dist/player/ "$PI:signforge/players/0/"
# Served at once, as a deploy is: the link renamed over the old one, which is atomic.
ssh "$PI" 'cd ~/signforge && ln -sfn ../../content players/0/content && ln -sfn players/0 www.new && mv -T www.new www'
# The supervisor's tests stay here: they run on a development machine against a faked wlr-randr.
rsync -az --exclude 'test_*.py' device/pi/kiosk.sh device/pi/tune.sh device/pi/bench.sh device/pi/*.py "$PI:signforge/"
# The release key the update channel checks a build against (#628); without it, the player is updated only from here.
[ -f device/pi/player-release.pub ] && rsync -az device/pi/player-release.pub "$PI:signforge/"
# The Pi's floor is raised to the one checked above, never lowered.
ssh "$PI" "f=~/signforge/player-release.floor; old=\$(cat \$f 2>/dev/null || echo 0)
  case \"\$old\" in '' | *[!0-9]*) old=0 ;; esac
  [ $floor -gt \$old ] && echo $floor > \$f.new && mv \$f.new \$f || true"
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
