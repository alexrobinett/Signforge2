# M3-36 Player content source for preview

Status: open  ·  Size: M  ·  Depends on: M3-32

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

- [ ] The player plays one spot from a posted draft in a test page on another origin, and ignores messages from any other origin.
- [ ] A user cannot fetch another org's file through the blob route (isolation test).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
