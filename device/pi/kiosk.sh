#!/bin/sh
# Runs inside cage. A Pi 4 cannot animate at 4K, so force 1080p 60 Hz before the browser starts.
# cage may still be bringing its output up at the panel's preferred mode when this starts, and a mode
# set then fails (#506), so set it until wlr-randr reads it back as current. A panel that never takes
# it still gets the browser, at whatever mode it is in, and the journal says so.
tries=0
until wlr-randr 2>/dev/null | grep -q '1920x1080 px, 60\.000000 Hz (.*current'; do
  if [ "$tries" -eq 50 ]; then
    echo "kiosk.sh: output not at 1920x1080@60 after $tries tries: $(wlr-randr 2>&1 | grep current)" >&2
    break
  fi
  tries=$((tries + 1))
  out=$(wlr-randr 2>/dev/null | awk 'NR==1 {print $1}')
  msg=
  [ -n "$out" ] && msg=$(wlr-randr --output "$out" --mode 1920x1080@60 2>&1) || echo "kiosk.sh: mode set try $tries failed: ${msg:-no output yet}" >&2
  sleep 0.1
done
# No secrets in this URL: a template frame can read its parent's address.
url="${KIOSK_URL:-http://127.0.0.1:8090/index.html}"
exec /usr/bin/chromium \
  --kiosk --ozone-platform=wayland --no-first-run --noerrdialogs --disable-infobars \
  --password-store=basic --autoplay-policy=no-user-gesture-required \
  --user-data-dir="$HOME/.kiosk-profile" \
  $CHROMIUM_EXTRA_FLAGS \
  "$url"
