# M3-07 Sync endpoint: heartbeat, play counts, snapshots

Status: done (branch t3/m3-07-sync-heartbeat-play-counts; Pi checks on branch m3-pi-pass, 2026-11-17)  ·  Size: M  ·  Depends on: M3-06, M3-32

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

- [x] Play counts on the server match the Pi's play log for a 30-minute run.
  **Pi, 2026-11-17** (build `m3-foundations` 7ee8188, local `wrangler dev --env dev`, a `dev:screen` screen): the Pi played from 01:07:32 to 02:00 UTC (52 minutes, across two manifest changes). The first sync after the hour closed (02:00:22) brought the 01:00 hour to the server. `play_counts` for that hour against `__sf.log` (saved every minute): big-video 58/58, big-video-2 29/29, coffee 68/68, energy 68/68, sport-drinks 69/69, weather-atlanta 68/68 plays; 360 against 360, and `ms` equal for every spot. Details in `spike/pi-perf/RESULTS.md` (Final Pi pass). In Chromium, `browser/heartbeat.test.ts` ("reach the server once an hour ends…") shows the same.
- [x] A changed snapshot reaches the Pi on its next sync.
  **Pi, 2026-11-17:** a new `weather-atlanta` snapshot (rain, 42°F) was stored at 01:27:56 UTC. The Pi's next sync (01:29:00; the one before was at 01:24:05) brought it: `__sf.data['weather-atlanta']` changed to the new `fetchedAt`, and the weather spot showed 42°F, rain, high 50, low 38 on screen. The API saw no request to `data/`. In Chromium, `browser/heartbeat.test.ts` ("snapshots arrive on the sync…") shows a changed snapshot on screen after the next sync. `apps/api/test/sync.test.ts` ("snapshots…") shows the server sends only snapshots newer than the screen holds, and only for the desired manifest's sources.
- [x] D1 writes per sync measured; within the plan's budget.
  Measured from D1's own `rows_written` (workerd's D1) in `packages/db/test/device.test.ts`: **1 row** for a sync with no counts, **+3** for each count that makes a new (hour, spot) row (the row, its key and `play_counts_org_hour_idx`), **+1** for each count added to an existing row. Hours are sent once they end, so each (hour, spot) row is written once. At 1,000 screens on a 5-minute sync that is 8.6M writes a month for heartbeats, plus 21.6M for 10 spots playing 24 hours: about 30M against the 50M included. `docs/backend-plan.md` (Screens, Sync; Cost) is updated: the old estimate there was 16–20M.
- [x] A retried sync (same `seq`) does not double count.
  `packages/db/test/device.test.ts` ("stores a batch once…": same seq and an older seq add nothing; a new epoch at seq 1 is counted), `apps/api/test/sync.test.ts` ("are stored once per seq…") through the route, and `browser/heartbeat.test.ts`, where the fixture drops the reply to the first batch: the player resends it with the same seq and counts, and the totals still match the log. The repeat check is in the SQL of the same batch, so two copies racing also count once.
- [x] With the Pi's clock set an hour wrong and the network up, schedule and display hours follow server time after one sync.
  **Pi, 2026-11-17:** content with display hours to 22:00 and an `evening` schedule entry 21:00–22:00 (America/New_York). At 21:00 server time the Pi played `evening`. Then `timedatectl set-ntp false; date -s '+1 hour'` (the Pi read 22:00, outside both) and a kiosk restart. The first sync came 3 s after the restart: `__sf.clock.offsetMs` -3599947, trusted. About 20 s after the sync the screen was on and playing `evening`, with plays logged at server time (02:01:23Z while the Pi read 03:01). One thing seen: 2 s after that sync the player switched the panel off once (the Pi read 22:01, outside display hours) and on again 14 s later; the cause was not traced. NTP back on: offset 54 ms. In Chromium, `browser/heartbeat.test.ts` ("follows server time after one sync…") uses a server clock 6 hours off; the clock rules are unit-tested in `packages/player-core/src/clock.test.ts`.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Both pass at this branch's HEAD (`pnpm test`: 22 of 22 tasks). Updated: `docs/architecture.md` (Content delivery, Player: Sync, Socket, Reporting, Clock, Play counts), `docs/backend-plan.md` (Sync, routes, cost), `packages/db/README.md`, `packages/player/browser/README.md`, and contract comments.
