# M3-44 Conditional updates (no lost writes)

Status: done (branch m3-44-conditional-updates)  ·  Size: S  ·  Depends on: nothing

## Goal

A person and an agent editing the same thing must not silently overwrite each other. Today `set_group_members` replaces the whole list, and the CMS builds that list from what the page loaded, so a member an agent added in between is dropped (`docs/research/cms-data-layer.md`).

## Read first

- docs/research/cms-data-layer.md (lost updates)
- packages/tools/src/dispatch.ts, tool.ts; packages/db (staged writes)

## Scope

- Every row that update tools change carries a `version` (or `updated_at` with enough precision); each view returns it.
- Update tools take an optional `ifVersion`. When it is given and the row has moved on, the call is refused with `conflict` and the current version in `details`, and nothing is written. The check runs inside the same D1 batch as the write.
- List-replacing tools (`set_group_members` and any like it) gain add/remove forms, or require `ifVersion`.
- The CMS sends `ifVersion` on every edit and shows "This changed since you opened it" with a reload, from the store action that made the call.
- A guard test: every update tool accepts `ifVersion`.

## Done when

- [x] Test: a stale `ifVersion` is refused and writes nothing; a current one succeeds. `packages/tools/test/versions.test.ts` ("refuses a stale one with conflict and the current version, writing nothing", "refuses inside the batch when the row moves on between the read and the commit", "lets a change made at the current version through", "guards groups and brand kits the same way"); in the repositories, `packages/db/test/versions.test.ts`. The guard test (every update tool takes `ifVersion` and returns `version`) is in `packages/tools/test/conventions.test.ts`.
- [x] Test: an agent adds a group member while a person's settings form is open; saving the form does not drop it. Through the CMS: `apps/cms/e2e/screens.spec.ts` ("an edit keeps a change someone else made while the form was open, and refuses one it would overwrite", which also checks the "This changed since you opened it" reload); at the tools, `packages/tools/test/versions.test.ts` ("keep a member an agent added while a person's settings form was open"). The form now adds and removes members (`add_group_members`, `remove_group_members`) instead of replacing the list.
- [x] `pnpm typecheck` and `pnpm test` pass (31 tasks, CMS e2e included); `pnpm lint`, `format:check`, `knip` and `dupes` too. Docs: `packages/tools/README.md` (Conditional updates, Group members, Adding a tool step 4, Tests), `packages/db/README.md` (Row versions), `apps/cms/README.md` (State, step 3).
