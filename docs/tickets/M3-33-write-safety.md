# M3-33 Write safety

Status: done (branch m3-33-write-safety)  ·  Size: M  ·  Depends on: nothing

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

- [x] Test: a failing audit insert rolls back the change. `packages/tools/test/dispatch.test.ts` › write safety › "rolls the change back when its audit row cannot be written" (a trigger makes the `audit_log` insert fail; the rename is not made). Also `packages/db/test/isolation.test.ts` › "commit atomically".
- [x] Test: retrying a create with the same key creates one row. `dispatch.test.ts` › "creates once for a retried key, returning the first result and writing nothing" (one group, same output, no second audit row), "creates once when two calls with the same key race", and "refuses a key reused for a different input, and keeps keys apart between orgs".
- [x] Test: finalize with a missing rendition fails and leaves the asset unverified. `packages/tools/test/assets.test.ts` › "refuses an asset missing a rendition, and leaves it unverified" (fails without the check, passes with it).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated: `packages/tools/README.md`, `packages/db/README.md`, `docs/backend-plan.md`. The guard is `packages/tools/test/write-guard.test.ts`.

## Notes from the build

- A tool stages writes with `ctx.write(org.<repo>.stage.<op>(...))` and returns its output as before; the dispatcher commits the writes, the audit row and any idempotency record in one batch. Handler return types are unchanged, which keeps the merge with M3-35 (output schemas) small.
- Behaviour change: a mutating call that stages nothing (publishing the current manifest again, revoking a revoked credential, finalizing a verified asset) is no longer audited. It changed nothing. `apps/api/test/admin.test.ts` now expects one audit row for two identical pushes.
- R2 is outside the batch. `finalize_asset` moves or deletes uploads before it commits; the README says what a failed batch leaves.
- Idempotency keys are kept indefinitely; expiring them belongs with M3-24's cleanup.
