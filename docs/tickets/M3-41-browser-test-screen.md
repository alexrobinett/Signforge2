# M3-41 Browser test screen

Status: done (branch m3-41-browser-test-screen)  ·  Size: M  ·  Depends on: M3-08, M3-11

## Goal

A new org's first screen in under a minute, with no hardware: "Open a test screen" opens the player in a browser tab, which shows a pairing code, and the empty Screens page pairs it.

## Read first

- Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`. (Idea 10 · Empty fleet)
- docs/tickets/M3-08-pairing.md, packages/player/src/credential.ts

## Scope

- The player build served on the CMS host at a test-screen path, without a supervisor.
- Credential storage for a browser screen: no supervisor, so it lives in the browser (IndexedDB), and the screen is marked `kind: browser` on claim. Browser screens are labelled as test screens in the CMS, count towards the quota, and are revoked from the same page.
- Display power commands are ignored on a browser screen.

## Out of scope

- Kiosk mode for browsers.

## Done when

- [x] From an empty org, "Open a test screen", pair it, publish a spot, and see it play in the tab, in under a minute (Playwright). `apps/cms/e2e/test-screen.spec.ts`: from the click to the spot playing in the tab took 6.3 s locally (asserted under 60 s). It publishes through `/admin` as `sf push` does, since the CMS cannot publish until M3-18.
- [x] Revoking the browser screen wipes its credential and cache. The same e2e revokes it from its page and finds the IndexedDB credential and `sf-blobs-v1` empty, with a code shown; `packages/player/browser/browser-screen.test.ts` also checks it still pairs after a reload.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (docs/architecture.md "Browser test screen", docs/backend-plan.md pairing and route trees, apps/cms/README.md, packages/player/browser/README.md).
