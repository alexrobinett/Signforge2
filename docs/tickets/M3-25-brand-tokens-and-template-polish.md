# M3-25 Brand tokens and template polish

Status: done except the Pi box (branch m3-25-brand-tokens-polish): news with brand fonts under video is over budget, see Notes  ·  Size: L  ·  Depends on: M3-38, M3-39

## Goal

Move every template onto brand tokens (M3-38 and M3-39 build the kits and the player side), and in the same pass clear the remaining findings from the visual reviews, since both touch every template's CSS.

## Read first

- docs/proposals/brand-and-editor.md
- docs/template-spec.md
- scripts/spot-shots.ts (screenshots through the real player)

## Scope

- Every template's colours from `var(--sf-*)`, passing M3-39's lint; `accent` fields default to `$brand.accent`.
- Templates use the SDK's `now()` (M3-32) instead of `new Date()`.
- A new version number for every template that changes (the spec: any edit is a new version).
- Remaining findings from the second visual review (2026-11-17):
  - weather: snow and rain still cross the reading (dimmed); stop or mask the particle layer above the text. In landscape rain and snow leave the right half empty; the top-left cloud is clipped and near the city name.
  - cstore-promo: the portrait copy panel hugs the left edge (about 55 px left, 200 px right); fine print sits close under the bottles.
  - news: in portrait a long source label ("THE NEW YORK TIMES") takes about 40% of the ticker; ellipsis at a word boundary shows as " ...".
  - agenda: portrait leaves room for more rows than `rows` allows; fit as many as the space holds.
  - clock: a faint purple patch remains in the bottom-right corner.
- Transition drops have drifted since the spike: 2–4.4% during fades on 2026-11-17, against 1.5% in `spike/pi-perf/RESULTS.md`, with the previous player as well (M3-05 notes). Find out why before the token migration's Pi measurement, so a regression is not hidden by the drift.
- Prepare budget on the Pi (M3-39): news prepares in 455-517 ms with brand fonts against a 500 ms budget; bring it back under. video-pan prepares in about 900 ms in every build, fonts or not: find out why.
- Portrait crops of landscape media are soft: a per-asset focal point (`object-position`) and portrait renditions, with M3-14's media library.

## Out of scope

- The CMS editor (M3-16).

## Done when

- [x] Every template passes the token lint, at both orientations, in screenshots of `examples/stress` and `examples/live`, reviewed by an agent against this list. Lint: no warnings on any template (`packages/cli/test/templates.test.ts`, which also checks `$brand.*` colour defaults and no device clock). Screenshots through `scripts/spot-shots.ts`: both projects, both orientations, no kit and two kits, 312 frames per pass, no player error or skip. Two agent reviews against this list: the first failed brand legibility (light-kit sun and moon, a fixed mint accent, the cstore panel, photo copy backing) and those were fixed; the second passed every finding and failed light-kit cards (1.1:1) and a cloud touching the weather card, fixed afterwards and checked on re-shot frames (not reviewed a third time).
- [x] Two different brand kits applied to the same spots produce correct, legible screens (screenshots). A dark kit (teal, yellow, Montserrat/Inter, round) and a light kit (red, orange, Oswald/Atkinson Hyperlegible, square) on every stress and live spot, both orientations; second review: pass except the cards, since fixed. The light kit's Atkinson Hyperlegible draws slashed zeros by design.
- [ ] Pi measurement of the full stress playlist shows no regression against `spike/pi-perf/RESULTS.md`. **Met without a kit, not with brand fonts** (RESULTS.md, Brand tokens and template polish; 290 s runs, fade 600, interleaved). This branch without a kit: overall 0.60-0.75%, prepares over 500 ms 0-1/36 (m3-foundations: 0.58-0.70%, 3/36), median 254-265 ms, nothing skipped. With a kit whose fonts the templates use: overall 0.73-0.79% (under the 1% budget), nothing skipped, but prepares over 500 ms 2-4/36: news, loading under video-pan, 1421-1622 ms then 549-550 ms. Cause found, fix not made: see Notes.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Notes (M3-25, 2026-11-17)

- **Transition drift: not a regression.** The third round's own build (301eee9), rebuilt and run against today's on the same Pi, interleaved, drops 1.85, 3.86 and 3.24% during fades; today's 1.63, 3.06 and 1.93%. A transition phase is about 650 frames a run and one build spreads 1.6-3.9%; the spike's 1.5% was one run. Measure transitions over three or more interleaved runs. Also: `transition=fade` in a player URL is a 500 ms fade; `fade600` is 600 ms.
- **video-pan, 900 ms: fixed.** The player waited for `requestVideoFrameCallback` on a paused video that has never played; it never fires, so every video prepare waited out a 600 ms timer. A video spot is now ready at `canplaythrough`: 305-399 ms on the Pi, overall frames unchanged (`packages/player/browser/playback.test.ts`).
- **news, 455-517 ms: met without a kit (379-472 ms), not with brand fonts.** news loads while video-pan plays. Under a playing video its work in the frame is 2-3 times slower (fonts 94-168 ms against 34-54), and the opaque video layer covers the 1 px gap that keeps the slot underneath drawn (M3-39), so the news frame is throttled to one frame a second: in about half the prepares under video, `settle` took 1.0-1.1 s. **Next step, untested in full:** the video at `opacity: 0.999` (one blended layer, no render surface) removed the stall in one probe (news under video 466-586 ms against 471-1607 ms, 12 prepares each), but its cost in frames while the video plays was not measured, so it is not in this branch. news also needs less work to clear 500 ms under video: its crawl is measured over about 14,600 px of text.
- **Templates (all 1.2.0).** Colours from tokens: roles map to `--sf-*`, shades are the kit's background mixed with `transparent`, other colours are mixes of tokens whose fallbacks are the same literal (docs/template-spec.md, Colour lint). Headings in `--sf-font-display`, text in `--sf-font-body`. Accent fields default to `$brand.accent` (with no kit that resolves to `DEFAULT_BRAND_COLORS.accent`, #f59e0b). `now()` was already in every template; the test keeps it.
- **Findings fixed.** weather: the forecast on an opaque card in the kit's surface colour, so rain and snow never cross it; a large cloud takes the sun's place when the sky is covered; clouds start clear of the city name; on a light kit, clouds, rain, snow, sun and moon from the kit's background. Also PR #5's layer order (precipitation layers appended in a fixed order). cstore-promo: the portrait panel centred, bottles clear of the fine print, lines that are too wide set smaller, the badge primary with on-primary text. news: the source label capped and cut at a word; headlines end on a word and never on an opening quote or bracket (`fitWords` in the SDK); tabular figures only on the clock (they spaced hyphens out). agenda: as many rows as fit (`rows` is now an upper bound, 25). clock: the gradient from below the screen that left the corner patch is gone.
- **Portrait focal point: not done.** Portrait renditions exist (M3-14) and publish picks them. A per-asset focal point needs a contract change (spot assets carry it), a db column, a tool, the compiler and the SDK, and the library UI to set it; left for M3-14 and M3-16.
