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
- Rewrite `packages/player/src/data.ts` to take snapshots from the sync response instead of polling each source.
- Play counts per UTC hour (`PlayCount`), persisted in Cache Storage, sent with `seq` until `ackSeq` covers them; the server ignores a repeated `seq`.
- Clock: keep the offset from `serverTime`, persist it, and read corrected time everywhere the player uses `new Date()` (schedule, display hours, play counts).
- Report supported manifest schemas and protocols (`SUPPORTED_MANIFEST_SCHEMAS`, `SUPPORTED_PROTOCOLS`); the server sends `reload` when a screen's player cannot play what it compiles.
- `play_counts` (M3-02) is keyed on screen, hour and spot, with no manifest column, while the contract's `PlayCount` carries `manifest`. Decide: add the column in a migration, or drop the field from the contract in its own commit.

## Out of scope

- Data source polling (M3-23); this only delivers snapshots that exist.

## Done when

- [ ] Play counts on the server match the Pi's play log for a 30-minute run.
- [ ] A changed snapshot reaches the Pi on its next sync.
- [ ] D1 writes per sync measured and recorded in the ticket's PR; within the plan's budget.
- [ ] A retried sync (same `seq`) does not double count.
- [ ] With the Pi's clock set an hour wrong and the network up, schedule and display hours follow server time after one sync.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
