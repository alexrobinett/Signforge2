#!/bin/sh
# Recreate the stress-test media (kept out of git: large, and the photos are third-party).
# Photos come from picsum.photos (Unsplash licence); videos are generated with ffmpeg.
set -e
cd "$(dirname "$0")/../examples/stress/media"
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
echo "stress media ready"
