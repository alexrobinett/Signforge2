# M3-19 Schedules, groups and takeovers

Status: in progress (branch m3-19-playlist-assignment)  ·  Size: M  ·  Depends on: M3-18, M3-32

## Goal

Target playlists by time and by screen, group or org.

## Read first

- packages/contract (ScheduleEntry)
- packages/player-core (resolvePlaylist, entryApplies)
- docs/backend-plan.md#risks (takeover expiry)

## Scope

- Screen groups CRUD and membership. *(The tools came with M3-12 (`create_group`, `rename_group`, `set_group_members`, …), and a screen's settings already joined and left groups. Here a screen's settings also make a new group with the screen in it, so the CMS alone can aim a playlist at a group; renaming and deleting a group stay with the tools.)*
- Schedule entries: playlist, priority, target, dates, days, window. Validated with `player-core`.
- Takeover: an entry with an end time under 24 hours (`startsAt` and `endsAt`, manifest schema 3). *(Was "compiled into a dated window", for schema-2 players, which ignore `endsAt`; no supported player plays schema 2 any more, so none is compiled, 2026-11-19.)*
- A takeover cuts in at once: when a screen receives a manifest whose active takeover differs from what it is playing, it ends the current spot (with the normal transition) instead of waiting for the spot boundary. Every other publish waits for the boundary (decided 2026-11-17, see M3-06).
- A week view showing what each screen plays when.
- Deleting and creating schedule entries go through `packages/db`'s repository (`org.scheduleEntries.delete`, `stage.delete`, `insert`, `stage.insert`), never SQL of their own: a schedule entry made again with a deleted one's id continues its versions (`draft_tombstones`, #64), so an edit sent with an `ifVersion` read before the delete is refused `conflict`.

## Out of scope

- Timed publish.

## Done when

- [x] On the Pi, a takeover published mid-spot is on screen within 2 seconds, whatever the current spot's length. *(0.10–0.42 s in five trials, cut 4–37 s into a 60 s spot; ending one by a publish 0.26–0.34 s. `spike/pi-perf/RESULTS.md`, "Takeovers cut in and end offline".)*

- [x] The week view agrees with `resolvePlaylist` for every hour of a test week. *(`apps/cms/test/schedule.test.ts`: the week view (`weekOf`) asks `resolvePlaylist` itself; the test checks every hour of a test week against `resolvePlaylist` on a manifest it builds independently, and against a week written out by hand, plus a day the clocks change.)*
- [x] A takeover published now plays on the Pi immediately and ends on time with the network down. *(On screen 0.1–0.4 s after the push; with the API stopped, it ended 16 ms after its `endsAt`, mid-spot. Same section. In CI: `packages/player/browser/takeover.test.ts`, on a fake clock.)*
- [x] A test deletes a schedule entry, makes it again with the same id, and sends an edit with the old `ifVersion`: refused `conflict`, nothing written (#64). *(`packages/tools/test/schedule.test.ts`, "an entry made again with a deleted one’s id…".)*
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
