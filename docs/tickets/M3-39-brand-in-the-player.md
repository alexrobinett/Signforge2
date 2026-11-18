# M3-39 Brand in the player and SDK

Status: done (branch m3-39-brand-in-player); slow prepares found and fixed (branch m3-39b-brand-font-cost); frame trade accepted 2026-11-17  ·  Size: M  ·  Depends on: M3-32, M3-28, M3-38

## Goal

Templates draw with the brand: tokens as CSS custom properties, brand fonts and the logo. The proposal said "player unchanged"; that was wrong, since Blob URLs do not reach an opaque-origin frame (review, proposal point 5).

## Read first

- docs/proposals/brand-and-editor.md, packages/template-sdk, packages/player/src/slot.ts

## Scope

- The player passes `theme` in `init` (protocol 2), with fonts and logo as Blobs like `assets`.
- The SDK applies the theme before `prepare`: `--sf-primary`, `--sf-accent`, `--sf-bg`, `--sf-surface`, `--sf-text`, `--sf-muted`, `--sf-radius`, `--sf-font-display`, `--sf-font-body`; `@font-face` per brand font (the template CSP allows `blob:` fonts); `data-sf-src="$brand.logo"` gets the logo. `settle()` waits for the fonts.
- The token lint in `sf build` and the server template check: colours come from `var(--sf-*)` or are built on them; a literal outside a `var()` fallback is a warning, not a failure (shadows, scrims and weather use literals legitimately).

## Done when

- [x] Browser test: a template using every token and a brand font renders with the brand values, and with its fallbacks when no theme is sent. `packages/player/browser/brand.test.ts`: every `--sf-*` colour, the radius per shape, both catalogue fonts (Oswald, Inter) loaded before ready, the logo by background; the same template with no kit draws every fallback; a template that never uses a brand font loads none; an SDK reset removes the theme. Breaking the player (no `theme` in init) fails three tests, breaking the reset cleanup or the use check fails one each.
- [x] A brand font adds no more than the prepare budget on the Pi (measured). **Measured, not met for every template** (`spike/pi-perf/RESULTS.md`, Brand fonts). The full stress playlist does not regress in frames (0.32% dropped with brand fonts against 0.34 to 0.54% plain, no stall of 150 ms or more, nothing skipped). A kit costs today's templates nothing (prepare median 256-259 ms against 247-260 ms). Decoding is 14 ms for six files. With the templates drawing in the brand fonts, most prepares grow 30 to 100 ms and stay inside 500 ms, but cstore-promo (235 to 1138 ms), news (467 to 1076 ms) and photo-promo over a 4K photo (about 300 to 515-690 ms) go over. That must be found and fixed before M3-25 moves those templates onto the brand fonts. **Found and fixed (branch m3-39b-brand-font-cost; RESULTS.md, Slow prepares):** two Chromium mechanisms, not the fonts themselves: a new frame's layers tiled at 0x0 kept 32x256 tiles (a 4K photo then rastered as ~700 tiles, a second of GPU), and viz throttles a frame with more than 3 undrawn frames to one BeginFrame a second, which a spot loading under an opaque one always was. The SDK now keeps the document hidden until the first init has the frame's size, and the black behind a spot leaves a 1 px column at the centre so the spot underneath is drawn. With brand fonts on the full stress playlist: prepares over 500 ms 2-3/35 (video-pan, over in every build, and news 517 ms once) against 7-10/34, slowest 908 ms (video-pan) against 1513, nothing skipped against 2, median 314-329 ms. Left open because of the cost: loads now run at full rate, so the spot on screen drops about 2 frames per load instead of 1 (overall 0.64-0.82% against 0.42-0.52%, still under 1%; no frame of 150 ms or more; worst 67 ms in both builds). Whether that trade is right is the owner's call; the news template's 455-517 ms is the closest to the budget. **Decided 2026-11-17 (owner delegated the call): accept.** Skipped spots went from 2 per run to 0 and the slowest prepare from 1513 to 908 ms; the cost is about one more dropped frame per load, overall still under the 1% budget with the worst frame unchanged at 67 ms. A skipped spot is visible to a customer; one extra dropped frame during a load is not. The news template's margin is M3-25's to win back, and video-pan (about 900 ms in every build) is its own follow-up.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated. Run on the branch after merging `m3-foundations`. Docs: template-spec (Brand, lint, budget), architecture (Player, Brand), backend-plan (seed pushes fonts), the brand proposal's status, fonts/README.md, the player harness README.

## Notes from the build

- The curated fonts' WOFF2 files are in `fonts/` (latin, the catalogue's weights, with OFL texts and sizes). `sf fonts push` uploads them, and so does `sf template seed`. The device and preview blob routes serve them from `sys/b/`.
- Fonts reach the frame as Blobs and become `@font-face` rules with `data:` URLs, so the template CSP did not need `blob:` fonts. Faces built from bytes were measured worse on the Pi; see RESULTS.md.
- The colour lint is in the contract (`brandColourWarnings`). Its warnings are kept on the check report (`warnings`) and do not fail a build.
- Owner decision flagged in `fonts/README.md`: Source Sans 3 and Playfair Display have Reserved Font Names, and the files are subsets. Decided 2026-11-17: both dropped (a subset may not carry a reserved name, and the unsubset files break the 150 kB budget); the catalogue has six fonts. A serif without a reserved name is a follow-up.

