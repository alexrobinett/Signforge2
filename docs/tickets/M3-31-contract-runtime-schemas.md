# M3-31 Contract runtime schemas

Status: done (branch m3-31-runtime-schemas)  ·  Size: M  ·  Depends on: nothing

## Goal

Runtime checks as strong as the types, in one place. Today malformed input can throw, number `min`/`max` are ignored, and validation sits in `player-core` although the server imports it (review A5). Also close the image decode budget gap (Astra).

## Read first

- docs/reviews/2026-11-17-full-review.md (A5, decode budget)
- packages/contract/src/index.ts, packages/player-core/src/index.ts (`validateManifest`, `validateSpotData` callers)
- packages/media/src/image-info.ts

## Scope

- One contract commit:
  - runtime validators for every shape a screen or tool receives (manifest, spot data per field type, snapshots, device API bodies), total over any JSON input: they return problems, never throw;
  - number `min`, `max` and `step` enforced; list `maxItems` enforced;
  - a decoded-pixel cap (`width × height`) alongside the per-side box, so a 65,535 × 1,080 PNG is refused at upload.
- `player-core` keeps playback logic; validation moves to the contract and `player-core` re-exports it during the move.
- Property-based tests (fast-check or similar) that feed random JSON to every validator.

## Out of scope

- New shapes (M3-32).

## Done when

- [x] No validator throws on random input (property tests). `packages/contract/src/validate.test.ts`: each of the eleven validators gets 1,000 random JSON values and 1,000 valid values with one part, at any depth, replaced or removed; `validateSpotData` also gets 500 random four-argument calls. Run against the old player-core `validateManifest`, the same test fails on its first counterexample (`html: null` throws).
- [x] Out-of-range numbers and oversize images are rejected with a clear problem. Contract tests: `field "price" must be at least 0` / `at most 100` / `a multiple of 0.5`, list `has more than 2 rows`; `imageSizeProblem(65535, 1080)` gives `65535x1080 is 70.8 million pixels; a screen decodes at most 8.3 million (3840x2160)`. Tools test: `create_asset_upload` refuses that strip with the same message on `renditions.landscape`; `finalize_asset` runs the same check on the bytes.
- [x] `pnpm typecheck` and `pnpm test` pass (20/20 and 21/21 turbo tasks, after merging `m3-foundations`). Docs: `docs/template-spec.md` (number `min`/`max`/`step`, enforced), `packages/tools/README.md`, `packages/media/README.md`, M3-28's read-first list.

## Notes

- Validators live in `packages/contract/src/validate.ts`, re-exported from the contract's index. `player-core` re-exports `validateManifest`, `displayHoursProblems`, `validTimezone`, `safeUrl` and `requiredFiles` for now; every caller in the repo already imports them from the contract, and the API, compiler and tools no longer depend on `player-core`.
- `validateManifest` is stricter: it requires `generatedAt`, `screen.id`, `screen.name` and `screen.orientation`, checks each template manifest in full, and checks each template spot's data and duration against its template.
- The pixel cap is 3840x2160 (8.3 million pixels, about 33 MB decoded). A 16:9 to 2:1 photo, cover-scaled for either box, fits; a 21:9 panorama scaled for portrait (4480x1920) does not, and must be cropped.
- The player now drops a data snapshot that fails `validateDataSnapshot` or names another source, keeping the last good one. Checking bound values against the field is M3-30.
- No Pi measurement: nothing here changes rendering.
