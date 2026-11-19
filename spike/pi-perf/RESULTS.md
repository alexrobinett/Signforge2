# Pi spike results (Milestone 1)

Measured 2026-11-16 on a Raspberry Pi 400 (Pi 4 class, 4 GB, 1.8 GHz, not overclocked) driving a 4K LG monitor.

- OS: Raspberry Pi OS Lite 64-bit, 2026-10-06 (Trixie), kernel 6.18
- Browser: Chromium 156 in kiosk mode under cage 0.3.1 (Wayland), default flags
- GPU compositing and GPU rasterization both reported enabled
- Content: the C-Store promo rebuilt under the template contract, in a sandboxed frame, looping an 8 s cycle
- Each run: 20 s of frame timing taken with `requestAnimationFrame` inside the template frame

Raw data is in `results/`.

## Frame pacing inside the template

| Mode | Variant | fps | Dropped frames | CPU busy (4 cores) |
| --- | --- | --- | --- | --- |
| 1080p 60 Hz | compositor (transform and opacity only) | 59.7 | 0.5% | 25% |
| 1080p 60 Hz | compositor, no sandbox | 59.9 | 0.2% | 27% |
| 1080p 60 Hz | filter (blur, drop-shadow, backdrop-filter) | 37.4 | runs at half rate | 27% |
| 1080p 60 Hz | layout (animating position and font size) | 57.6 | 4.0% | 49% |
| 4K 30 Hz | compositor | 23.5 to 25.2 | 16 to 22% | 19 to 23% |
| 4K 30 Hz | compositor, no sandbox | 21.0 | 30% | 19% |
| 4K 30 Hz | filter | 9.0 | runs at a third of rate | 12% |
| 4K 60 Hz | compositor | 12.6 | 33%, stalls up to 4.5 s | 52% |
| 4K 60 Hz | filter | 2.0 | 81%, stalls up to 7.7 s | 38% |

Time from load to the template reporting ready was 100 to 230 ms in every run. Peak temperature was 57.9 C with no throttling at any point.

## Second round: which effects cost what (1080p 60 Hz)

The first round bundled three effects into one "filter" variant. Measured separately:

| What was added to the base animation | fps | Dropped frames |
| --- | --- | --- |
| Nothing (transform and opacity only) | 59.7 | 0.5% |
| Drop shadow on a moving element | 59.8 | 0.4% |
| Blur on a moving element | 59.8 | 0.4% |
| Frosted glass (`backdrop-filter`) over moving content | 48.6 | 19% |
| All three together | 43.7 | 27% |
| "Rich" look: shadows, blurred glow, translucent gradient panel, box shadow, text shadow, gradient text, `will-change` | 59.5 | 0.8% |

How many things can move at once, on top of the rich version:

| Extra moving items | Method | fps |
| --- | --- | --- |
| 50 | one DOM element each | 59.2 |
| 150 | one DOM element each | 37.3 |
| 300 | one DOM element each | 15.1 |
| 600 | one DOM element each | 7.1 |
| 2,000 | one 2D canvas | 59.5 |
| 20,000 | one WebGL canvas | 59.4 |

Things that made no difference: Chromium GPU flags (`--ignore-gpu-blocklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`, Vulkan features; the GPU is already fully used by default and Vulkan stays off), and an overclock (`arm_freq=2000`, `gpu_freq=750`, `over_voltage=6`), which changed nothing at 1080p, did not rescue 4K and ran 8 C hotter. Both were reverted.

## Rive compared like for like (1080p 60 Hz)

The promo was rebuilt as a real Rive file (`spike/rive-promo/`, written in Rive Markup Language and compiled with the Rive CLI 1.9.2), with the same layout, text, gradients, shadows and three animation loops as the HTML "rich" variant. Screenshots of both running on the Pi are in `results/shots/`. Rive web runtime 2.51.0.

| Version | fps | Time to ready |
| --- | --- | --- |
| HTML, rich variant | 59.4 | about 0.15 s |
| Rive, WebGL2 runtime (Rive Renderer) | 21.5 | 0.3 to 0.5 s |
| Rive, canvas runtime | 16.5 | 0.4 s |
| Rive, WebGL2, without the blurred shadows | 22.6 | 0.4 s |
| Rive, canvas, without the blurred shadows | 24.3 | 0.2 s |
| Rive, WebGL2, drawing at half resolution (960x540, upscaled) | 56.0 | 0.4 s |

Rive's own sample file `vehicles.riv` ran at 12 to 13 fps (WebGL2) and 23 fps (canvas).

Why: Chromium draws each HTML layer once and then only moves the finished textures, which the Pi's GPU handles easily. Rive redraws every vector shape in the scene on every frame, and the Pi's GPU cannot fill a 1080p frame that way 60 times a second. Removing the blurred shadows barely helped, so it is the redraw itself, not one effect. The WebGL2 build also showed visible noise in the shadows on this GPU.

Each Rive runtime is about 0.7 MB of JS plus 2.3 to 2.5 MB of WASM, and the compiled promo is 0.9 MB (almost all of it the embedded font).

Authoring notes: the Rive scene took one pass to compile and render correctly from the CLI's built-in docs, so agent authoring in RML is workable. Writing a `.riv` to disk needs `rive --publish`, which needs a Rive account; the free plan allows 50 publishes a month and adds a splash-screen watermark flag.

## Third round: the real player (2026-11-17)

Measured in the Milestone 2 player rather than the spike harness: real templates, the content cache, the two-slot swap. Seven templates, 16 spots: price promos, photo promos with 4K and 1080p photos, still images, 1080p30 video, live weather (clear, rain, snow), clock, a Google Calendar agenda, a meeting-room agenda, an RSS news crawl and a menu board. Dropped frames are split by what the player was doing: playing, loading the next spot underneath, or transitioning.

### The full 16-spot playlist, 150 s each

| Transition | Overall | Playing | Loading next | During transition | Worst frame |
| --- | --- | --- | --- | --- | --- |
| Cut | 0.16% | 0.00% | 4.6% | - | 17 ms |
| Fade through black, 600 ms | 0.20% | 0.01% | 2.6% | 1.5% | 50 ms |
| Crossfade, 600 ms | 0.94% | 0.10% | 4.5% | 10.0% | 50 ms |

