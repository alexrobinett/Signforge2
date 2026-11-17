# M3-21 Video upload and check

Status: open  ·  Size: M  ·  Depends on: M3-14, M3-00

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

- [ ] The clips in `spike/pi-perf/rejected-media/` are rejected for the right reason; `examples/stress/media/pan-1080p30.mp4` is accepted.
- [ ] Results match `sf build`'s ffprobe check on the same files.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
