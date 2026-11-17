# M3-04 `sf push`: publish from the CLI

Status: open  ·  Size: S  ·  Depends on: M3-03

## Goal

Upload what `sf build` produces to the API, so the Pi can play real content from Cloudflare before the CMS exists.

## Read first

- packages/cli/src/sf.ts
- docs/backend-plan.md#publishing (R2 layout)

## Scope

- `sf push <out-dir> --screen <id>`: upload blobs missing from R2 (ask the API which exist), upload the manifest, set it as the screen's desired manifest.
- An admin route protected by a deploy secret, removed or replaced once M3-12 exists.
- R2 keys follow the plan's layout.

## Out of scope

- The server compiler (M3-13).

## Done when

- [ ] Pushing twice uploads no blobs the second time.
- [ ] After a push, `GET /v1/device/manifest.json` returns the pushed manifest.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