### What it took to get there

| Problem | Cause | Fix | Before | After |
| --- | --- | --- | --- | --- |
| 1 s stall when a template appeared | First draw of the incoming spot happened at the moment of the swap | Load the next spot fully drawn underneath the current one | 3 to 4% dropped | 0.5% |
| Stalls around 4K photos | Decoding and uploading 8 MP images | Scale photos at publish time to cover the screen (1920x1080) | 1.4 s stalls | none |
| Rain and snow, 8 to 37% dropped | Canvas redrawn every frame, then one giant canvas | Small seamless tile, repeating background, slid by CSS | 8.8% | 0.4% |
| Two templates on screen at once | CSS `filter` blur and drop-shadow reapplied every frame | Gradients and box-shadow, which are drawn once | | |
| Crossfade cost | Two full templates composited | `fade` transition: one spot on screen at a time | 10% during | 1.5% during |
| Measurement itself | A 4 px always-rotating debug element over the templates cost 7% of frames | Debug speck off by default | | |

Other findings:

- **Video is decoded in hardware.** Chromium uses the Pi's V4L2 H.264 decoder. 1080p30 at 8 Mbit/s drops about 1% of video frames; 1080p60 at 12 Mbit/s drops about 18% and makes loading the next spot drop 18% too. The video spec is 1080p30, and the build rejects anything else.
- **A template cannot load invisibly.** At opacity 0, Chromium stops rendering the frame, so the template never reports ready and is skipped. Loading underneath at full opacity is required.
- **The skip path works.** A template that threw an error during the rain rewrite was skipped every time with the error recorded, and playback carried on.
- **An element the player draws on top of templates is costly.** The always-moving debug speck cost 7% of frames. A player-level overlay such as a ticker bar over spots would cost the same; overlays belong inside templates.
- **The page's frame counter is a valid measure.** With every frame forced to draw, frames presented by the compositor and the page's counter agreed within a few percent.

## The template wrapper frame (M3-27, 2026-11-17)

Each template now runs inside a same-origin wrapper frame (see Template containment in `docs/architecture.md`). Same Pi, content and measurement as the third round: the full 16-spot playlist, 150 s per run, `device/pi/isolate.py`. The baseline is the `m3-foundations` build without the wrapper, measured in the same session, alternating builds.

| Build | Transition | Overall | Playing | Loading next | During transition | Worst frame |
| --- | --- | --- | --- | --- | --- | --- |
| Without wrapper | Cut | 0.12% | 0.01% | 3.6% | - | 67 ms |
| With wrapper | Cut | 0.12% | 0.00% | 3.3% | - | 67 ms |
| Without wrapper (3 runs) | Fade, 600 ms | 0.28, 0.74, 0.33% | 0.01, 0.18, 0.02% | 3.8, 10.9, 1.9% | 2.6, 2.8, 4.5% | 17, 467, 17 ms |
| With wrapper (3 runs) | Fade, 600 ms | 0.46, 0.33, 0.34% | 0.02, 0.02, 0.02% | 3.3, 1.7, 2.6% | 5.6, 4.4, 4.0% | 67, 17, 50 ms |

No spot was skipped in any run. Overall and while playing, the wrapper makes no difference beyond run-to-run noise, and every run is inside the 1% budget. During the 600 ms fade the wrapper runs drop slightly more frames (4.0 to 5.6% against 2.6 to 4.5%); the ranges overlap, so three runs cannot tell whether that is real.

## Brand fonts (M3-39, 2026-11-17)

The full 16-spot stress playlist (fade 600 ms), 290 s per run, two runs per variant, alternating, with the M3-39 player (prepare time is `__sf.prepares`: start of loading to ready). Variants: **plain**, `examples/stress` as is; **kit only**, the same with a brand kit (Montserrat display, Inter body, 6 WOFF2 files, 128 kB, and a logo) that the templates do not use; **fonts used**, the kit plus the templates' styles switched to `var(--sf-font-body)` for text and `var(--sf-font-display)` for `h1`-`h3` (a scratch edit, not committed).

| Variant | Overall dropped | While loading next | Prepares over 500 ms | Prepare median | Slowest prepare |
| --- | --- | --- | --- | --- | --- |
| Plain | 0.34, 0.54% | 2.6, 4.8% | 4/33, 2/33 | 260, 247 ms | 1225 ms |
| Kit only | 0.35, 0.46% | 2.9, 3.7% | 4/33, 2/33 | 256, 259 ms | 900 ms |
| Fonts used | 0.32, 0.32% | 1.7, 2.3% | 10/33, 9/33 | 362, 384 ms | 1618 ms |

Nothing was skipped, and no frame took 150 ms or more. Frames do not regress. Prepare time, median per spot, plain against fonts used: clock 203 to 252, menu 201 to 246, weather-live 204 to 255, sport-drinks 288 to 386 ms: a brand font adds 30 to 100 ms on most templates. Over the budget: energy (cstore-promo) 235 to 1138 ms, news 467 to 1076 ms, photo-promo over a 4K photo 260-323 to 515-690 ms. Why is in the next section.

Decoding is not the cost: the 6 files decode in 14 ms (`new FontFace(...).load()` in the player page, median of 5). Two things were measured and fixed on the way:

- Faces built from bytes in the frame (`new FontFace(name, buffer)`) are a new typeface in every document, and about one prepare in three of photo-river (photo-promo, 4K photo) then took about 1.1 s to paint, whether or not text used the face. As `@font-face` with `data:` URLs (how templates already ship their own fonts), one in fifteen did. The SDK uses `data:` URLs.
- A family the template's styles never reference is not loaded at all, so a kit costs today's templates nothing (the kit-only row).

## Slow prepares: the cause and the fix (M3-39, 2026-11-17)

Traced on the Pi (Chromium tracing over CDP, the prepare split into phases inside the SDK). Two mechanisms, neither specific to fonts; brand fonts made both more frequent because they make a prepare take more frames.

