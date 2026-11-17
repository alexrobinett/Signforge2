# M3-29 Pin files in use, and stream downloads

Status: open  ·  Size: S  ·  Depends on: M3-26

## Goal

Cache cleanup must not delete a file a spot is still preparing or playing (review A2), and downloads must not hold whole files in memory (Fable; it matters for video).

## Read first

- docs/reviews/2026-11-17-full-review.md (A2)
- packages/player/src/store.ts (cleanup, `getBlob`), packages/player/src/main.ts (`prepareStep`)

## Scope

- A pin set: files needed by the playing spot, the spot preparing, and the last known good manifest (M3-28). Cleanup skips pinned files.
- Downloads stream into the cache instead of buffering, still verifying the SHA-256 before the file is used, and keep the 30-second stall rule.

## Done when

- [ ] Browser test: a manifest change mid-prepare does not delete that spot's files, and the spot plays.
- [ ] Browser test: a large file downloads with flat memory (heap measured before and after).
- [ ] A file whose hash does not match is never used.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
