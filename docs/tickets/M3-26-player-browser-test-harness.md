# M3-26 Player browser test harness

Status: done (branch t3/m3-26-player-browser-test-harness)  ·  Size: M  ·  Depends on: nothing

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
  On the Mac, yes: `pnpm test` runs `@signforge/player:test` (20 tests, about 10 s, headless Chromium through Playwright) and the CMS e2e as Turbo task `test:e2e`. Left unticked for CI, which does not exist yet: M3-37 must add `pnpm --filter @signforge/player exec playwright install chromium` (and the same for `@signforge/cms`) before `pnpm test`.
- [x] Each first test above fails when the behaviour it covers is broken by hand (checked once, noted in the PR).
  Checked on 2026-11-17, one mutation at a time, each restored after: calling `sequencer.next` twice per step (loop test fails); `prepareStep` returning true on error (throw test fails); `await work` without the ready timeout (never-ready test fails); the stall timer not aborting (stall test fails); the 304 branch removed (304 test fails); the SDK not pausing animations before ready (SDK lifecycle test fails); the SDK not awaiting `prepare` (SDK error and never-ready tests fail).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Both pass at the root (21 test tasks). New `packages/player/browser/README.md`; `apps/cms/README.md` says the e2e joins the root run; `?stall=` documented in `src/main.ts`.

## Notes

- There is no `done` message in frame protocol 1, so the SDK tests cover `loaded`, `init`, `ready`, `error` and `play`.
- New player option `?stall=<seconds>` (and `SyncOptions.stallMs`) so the stall test takes 1 s, not 30.
- The CMS e2e uses fixed ports (8797, 3997): two checkouts running `pnpm test` at once will collide.
