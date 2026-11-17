# M3-33 Write safety

Status: open  ·  Size: M  ·  Depends on: nothing

## Goal

Every change is recorded, and a retry never duplicates one. Today the audit row is written after the change, so a failure leaves a change without its audit and invites a retry that can create twice (Astra). `finalize_asset` can mark an asset verified with no renditions because its rows are written separately (review A3).

## Read first

- docs/reviews/2026-11-17-full-review.md (A3, change without audit)
- packages/tools/src/dispatch.ts (audit after change), tool.ts, assets.ts, upload.ts
- packages/db (scoped repositories)

## Scope

- Tools return their writes as statements; `dispatch()` runs them and the audit row in one D1 `batch()` (atomic).
- Idempotency keys on every creating tool: the same key returns the first result and writes nothing.
- An asset and its renditions are written in one batch; `finalize_asset` requires both renditions verified in R2.
- The isolation and guard tests keep passing; a new guard test fails if a mutating tool writes outside the batch.

## Done when

- [ ] Test: a failing audit insert rolls back the change.
- [ ] Test: retrying a create with the same key creates one row.
- [ ] Test: finalize with a missing rendition fails and leaves the asset unverified.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
