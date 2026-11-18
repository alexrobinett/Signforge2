# M3-28 Last known good

Status: done (branch t3/m3-28-last-known-good)  ·  Size: M  ·  Depends on: M3-26

## Goal

A screen that was playing keeps playing. Two ways it can go blank today:

- A player update drops the cached manifest if the newer validator rejects it, and only schema 2 is supported, so an offline screen updated to a stricter player shows nothing (Fable).
- A manifest that validates but whose spots all fail leaves "Content is unavailable" until someone republishes (Fable).

## Read first

- docs/reviews/2026-11-17-full-review.md (single-reviewer findings)
- packages/player/src/store.ts (`loadActiveManifest`, `sync`)
- packages/contract (`validateManifest`, `SUPPORTED_MANIFEST_SCHEMAS`; validation moved there from player-core in M3-31)

## Scope

- Keep the last manifest that played at least one spot, with its files, until a newer one has played a spot.
- When a new manifest is active but nothing in it plays for one full playlist pass, fall back to the last known good one and report it (heartbeat field once M3-07 lands; `__sf` until then).
- The player supports the previous manifest schema as well as the current one. Write down the rule in `docs/architecture.md`: a player release supports schema N and N−1.
- A cached manifest the new validator rejects is kept as a fallback when it was valid for the player that stored it, rather than deleted.

## Out of scope

- Player releases themselves (M3-24).

## Done when

- [x] Browser tests: a manifest whose spots all fail falls back to the last good one; a cached schema N−1 manifest still plays after an update; a corrupt cached manifest does not crash the player.
  Evidence: `packages/player/browser/last-known-good.test.ts` (6 tests: fallback, then a restart online (the last good files survive the sync that runs first) and one with the content server failing; a new manifest that plays one spot becomes last good; cached schema 1 plays after a restart offline; a cached manifest this release rejects still plays; a torn cached manifest falls back to the last good one; `null` in both slots shows "Waiting for content" with no page error). A store unit test covers the damaged-copy 304 path. The last good manifest's files are pinned through M3-29's `PinSet` (holder `last-good`). Breaking each behaviour by hand (no fallback, no pinning, strict load, no JSON guard) fails a test.
- [x] On the Pi, offline: publishing a manifest with a broken template, then cutting the network, leaves the previous content on screen.
  Evidence (2026-11-17, Pi 400, local config, demo content `c43b4aa8`): published `1fc2e5b9`, whose only spot's template never reports ready. The player skipped it once and fell back in about 12 s (`__sf.fallback = 1fc2e5b9`, playing `c43b4aa8`). With the content server stopped, it kept playing (`online: false`). With the content gone and the kiosk restarted, it loaded the broken manifest, skipped once, fell back and played the demo (screenshot: HUD `OFFLINE`, "Fresh coffee", 0.08% dropped). Rendering code is unchanged, so no `isolate.py` run.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Evidence: both pass after merging `m3-foundations`; `docs/architecture.md` (schema N and N−1, last known good) and the contract's versioning note are updated.
