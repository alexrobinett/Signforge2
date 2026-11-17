#!/bin/sh
# Runs inside cage. A Pi 4 cannot animate at 4K, so force 1080p 60 Hz before the browser starts.
out=$(wlr-randr | awk 'NR==1 {print $1}')
wlr-randr --output "$out" --mode 1920x1080@60 || true
# No secrets in this URL: a template frame can read its parent's address.
url="${KIOSK_URL:-http://127.0.0.1:8090/index.html}"
exec /usr/bin/chromium \
  --kiosk --ozone-platform=wayland --no-first-run --noerrdialogs --disable-infobars \
  --password-store=basic --autoplay-policy=no-user-gesture-required \
  --user-data-dir="$HOME/.kiosk-profile" \
  $CHROMIUM_EXTRA_FLAGS \
  "$url"
