# M3-01 API Worker scaffold

Status: done (m3-01-api-scaffold)  ·  Size: S  ·  Depends on: nothing

## Goal

Create `apps/api`, a Hono Worker that builds, tests and runs locally inside the monorepo.

## Read first

- docs/backend-plan.md#layout

## Scope

- Add `apps/*` to `pnpm-workspace.yaml`.
- `apps/api` with Hono, `wrangler.jsonc` (D1 and R2 bindings, `nodejs_compat`; Durable Objects are declared in M3-06 with their classes), and dev/demo/prod environments.
- Tests with `@cloudflare/vitest-pool-workers`; `typecheck` and `test` wired into Turborepo.
- `GET /health` returning the build version.

## Out of scope

- Any route beyond health. Deploying.

## Done when

- [x] `pnpm typecheck` and `pnpm test` pass from the repo root with the new app included.
- [x] `pnpm --filter @signforge/api dev` serves `/health` locally.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
