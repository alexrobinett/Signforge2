# M3-17 Playlist editor

Status: done (branch t3/m3-17-playlist-editor)  ·  Size: S  ·  Depends on: M3-16

## Goal

Order spots into playlists with a transition.

## Read first

- packages/contract (Playlist, Transition)
- docs/architecture.md#player (transitions)
- packages/tools `src/spots.ts` and the CMS spot editor (`apps/cms/src/routes/_app/spots/$spotId.tsx`, `src/state/spot-editor.ts`): the playlist tools and editor follow them, drafts and `ifVersion` included.

## Scope

- Playlist tools: `list_playlists`, `get_playlist`, `create_playlist`, `update_playlist` (name, transition, and the whole order, guarded by `ifVersion`), `delete_playlist`. They change the draft only; the publish (M3-18) promotes a playlist once every spot in it is published (M3-34).
- Drag to reorder (with move buttons for the keyboard and phones), add and remove spots, per-playlist transition (cut, fade, crossfade, with the crossfade cost explained).
- Total loop length shown.
- Preview plays the playlist in the player: the spot editor's stage, fed the playlist's draft compiled in the browser.
- Deleting and creating playlists go through `packages/db`'s repository (`org.playlists.stage.delete`, `stage.insert`), never SQL of their own: a playlist made again with a deleted one's id continues its versions (`draft_tombstones`, #64), so an edit sent with an `ifVersion` read before the delete is refused `conflict`.
- `delete_playlist` refuses (`conflict`) while the playlist is the default or a schedule entry plays it, in its draft or its published version: the schema would refuse the delete anyway, and deleting a row deletes its published version (docs/backend-plan.md#publishing).

## Out of scope

- Scheduling (M3-19), publishing (M3-18).
- Setting the default playlist: no tool sets `org_settings.default_playlist_id` yet. M3-18 needs it (see there).
- Thumbnails of spots in the playlist: spots have none yet.

## Decisions

- A new playlist fades for 500 ms: fade is the player's default (docs/architecture.md, Transitions), and 500 ms is the player's own default length.
- The order is replaced whole, with `ifVersion`, rather than through add and remove tools: positions matter, and the version guard refuses an order made from an old read (the CMS README's list rule now says so).
- The stage leaves out a spot a screen could not play yet (an image field with no image, data its template refuses) and the editor says why by the spot, so the rest of the loop still plays. A publish would hold the whole playlist back.
- Removing a spot is optimistic with an Undo toast; deleting the playlist asks first (docs/research/cms-ux.md).
- There is no playlist board on the canvas; the editor follows Spot editor A's layout (header, form, dark stage). A review sub-agent compared the screenshots with EditorA, IdeaStage and the app nav board; its findings that applied were fixed (the stage stays in view beside a long form, the playing spot is marked by its row's border, an amber note for a spot left out, a quieter Delete).

## Done when

- [x] A playlist built in the CMS matches `examples/stress/playlists/stress.json` when compiled. `packages/tools/test/publishing.test.ts`, "compiles a playlist built with the playlist tools, as the CMS builds it, to the one sf build makes for examples/stress (M3-17)": the stress spots seeded, the playlist made with `create_playlist` and edited with `update_playlist` (spots added, reordered, transition set, each with `ifVersion`), as the editor does, then published and compiled: the manifest's playlist equals the golden's (its id aside) and its spots equal the golden's. The CMS side of the same calls is `apps/cms/e2e/playlists.spec.ts`, which checks with `get_playlist` that the order and transition the editor saved are the ones on screen.
- [x] A test deletes a playlist, makes it again with the same id, and sends an edit with the old `ifVersion`: refused `conflict`, nothing written (#64). `packages/tools/test/playlists.test.ts`, "refuses an edit read before a delete on a playlist made again with its id, and writes nothing (#64)"; the repository side is in `packages/db/test/drafts.test.ts` ("playlist edits (M3-17)", and the #64 cases).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated: `packages/tools/README.md`, `packages/db/README.md`, `apps/cms/README.md`, `docs/architecture.md` (Content sources), `docs/backend-plan.md` (Drafts), M3-18 (the default playlist).
