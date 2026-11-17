# M3-23 Data source poller

Status: open  ·  Size: M  ·  Depends on: M3-22, M3-07, M3-12

## Goal

Fetch feeds on a schedule in the Worker and deliver snapshots to screens; retire `datad.py`.

## Read first

- docs/backend-plan.md#data-sources

## Scope

- Data source CRUD tools; feed URLs encrypted at rest.
- A one-minute Cron Trigger polls due sources: conditional requests, backoff to 6 hours, write only on change.
- Fetch guards: https only, default ports, no IP literals, private-range check, manual redirects (3 max), 5-second timeout, categorised errors.
- Per-org limits from the plan.

## Out of scope

- Push of snapshots outside sync.

## Done when

- [ ] The stress playlist's weather, holidays and news update on the Pi with `datad` stopped.
- [ ] Tests show each fetch guard rejecting its case.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
