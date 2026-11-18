# M3-36 Player content source for preview

Status: done (branch m3-36-player-content-source)  ·  Size: M  ·  Depends on: M3-32

## Goal

Let the real player build run in the CMS preview. Today the player has one content transport, the device API with a device credential (Fable). The editor preview runs on the CMS origin as a signed-in user.

## Read first

- packages/player/src/main.ts, store.ts, credential.ts
- docs/proposals/brand-and-editor.md (the live editor)

## Scope

- A content-source seam in the player: device (today's path) and preview (a manifest and files posted in from the parent page, or fetched from a user-side blob route).
- A user-side blob route on the API, behind the session and org scope, for files an org can see.
- The preview channel is a new inbound surface: accept messages only from the CMS origin, and only when framed by it.
- Device blobs switch to `cache-control: private` (Fable).

## Done when

- [x] The player plays one spot from a posted draft in a test page on another origin, and ignores messages from any other origin. `packages/player/browser/preview.test.ts`: the player (127.0.0.1) framed by `http://cms.test` plays the posted draft, fetches unsent files from the blob route, plays posted data, and updates the spot on screen in the same frame; a page on `evil.test` framing it, and an `evil.test` frame posting to it while the CMS frames it, get nothing played. Breaking the origin checks fails the last two; making updates always reload fails the same-frame test.
- [x] A user cannot fetch another org's file through the blob route (isolation test). `apps/api/test/blobs.test.ts`: org A's session gets 404 for org B's file (which org B fetches), base template HTML is served to both, a non-bundle under `sys/b/` is not. Device blobs are `private` (`device.test.ts`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated. Root runs green after merging `m3-foundations`; `docs/architecture.md` (Player, Content sources), `docs/backend-plan.md` (device blobs `private`, files for users), `packages/player/browser/README.md`.
