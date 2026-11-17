# M3-16 Spot editor

Status: open  ·  Size: L  ·  Depends on: M3-14, M3-15, M3-13, M3-34, M3-36, M3-38

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

## Out of scope

- Playlists.
- Timeline scrubbing (`seek`), click-to-edit (`field-clicked`) and template notices (`notice`): later, after v1 (owner decision 2026-11-17).

## Done when

- [ ] Every template in `templates/` can be configured and previewed.
- [ ] Server rejects data `validateSpotData` rejects.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
