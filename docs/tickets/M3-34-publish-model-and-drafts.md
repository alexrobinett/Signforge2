# M3-34 Publish model and drafts

Status: open  ·  Size: M  ·  Depends on: M3-33

## Goal

One broken or unfinished spot must not block every screen's publish (review A4), and the server needs a loader from the database to `compileScreen`.

## Read first

- docs/reviews/2026-11-17-full-review.md (A4)
- packages/compiler/src/index.ts (checks every spot in the org)
- docs/backend-plan.md#publishing, docs/tickets/M3-18

## Scope

- Drafts: spots, playlists and schedule entries have a draft and a published state. Editing changes the draft; publish promotes drafts that pass their checks and reports the rest without blocking.
- The compiler checks only what it compiles: the published content this screen reaches. Draft problems are shown in the CMS, not raised by publish.
- Decide and implement where the default playlist lives (org setting or screen group), recorded in `docs/backend-plan.md`.
- A loader that reads an org's published graph through `scoped(db, orgId)` into `CompileInput`, used by M3-18's publish.
- Brand resolution hook: the loader passes the screen's brand kit once M3-38 lands.

## Done when

- [ ] Test: an org with one broken draft spot publishes every screen.
- [ ] Test: the loader plus compiler produce the same manifest as `sf build` for `examples/stress`.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
