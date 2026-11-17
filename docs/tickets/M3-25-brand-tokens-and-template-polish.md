# M3-25 Brand tokens and template polish

Status: open  ·  Size: L  ·  Depends on: the owner's decisions in `docs/proposals/brand-and-editor.md`

## Goal

Move every template onto brand tokens, as the proposal describes, and in the same pass clear the remaining findings from the visual reviews, since both touch every template's CSS.

## Read first

- docs/proposals/brand-and-editor.md
- docs/template-spec.md
- scripts/spot-shots.ts (screenshots through the real player)

## Scope

- Contract and SDK changes from the proposal (brand kit, token defaults, `theme` in `init`), contract first in its own commit.
- Every template's colours from `var(--sf-*)`; the lint from the proposal in `sf build` and the server check.
- A new version number for every template that changes (the spec: any edit is a new version).
- Remaining findings from the second visual review (2026-11-17):
  - weather: snow and rain still cross the reading (dimmed); stop or mask the particle layer above the text. In landscape rain and snow leave the right half empty; the top-left cloud is clipped and near the city name.
  - cstore-promo: the portrait copy panel hugs the left edge (about 55 px left, 200 px right); fine print sits close under the bottles.
  - news: in portrait a long source label ("THE NEW YORK TIMES") takes about 40% of the ticker; ellipsis at a word boundary shows as " ...".
  - agenda: portrait leaves room for more rows than `rows` allows; fit as many as the space holds.
  - clock: a faint purple patch remains in the bottom-right corner.
- Transition drops have drifted since the spike: 2–4.4% during fades on 2026-11-17, against 1.5% in `spike/pi-perf/RESULTS.md`, with the previous player as well (M3-05 notes). Find out why before the token migration's Pi measurement, so a regression is not hidden by the drift.
- Portrait crops of landscape media are soft: a per-asset focal point (`object-position`) and portrait renditions, with M3-14's media library.

## Out of scope

- The CMS editor (M3-16).

## Done when

- [ ] Every template passes the token lint, at both orientations, in screenshots of `examples/stress` and `examples/live`, reviewed by an agent against this list.
- [ ] Two different brand kits applied to the same spots produce correct, legible screens (screenshots).
- [ ] Pi measurement of the full stress playlist shows no regression against `spike/pi-perf/RESULTS.md`.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
