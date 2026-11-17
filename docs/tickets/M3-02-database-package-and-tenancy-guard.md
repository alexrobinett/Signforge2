# M3-02 Database package and tenancy guard

Status: open  ·  Size: M  ·  Depends on: M3-01

## Goal

Create `packages/db`: the Drizzle schema, migrations, and the scoped repository that is the only way handlers reach tenant tables.

## Read first

- docs/backend-plan.md#data-model-d1
- docs/backend-plan.md#auth-and-tenancy

## Scope

- Drizzle schema for the tables in the plan, minus Better Auth's own (M3-09 adds those). Every tenant table has `org_id`, indexes lead with it, foreign keys are composite `(org_id, id)`.
- Generated SQL migrations applied by `wrangler d1 migrations`.
- `scoped(db, orgId)` returning repositories whose every query is filtered by org. Raw table access is not exported.
- A test helper that seeds two orgs, for isolation tests in later tickets.

## Out of scope

- Routes. Better Auth tables.

## Done when

- [ ] Migrations apply to a fresh local D1.
- [ ] A test proves a repository call made for org B with org A's id returns nothing.
- [ ] A lint or test fails if any package outside `packages/db` imports the table objects.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
