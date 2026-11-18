# M3-21 Video upload and check

Status: done (branch `m3-21-video-upload`)  ·  Size: M  ·  Depends on: M3-14, M3-00

## Goal

Accept only video the Pi plays well, checked in the browser and again on the server.

## Read first

- packages/contract (VIDEO_SPEC)
- packages/cli/src/sf.ts (`checkVideo`)
- spike/m3-platform/RESULTS.md (MP4 parsing in workerd)

## Scope

- `packages/media-check`: read the MP4 header for codec, profile, level, pixel format, size, frame rate, bit rate; compare with `VIDEO_SPEC`. Same code in browser and Worker.
- Multipart upload to R2; server re-checks by range reads before marking verified.
- Rejections explain how to export a compliant file.
- Restate `VIDEO_SPEC` in codec terms an MP4 header parser can check (profile, level, chroma format and bit depth from the SPS, progressive), and add a maximum file size. Keep `sf build`'s ffprobe check consistent with it.
- Fail closed: a file whose profile, level or frame rate cannot be read is rejected.

## Out of scope

- Transcoding.

## Done when

- [x] The clips in `spike/pi-perf/rejected-media/` are rejected for the right reason; `examples/stress/media/pan-1080p30.mp4` is accepted. `packages/cli/test/video.test.ts`, run with the clips present: `motion-1080p60.mp4` is rejected for `fps` (60 > 30) and `bitrate` (11.9 Mbit/s > 10), and `pan-1080p30.mp4` passes. The clips are not in git (`scripts/stress-media.sh`); the test skips them when absent. Also 11 ffmpeg-made clips in `packages/media-check/test/fixtures/` fail, one per rule (`test/check.test.ts`).
- [x] Results match `sf build`'s ffprobe check on the same files. Same test: `sf build` now feeds ffprobe's report to media-check's `videoProblems`, and the two readers reach the same problem codes on all 17 clips. Two known differences: a fragmented MP4 (ffprobe accepts it; the header check refuses the layout) and a WebM (ffprobe names its codec; the header check says it is not an MP4). Both are listed in the test. Where ffprobe is installed, `packages/media-check/test/check.test.ts` also compares profile, level, pixel format, size, frame rate and bit rate with ffprobe's values field by field.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (`docs/backend-plan.md`, `docs/architecture.md`, `packages/tools/README.md`, `packages/media/README.md`, new `packages/media-check/README.md`).

## Notes

- **Code.** `packages/media-check`: the MP4 box walker, the SPS parser and the rules. `packages/tools/src/videos.ts`: `create_video_upload` and `finalize_video_upload`. `packages/media/src/video-upload.ts`: `uploadVideo` for the browser. `packages/cli/src/video.ts`: `sf build`'s ffprobe reader.
- **Own parser, not mp4box.js.** mp4box gives profile and level but not the SPS's chroma format, bit depth or frame_mbs_only_flag. The box walk plus SPS parse is about 250 lines and has no dependency.
- **Multipart.** The Worker starts the upload through the R2 binding and signs an S3 UploadPart URL per 16 MiB part. Miniflare's S3 API accepts these against a binding-made upload, and the e2e test runs the flow in Chromium. Finalize asks for every part's ETag, 1 to N; R2 would otherwise complete a subset into a shorter file. ETags come quoted from the S3 API, and the tool strips the quotes. Deploying needs the bucket's CORS rule to expose `ETag`, and the `up/` lifecycle rule to abort incomplete multipart uploads too.
- **Hashing.** The server hashes with `crypto.DigestStream`, then writes the final key with R2's `sha256` option, so R2 checks the hash again on write. The browser hashes the whole file in memory (Web Crypto has no streaming digest), and so the file cap is 500 MB.
- **Fail closed, where ffprobe is lenient.** `sf build` used to skip profile and level when ffprobe gave none, and passed `field_order: unknown`. It now rejects all three.
- **No Pi run.** The playback profile is unchanged (1080p30, 10 Mbit/s, H.264 8-bit 4:2:0); only how it is written and checked changed, and the clips the spike measured are the ones tested.
- **No CMS UI.** The library page (M3-14's other half) calls `uploadVideo` from `@signforge/media` the way it calls `uploadImage`. It shows a `VideoRejectedError`'s message, which includes the export advice.
- **Pre-existing, not from this branch.** With the main checkout's stress media copied in, `packages/cli/test/golden.test.ts`'s stress golden fails on clean `origin/master` too (another manifest id). Without the media it skips, as in CI.
