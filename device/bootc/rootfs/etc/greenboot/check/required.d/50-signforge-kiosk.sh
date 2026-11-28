#!/bin/bash
# Greenboot's required check for a new deployment: the network is up and the kiosk runs without crashing. A failure
# reboots, and after GREENBOOT_MAX_BOOT_ATTEMPTS grub boots the previous deployment. The healthcheck unit is ordered
# after neither the network nor the kiosk, so this waits for both.
set -u

unit=signforge-kiosk.service

if ! nm-online --quiet --timeout=60; then
  echo "50-signforge-kiosk: no network within 60 s" >&2
  exit 1
fi

for _ in $(seq 120); do
  systemctl is-active --quiet "$unit" && break
  sleep 1
done
if ! systemctl is-active --quiet "$unit"; then
  echo "50-signforge-kiosk: $unit not active within 120 s" >&2
  exit 1
fi

# A crash loop reads as active between restarts, and Chromium exiting takes cage with it, so the restart count must
# hold still too.
restarts=$(systemctl show -P NRestarts "$unit")
sleep 15
if ! systemctl is-active --quiet "$unit" || [ "$(systemctl show -P NRestarts "$unit")" != "$restarts" ]; then
  echo "50-signforge-kiosk: $unit restarted or stopped within 15 s (restarts were $restarts)" >&2
  exit 1
fi
