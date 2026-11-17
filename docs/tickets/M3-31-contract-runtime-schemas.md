# M3-31 Contract runtime schemas

Status: open  ·  Size: M  ·  Depends on: nothing

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

- [ ] No validator throws on random input (property tests).
- [ ] Out-of-range numbers and oversize images are rejected with a clear problem.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
