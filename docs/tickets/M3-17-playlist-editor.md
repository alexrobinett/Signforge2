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
- Deleting and creating playlists go through `packages/db`'s repository (`org.playlists.delete`, `stage.delete`, `insert`, `stage.insert`), never SQL of their own: a playlist made again with a deleted one's id continues its versions (`draft_tombstones`, #64), so an edit sent with an `ifVersion` read before the delete is refused `conflict`.

## Out of scope

- Scheduling.

## Done when

- [ ] A playlist built in the CMS matches `examples/stress/playlists/stress.json` when compiled.
- [ ] A test deletes a playlist, makes it again with the same id, and sends an edit with the old `ifVersion`: refused `conflict`, nothing written (#64).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
