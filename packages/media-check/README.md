# @signforge/media-check

Is this video one a screen plays well? It reads an MP4's header, without decoding, and checks it against the contract's `VIDEO_SPEC`. The same code runs in the browser before an upload (`uploadVideo` in `@signforge/media`) and in the Worker after it (`finalize_video_upload` in `@signforge/tools`, over R2 range reads). `sf build` applies the same rules to what ffprobe reports.

## What it checks

`VIDEO_SPEC`, in the terms of the H.264 sequence parameter set (SPS) the header carries:

| Rule | From the file | Why |
| --- | --- | --- |
| H.264 | the `avc1` sample entry | the Pi 4 decodes H.264 in hardware |
| profile_idc 66, 77 or 100 (Baseline, Main, High) | SPS | High 10 and the 4:2:2 and 4:4:4 profiles are 10-bit or not 4:2:0 |
| level_idc up to 42 (4.2) | SPS | |
| chroma_format_idc 1 (4:2:0), 8-bit luma and chroma | SPS | the decoder cannot play 10-bit or 4:2:2 |
| progressive (frame_mbs_only_flag 1) | SPS | |
| at most 1920x1080, either way round | SPS, after cropping | |
| at most 30 fps on average (29.97 passes) | frames over the track's length (`stts`, `mdhd`) | 60 fps drops about 18% of its frames on the Pi |
| at most 10 Mbit/s | the track's sample bytes over its length (`stsz`, `mdhd`) | |
| at most 500 MB | the file | every screen stores it; the browser hashes it in memory |

It fails closed. A value it cannot read is a problem (`unreadable`), and so is a layout it does not follow:

- a fragmented MP4 (`mvex`; ffprobe reads these, this check does not);
- `avc3`, whose SPS may be in the stream rather than the header;
- more than one video track, sample description or SPS;
- anything that is not an MP4 (WebM, AVI, ...).

## API

- **`checkVideo(read, size)`** returns `{ info, problems }`. `read(offset, length)` returns those bytes of the file. It reads the top-level box headers until the `moov`, then the `moov` whole: one read when the file starts with it (`-movflags +faststart`), and a jump past the `mdat` when it ends with it. `info` is null when the header cannot be read at all. A file over the size cap is refused without reading it.
- **`blobReader(blob)`**: the reader for a browser `File`.
- **`videoProblems(info)`**: the rules alone, for a `VideoInfo` from anywhere (`sf build` makes one from ffprobe).
- **`EXPORT_ADVICE`**: how to export a file that passes, with HandBrake or ffmpeg. Every rejection shows it.

Each problem is `{ code, message }`. The codes are `unreadable`, `codec`, `profile`, `level`, `pixel-format`, `interlaced`, `size`, `fps`, `bitrate` and `bytes`. The message is plain enough to show as it is: `60 fps is above 30`.

## Tests

`test/fixtures/` holds small clips made by `test/fixtures/make.sh` with ffmpeg 9.0.2 and libx264. They are committed because CI has no ffmpeg. There are 4 that pass and 11 that fail, one for each rule. `test/check.test.ts` checks each verdict and the messages. Where ffprobe is installed, it also checks that the reader's profile, level, pixel format, size, frame rate and bit rate agree with ffprobe's.

`packages/cli/test/video.test.ts` checks that `sf build` (ffprobe) and this check reach the same verdict on every fixture and on the clips measured on the Pi. These are `examples/stress/media/pan-1080p30.mp4` (accepted) and `spike/pi-perf/rejected-media/motion-1080p60.mp4` (rejected for frame rate and bit rate), when they are present.
