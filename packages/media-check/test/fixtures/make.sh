#!/bin/sh
# Remake the test clips (committed: small, and CI has no ffmpeg). Made with ffmpeg 9.0.2 and libx264.
set -e
cd "$(dirname "$0")"
src="-f lavfi -i testsrc=size=320x180:rate=30 -t 1"
x264="-c:v libx264 -preset veryfast -an"
ff() { ffmpeg -v error -y "$@"; }

# Accepted.
ff $src $x264 -profile:v high -level 4.1 -pix_fmt yuv420p -movflags +faststart high.mp4
ff $src $x264 -profile:v main -pix_fmt yuv420p main-moov-at-end.mp4
ff $src $x264 -profile:v baseline -pix_fmt yuv420p baseline.mp4
ff -f lavfi -i testsrc=size=180x320:rate=30000/1001 -t 1 $x264 -pix_fmt yuv420p -movflags +faststart portrait-29.97.mp4

# Rejected.
ff $src $x264 -profile:v high10 -pix_fmt yuv420p10le high10.mp4
ff $src $x264 -profile:v high422 -pix_fmt yuv422p high422.mp4
ff -f lavfi -i testsrc=size=320x180:rate=60 -t 1 $x264 -pix_fmt yuv420p fps60.mp4
ff $src -c:v libx264 -preset veryfast -an -flags +ildct+ilme -x264-params tff=1 -pix_fmt yuv420p interlaced.mp4
ff -f lavfi -i testsrc=size=2560x1440:rate=30 -t 0.2 $x264 -level 5.0 -pix_fmt yuv420p 1440p.mp4
ff $src $x264 -level 5.1 -pix_fmt yuv420p level51.mp4
ff -f lavfi -i "nullsrc=size=320x180:rate=30,geq=random(1)*255:128:128" -t 0.3 $x264 -crf 1 -pix_fmt yuv420p bitrate.mp4
ff $src -c:v libx265 -x265-params log-level=error -an -pix_fmt yuv420p -tag:v hvc1 hevc.mp4
ff $src $x264 -pix_fmt yuv420p -movflags frag_keyframe+empty_moov fragmented.mp4
ff -f lavfi -i sine=frequency=440 -t 1 -c:a aac audio-only.mp4
ff $src -c:v libvpx-vp9 -pix_fmt yuv420p -an vp9.webm
