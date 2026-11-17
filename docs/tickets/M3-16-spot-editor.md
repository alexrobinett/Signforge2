# M3-16 Spot editor

Status: open  ·  Size: L  ·  Depends on: M3-14, M3-15, M3-13

## Goal

Create and edit spots with a form generated from the template's fields and a live preview using the real player.

## Read first

- packages/contract (FieldDef, validateSpotData)
- packages/player (preview runs the real build)

## Scope

- Form generated from `TemplateManifest.fields`: text, number, boolean, color, select, image (asset picker), list (repeating rows, `maxItems`).
- Binding a field to a data source and path, with the static value kept as fallback.
- Preview: the player build in an iframe, playing this one spot at landscape and portrait sizes, updating as the form changes.
- Image, video and URL spots: file or URL plus fit and duration. URL spots validated with `safeUrl`.

## Out of scope

- Playlists.

## Done when

- [ ] Every template in `templates/` can be configured and previewed.
- [ ] Server rejects data `validateSpotData` rejects.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