1. **Tiles sized for a 0x0 frame.** A new template frame starts at 0x0 and gets its size a moment later, when the compositor tree that carries the size activates. When that tree already held the template's own markup, cc tiled its layers with the smallest tile (32x256 px), and the layers kept those tiles: a full-screen photo then rasterized as about 700 tiles, a second of GPU time (in the trace, `SharedImageStub::OnCreateSharedImage` 32x256 x680 against 15 to 30 tiles of 992x288 normally). Plain templates hit it too, but only on a cheap layer (the shade); with brand fonts the photo was bound later, inside the window. **Fix (SDK):** the document is hidden from load until the first `init` and until the frame has its size (two frames after `innerWidth` is set), so the first trees have nothing to tile. Afterwards no 32x256 tile was seen in any run.
2. **Undrawn frames are throttled to 1 Hz.** viz sends one BeginFrame a second to a client that has submitted more than `kUndrawnFrameLimit` (3) frames without being drawn (`components/viz/service/frame_sinks/compositor_frame_sink_support.cc`). The next spot loads underneath the one on screen, whose black background covered it completely, so cc culled it and it was never drawn: any template that needed more than three frames to reach ready waited about a second for each of its last ones (the trace shows nothing busy for that second). **Fix (player):** the black behind a spot is two layers with a 1 px gap at the centre, which the spot itself covers; the slot underneath is drawn through that column, out of sight, and is never throttled. Tried first and dropped: the spot on screen at opacity 0.999 (a full-screen render pass, 27% of frames dropped while loading), a 99% black background (11%), and transparent slots (10%, and news still stalled).

The full 16-spot stress playlist, as above (290 s, fade 600 ms), this fix against the M3-39 build, alternating:

| Variant | Build | Overall dropped | Dropped while loading | Prepares over 500 ms | Prepare median | Slowest | Skipped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fonts used | M3-39 | 0.52, 0.42% | 42, 37 frames (3.7, 3.3%) | 7/34, 10/34 | 326, 312 ms | 1463, 1513 ms | 2, 2 |
| Fonts used | fix | 0.82, 0.64% | 73, 74 frames (10.7, 11.0%) | 2/35, 3/35 | 329, 314 ms | 896, 908 ms | 0, 0 |
| Plain | M3-39 | 0.29% | 26 frames (3.8%) | 3/35 | 273 ms | 1243 ms | 0 |
| Plain | fix | 0.40% | 55 frames (9.1%) | 3/35 | 260 ms | 943 ms | 0 |

- With the fix and brand fonts, prepares per spot: energy (cstore-promo) 253 to 268 ms, news 455 to 517, photo-river (photo-promo, 4K) 316 to 352, photo-kitchen 319 to 362, weather-rain 384 to 455, sport-drinks 352 to 497. Over 500 ms: video-pan (870 to 940 ms in every build, fonts or not; a video spot, not a font cost) and one news at 517 ms.
- No frame of 150 ms or more in any run; the worst frame is 67 ms in both builds (83 ms once in the old one), always while the next spot loads.
- **The cost:** a load now runs at full rate instead of being throttled, so the spot on screen drops about 2 frames per load instead of about 1 (73/35 against 42/34 with fonts). Overall drops stay under the 1% budget, transitions drop fewer frames than before (15 to 19 against 20 to 33), and nothing is skipped (the throttled build skipped spots whose throttled frames ran past the 2 s ready timeout).

## Final Pi pass of `m3-foundations` (2026-11-17)

The integration branch at 7ee8188 (M3-07 sync loop and clock, M3-27 wrapper frame, M3-29 streamed downloads, M3-36 content source, M3-39 brand and slow-prepare fix) on the Pi 400, 1080p 60 Hz. The player was copied with `rsync --checksum`; every run cleared the HTTP cache and bypassed the service worker, and the loaded script was checked to be this build's (`index-DyY_o52e.js`).

### The full 16-spot stress playlist

`examples/stress` as is (no brand kit), served beside the player, 290 s per run after 10 s to settle, measured as `device/pi/isolate.py` does (frames split by phase), plus `__sf.prepares`. Runs alternated cut and fade.

| Transition | Run | Overall | Playing | Loading next | During transition | Worst frame | Prepares over 500 ms | Prepare median | Skipped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cut | 1 | 0.37% | 0.08% | 8.5% (51/598) | - | 50 ms | 2/33 | 256 ms | 0 |
| Cut | 2 | 0.36% | 0.08% | 8.4% (49/580) | - | 50 ms | 2/33 | 262 ms | 0 |
| Cut | 3 | 0.41% | 0.10% | 9.7% (56/577) | - | 17 ms | 2/33 | 262 ms | 0 |
| Fade, 600 ms | 1 | 0.50% | 0.12% | 7.6% (43/567) | 2.0% (25/1225) | 50 ms | 2/34 | 246 ms | 0 |
| Fade, 600 ms | 2 | 0.50% | 0.06% | 8.6% (51/592) | 2.1% (26/1228) | 17 ms | 2/34 | 260 ms | 0 |
| Fade, 600 ms | 3 | 0.49% | 0.13% | 7.6% (43/569) | 1.8% (22/1228) | 17 ms | 2/34 | 244 ms | 0 |

- **Within budget.** Every run is under 1% overall, no frame was longer than 50 ms, nothing was skipped.
- The only prepares over 500 ms are video-pan's, 856 to 931 ms in every run (two per run), as in every earlier build. Every other spot's prepares are 77 to 452 ms; news 356 to 447 ms, weather-rain 319 to 452 ms.
- **Against earlier rounds.** Overall and loading-next match the slow-prepare fix's "Plain, fix" row (0.40%, 9.1% while loading): the cost accepted in M3-39b, a load at full rate takes about twice the frames from the spot on screen that a throttled one did. Against the third round (cut 0.16%, 4.6% while loading) and the M3-27 rows (cut 0.12%, 3.3 to 3.6%), cut runs drop about twice as many frames overall, all of it while loading. The fade window is better than before: 1.8 to 2.1% against 4.0 to 5.6% with the wrapper in the M3-27 runs and 1.5% in the third round. So the M3-27 fade question (wrapper 4.0 to 5.6% against 2.6 to 4.5% without) does not show on this build.

### Frame rate during a large download (M3-29)

The Pi on a local API (`wrangler dev --env dev` on a laptop on the same Wi-Fi), playing the demo content plus a live weather spot (4 to 6 spots, demo brand kit, fade 600 and cut). A new manifest adding a 146 MB 1080p30 video (9 Mbit/s, synthetic) was published while it played; a 1 Hz sampler read the player's cumulative frame counts, wlan0 bytes and CPU. The download is the 35 s in which wlan0 received over 1 MB/s (4.3 MB/s, Wi-Fi bound); the idle window is the 35 s just before it, same playlist. Two trials, the second adding another 146 MB file to the content of the first.

