#!/bin/sh
# Runs inside cage. A Pi 4 cannot animate at 4K, so force 1080p 60 Hz before the browser starts.
out=$(wlr-randr | awk 'NR==1 {print $1}')
wlr-randr --output "$out" --mode 1920x1080@60 || true
exec /usr/bin/chromium \
  --kiosk --ozone-platform=wayland --no-first-run --noerrdialogs --disable-infobars \
  --password-store=basic --autoplay-policy=no-user-gesture-required \
  --user-data-dir=/home/alex/.kiosk-profile \
  --remote-debugging-port=9222 --remote-allow-origins=* \
  $CHROMIUM_EXTRA_FLAGS \
  "http://127.0.0.1:8080/index.html?variant=rich,willchange&webgl=400&seconds=5"
