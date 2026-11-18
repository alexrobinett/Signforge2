# M3-16 Spot editor

Status: in progress, first PR (branch t3/m3-16-spot-editor)  ·  Size: L  ·  Depends on: M3-14, M3-15, M3-13, M3-34, M3-36, M3-38, M3-44

## Goal

Create and edit spots with a form generated from the template's fields and a live preview using the real player.

## Read first

- packages/contract (FieldDef, validateSpotData)
- packages/player (preview runs the real build)

## Scope

- Form generated from `TemplateManifest.fields`: text, number, boolean, color, select, image (asset picker), list (repeating rows, `maxItems`).
- Binding a field to a data source and path, with the static value kept as fallback.
- Preview: the player build in an iframe, playing this one spot at landscape and portrait sizes, updating as the form changes.
- Preview follows frame protocol 2's update lifecycle (M3-32), at the screen's true resolution scaled to fit, with landscape/portrait and fit/100% toggles; a brand-kit switcher themes it; a sample-data switch shows the fallback.
- Edits save to the spot's draft (M3-34).
- Image, video and URL spots: file or URL plus fit and duration. URL spots validated with `safeUrl`.

- **From the design canvas (2026-11-17).** Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`.
  - The stage is labelled "Draft. Not on any screen." While a field is invalid, the stage keeps the last valid frame and shows the contract's message by the field; publish stays disabled.
  - The stage updates within 100 ms of a keystroke (debounced `draft` messages, M3-36).

## Out of scope

- Playlists.
- Timeline scrubbing (`seek`), click-to-edit (`field-clicked`) and template notices (`notice`): later, after v1 (owner decision 2026-11-17).

- Later, not v1: the time scrubber ("what will this screen show on Friday at 6 pm?") needs a clock override in the preview channel, a contract change; an agent's draft shown before and after on two stages (Milestone 4).


## Notes from M3-14 (asset library)

- **`AssetPicker`** (`apps/cms/src/components/assets/asset-picker.tsx`) is ready for the image field: pass the assets from the route's loader (`getAssets` in `src/server/assets.functions.ts`), `open`, `onOpenChange` and `onPick`. Then drop its entry from knip.jsonc.
- **Per-asset focal point for portrait crops** (deferred by M3-25 and M3-14). A portrait screen shows a landscape photo's portrait rendition, which is cover-scaled (3413x1920 for 4K) and cropped at the centre today. What it needs:
  - Contract, in its own commit: a spot's image references carry an optional focus, `{ x, y }` from 0 to 1 (image spots beside `file` and `fit`; template image fields beside `assets[field]`). Optional, so older manifests and players still work.
  - `packages/db`: a nullable `assets.focus_json` column (a migration), through the scoped repository.
  - A tool, `set_asset_focus { assetId, focus | null }`, and `focus` in the asset views.
  - The compiler (`packages/tools/src/publishing.ts`, `assetFile`) writes it into the manifest for both orientations.
  - The player (image spots) and the template SDK (image fields) set `object-position` from it; each template that shows an image uses the SDK's value. A Pi measurement, as for any rendering change.
  - The UI: a point set over the image in the picker or the field, judged on the editor's portrait stage.

## Done when

- [x] Every template in `templates/` can be configured and previewed. `apps/cms/e2e/spots.spec.ts`, "every base template can be configured and previewed": for each seeded base template it makes a spot in the new-spot dialog, picks an image for each image field in the asset picker, waits for the player on the stage to say it plays, changes a text field and sees the change in the template's frame, and sees the draft saved. At a 1920x1200 window; see What is left for cstore-promo below half scale.
- [x] Server rejects data `validateSpotData` rejects. `create_spot` and `update_spot` check template data with the compiler's `spotProblems` (`validateSpotData`, brand tokens, the duration range) and refuse with `invalid_input` naming the field (`packages/tools/test/spots.test.ts`, "refuses data the contract refuses"); URL spots with `safeUrl`.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (packages/tools and packages/db READMEs, apps/cms README, docs/architecture.md, Content sources).

## First PR (2026-11-18)

Built:

- Tools `list_spots`, `get_spot`, `create_spot` (idempotent), `update_spot` (`ifVersion`; spots got a `row_version`), `get_spot_preview` (the template, brand kit and data sources a draft compiles against, built by the publish's own code).
- The Spots page and the editor (canvas board Spot editor A): a form made from the template's fields (text, number, boolean, colour as a brand colour or a custom one, select, image through the asset picker, list with `maxItems`), image and web-page spots (asset or https URL, fit, duration), and the stage: the real player build, served by the CMS at `/player/`, at the screen's true resolution with landscape/portrait, fit/100% and a brand-kit switcher, labelled "Draft. Not on any screen." The draft is compiled in the browser and posted 40 ms after a keystroke (measured in the e2e: the template's frame shows the new text about 60 ms after the fill, Playwright's polling included). While a field is invalid, the contract's message is under it, the stage keeps the last valid frame, and the draft is not saved. Drafts save a second after the last edit with `ifVersion`; a change made by someone else meanwhile shows "This changed since you opened it" with Reload.
- TanStack Query for these pages (src/queries/spots.ts), as docs/research/cms-data-layer.md decides.

What is left:

- **Binding a field to a data source** and **the sample-data switch**: no data-source tools exist yet (list them, read a snapshot for the live value). `update_spot` keeps a spot's bindings as they are.
- **Publish** in the editor (M3-18). The stage label and the disabled publish while a field is invalid come with it; the header says whether the spot is published.
- **cstore-promo on a small stage.** Below about half scale (a 1280 px window: the stage is at 27%) the player misses its 2 s ready timeout for cstore-promo, every retry, in Chromium headless and headed; at 100%, or at 60% and more, it plays. The other six templates play at any scale. Not the slot's 1 px gap (an 8 and a 12 px gap changed nothing) nor CSS `zoom` instead of `transform`. Likely the throttle M3-39 found (undrawn frames under the scaled layer); it needs a trace (`m39b-scripts/ptrace*.py`).
- **Focal point** for portrait crops (below).
- From the design review: the stage could take the full width of wide windows (the app shell caps pages at 72rem), stay in view while a long form scrolls (sticky), and the duration could have -/+ buttons.
