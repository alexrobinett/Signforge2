# M3-14 Assets: upload and library

Status: open  ·  Size: M  ·  Depends on: M3-12

## Goal

Upload images straight to R2, scaled in the browser, verified on the server.

## Read first

- docs/backend-plan.md#publishing (uploads)
- packages/cli/src/sf.ts (`fitImage`: the cover rule)

## Scope

- Presigned R2 PUT; a finalize tool re-hashes and marks the asset verified.
- Browser scaling with `createImageBitmap` and `OffscreenCanvas` into landscape and portrait renditions using the same rule as `fitImage`; EXIF orientation honoured.
- The Worker checks image dimensions and type; rejects oversize.
- Asset library page: grid, search by name, usage count, delete when unused.

## Out of scope

- Video (M3-21).

## Done when

- [ ] A 4K phone photo uploads as renditions no larger than the screen box.
- [ ] A file whose bytes do not match its claimed hash is rejected.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
