#!/bin/bash
# Greenboot's required check: on a new deployment, the network is up and the kiosk runs without crashing.
#
# Greenboot reboots on a failed check on any boot, not only the first after an update, and after
# GREENBOOT_MAX_BOOT_ATTEMPTS grub boots the other deployment (seen in a VM: a screen switched on with its network down
# rebooted every minute). So this judges a deployment once. One that has passed, or that has no other deployment to go
# back to, is not checked again: a reboot would not mend it, and a rollback would swap a working OS for an older one.
set -u

unit=signforge-kiosk.service
proven=/var/lib/signforge/proven-deployments

if ! status=$(bootc status --format=json); then
  echo "50-signforge-kiosk: bootc status failed" >&2
  exit 1
fi
digest=$(jq -r '.status.booted.image.imageDigest' <<<"$status")

if grep -qxF "$digest" "$proven" 2>/dev/null; then
  exit 0
fi

if [ "$(jq -r '.status.rollback | type' <<<"$status")" != null ]; then
  if ! nm-online --quiet --timeout=60; then
    echo "50-signforge-kiosk: no network within 60 s" >&2
    exit 1
  fi

  # The healthcheck unit is not ordered after the kiosk, so wait for it.
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
fi

mkdir -p "${proven%/*}"
echo "$digest" >> "$proven"
