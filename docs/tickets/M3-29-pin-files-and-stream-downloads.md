# M3-29 Pin files in use, and stream downloads

Status: done (branch m3-29-pin-files-stream-downloads)  ·  Size: S  ·  Depends on: M3-26

## Goal

Cache cleanup must not delete a file a spot is still preparing or playing (review A2), and downloads must not hold whole files in memory (Fable; it matters for video).

## Read first

- docs/reviews/2026-11-17-full-review.md (A2)
- packages/player/src/store.ts (cleanup, `getBlob`), packages/player/src/main.ts (`prepareStep`)

## Scope

- A pin set: files needed by the playing spot, the spot preparing, and the last known good manifest (M3-28). Cleanup skips pinned files.
- Downloads stream into the cache instead of buffering, still verifying the SHA-256 before the file is used, and keep the 30-second stall rule.

## Done when

- [x] Browser test: a manifest change mid-prepare does not delete that spot's files, and the spot plays. `browser/files.test.ts` "keeps the files of a spot preparing under a replaced manifest": spot `a` waits in the data wait under the first manifest while the second replaces it; `a` plays from the first manifest with no skip, and its file is dropped after. Fails with the `preparing` pin removed.
- [x] Browser test: a large file downloads with flat memory (heap measured before and after). `browser/files.test.ts` "downloads a large file with flat memory": a 64 MB file at 32 MB/s; page heap +1.5 MB at peak, 0 after; download worker retains at most 3 MB (64 MB when made to buffer, which fails the test). Heap is JS heap plus ArrayBuffer backing stores over CDP.
- [x] A file whose hash does not match is never used. Unit test in `src/store.test.ts` and browser test in `browser/files.test.ts`: the file is never stored under its hash, the manifest is not adopted, and the player recovers once the right bytes are served. Fails with the hash check removed.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated. Both green after merging `m3-foundations` (22/22 test tasks, CMS e2e included); `docs/architecture.md` (Cache) and `packages/player/browser/README.md` updated.

Pi: the incremental SHA-256 runs at 32 MB/s in the Pi 4's Chromium (about 2 ms per 64 KB chunk), so downloads run in a worker to keep hashing off the main thread. A frame measurement during a large download on the Pi was not taken: it needs content with a large file on the cloud demo, and this ticket does not deploy.
