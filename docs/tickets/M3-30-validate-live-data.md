# M3-30 Validate live data before it replaces fallbacks

Status: open  ·  Size: S  ·  Depends on: M3-26, M3-31

## Goal

Malformed live data must not replace a spot's valid fallback. Today a snapshot like `items: {}` replaces the static data, makes the news template throw, and survives offline because it is cached (Astra).

## Read first

- docs/reviews/2026-11-17-full-review.md (single-reviewer findings)
- packages/player/src/data.ts, packages/contract (`FieldDef`, `validateSpotData`)

## Scope

- Before a bound value replaces the static one, check it against the field's definition with the contract's runtime schema (M3-31). A value that fails is ignored for that spot, and the fallback is shown.
- A snapshot that fails for every spot bound to it is not cached as the latest.
- Count rejections per source (`__sf` now; heartbeat once M3-07 lands) so a broken feed is visible.
- The server applies the same check when it stores a snapshot (M3-23).

## Done when

- [ ] Browser tests: wrong type, wrong shape, too many list items and a missing path each leave the fallback on screen.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
