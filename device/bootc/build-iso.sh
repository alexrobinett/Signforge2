#!/bin/bash
# Builds the unattended USB installer for the signage OS: ./build-iso.sh [image]
# The ISO it makes erases every disk in the machine it boots on. With WIFI_SSID and WIFI_PSK it also carries that
# network's password, to the device and to anyone holding the stick.
set -euo pipefail

image=${1:-ghcr.io/alexrobinett/signforge-os:stable}
pubkey_file=${SSH_PUBKEY_FILE:-$HOME/.ssh/id_ed25519.pub}
timezone=${TIMEZONE:-UTC}
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [ ! -f "$pubkey_file" ]; then
  echo "build-iso.sh: no SSH public key at $pubkey_file; set SSH_PUBKEY_FILE" >&2
  exit 1
fi
pubkey=$(<"$pubkey_file")

wifi_profile=
if [ -n "${WIFI_SSID:-}" ]; then
  if [ -z "${WIFI_PSK:-}" ]; then
    echo "build-iso.sh: WIFI_SSID is set, so WIFI_PSK must be too" >&2
    exit 1
  fi
  # Both go into a TOML string and a NetworkManager keyfile as they are, and these three characters would break one.
  case "$WIFI_SSID$WIFI_PSK" in
    *[\\\"$'\n']*)
      echo "build-iso.sh: WIFI_SSID and WIFI_PSK cannot hold a backslash, a double quote or a newline" >&2
      exit 1
      ;;
  esac
  wifi_profile="%post --erroronfail
install -m 600 /dev/stdin /etc/NetworkManager/system-connections/signforge-wifi.nmconnection <<'NM'
[connection]
id=signforge-wifi
type=wifi

[wifi]
ssid=$WIFI_SSID

[wifi-security]
key-mgmt=wpa-psk
psk=$WIFI_PSK
NM
restorecon /etc/NetworkManager/system-connections/signforge-wifi.nmconnection
%end"
fi

config=$(mktemp)
trap 'rm -f "$config"' EXIT
template=$(<"$dir/config.toml")
# The replacements are quoted so that bash does not read an & in them as the matched text.
template=${template//@SSH_PUBKEY@/"$pubkey"}
template=${template//@TIMEZONE@/"$timezone"}
printf '%s\n' "${template//@WIFI_PROFILE@/"$wifi_profile"}" > "$config"

mkdir -p "$dir/output"
sudo podman pull "$image"
sudo podman run --rm --privileged --pull=newer \
  --security-opt label=type:unconfined_t \
  -v "$config":/config.toml:ro \
  -v "$dir/output":/output \
  -v /var/lib/containers/storage:/var/lib/containers/storage \
  quay.io/centos-bootc/bootc-image-builder:latest \
  --type anaconda-iso --rootfs xfs "$image"

echo "$dir/output/bootiso/install.iso"
