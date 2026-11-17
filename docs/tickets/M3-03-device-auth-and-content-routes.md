# M3-03 Device auth and content routes

Status: open  ·  Size: M  ·  Depends on: M3-02

## Goal

Serve a screen its manifest, files and data snapshots from the Worker, authenticated by its credential.

## Read first

- docs/backend-plan.md#screens (credential, route table)
- packages/player/src/store.ts, data.ts (what the player fetches)

## Scope

- Device bearer middleware: parse `sfd_<screenId>.<secret>`, compare the SHA-256 against `screen_credentials`, reject revoked. Constant-time compare.
- `GET /v1/device/manifest.json`: the screen's desired manifest from R2, ETag = manifest id, 304 on `If-None-Match`.
- `GET /v1/device/blobs/:sha256`: streamed from R2, `cache-control: immutable`, only blobs listed in the screen's current or previous manifest.
- `GET /v1/device/data/:id.json`: latest snapshot for a source the screen's manifest lists.
- A script that creates a screen and prints a credential, for the Pi until pairing exists.
- Use the device API types in `packages/contract`; ids follow `ID_PATTERN`.

## Out of scope

- Pairing, sync, sockets.

## Done when

- [ ] Tests cover: no token, bad token, revoked token, another org's blob, 304 path.
- [ ] With `curl` and a seeded credential, the three routes return what `dist/content` holds.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
