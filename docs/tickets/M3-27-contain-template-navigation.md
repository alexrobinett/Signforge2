# M3-27 Contain template navigation

Status: open  ·  Size: M  ·  Depends on: M3-26

## Goal

A template must not reach the network by navigating its own frame. Today the CSP is a meta tag in the srcdoc, so it dies with the document, and the second-`load` check fires too late or not at all (review A1; high before agent-written templates).

## Read first

- docs/reviews/2026-11-17-full-review.md (A1)
- packages/player/src/slot.ts (srcdoc and CSP, about line 118; the load handlers)
- docs/template-spec.md (the no-network rule)

## Scope

- Run each template inside a same-origin wrapper frame whose policy forbids navigation away and nested framing (Fable's suggestion: a wrapper document with `frame-src 'none'` and a CSP the template cannot replace). Compare it with the alternatives (`sandbox` without `allow-top-navigation`, a CSP header from the service worker) and record the choice in `docs/architecture.md`.
- Hostile templates as browser tests: `location = 'https://…'`, `<meta http-equiv=refresh>`, form submit, `window.open`, a link click, `<iframe src>`, `fetch`, image and font loads. None may make a request; the spot fails and the next one plays.
- The wrapper must keep the opaque origin that stops templates reading the player's storage.

## Out of scope

- URL spots (they are other origins by design).

## Done when

- [ ] Every hostile-template test passes, and fails against the current `slot.ts`.
- [ ] The full stress playlist on the Pi shows no regression against `spike/pi-perf/RESULTS.md` (the wrapper adds a frame).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
