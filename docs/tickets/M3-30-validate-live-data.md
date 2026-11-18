# M3-30 Validate live data before it replaces fallbacks

Status: done (branch t3/m3-30-validate-live-data)  ·  Size: S  ·  Depends on: M3-26, M3-31

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

## Notes

- **Server half is M3-23's.** No snapshot store exists yet. The contract exports the check for it: `readPath(data, path)` and `validateBoundValue(fields, fieldName, value)` in `packages/contract/src/validate.ts`. M3-23 should, for each spot bound to the source, run `validateBoundValue(fields, name, readPath(snapshot.data, binding.path))`, and refuse to store a snapshot that fits none of them, as `snapshotFit` in `packages/player-core` does on the screen.
- **Heartbeat half is M3-07's.** The player counts refusals in `dataRejections()` (`packages/player/src/data.ts`), shown as `__sf.dataRejected` and on the debug HUD. M3-07 should report it in the heartbeat.
- A snapshot is kept when it fills at least one bound field in the current manifest, or no spot binds to it. A partly valid snapshot is kept; its bad values fall back per spot at play time.
- The count is per refusal: each bound value refused when a spot starts, and each snapshot refused as a whole (malformed, or fits no bound field). The console logs each distinct problem once.
- `readPath` moved from `player-core` to the contract, and now reads own keys only (`constructor` or an array's `length` read as missing).

## Done when

- [x] Browser tests: wrong type, wrong shape, too many list items and a missing path each leave the fallback on screen. `packages/player/browser/data.test.ts`, 6 tests, also covering a snapshot that fits nothing not being kept in memory or on disk. Broken by hand: skipping the per-field check fails the 4 fallback tests (the `{}` case makes the template throw and the spot is skipped); skipping the whole-snapshot check fails the caching test.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated: `docs/template-spec.md` (Live data), `docs/architecture.md` (data snapshots), `packages/player/browser/README.md`.
