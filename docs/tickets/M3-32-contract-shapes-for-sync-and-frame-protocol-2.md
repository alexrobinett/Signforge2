# M3-32 Contract shapes for sync and frame protocol 2

Status: open  ·  Size: M  ·  Depends on: M3-31

## Goal

Add the shapes M3-06 to M3-08, the editor and brand kits need, in one contract commit, so those tickets do not each change the contract (review A6).

## Read first

- docs/reviews/2026-11-17-full-review.md (A6, proposal section)
- docs/proposals/brand-and-editor.md (decisions)
- packages/contract/src/index.ts, packages/template-sdk

## Scope

- **Snapshots** carry a `version`, so a screen can tell an older snapshot from a newer one.
- **A clock in `init`**: the server-corrected time and its offset, and an SDK `now()` templates use instead of `new Date()`. Templates move to it (the clock, agenda and news use the time).
- **Sync recovery**: a `seq` epoch, so a screen that loses its counter (re-image, no RTC) and the server agree on a reset; what a screen does when its clock is wildly wrong.
- **Takeovers** expire at an absolute time, not a duration.
- **Frame protocol 2**:
  - `theme` in `init` (the resolved brand tokens; fonts and logo passed as Blobs the way `assets` are);
  - a defined update lifecycle for the editor: the player reloads the template frame on a debounce, or sends `reset` and the SDK restores a clean document before `init`. Choose one and test it against every template (lists must not append twice, weather must not stack effects);
  - `SUPPORTED_PROTOCOLS = [1, 2]`; protocol-1 bundles keep working.
- `MANIFEST_SCHEMA` 3 if the manifest changes, relying on M3-28's N−1 support.

## Out of scope

- `seek`, `field-clicked` and `notice` (cut from v1 of the editor).
- Building the sync endpoint, socket or brand kits; only their shapes.

## Done when

- [ ] Contract tests cover each new shape; golden output updated.
- [ ] Every template passes the update-lifecycle test (an `init` with new data after the first leaves the same DOM as a fresh load).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
