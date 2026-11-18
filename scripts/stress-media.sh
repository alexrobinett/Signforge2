#!/bin/sh
# The stress-test media, kept out of git (large, and the photos are third-party).
#
#   sh scripts/stress-media.sh             fetch the canonical set into examples/stress/media
#   sh scripts/stress-media.sh --generate  make a new set there with curl and ffmpeg
#
# Fetching downloads the tarball of release $release with gh (logged in, or GH_TOKEN set) and checks
# every file against examples/stress/media.sha256. The stress golden (packages/cli/test/golden) is
# built from exactly those bytes, and ffmpeg's output differs by machine and version, so tests use the
# fetched set only. Generating is for making a new version: see docs/ci.md, "Stress media".
set -e
release=stress-media-v1
cd "$(dirname "$0")/../examples/stress"
mkdir -p media

if [ "$1" = --generate ]; then
  cd media
  # Photos from picsum.photos (Unsplash licence); the video is made from one of them.
  get() { [ -f "$4.jpg" ] || curl -fsL -o "$4.jpg" "https://picsum.photos/id/$1/$2/$3.jpg"; }
  get 1015 3840 2160 river-4k
  get 1036 3840 2160 snow-4k
  get 292 3840 2160 kitchen-4k
  get 429 1920 1080 berries-1080
  get 1080 1920 1080 strawberries-1080
  [ -f pan-1080p30.mp4 ] || ffmpeg -v error -y -loop 1 -i river-4k.jpg \
    -vf "zoompan=z='1+0.15*on/300':x='iw/2-(iw/zoom/2)+on':y='ih/2-(ih/zoom/2)':d=300:s=1920x1080:fps=30,format=yuv420p" \
    -t 10 -c:v libx264 -profile:v high -level 4.1 -b:v 8M -maxrate 10M -bufsize 16M -movflags +faststart -an pan-1080p30.mp4
  cp ../../demo/media/bottle-*.svg .
  echo "stress media generated: not the canonical set, so the stress golden will not match it"
  exit 0
fi

# sha256sum where there is one (Linux, recent macOS), else shasum.
check() { (cd "$1" && if command -v sha256sum >/dev/null; then sha256sum --quiet -c "$2"; else shasum -a 256 --quiet -c "$2"; fi) }

if check media ../media.sha256 >/dev/null 2>&1; then
  echo "stress media ready ($release)"
  exit 0
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh release download "$release" --repo alexrobinett/Signforge2 --pattern "$release.tar.gz" --dir "$tmp"
mkdir "$tmp/media"
tar -xzf "$tmp/$release.tar.gz" -C "$tmp/media"
check "$tmp/media" "$PWD/media.sha256"
cp "$tmp"/media/* media/
echo "stress media ready ($release)"
