# M3-28 Last known good

Status: open  ·  Size: M  ·  Depends on: M3-26

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

- [ ] Browser tests: a manifest whose spots all fail falls back to the last good one; a cached schema N−1 manifest still plays after an update; a corrupt cached manifest does not crash the player.
- [ ] On the Pi, offline: publishing a manifest with a broken template, then cutting the network, leaves the previous content on screen.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
