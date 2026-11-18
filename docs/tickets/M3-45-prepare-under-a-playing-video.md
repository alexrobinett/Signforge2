# M3-45 Prepare under a playing video

Status: open  ·  Size: S  ·  Depends on: M3-25

## Goal

Bring a spot's prepare back under the 500 ms budget when the spot on screen is a playing video. Measured with brand fonts on the Pi, news after video-pan prepares in 1.4–1.6 s; everywhere else it meets the budget (M3-25).

## Read first

- spike/pi-perf/RESULTS.md ("Slow prepares: the cause and the fix", and M3-25's section)
- docs/architecture.md (Playback: `kUndrawnFrameLimit` and the 1 px gap)
- ~/.signforge-agent-notes/M3-25.md and M3-39.md (measuring scripts and pitfalls)

## What is known

- The player keeps a 1 px column at the centre of each slot uncovered, so the loading spot underneath is drawn and Chromium does not throttle it to one BeginFrame a second (M3-39). A playing `<video>` is an opaque layer to Chromium and covers that column, so under video the loading frame is throttled again: about half of news's prepares waited about a second.
- Under a playing video, news's own in-frame work is also 2–3× slower than under the clock spot.
- Full stress playlist, 290 s runs, M3-25 build with kit fonts: news 1421–1622 ms on the first prepare after video, then about 550 ms; 2–4 of 36 prepares over 500 ms; overall drops 0.73–0.79%. Without a kit every prepare is in budget.

## Scope

- Measure `opacity: 0.999` on the video element (or its layer) as the fix for the throttle. A probe removed the stall (news 466–586 ms over 12 prepares), but its frame cost was not measured; M3-39 found the same trick on the whole playing slot cost 27% dropped frames while loading, so measure dropped frames during the video and during loads before adopting it. Other candidates are fine if they keep the loading frame drawn.
- Even without the stall, news is 470–590 ms under video: cut news's own work at prepare (fonts, layout, the fitting passes) until it is under budget with a kit.
- A browser test for whatever keeps the loading frame drawn under video, as M3-39 has for the gap.

## Out of scope

- Other templates' polish (M3-25).

## Done when

- [ ] On the Pi, full stress playlist with brand fonts: every prepare under 500 ms except any named and explained, nothing skipped, and dropped frames no worse than M3-25's numbers (`spike/pi-perf/RESULTS.md`).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
