# M3-19 Schedules, groups and takeovers

Status: open  ·  Size: M  ·  Depends on: M3-18, M3-32

## Goal

Target playlists by time and by screen, group or org.

## Read first

- packages/contract (ScheduleEntry)
- packages/player-core (resolvePlaylist, entryApplies)
- docs/backend-plan.md#risks (takeover expiry)

## Scope

- Screen groups CRUD and membership.
- Schedule entries: playlist, priority, target, dates, days, window. Validated with `player-core`.
- Takeover: an entry with an end time under 24 hours, compiled into a dated window.
- A takeover cuts in at once: when a screen receives a manifest whose active takeover differs from what it is playing, it ends the current spot (with the normal transition) instead of waiting for the spot boundary. Every other publish waits for the boundary (decided 2026-11-17, see M3-06).
- A week view showing what each screen plays when.

## Out of scope

- Timed publish.

## Done when

- [ ] On the Pi, a takeover published mid-spot is on screen within 2 seconds, whatever the current spot's length.

- [ ] The week view agrees with `resolvePlaylist` for every hour of a test week.
- [ ] A takeover published now plays on the Pi immediately and ends on time with the network down.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
