# M3-17 Playlist editor

Status: open  ·  Size: S  ·  Depends on: M3-16

## Goal

Order spots into playlists with a transition.

## Read first

- packages/contract (Playlist, Transition)
- docs/architecture.md#player (transitions)

## Scope

- Drag to reorder, add and remove spots, per-playlist transition (cut, fade, crossfade, with the crossfade cost explained).
- Total loop length shown.
- Preview plays the playlist in the player.

## Out of scope

- Scheduling.

## Done when

- [ ] A playlist built in the CMS matches `examples/stress/playlists/stress.json` when compiled.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