| Trial | Window | Dropped | Playing | Loading next | Transition | CPU (all cores) | Frames over 50 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Idle | 0.57% (12/2109) | 1/1913 | 8/49 | 3/147 | 20% | 1 (67 ms, loading) |
| 1 | Downloading | 0.76% (16/2111) | 1/1898 | 10/61 | 5/152 | 49% | 3 (67, 83, 67 ms, all while loading) |
| 2 | Idle | 1.66% (35/2108) | 8/1867 | 14/95 | 13/146 | 22% | 3 (67 ms; one while playing) |
| 2 | Downloading | 2.61% (55/2111) | 5/1844 | 26/122 | 24/145 | 54% | 6 (67 to 83 ms; one while playing) |

- A download costs CPU (about 1.2 of the 4 cores: the fetch plus hashing in the worker at 4 MB/s) and a few frames in loads and transitions: +4 and +20 frames over 35 s, and a few more frames of 67 to 83 ms; none longer than the content's own idle worst. Frames while a spot just plays are unchanged (1 and 5 against 1 and 8). Heap stayed at 3 to 4 MB. No spot was skipped, and each manifest was adopted 2 s after its download ended.
- **Over budget, not caused by the download:** trial 2's playlist already drops 1.40% idle over 192 s (1.66% in the window), and the demo content drops frames of 67 to 133 ms with nothing downloading (trial 1's baseline had a 133 ms frame while sport-drinks played and many 50 to 84 ms frames while loading). By spot on screen (trial 2): coffee 3.6% while it loads the next spot, weather-atlanta 2.4% (by then on its rain snapshot, which draws rain, while loading the 9 Mbit noise video), the noise video 2.0%. The stress playlist does not do this. The cause was not traced; it is in the content (the demo templates with the brand kit, the rain snapshot, the 9 Mbit noise video), not in the download, and is for M3-25 to look at.
- With one Wi-Fi link the download rate, not the hash, set the pace. On a wired link at 32 MB/s the CPU cost would be higher for a shorter time; not measured.

### M3-07 on the Pi

Same local API. Evidence in `docs/tickets/M3-07-*.md`:

- Play counts: 52 minutes (01:07:32 to 02:00 UTC); after the hour closed and one sync, the server's counts for the hour equal the play log for every spot (360 plays, and play ms).
- A changed snapshot was on screen after the next sync (65 s later), with no request to `data/`.
- Clock an hour fast: after the first sync (3 s after the kiosk restart) the offset was -3599947 ms and the screen followed server time for display hours and schedule. One thing to look at: the player switched the panel off once, 2 s after that sync (the Pi read 22:01, outside display hours), and on again 14 s later; it then stayed on and playing.

### Kiosk restarts: "not ready within 2000 ms"

