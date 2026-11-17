# M3-07 Sync endpoint: heartbeat, play counts, snapshots

Status: open  ·  Size: M  ·  Depends on: M3-06

## Goal

One periodic HTTP call that carries everything chatty, so the socket stays silent.

## Read first

- docs/backend-plan.md#screens (sync)
- packages/player/src/main.ts (`__sf` state, play log)

## Scope

- `POST /v1/device/sync`: player and manifest versions, cache state, display state and method, hourly play counts. Returns desired manifest id, changed snapshots, a socket ticket, server time, next interval.
- Request and response types in `packages/contract`.
- Player: sync loop every 5 minutes with jitter; applies snapshots; records clock skew from server time.
- `play_counts` upserts; `screens` last-seen and status.

## Out of scope

- Data source polling (M3-23); this only delivers snapshots that exist.

## Done when

- [ ] Play counts on the server match the Pi's play log for a 30-minute run.
- [ ] A changed snapshot reaches the Pi on its next sync.
- [ ] D1 writes per sync measured and recorded in the ticket's PR; within the plan's budget.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
