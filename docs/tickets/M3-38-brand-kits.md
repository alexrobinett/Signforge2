# M3-38 Brand kits

Status: done (branch t3/m3-38-brand-kits)  ·  Size: M  ·  Depends on: M3-32, M3-33, M3-34

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

- [x] Compiler tests: two kits, two screens, the same spots compile to different values; a group conflict is reported for that screen only. `packages/compiler/test/brand.test.ts` ("compiles the same spots to different values on two screens with two kits…", "reports two groups with different kits as a problem for that screen only"); through the database in `packages/tools/test/brand.test.ts` ("assigns kits to screens and groups, and a group conflict shows on that screen only").
- [x] Test: editing a kit leaves the stored manifests unchanged until publish. `packages/tools/test/brand.test.ts`, "leaves stored manifests unchanged when a kit is edited, until the next publish".
- [x] The generated isolation test covers the new tools. `packages/tools/test/isolation.test.ts` runs all seven brand tools (`brandKit` and logo ids mapped to org A's rows; font ids are shared catalogue ids) and checks org A's kits and assignments are unchanged; `write-guard.test.ts` covers the five that write; `packages/db/test/isolation.test.ts` covers `brandKits`.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated: `docs/backend-plan.md` (data model, Brand kits), `docs/template-spec.md` (token defaults), `packages/db/README.md`, `packages/tools/README.md`.

## Notes (M3-38)

- No contract change was needed: `BrandKit`, `BrandFont`, `BRAND_TOKEN` came with M3-32.
- **Ids.** `brand_kits` is keyed `(org_id, id)` and its ids are always the server's (`bk_…`); a caller's `id` is ignored. Choices live in `brand_assignments` (target `org` for the default, `group`, `screen`), not in new columns: adding a composite foreign key to `screens`, `screen_groups` or `org_settings` would rebuild those tables.
- **Fonts.** Eight OFL-1.1 fonts (six since 2026-11-17: Source Sans 3 and Playfair Display dropped for their Reserved Font Names, see `fonts/README.md`) in `packages/compiler/src/fonts.ts`, each with its copyright line and source: Inter, Atkinson Hyperlegible, Source Sans 3, Archivo, Montserrat, Oswald, Bebas Neue, Playfair Display. Their WOFF2 files are a follow-up: until each entry's `files` is filled, a kit's font is left out of the manifest and `list_fonts` says `available: false`.
- **No kit:** token defaults take `DEFAULT_BRAND_COLORS` and the manifest has no `brand`.
- Not built (not asked): deleting a kit. `delete_asset` now refuses an asset a kit uses as its logo.