The old build logged `energy: not ready within 2000 ms` once after a restart on the cloud demo. This build, on the local API with the demo content: 10 restarts of `signforge-kiosk` (which also restarts Chromium's content server), each watched for 90 s over CDP for console warnings and errors, skips and `__sf.prepares`. Five on the `evening` playlist (weather-atlanta, coffee), five on `all-day` (sport-drinks, energy, coffee, weather-atlanta).

- **No "not ready", no warning or error, nothing skipped** in any of the 10.
- energy, the spot that failed on the old build, prepared in 220 to 286 ms every time, including as the second spot after each restart.
- **Over the 500 ms budget: the first prepare after a restart.** weather-atlanta first 711 to 948 ms (later ones 323 to 454 ms); sport-drinks first 516 to 894 ms (later ones 256 to 369 ms). That is under half the 2000 ms timeout at worst; a slower cold start (a busier Pi, a first boot) is untested. When the Pi was put back on its old player and cloud config afterwards, that old build skipped `weather-atlanta: not ready within 2000 ms` repeatedly (offline, on the cached test content), so the old build still fails this way. Later prepares are within budget except weather-atlanta once at 521 ms on its rain snapshot.

## Brand tokens and template polish (M3-25, 2026-11-17)

Same Pi and stress playlist, fade 600 ms (`transition=fade600`; note that `transition=fade` is a 500 ms fade, so the M3-39 tables above, taken with `fade`, were 500 ms fades), soak logger stopped, cache cleared and the service worker bypassed before every run, builds alternated.

### The transition drift is run-to-run spread, not a regression

Transitions dropped 2 to 4.4% since M3-05 against 1.5% in the third round. The third round's own build (commit 301eee9, its player and its content) was rebuilt and run against today's, interleaved, 150 s each:

| Build | Transition dropped (3 runs) | Overall |
| --- | --- | --- |
| Third round (301eee9) | 1.85, 3.86, 3.24% (12, 25, 21 of about 650 frames) | 0.31, 0.54, 0.41% |
| Today's player and content | 1.63, 3.06, 1.93% (10, 19, 12 of about 620) | 0.58, 0.58, 0.51% |

The old build reproduces the "drift" today, so the code did not regress. The transition phase is only about 650 frames a run, and one build spreads from 1.6 to 3.9% between runs; the third round's 1.5% was a single run. Compare transitions over three or more interleaved runs, and judge builds on the overall and playing figures.

### video-pan: 900 ms prepares

Traced with timing in the player: a video prepare was about 350 ms to `canplaythrough`, then 600 ms waiting for a `requestVideoFrameCallback` that never fires on a paused video that has never played, so every video prepare waited out its 600 ms timer. The player now treats a video spot as ready at `canplaythrough`. video-pan, mini playlist with clock and photo-river, 3 runs each:

| Build | video-pan prepare | Overall | Play + prepare dropped |
| --- | --- | --- | --- |
| With the wait | 913 to 1034 ms | 0.60 to 0.71% | 53 to 63 frames |
| Ready at canplaythrough | 305 to 399 ms | 0.60 to 0.66% | 52 to 56 frames |

The decoder's warm-up frames now count while the spot before plays rather than inside a longer prepare; their sum is unchanged. Transitions in this mini playlist dropped 2 to 6 frames a run against 1.

### The full stress playlist (290 s per run)

A: the `m3-foundations` player and templates, no kit. B: this branch (player and templates), no kit. C: this branch with a brand kit whose fonts the templates now use (Montserrat display, Inter body).

| Variant | Overall dropped | Playing | Prepares over 500 ms | Prepare median | news | video-pan | Skipped |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 0.58, 0.70% | 0.12, 0.21% | 3/36, 3/36 | 248 ms | 332-500 ms | 861-937 ms | 0 |
| B | 0.75*, 0.60, 0.62% | 0.29*, 0.11, 0.15% | 0, 0, 1/36 | 254-265 ms | 379-472 ms | 254-323 ms | 0 |
| C | 0.73, 0.79, 0.78% | 0.12, 0.16, 0.15% | 4, 2, 2/36 | 328-342 ms | 1421-1622 ms, then 549-550 | 226-355 ms | 0 |

\* B's first run overlapped another agent briefly taking the Pi (a 333 ms frame); every other run's worst frame is 83 to 167 ms.

Without a kit (B) nothing regresses and the prepare budget is met everywhere. With brand fonts (C) frames stay under 1%, but **news over 500 ms is still open**:

- **news loads under video-pan**, and under a playing video its work in the frame is 2 to 3 times slower (theme and fonts 94 to 168 ms against 34 to 54 under clock; prepare 175 to 250 against 53 to 81).
- **The opaque video layer covers the 1 px gap** that keeps the slot underneath drawn (Slow prepares, above). Chromium knows a video layer is opaque, unlike a template frame, so the news frame underneath is culled and throttled to one frame a second: in about half the prepares under video, waiting for two animation frames (`settle`) took 1.0 to 1.1 s (news 1465 to 1607 ms). Under clock, news prepares in 229 to 278 ms.
- **Not adopted, a next step:** the video at `opacity: 0.999` (one layer blended, not a render surface) removed the stall in one probe (news under video 466 to 586 ms against 471 to 1607, 12 prepares each), but its frame cost while video plays was not measured. Even without the stall, news under video is 470 to 590 ms with brand fonts, so news needs less work as well (its crawl is measured over about 14,600 px of text).

## The demo deploy on the Pi (2026-11-18)

`m3-foundations` deployed to the demo API and CMS; the Pi runs the player built from `m3-foundations` at 0d4b75a with `kiosk.env` = `kiosk.env.cloud` (content is the demo API). Checked at 23:51 local on 2026-11-17, after M3-25 released the rig:

- **Online and playing the desired manifest.** `__sf`: online, socket open, manifest `e131056e…` (`examples/live`, which the owner published to `stress-screen` with `sf push`), last good the same, clock trusted (offset 0.5 s), nothing skipped, no error. M3-25's test content (`32e3dfd8…` earlier) was no longer on the screen.
- **A push reaches the Pi in under a second.** `sf push` of a one-word variant of `examples/live` (`abe51d22…`) from a laptop on the same Wi-Fi: the player had adopted it 742 ms after `sf push` returned. Pushing `examples/live` back: 202 ms. Times from a watcher in the page polling `__sf.manifestId` every 20 ms, against the laptop's clock corrected by the measured Pi-laptop offset (about 0.1 s).
- **It plays at a spot boundary.** First push: adopted during holidays-us; the next spot, holidays-uk, was the first from the new manifest. Second push: adopted about 2 s before the end of news-npr, inside the 3 s in which the next spot (news-bbc) was already loading, so news-bbc played from the old manifest and news-nyt, one boundary later, from the new one. That is the player's design (a spot that is loading is not thrown away), not a delay in the push.
- Left on `examples/live` (`e131056e…`), as found.

## Linux tuning (2026-11-18)

The Pi 400 tuned on the Linux side, one change at a time, with the `m3-foundations` player (0d4b75a) and the 16-spot stress playlist. Kept changes are in `device/pi/tune.sh` and the unit files; how to set up a Pi is in `device/pi/README.md`.

**Method.**
- *Playback.* `device/pi/bench.sh`, which drives `bench.py`: the whole stress playlist, alternating cut and fade 600 ms, 290 s per run after 10 s to settle, frames split by phase. Every run clears the HTTP cache and bypasses the service worker, and the soak logger is stopped. Prepares are every `__sf.prepares` entry since the page loaded. Temperature, ARM clock and throttling were sampled every 5 s.
- *Restarts.* 5 kiosk restarts on the stress content, timed from just before `systemctl restart signforge-kiosk`: Chromium's navigation start, the first spot, the first and second prepares.
- *Boot.* `/proc/uptime` (kernel start) at navigation and at the first spot, recorded by `signforge-bootprobe.service` from early boot, 3 reboots per variant, on the cloud config.
- *Screening.* Chromium flags were screened with 2 runs and 5 restarts against the 6- to 9-run noise band of the same governor.

**Two measurement traps found on the way.**
- *Chromium uptime.* Prepares get slower the longer Chromium has run: the same settings gave a 247–265 ms median after about two hours and 230–240 ms on a fresh start. The first baseline was taken on a long-running Chromium and made the governor look like a 12% prepare win. Every variant below starts on a freshly restarted kiosk.
- *The wall clock at boot.* The Pi has no real-time clock, so its time jumps when NTP first syncs (37.8 s after kernel start in one boot, after Chromium had started), and wall-clock boot timings were wrong by up to 17 s. Boot is timed from `/proc/uptime` instead.

### Playback

| Variant | Runs | Overall cut | Overall fade | Fade window | Loading next | Prepare median | Worst frame | Temp max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (ondemand), Chromium up about 2 h | 3 + 3 | 0.40, 0.41, 0.40% | 0.51, 0.45, 0.52% | 1.79, 1.55, 1.71% | 7.5–9.4% | 247–265 ms | 100 ms | 56.9 C |
| ondemand, fresh Chromium | 4 + 3 | 0.36, 0.41, 0.39, 0.49% | 0.62, 0.55, 0.60% | 2.89, 2.43, 3.00% | 7.3–12.8% | 225–240 ms | 300 ms ¹ | 54.5 C |
| **performance** governor, fresh Chromium | 5 + 4 | 0.50, 0.30, 0.37, 0.44, 0.32% | 0.44, 0.44, 0.43, 0.42% | **1.29, 1.22, 1.30, 1.20%** | 7.4–13.0% | 219–231 ms | 317 ms ¹ | 56.9 C |
| **Final: everything kept** (performance, unit ordering, sessions, cloud-init off) | 3 + 3 | 0.43, 0.37, 0.35% | 0.43, 0.44, 0.46% | 1.14, 1.14, 1.14% | 8.1–11.5% | 220–233 ms | 300 ms ¹ | 56.4 C |
| performance + `--num-raster-threads=4` | 1 + 1 | 0.29% | 0.43% | 1.14% | 7.7, 9.7% | 223, 228 ms | 83 ms | 56.4 C |
| performance, templates in the player's process ² | 1 + 1 | 1.13% | 0.95% | 1.69% | 10.0, 14.5% | 194, 199 ms | 417 ms | 56.4 C |
| performance, `apt-daily` started during the run | 1 + 0 | 0.36% | - | - | 8.8% | 214 ms | 67 ms | 55.5 C |

¹ One frame of 300–383 ms on the first weather-rain prepare after Chromium starts, while photo-berries is on screen. It happened in 5 of the 8 first runs after a fresh start, under either governor, and in no later run. Every other frame with the templates out of process was 133 ms or less.
² `--disable-features=IsolateSandboxedIframes`: measured to find out what the template process costs, not as a candidate. It removes a process boundary that templates are meant to have.

Kiosk restarts (5 each), with first spot and first prepare timed from `systemctl restart`:

| Variant | Navigation | First spot | First prepare (sport-drinks) | Second prepare |
| --- | --- | --- | --- | --- |
| Baseline (ondemand) | 2.00–2.08 s | 3.43–3.82 s | 586, 629, 629, 865, 994 ms (median 629) | 210–282 ms |
| performance | 2.00–2.18 s | 3.41–4.01 s | 547, 563, 642, 811, 998 ms (median 642) | 225–231 ms |
| Final: everything kept | 2.05–2.09 s | 3.48–3.78 s | 596, 620, 622, 631, 850 ms (median 622) | 219–243 ms |
| performance + `--num-raster-threads=4` | 2.03–2.10 s | 3.41–3.60 s | 593, 603, 614, 614, 799 ms (median 614) | 219–228 ms |
| performance, templates in the player's process ² | 2.00–2.06 s | 3.34–3.44 s | 504, 504, 506, 513, 522 ms (median 506) | 185–222 ms |

### Boot

Kernel start to Chromium's navigation and to the first spot (cloud config, first spot news-npr), 3 reboots each. Each row adds to the one above.

| Change | Kiosk unit starts | Navigation | First spot | Kept |
| --- | --- | --- | --- | --- |
| Baseline (2 valid reboots) | 23.6, 30.5 s | 33.5, 40.4 s | 36.9, 46.2 s | |
| Kiosk and supervisor not after `network-online.target` | 17.7 s | 27.6–27.7 s | 30.8–31.1 s | yes |
| Kiosk not after `systemd-user-sessions` (after logind and seatd) | 10.0 s | 27.5–27.6 s | 30.8–31.0 s | yes ³ |
| `user@1000` without its login barrier | 9.9 s | 27.1–27.2 s | 30.3–32.8 s | no: reverted |
| `systemd-user-sessions` not after `network.target` | 9.9 s | 20.5 s | 23.8–24.0 s | **yes** |
| Governor on the kernel command line | 9.9 s | 20.5–20.6 s | 23.8–24.1 s | no: a udev rule overrides it |
| Governor by udev rule | 9.9 s | 20.5 s | 23.2–23.9 s | yes, for playback |
| Preload Chromium's files from early boot | 16.5–16.8 s | 23.8–23.9 s | 25.9–26.0 s | no: slower |
| cloud-init off (`cloud-init=disabled`) | 7.7–7.9 s ⁴ | 18.5–18.7 s | 21.3–21.9 s | **yes** |
| Final, applied by `tune.sh` (1 reboot) | | 18.6 s | 22.0 s | |

³ Needed for the next row to help, so kept although it changes nothing alone.
The kiosk column is when its main process started (`ExecMainStartTimestampMonotonic`).
⁴ The unit itself is activated at 5.4 s (`critical-chain`); its PAM session takes the rest.

**What held the kiosk back.**
- The kiosk unit was ordered after `network-online.target`, which waits for Wi-Fi.
- Without that, its PAM login session still waited. logind orders every non-system user's session scope after `systemd-user-sessions.service`, which upstream orders after `network.target`. A probe of the kiosk's processes at 13 and 15 s showed cage not yet exec'd, still inside PAM, waiting for the `session-1.scope` start job.
- `network.target` comes late because NetworkManager takes 7.7 s to start on this image. It rewrites its netplan files (`/etc/netplan/90-NM-*.yaml`) at every boot, and each rewrite runs `netplan generate` and a full systemd reload (1.2 s each, four of them).
- After that, Chromium's first start (6.7 s, against 2 s on a warm restart and 3.7 s on a restart with the page cache dropped) is mostly waiting on SD reads while `netplan` takes a whole core. Chromium was in D state on `folio_wait_bit`, and 339 MB of its files are resident after a cold start.
- Preloading those files competed with the same boot I/O and made boot 2 s slower.

Against the baseline, the kept changes:
- Halved the frames dropped during a fade (1.14–1.30% against 1.55–3.00%).
- Brought fade runs to 0.42–0.46% overall from 0.45–0.62%, and cut runs stay where they were.
- Brought the first spot after boot to 21.3–22.0 s from 36.9–46.2 s.
- Cost about 2 C (max 56.9 C, never throttled).

Video-pan's prepare, loading-next drops and the first prepare after a restart did not move.

### Not changed, and why

- **`hdmi_enable_4kp60=1` stays.** With it the firmware runs the core and V3D (the 3D GPU) at 550 MHz instead of 500 (`vcgencmd measure_clock`, `get_config`). The kiosk outputs 1080p, but removing it would cut the GPU clock.
- **gpu_mem and CMA.** 457 of the 512 MB CMA pool is free while playing. KMS and V3D do not use gpu_mem.
- **Zero-copy raster.** It applies to software raster buffers (`docs/how_cc_works.md`, raster buffer providers). This Chromium already rasterizes on the GPU (Debian's `--enable-gpu-rasterization`, ANGLE on GLES). Not tested.
- **More raster threads.** No change beyond noise (table above). cc runs GPU raster on one worker at a time.
- **SD writes, journald and cache on tmpfs.** The SD card takes about 4.3 MB of writes in 2 minutes of playback, about 3 GB a day. Of that, Chromium wrote 1.2 MB in 90 s (session-restore files, `shared_proto_db`, GPU caches, the player's localStorage) and journald 0.2 MB. That is well within an SD card's wear leveling. A volatile journal would lose the logs that explain a reboot in the field. Chromium's HTTP disk cache is 128 kB, since the player keeps content in Cache Storage, which must persist. Not changed.
- **Timers and services.** `apt-daily` ran in 3.8 s with no effect on frames (table above). man-db already runs at idle I/O priority and nice 19. Not changed.
- **zram.** 30 MB of the 2 GB swap is in use, so it is not changed.
- **I/O scheduler** (mq-deadline) and **ozone/Wayland against cage**: not tried. Nothing measured pointed at them.
- **Overclock**: not tried. It could not be left in place, and no measurement showed the ARM clock to be the limit. Performance pins the ARM at 1.8 GHz and the hot spots are GPU and process start.
- **NetworkManager's netplan rewrites** cost about 5 s of boot and are the biggest remaining delay. They were not touched: the network configuration is how the rig is reached, and a mistake there leaves a Pi off the network.

### Still over budget

- **First prepare after a kiosk restart: 547–998 ms, median 642 (budget 500).** No Linux setting changed it.
  - Most of the excess is starting the template renderer process. With templates in the player's process it is 504–522 ms. The template frames are out-of-process (`IsolateSandboxedIframes`, two `about:srcdoc` iframe targets), the first prepare after a start launches that process, and later prepares reuse it.
  - A player-side warm-up would recover most of it while keeping the boundary: a blank sandboxed `srcdoc` frame made at boot, before the first prepare. That is player code, and even in-process the first prepare is just over 500 ms.
- **video-pan's prepare: 843–963 ms in every run of every variant here.** That is player code, not the Pi: the slot waited for a `requestVideoFrameCallback` that never fires on a paused video (confirmed again here in the player page, on top and covered, 4 times), then its 600 ms timer. M3-25 fixed it on master after these runs (ready at `canplaythrough`, 254–399 ms; section above). These runs used 0d4b75a, from before that fix.
- **A 300–383 ms frame on the first weather-rain prepare after Chromium starts** (footnote ¹). It was not traced; the template's rain-tile setup is the first suspect.
- **Boot to first spot is 21.3–22.0 s** (from kernel start; the firmware's time before that was not measured). NetworkManager's netplan rewrites are the next 5 s.

## The supervisor restarts a hung player (issue #36, 2026-11-18)

The player beats the supervisor (`POST /alive`) every 5 s; with no beat for 30 s the supervisor restarts `signforge-kiosk`. Branch `gh-36-supervisor-liveness` against master (`f50e79f` player and supervisor; the first master run was the `84d704a` build then on the rig), each run on a freshly restarted kiosk with the HTTP cache cleared, the soak logger stopped. Frames: the full 16-spot `examples/stress` playlist, fade 600 ms, 150 s per run, `device/pi/isolate.py`, alternating master, branch, branch, master.

| Build | Overall | Playing | Loading next | During transition | Worst frame |
| --- | --- | --- | --- | --- | --- |
| Master (2 runs) | 0.66, 0.72% | 0.28, 0.16% | 10.5, 16.5% | 1.5, 1.2% | 217, 317 ms |
| With the beat (2 runs) | 0.74, 0.53% | 0.17, 0.16% | 17.1, 9.7% | 2.6, 1.7% | 333, 100 ms |

No spot was skipped. The beat costs nothing beyond run-to-run noise. The 317 and 333 ms frames are single prepares, in both builds.

Hang: `kill -STOP` of every Chromium renderer (the player's and the templates') while the cloud config played. Twice, the supervisor restarted the kiosk 27.5 s and 31.7 s after the stop (30 s after the last beat, checked every 5 s); the first spot played again 36.1 s after the stop. systemd's stop took 0.3 s, as it sends SIGCONT with SIGTERM. With the signal turned off (`/display/off`) for 75 s the page stayed `visible`, the beat went on and nothing was restarted. The polkit rule lets the supervisor's user restart `signforge-kiosk` and nothing else (stopping `signforge-player-web` was refused).

## Badge text chosen for its fill (issue #57, 2026-11-18)

news 1.3.1 and cstore-promo 1.2.1 choose their badge text in `prepare` with the SDK's `readableOn` (two custom property reads, one `getComputedStyle` in news). This branch's player at a subdirectory of the rig, with content built from master's templates (before) and this branch's (after) beside it; cut, 60 s per run after 10 s to settle, HTTP cache cleared and the service worker bypassed before each run, the soak logger stopped, `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Order alternated (before, after, then after, before).

| Content | Build | Overall | Playing | Loading next | Worst frame | Prepares (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| `examples/stress`, no kit: energy, sport-drinks, news | before | 0.28, 0.94% | 0.00, 0.71% | 12.5, 13.6% | 50, 433 ms | energy 202-231, sport-drinks 221-245, news 185-253 |
| | after | 0.17, 0.22% | 0.00, 0.00% | 8.6, 11.6% | 33, 50 ms | energy 204-223, sport-drinks 215-277, news 207-289 |
| `examples/demo`, demo kit: energy, sport-drinks | before | 0.56, 0.50% | 0.06, 0.09% | 16.2, 14.0% | 67, 67 ms | energy 278-316, sport-drinks 282-327 |
| | after | 0.39, 0.47% | 0.06, 0.03% | 10.9, 14.3% | 50, 50 ms | energy 304-326, sport-drinks 295-361 |

No cost in frames. The one 433 ms frame was while a spot played, in master's last run. With the kit, energy's prepares were 10 to 26 ms slower (medians 315 against 295 ms) over six each, about the run-to-run spread, and all well within 500 ms. Nothing was skipped.

## Accent text and tag text chosen for what they sit on (issue #69, 2026-11-18)

news 1.3.3, agenda 1.2.2, clock 1.2.2, cstore-promo 1.2.3, photo-promo 1.2.2 and menu-board 1.2.2 choose accent-coloured text (and photo-promo's and menu-board's tag text) in `prepare` with the SDK's `readableOn`: one or two `getComputedStyle` reads, and in agenda a 1x1 canvas paint and read per row to resolve its `color-mix` card. This branch's player at a subdirectory of the rig, with `examples/stress` built from master's templates (before) and this branch's (after) beside it, with no kit and with a light kit (a scratch copy of the project with a `brand.json`: white background, amber accent). Cut, 60 s per run after 10 s to settle, HTTP cache cleared and the service worker bypassed before each run, the soak logger stopped, `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Two playlists per run: sport-drinks, clock, holidays, news; and menu, photo-river, meeting-room, photo-berries. Order alternated. Set 1 was measured before #73 (#71) landed, on its bundles; set 2 again after merging it, on the bundles that ship.

| Content | Build | Runs | Overall | Playing | Loading next | Worst frame |
| --- | --- | --- | --- | --- | --- | --- |
| stress, no kit | before | 6 | 0.06-0.19% | 0.00-0.03% | 2.6-11.7% | 50 ms |
| | after | 6 | 0.06-0.25% | 0.00-0.11% | 2.4-8.2% | 83 ms |
| stress, light kit | before | 6 | 0.00-0.17% | 0.00% | 0.0-10.2% | 50 ms |
| | after | 6 | 0.00-0.17% | 0.00-0.03% | 0.0-7.6% | 33 ms |

Prepares over both sets and kits (ms, before / after): meeting-room (agenda) median 194 / 214, 151-220 / 175-287; holidays (agenda) 166 / 163; clock 176 / 177; news 158 / 161; sport-drinks (cstore-promo) 192 / 195; menu 167 / 167; photo-berries 200 / 201; photo-river 213 / 214.

No cost in frames: the ranges overlap run for run, and the one 83 ms frame was in set 1's second after run with no kit. Agenda's meeting room, the spot with the most rows, prepares about 20 ms slower, the canvas read per row; well within 500 ms. The other templates are within run-to-run noise. Nothing was skipped.

## Baseline: the same player on a Mac (2026-11-17)

The stress playlist on an Apple M5 Pro laptop in Chrome for Testing 157, a windowed app on the built-in 120 Hz ProMotion panel. Same build, content and measurement as the Pi.

| Pixels drawn | Full playlist, cut | Every spot except video | Video spot | Worst frame |
| --- | --- | --- | --- | --- |
| 3024 x 1720 (native 2x) | 1.4 to 1.7% | 0.00% | 23% | 35 ms |
| 1920 x 1093 (about 1080p) | 2.2% | 0.00% | 25% | 35 ms |
| 1512 x 860 (1x) | 2.1% | 0.00% | 25% | 35 ms |

- **Resolution makes no difference.** Every template, including rain, snow and the crawl, holds 120 Hz at 5 million pixels. Pixel count limits only the Pi.
- **The video figure is the display, not the player.** While only a 30 fps video changes, macOS drops the panel to 30 Hz, so animation frames arrive 33 ms apart and the frame monitor counts them as drops. The decoder itself dropped 2 of 145 video frames, about the same as the Pi. The frame monitor assumes a fixed refresh rate; on a variable-refresh panel, read the video decoder's own count instead.
- **It found a real bug.** On a fresh profile, `weather-snow` failed on its first play: the template read `innerWidth` before its frame had been laid out, drew a 0-pixel tile, and `toBlob` returned null. Templates now size from `ctx.viewport`, and a decorative effect that fails no longer fails the spot. The same pattern was in the news crawl.

## Conclusions

1. **A Pi 4 is a 1080p player.** Transform and opacity animation holds 60 fps at 1080p. At 4K the same content drops a sixth to a third of its frames even at 30 Hz, and 4K 60 Hz is unusable. Flags and overclocking do not change this.
2. **On a 4K panel, output 1080p and let the panel upscale.** The kiosk start script now forces 1080p 60 Hz.
3. **The sandboxed frame costs nothing measurable.**
4. **Only frosted glass is expensive.** Drop shadows, blur, glows, box shadows, text shadows and gradient text all hold 60 fps, including on moving elements. `backdrop-filter` over moving content does not. The first round's blanket "no filters" conclusion was wrong.
5. **Layout-property animation costs double the CPU** and drops eight times as many frames as the transform version.
6. **The real limit is the number of separately moving DOM elements**: about 50 is safe, 150 is not. Particle-style effects belong in a single canvas, where thousands are free.
7. **Cooling is adequate** in the printed enclosure.
8. **Rive is not viable as the template format on a Pi 4.** The same scene runs at about a third of the frame rate of the HTML version. It only reaches near 60 fps at quarter the pixel count.
9. **Cuts and fades are within budget; crossfades are not.** Two full templates on screen at once costs about 10% of frames on a Pi 4 for the length of the fade.
10. **Prefer effects drawn once over CSS `filter`**, and draw particles as a sliding tile, not a per-frame canvas.

## Proposed template budgets (Pi 4, 1080p 60 Hz)

- Dropped frames: at most 1% over a full play
- No single frame longer than 50 ms after play starts
- Time to ready: at most 500 ms from cached files
- Animate `transform` and `opacity`; do not animate layout properties
- No `backdrop-filter` over moving content
- At most about 50 simultaneously animating DOM elements; use one canvas (2D or WebGL) for anything denser
- Bundle size: not measured by this spike

## Limits of this measurement

- One template, one 20 s run per configuration.
- `requestAnimationFrame` timing measures how often the page is asked to produce a frame. It does not directly observe frames the GPU process drops after that, so real smoothness can be slightly worse than reported.
- The template uses vector artwork. Large photos and video were not tested.
- The canvas and WebGL tests drew small flat squares. Heavier shaders will cost more.

## Reproducing

On the Pi, with the two service files installed and the kiosk running:

```
python3 ~/spike/run.py <label> compositor compositor:nosandbox filter layout
```

Switch modes with `wlr-randr --output HDMI-A-1 --mode 1920x1080@60` (set `XDG_RUNTIME_DIR=/run/user/1000` and `WAYLAND_DISPLAY=wayland-0` first).
