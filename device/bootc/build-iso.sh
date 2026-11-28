#!/bin/bash
# Builds the unattended USB installer for the signage OS: ./build-iso.sh [image]
# The ISO it makes erases every disk in the machine it boots on.
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

config=$(mktemp)
trap 'rm -f "$config"' EXIT
template=$(<"$dir/config.toml")
# The replacements are quoted so that bash does not read an & in them as the matched text.
template=${template//@SSH_PUBKEY@/"$pubkey"}
printf '%s\n' "${template//@TIMEZONE@/"$timezone"}" > "$config"

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
