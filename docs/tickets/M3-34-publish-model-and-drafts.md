# M3-34 Publish model and drafts

Status: done (branch m3-34-publish-model-drafts)  ·  Size: M  ·  Depends on: M3-33

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

- [x] Test: an org with one broken draft spot publishes every screen. `packages/tools/test/publishing.test.ts` "publishes every screen when one draft spot is broken, and reports that spot", plus held drafts keeping their published version and one bad screen not stopping the others.
- [x] Test: the loader plus compiler produce the same manifest as `sf build` for `examples/stress`. Same file, "with the compiler, produces the manifest sf build produces for examples/stress": the stress golden seeded into D1 as base templates, assets, spots, a playlist and data sources, then promoted, loaded and compiled; the body equals the golden and the id is the hash of its body. (The golden's stored `id` is stale: `golden.test.ts` does not compare it.)
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated: `docs/backend-plan.md` (Drafts, Default playlist decision, data model), `packages/db/README.md`, `packages/tools/README.md`.

## Notes

- Default playlist (owner decision): an org setting, table `org_settings`; recorded in `docs/backend-plan.md#publishing`.
- Brand: `packages/tools/src/publishing.ts` marks where `compileInputFor` resolves the screen's brand kit once M3-38 lands. Nothing to pass yet.
- Not here: deleting spots or playlists that a published version still uses must be refused by the tools that delete them (M3-16, M3-17). A tool to show draft problems in the CMS comes with the editor (M3-16); `promoteDrafts` reports them.
