# M3-38 Brand kits

Status: open  ·  Size: M  ·  Depends on: M3-32, M3-33, M3-34

## Goal

An org keeps several brand kits (colours, fonts, logo) and the compiler applies the right one to each screen, frozen at publish. Owner decisions, 2026-11-17: three layers (brand kit, style fields, forked templates); several brands per org; curated fonts now, custom fonts later.

## Read first

- docs/proposals/brand-and-editor.md (the model and the decisions)
- docs/reviews/2026-11-17-full-review.md (proposal section)
- packages/compiler/src/index.ts, packages/db

## Scope

- **Data:** a `brand_kits` table (org scoped, through `scoped(db, orgId)`): name, colours, display and body font, logo assets, shape. One kit is the org default.
- **Which kit a screen gets:** the screen's own choice, else its group's, else the org default. A screen in two groups with different kits and no choice of its own is a publish problem for that screen, so the conflict is explicit.
- **Fonts catalogue:** fonts are referenced by id from a catalogue with an owner, like templates. `base` holds the curated set (licensed open fonts, WOFF2, a size cap of about 150 kB per family). The id format leaves room for org-owned uploads later without a migration; uploads are out of scope.
- **Tokens:** template fields may default to a token (`"$brand.accent"`). The compiler resolves tokens into ordinary field values, so the screen receives values only; a spot's override is just a field value. One theme path.
- **Frozen at publish:** editing a kit changes nothing on screens until the next publish; the CMS shows which screens a kit's edits will reach.
- **Contrast:** `on*` colours derived for 4.5:1 unless set by hand; pairs that fail are warnings.
- A `brand` tool group in the registry (list, create, update, set default, assign to screen or group), with output schemas and paging (M3-35).

## Out of scope

- Template migration to tokens (M3-25), fonts in the player (M3-39), the CMS screens (M3-40).
- Font uploads; re-theming the CMS by tenant brand.

## Done when

- [ ] Compiler tests: two kits, two screens, the same spots compile to different values; a group conflict is reported for that screen only.
- [ ] Test: editing a kit leaves the stored manifests unchanged until publish.
- [ ] The generated isolation test covers the new tools.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
