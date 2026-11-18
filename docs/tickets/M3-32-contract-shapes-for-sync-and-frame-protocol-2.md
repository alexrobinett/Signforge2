# M3-32 Contract shapes for sync and frame protocol 2

Status: done (branch t3/m3-32-contract-shapes-sync-frame)  ·  Size: M  ·  Depends on: M3-31

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

- [x] Contract tests cover each new shape; golden output updated. `packages/contract/src/validate.test.ts`: snapshot `version`, sync `epoch` and `clock` both ways, `startsAt`/`endsAt`, `BrandKit` (`validateBrandKit`, its files in `requiredFiles` and checked against `files`), schema 3 with schema 2 still valid, protocols 1 and 2 accepted and 3 refused; each new validator is in the random-JSON table. `packages/cli/test/golden/*.json`: schema 3, templates at 1.1.0 with protocol 2.
- [x] Every template passes the update-lifecycle test (an `init` with new data after the first leaves the same DOM as a fresh load). `packages/player/browser/templates.test.ts`, all seven, both with `reset` and with a bare second `init`. Breaking the SDK's restore by hand fails agenda, menu-board, news and weather.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (`architecture.md` clock and seq rules and takeovers, `template-spec.md` lifecycle and `now()`, `backend-plan.md`, the browser test README).

## What was built

- **Update lifecycle: SDK `reset`.** The player sends `reset`; the SDK stops the template, cancels animations, revokes image URLs, restores the document as it loaded (body and root attributes), and answers `loaded`; the normal `init` follows. A bare second `init` does the same. Chosen over a frame reload because it keeps the frame (fonts parsed, no blank) and still guarantees a clean document. Protocol-1 bundles have no `reset`: the player reloads their frame (M3-36 builds the player side).
- **Clock in `init`** (`clock: { now, offsetMs }`) and SDK `now()`; clock, agenda and news use it. The player sends offset 0 until M3-07 keeps one.
- **Theme in `init`** (`FrameTheme`, fonts and logo as Blobs) and the manifest's `BrandKit`, `BRAND_COLORS`, `BRAND_CSS_VARS`, `BRAND_TOKEN`. Shapes only: the compiler (M3-38) and SDK (M3-39) use them.
- **Manifest schema 3** (`brand`, `ScheduleEntry.startsAt`/`endsAt`); `SUPPORTED_MANIFEST_SCHEMAS = [2, 3]`. `resolvePlaylist` honours the bounds and skips bounded entries on an untrusted clock.
- All seven templates are now 1.1.0 (protocol 2). Rendering is unchanged (the SDK clones the body once per init, and templates only swap `new Date()` for `now()`), so no Pi measurement was taken.
