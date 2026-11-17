# M3-27 Contain template navigation

Status: done (branch m3-27-contain-template-navigation)  ·  Size: M  ·  Depends on: M3-26

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

- [x] Every hostile-template test passes, and fails against the current `slot.ts`. `packages/player/browser/containment.test.ts`, 13 tests, all pass. Against the old `slot.ts`, the five navigation tests fail: `navigate`, `refresh`, `link` and navigate-while-playing each made a request to the server, and `navigate-data` was only caught by the 2 s ready timeout. The other eight (`navigate-top`, `form`, `open`, `iframe`, `fetch`, `image`, `font`, opaque origin) also pass against the old `slot.ts`, because the sandbox and the template's own policy already stopped them. They stay as guards: with the wrapper's policy removed, `iframe`, `fetch`, `image` and `font` fail too, because the template now relies on the policy it inherits from the wrapper.
- [x] The full stress playlist on the Pi shows no regression against `spike/pi-perf/RESULTS.md` (the wrapper adds a frame). Numbers are in RESULTS.md, "The template wrapper frame". With cuts: 0.12% dropped frames overall both with and without the wrapper. With fades, three runs each: 0.33 to 0.46% with the wrapper against 0.28 to 0.74% without, and no spot skipped. One caveat: during the fade itself, drops were 4.0 to 5.6% with the wrapper against 2.6 to 4.5% without. The ranges overlap, so this may be noise.
- [x] `pnpm typecheck` and `pnpm test` pass after merging `m3-foundations` (20/20 typecheck tasks, 22/22 test tasks, player 39 tests). Updated: `docs/architecture.md` (Template containment, with the alternatives), `docs/template-spec.md`, `packages/player/browser/README.md`, `spike/pi-perf/RESULTS.md`.
