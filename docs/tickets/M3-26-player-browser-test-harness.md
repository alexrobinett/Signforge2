# M3-26 Player browser test harness

Status: open  ·  Size: M  ·  Depends on: nothing

## Goal

Test the player where it can break: in a real browser. Today the playback loop, slots, data loop, template SDK, iframe lifecycle and service worker have no tests (review A7), and the resilience tickets after this one need somewhere to put theirs.

## Read first

- docs/reviews/2026-11-17-full-review.md (A7)
- packages/player/src/main.ts, slot.ts, data.ts, store.ts
- packages/template-sdk
- scripts/spot-shots.ts (already drives Chromium over CDP; reuse its approach or switch to Vitest browser mode)

## Scope

- A browser test runner for `packages/player` and `packages/template-sdk`, run headless in `pnpm test` and in Turbo.
- A fixture server that serves a built player plus a content directory, and can fail, stall or change content on command.
- First tests:
  - a playlist of two spots plays in order and loops;
  - a spot whose template throws in `prepare` is skipped and the next one plays;
  - a stalled download is abandoned after the stall timeout;
  - a 304 manifest poll changes nothing;
  - the SDK's `ready` / `done` lifecycle, including a template that never reports ready.
- The CMS end-to-end test joins the root test run, or the reason it cannot is written in the README.

## Out of scope

- The fixes in M3-27 to M3-30; they add their own tests here.
- Pi measurement.

## Done when

- [ ] `pnpm test` runs the browser tests headless on the Mac and in CI (M3-37).
- [ ] Each first test above fails when the behaviour it covers is broken by hand (checked once, noted in the PR).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
