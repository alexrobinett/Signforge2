# M3-40 CMS: brand kits

Status: open  ·  Size: S  ·  Depends on: M3-38, M3-36, the chosen CMS design

## Goal

Create and edit brand kits in the CMS, and see them on real templates while editing.

## Read first

- The chosen concepts on the CMS design canvas
- docs/tickets/M3-38-brand-kits.md

## Scope

- List, create, edit, duplicate and set the default kit; assign kits to screens and groups.
- Colour pickers with live contrast checks; a curated font picker with samples; logo upload (light and dark) through the asset library.
- A preview strip of two or three templates themed by the kit, through the real player (M3-36).
- "Edits reach these screens at the next publish."

- **From the design canvas (2026-11-17).** Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`. Picking a colour re-themes the org's own spots live, through `PlayerStage`, with a contrast verdict (word, not colour) beside every pair and a one-click fix. "Affects N spots on M screens" (M3-38's `reach`) sits beside Publish. Fonts are only the six in the catalogue.


## Done when

- [ ] A kit can be made, assigned to a group, published, and seen on the Pi.
- [ ] Playwright test of the kit flow, in the root test run.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
