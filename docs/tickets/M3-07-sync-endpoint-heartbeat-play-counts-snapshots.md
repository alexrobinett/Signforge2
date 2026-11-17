# M3-07 Sync endpoint: heartbeat, play counts, snapshots

Status: in progress (branch t3/m3-07-sync-heartbeat-play-counts): built and tested locally; the Pi checks are still to run  ·  Size: M  ·  Depends on: M3-06, M3-32

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

## Decision: `play_counts` and `PlayCount.manifest`

I dropped the field from the contract (its own commit) and added no column. Keying counts on the manifest would add rows at every publish, and the screen's publish history (`publish_screens`) already says which manifest it had when.

## Done when

- [ ] Play counts on the server match the Pi's play log for a 30-minute run.
  **Not run on the Pi:** the rig lock was held by M3-39 for the whole hour the brief allows, and was still in use when I stopped (its measurement had just started). In Chromium, `browser/heartbeat.test.ts` ("reach the server once an hour ends…") shows the stored counts equal the player's play log, tallied per hour and spot, after the server time crosses an hour. To run on the Pi: start a local API (`wrangler dev --env dev --ip 0.0.0.0` with a `dev:screen` screen), point the kiosk at it, play for 30 minutes, wait for the hour to end plus one sync, then compare `play_counts` (`wrangler d1 execute DB --local --env dev`) with `__sf.log`. Counts are sent only once their hour has ended, so the comparison waits for the hour to close.
- [ ] A changed snapshot reaches the Pi on its next sync.
  **Not run on the Pi** (same reason). In Chromium, `browser/heartbeat.test.ts` ("snapshots arrive on the sync…") shows a changed snapshot on screen after the next sync, and no request to `data/` in API mode. `apps/api/test/sync.test.ts` ("snapshots…") shows the server sends only snapshots newer than the screen holds, and only for the desired manifest's sources.
- [x] D1 writes per sync measured; within the plan's budget.
  Measured from D1's own `rows_written` (workerd's D1) in `packages/db/test/device.test.ts`: **1 row** for a sync with no counts, **+3** for each count that makes a new (hour, spot) row (the row, its key and `play_counts_org_hour_idx`), **+1** for each count added to an existing row. Hours are sent once they end, so each (hour, spot) row is written once. At 1,000 screens on a 5-minute sync that is 8.6M writes a month for heartbeats, plus 21.6M for 10 spots playing 24 hours: about 30M against the 50M included. `docs/backend-plan.md` (Screens, Sync; Cost) is updated: the old estimate there was 16–20M.
- [x] A retried sync (same `seq`) does not double count.
  `packages/db/test/device.test.ts` ("stores a batch once…": same seq and an older seq add nothing; a new epoch at seq 1 is counted), `apps/api/test/sync.test.ts` ("are stored once per seq…") through the route, and `browser/heartbeat.test.ts`, where the fixture drops the reply to the first batch: the player resends it with the same seq and counts, and the totals still match the log. The repeat check is in the SQL of the same batch, so two copies racing also count once.
- [ ] With the Pi's clock set an hour wrong and the network up, schedule and display hours follow server time after one sync.
  **Not run on the Pi** (same reason). In Chromium, `browser/heartbeat.test.ts` ("follows server time after one sync…") uses a server clock 6 hours off. The schedule window and display hours are set so they hold only by server time. After one sync the screen is on, plays the scheduled playlist, logs plays at server time, and has the offset; the offset survives a reload with the sync failing. The clock rules (offset from the request's midpoint, folding in jumps over 2 s, trust at start) are unit-tested in `packages/player-core/src/clock.test.ts`. To run on the Pi: `sudo timedatectl set-ntp false; sudo date -s '+1 hour'`, use content whose schedule window and display hours hold only at real time, restart the kiosk, check `__sf.clock` and `__sf.log`, then `sudo timedatectl set-ntp true`.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Both pass at this branch's HEAD (`pnpm test`: 22 of 22 tasks). Updated: `docs/architecture.md` (Content delivery, Player: Sync, Socket, Reporting, Clock, Play counts), `docs/backend-plan.md` (Sync, routes, cost), `packages/db/README.md`, `packages/player/browser/README.md`, and contract comments.
