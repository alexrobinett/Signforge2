# M3-44 Conditional updates (no lost writes)

Status: open  ·  Size: S  ·  Depends on: nothing

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

- [ ] Test: a stale `ifVersion` is refused and writes nothing; a current one succeeds.
- [ ] Test: an agent adds a group member while a person's settings form is open; saving the form does not drop it.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
