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

## No WebRTC in template frames (issue #91, 2026-11-19)

The template's policy runs only the bundle's classic scripts, by hash, each rewritten to start (after its directive prologue) with a guard that deletes `RTCPeerConnection` and `webkitRTCPeerConnection` from `this`; a second policy allows no script URL. The player builds both policies and the rewritten bundle at every template load (`containedFrames` in `packages/player-core`; see Template containment in `docs/architecture.md`). Master's player (`96cd45b`), this branch's (`504ad0c`) and, for the two cases found in the re-check, the PR's previous head (`cd3b308`), at subdirectories of the rig, served on `http://localhost:8090` so the kiosk's own origin and caches were not touched.

WebRTC, in a new tab of the kiosk's Chromium 156: the browser tests' fixture modes (a peer connection to a STUN server on UDP 34780 and a TURN server on TCP 34781, both on the Pi's loopback; `external-script` asks for `http://127.0.0.1:34781/x.js` with the template's own hash as `integrity`), 14 s, so the spot came up three times. Datagrams, then TCP connections:

| Mode | Master | Previous head | This branch |
| --- | --- | --- | --- |
| `webrtc` (the template's own window) | 9, 3 | | 0, 0 |
| `webrtc-srcdoc` (a frame it adds runs its own script) | 9, 3 | | 0, 0 |
| `webrtc-javascript-url` | 9, 3 | | 0, 0 |
| `webrtc-markup` (the frame is in the bundle's markup, so every spot of it has one) | 24, 8 | | 0, 0 |
| module copy (one of its classic scripts, declaring `function window`, run as a module in a frame it adds) | 24, 8 | 23, 8 | 0, 0 |
| `external-script` | 0, 0 (no hashes in its policy) | 0, 3 (requested) | 0, 0 |

Frames: the full 16-spot `examples/stress` playlist, cut, 120 s per run after 10 s to settle, HTTP cache cleared, the service worker bypassed and the origin's storage cleared before each run, the soak logger and the supervisor stopped (the kiosk page left the player's origin, so it did not beat), `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Order: master, branch, branch, master.

| Build | Overall | Playing | Loading next | Worst frame | Prepares, median and max (13 each) |
| --- | --- | --- | --- | --- | --- |
| Master | 0.35, 0.33% | 0.11, 0.13% | 9.1, 7.8% | 117, 117 ms | 243 / 371, 233 / 512 ms |
| This branch | 0.43, 0.43% | 0.14, 0.13% | 10.3, 10.3% | 100, 117 ms | 243 / 529, 267 / 446 ms |

`containedFrames` itself, timed in a tab of the same Chromium on a 79 kB stress bundle, 30 times: 0.9 ms median, 0.4 ms at best, 11.6 ms on the first (cold) call. That is well inside the spread between runs: the previous session of this issue had master higher (0.60, 0.37% against 0.39, 0.39%), and both builds here have one prepare over 500 ms. Nothing was skipped.

After the second re-check the guard goes right after the exact `"use strict";` every bundle script starts with, with no prologue matching (`cea6a31`). One more round, same method, master `50c0dfe` against the branch, master/branch/branch/master; `webrtc` sent 9 datagrams and 3 TURN connections on master and nothing on the branch:

| Build | Overall | Playing | Loading next | Worst frame | Prepares, median and max (13 each) |
| --- | --- | --- | --- | --- | --- |
| Master | 0.62, 0.36% | 0.14, 0.10% | 17.6, 10.2% | 300, 100 ms | 235 / 660, 249 / 345 ms |
| This branch | 0.39, 0.37% | 0.14, 0.13% | 9.1, 9.2% | 100, 117 ms | 236 / 534, 242 / 380 ms |

No cost; the 300 ms frame was again in master's first run after the cache was cleared. Nothing was skipped.

After the third re-check the player finds a bundle's scripts with an HTML parser (parse5, `bundleScripts` in the contract) and arms them at their offsets. That parse costs, in a tab of the kiosk's Chromium on a 79 kB stress bundle, 12.4 ms median and 91 ms on the first, cold call (the text matcher it replaced took 0.9 ms), and the player's main script grows from 68 to 221 kB (24 to 66 kB gzipped). Master `7f03512` against the branch; `webrtc` sent 9 datagrams and 3 TURN connections on master and nothing on the branch.

| Build | Overall | Playing | Loading next | Worst frame | Prepares, median and max (13 each) |
| --- | --- | --- | --- | --- | --- |
| Master | 0.69, 0.42% | 0.19, 0.13% | 17.3, 10.8% | 300, 100 ms | 247 / 626, 228 / 460 ms |
| Branch, parsing at every prepare | 0.61, 0.61% | 0.16, 0.17% | 14.6, 14.0% | 117, 150 ms | 299 / 464, 266 / 694 ms |
| Master | 0.40, 0.40% | 0.10, 0.16% | 11.6, 8.5% | 100, 150 ms | 256 / 358, 228 / 545 ms |
| Branch, parsed once per bundle (`47b4492`) | 0.49, 0.56% | 0.10, 0.19% | 13.3, 12.3% | 100, 150 ms | 272 / 469, 259 / 456 ms |

Parsing at every prepare made prepares 30 to 50 ms slower, so the player now keeps the result per bundle hash for the manifest playing. Each run above reloads the page, so about half its prepares still parse a bundle for the first time. A longer pair (240 s each, 27 prepares) split them: a spot's first prepare took 246 ms median on master and 261 ms on the branch; repeats took 213 and 231 ms. Overall dropped frames were 0.37 and 0.49%. Master alone has measured 0.29 to 0.69% across this issue's sessions, so the difference is within the spread, but the branch now tends to the higher side, by about 0.1 point overall and 15 to 20 ms per prepare. All runs are within the 1% budget. Prepares over 500 ms happened in both builds (master 545, 626 ms; branch 694, 713 ms). Nothing was skipped.

### After the merge: master before and after #100 (2026-11-19)

The check after #100 merged (`f78da0d`): master just before it (`19ebbac`) against the merge, both built with `pnpm build:player` (main script 72 and 225 kB). Same method as above: `examples/stress` built once from `f78da0d` (no brand kit) and served to both players, each build at `http://localhost:8090/c100/<build>/`, the full 16-spot playlist, cut, 120 s per run after 10 s to settle, HTTP cache cleared, the service worker bypassed and the origin's storage cleared before each run, the soak logger and the supervisor stopped, `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Six runs per build, starting 23:29 at night: before, after three times, then after, before three times. Every run drew 7202 frames, and nothing was skipped.

| Build | Overall (`all%`) | Playing (`play%`) | Loading next | Worst frame | Prepare median per run (13 each) | Prepare max per run |
| --- | --- | --- | --- | --- | --- | --- |
| Before (`19ebbac`) | 0.67, 0.42, 0.36, 0.37, 0.35, 0.44% | 0.17, 0.14, 0.10, 0.11, 0.13, 0.14% | 15.3, 9.6, 9.1, 9.6, 7.9, 10.7% | 317, 117, 117, 117, 117, 117 ms | 262, 238, 277, 257, 242, 242 ms | 723, 590, 434, 390, 526, 567 ms |
| After (`f78da0d`) | 0.49, 0.50, 0.86, 0.47, 0.54, 0.61% | 0.10, 0.13, 0.47, 0.11, 0.13, 0.17% | 13.6, 12.7, 13.4, 13.3, 14.2, 14.5% | 100, 133, 367, 117, 117, 117 ms | 264, 291, 263, 252, 245, 262 ms | 464, 454, 460, 416, 477, 718 ms |

Medians of the six runs, before against after: overall 0.40 and 0.52%, playing 0.135 and 0.13%, loading next 9.6 and 13.5%. All 78 prepares of each build: median 247 and 263 ms, 90th percentile 390 and 406 ms, over 500 ms 4 and 1 times.

- **Playing: no change.** Five of six runs per build are 0.10 to 0.17%. The outliers are single long frames, one in each build: before's 317 ms frame (with a 150 ms one) was in its first run, the first after the cache was cleared, as in the sections above; after's 367 ms frame was in its third run, while a spot played. That run did not record which spot, and no other run of either build had a frame over 133 ms. Every run is within the 1% budget per play.
- **Loading next and overall: a small cost, beyond the noise.** Every after run lost more frames while the next spot loaded (12.7 to 14.5%) than every before run except the first one after the cache was cleared (7.9 to 10.7%). That puts overall about 0.1 point higher (0.47 to 0.61% against 0.35 to 0.44%, without those two outliers). This is the cost found before the merge (above): parsing a bundle the first time it plays, about 12 ms on the main thread (91 ms cold). Each run reloads the page, so most of its 13 prepares parse a bundle for the first time. A screen that plays one manifest for longer parses each bundle once, so these runs overstate it.
- **Prepares: about 15 ms slower** (pooled medians 247 and 263 ms), as before the merge. Per spot (6 each) the medians move both ways, from news +76 ms to weather-snow -36 ms, within the run-to-run spread.

So #100 costs what it was measured to cost before it merged, and no more. It is not a regression against the budget: frames while a spot plays did not change.

Afterwards the rig went back to master's player (`4196dd3`, which has #100). A kiosk restart came back on the old player's script from Chromium's HTTP cache. The player web server sends no cache headers, so the page needed a reload that ignored the cache (`Page.reload` with `ignoreCache`).

### The playback module (second architecture review, item 2, 2026-11-20)

The playback loop moved out of `src/main.ts` into `src/playback.ts`, with the same order of calls. Master (`acaf49e`) against the branch (`6563e82`), both built with Vite (main script 227 and 229 kB). #144's method: `examples/stress` built once from the branch (no brand kit) and served to both players, each at `http://localhost:8090/cpb/<build>/`, the full 16-spot playlist, cut, 120 s per run after 10 s to settle, HTTP cache cleared, the service worker bypassed and the origin's storage cleared before each run, the supervisor stopped (the soak logger was already stopped), `device/pi/isolate.py`'s measurement plus `__sf.prepares` (15 per run, from page load). Six runs per build, from 14:37 to 15:03: before, after three times, then after, before three times. Every run drew 7135 to 7170 frames, and nothing was skipped.

| Build | Overall (`all%`) | Playing (`play%`) | Loading next | Worst frame | Prepare median per run (15 each) | Prepare max per run |
| --- | --- | --- | --- | --- | --- | --- |
| Before (`acaf49e`) | 0.92, 0.56, 0.53, 0.43, 0.53, 0.47% | 0.19, 0.13, 0.13, 0.13, 0.13, 0.13% | 22.6, 14.6, 14.4, 12.0, 13.7, 11.9% | 300, 133, 100, 117, 133, 117 ms | 297, 286, 254, 248, 296, 234 ms | 658, 462, 457, 369, 438, 691 ms |
| After (`6563e82`) | 0.51, 0.50, 0.51, 0.57, 0.57, 0.58% | 0.13, 0.14, 0.13, 0.16, 0.11, 0.11% | 14.1, 12.8, 13.7, 14.1, 15.8, 16.4% | 100, 150, 100, 117, 117, 167 ms | 263, 261, 241, 273, 282, 231 ms | 381, 440, 601, 458, 444, 718 ms |

Medians of the six runs, before against after: overall 0.53 and 0.54%, playing 0.13 and 0.13%, loading next 14.0 and 14.1%. All 90 prepares of each build: median 260 and 265 ms, 90th percentile 397 and 381 ms, over 500 ms 3 and 3 times. No change: every figure is within the run-to-run spread. Before's first run, the first after the cache was cleared, has the 300 ms frame (while loading) and the highest loss, as in the sections above; the worst frames otherwise are 100 to 167 ms in both builds.

Afterwards the rig went back to the player it had (`index-Dwf3l023.js`, checked in the page after the kiosk restart), on `kiosk.env.cloud`, with the supervisor running.

### Bound fields in player-core (second architecture review, item 4, #155, 2026-11-20)

A snapshot the player is offered is now checked by `packages/player-core/src/bound.ts`, the rule the sync and the poller use too, which also refuses a table that lacks a mapped column; the spot's locale comes from `screenLocale`. Nothing that draws changed. Master (`3cecf24`) against the branch (`fd682f7`), both built with Vite (main script 229.20 and 229.63 kB). #144's method, as for the playback module above: `examples/stress` built once from the branch and served to both players at `http://localhost:8090/cpb155/<build>/`, the full 16-spot playlist, cut, 120 s per run after 10 s to settle, HTTP cache cleared, the service worker bypassed and the origin's storage cleared before each run, the supervisor stopped (the soak logger was already stopped). Six runs per build, from 20:47 to 21:13, in the order before, after, after, before, before, after, after, before, before, after, after, before. Every run drew 7201 or 7202 frames, and nothing was skipped.

| Build | Overall (`all%`) | Playing (`play%`) | Loading next | Worst frame | Prepare median per run (15 each) | Prepare max per run |
| --- | --- | --- | --- | --- | --- | --- |
| Before (`3cecf24`) | 0.87, 0.57, 0.58, 0.81, 0.67, 0.68% | 0.20, 0.13, 0.14, 0.11, 0.13, 0.13% | 20.8, 15.2, 15.8, 21.4, 17.8, 19.2% | 300, 117, 134, 367, 250, 117 ms | 281, 285, 257, 296, 267, 246 ms | 747, 470, 653, 804, 517, 634 ms |
| After (`fd682f7`) | 0.47, 0.49, 0.53, 0.49, 0.72, 0.46% | 0.10, 0.07, 0.11, 0.10, 0.39, 0.14% | 12.7, 13.8, 14.5, 13.5, 12.4, 11.4% | 133, 83, 100, 117, 283, 117 ms | 249, 263, 275, 261, 252, 260 ms | 712, 527, 456, 507, 420, 459 ms |

Medians of the six runs, before against after: overall 0.68 and 0.49%, playing 0.13 and 0.11%, loading next 18.5 and 13.1%. All 90 prepares of each build: median 267 and 262 ms, 90th percentile 440 and 413 ms, over 500 ms 7 and 3 times. No cost. The branch's losses while loading are lower in this session; nothing in the change runs while a spot loads (a snapshot is checked when it is offered, once a minute here), so that is the session's spread, not a gain.

Afterwards the rig went back to the player it had (`index-Bx5JgWcb.js`, checked in the page after the kiosk restart), on `kiosk.env.cloud`, with the supervisor running.

After the review, the player also offers a snapshot it refused for the manifest playing to the next manifest it adopts, when the sync had named that one. The same method, master (`3cecf24`'s player, which master has not changed since) against `6155e28` (main script 229.97 kB), three runs each from 22:01 to 22:14 in the order before, after, after, before, before, after, every run 7201 to 7203 frames with nothing skipped: overall 0.72, 0.44, 0.60% against 0.53, 0.49, 0.54%; playing 0.13, 0.10, 0.20% against 0.13, 0.10, 0.13%; loading next 19.4, 12.1, 13.8% against 14.2, 13.3, 14.0%; all 45 prepares median 257 and 269 ms, 90th percentile 448 and 358 ms, over 500 ms 2 and 0 times. No cost. The rig went back to the same player on `kiosk.env.cloud`, with the supervisor running.

## The sun and moon cross the sky (issue #70, 2026-11-18)

weather 1.3.0 places the sun or moon on an arc from sunrise, sunset and `now()`, mixes the day and night skies, and adds a dawn or dusk glow, the moon's phase (a `clip-path`) and stars. Four spots with fixed data, with sunrise and sunset set around the time of the run: clear midday, partly cloudy 5 min after sunset (glow, clouds, faint stars), clear night (moon, stars), rain 5 min after sunset (glow muted, rain tiles). Before: master's weather 1.2.1 with `isDay` instead. This branch's player at a subdirectory of the rig, cut, 45 s per spot after 10 s to settle, HTTP cache cleared and the service worker bypassed before each run, the soak logger stopped, `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Order before, after, after, before. Portrait by rotating the output (`wlr-randr --transform 90`; cage resizes Chromium to 1080×1920), restored afterwards.

| Orientation | Spot | Overall (before; after) | Playing (before; after) | Worst frame | Prepares, ms (before; after) |
| --- | --- | --- | --- | --- | --- |
| Landscape | midday | 0.11, 0.22%; 0.15, 0.22% | 0.00; 0.00% | 33-50; 33-50 ms | 164-182; 166-185 |
| | dusk | 0.19, 0.19%; 0.15, 0.15% | 0.00; 0.00% | 33; 33 ms | 168-206; 167-183 |
| | night | 0.00, 0.07%; 0.04, 0.00% | 0.00; 0.00% | 17-33; 17-33 ms | 147-151; 151-154 |
| | rain at dusk | 1.96, 1.67%; 1.67, 1.63% | 1.23, 1.00; 0.88, 0.96% | 133; 117 ms | 372-500; 385-473 |
| Portrait | midday | 0.67, 0.59%; 0.70, 0.67% | 0.27, 0.23; 0.30, 0.30% | 67; 67 ms | 238-285; 239-286 |
| | dusk | 0.59, 0.67%; 0.67, 0.67% | 0.26, 0.34; 0.30, 0.38% | 67; 67 ms | 211-254; 241-275 |
| | night | 0.19, 0.22%; 0.19, 0.15% | 0.15, 0.19; 0.15, 0.11% | 33; 33 ms | 151-183; 164-535¹ |
| | rain at dusk | 5.74, 5.33%; 5.77, 5.29% | 4.72, 4.46; 4.55, 4.50% | 100; 83-117 ms | 458-893; 459-904 |

No extra dropped frames and no longer frames. Nothing was skipped. ¹ One of 8 prepares; 12 more, alternating (30 s each), were 164-181 ms after and 150-166 ms before. Rain in portrait drops 4.5-5.7% before and after alike; it is over the 1% budget already in 1.2.1 and is not changed here.

The first version drew the stars as twelve full-screen repeating `radial-gradient` layers, and the stars and glow through `opacity`. In portrait it played dusk and night with a 167-200 ms frame at every play (1.4-1.9% dropped, against 0.3-0.6%), and landscape dusk dropped 0.94% while playing (0.00%). Those layers are rastered as the frame comes on screen. Stars as 60 small dots, and the glow's strength in its gradient stops' alpha, removed it (the table).

## Accent text measured on its real backdrop, 3:1 for large text (issue #92, 2026-11-19)

agenda 1.2.3 (shipped as 1.3.1 after #98, the same bundle), menu-board 1.2.3 and cstore-promo 1.2.4 measure accent-coloured text against what it sits on, resolved with the SDK's `painted` on a 1x1 canvas: menu-board reads its card's style once after the rows are in, agenda paints each kind of card (ordinary, happening now) over both ends of its gradient, four reads at most instead of one per row, and cstore-promo paints the kit's surface over both ends of its stage. Every template with accent text passes `{ large: true }` to `readableOn` (news 1.3.4, shipped as 1.4.1 with the same bundle, clock 1.2.3 and photo-promo 1.2.3 change only that). Same method as #69: this branch's player at a subdirectory of the rig on its own origin (`http://localhost:8090`, so the kiosk's caches are untouched), `examples/stress` built from master's templates (before) and this branch's (after), with no kit and with the demo kit's colours (a scratch copy with a `brand.json`). Cut, 60 s per run after 10 s to settle, HTTP cache cleared and the service worker bypassed before each run, `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Two playlists: sport-drinks, energy, menu, clock; and meeting-room, holidays, news, photo-berries. Order alternated (before, after, after, before), then menu's playlist again for the variants below. The supervisor was stopped during the runs: its liveness check restarts the kiosk 30 s after the kiosk's player stops beating, which it does as soon as the page is navigated away.

| Content | Build | Runs | Overall | Playing | Loading next | Worst frame |
| --- | --- | --- | --- | --- | --- | --- |
| stress, no kit | before | 6 | 0.06-0.22% | 0.00-0.03% | 1.6-11.1% | 50 ms |
| | after | 7 | 0.06-0.33% | 0.00-0.09% | 0.0-17.1% | 67 ms |
| stress, demo kit | before | 5 | 0.06-0.22% | 0.00-0.06% | 1.6-11.4% | 50 ms |
| | after | 4 | 0.06-0.25% | 0.00% | 3.1-12.2% | 67 ms |

Prepares (ms, median before / after, over both kits): meeting-room (agenda) 185 / 178, holidays (agenda) 150 / 146, menu (menu-board) 192 / 203, sport-drinks (cstore-promo) 220 / 211, energy (cstore-promo) 225 / 234, clock 167 / 167, news 151 / 149, photo-berries 199 / 198.

No cost in frames: the ranges overlap and nothing was skipped. Agenda's meeting room is about 7 ms faster than master and gives back about a third of #69's 20 ms, now that a card is read once per kind and not per row. Menu-board prepares about 11 ms slower (before 167-201, after 197-229, 14 prepares each), well within 500 ms. Four variants did not move it, so it is not the canvas: `willReadFrequently: true` (200 ms), compositing the colours arithmetically with no canvas (204), reading the first card before the other rows are in (202, 234), and a registered `@property --card` read from the stage's style with no row's style read at all (193-221). cstore-promo's two prepares move in opposite directions, run-to-run noise.

Review fixes (PR #104): clock 1.2.3 now measures its greeting over its accent glow, one more 1x1 canvas read in `prepare` (`painted(bg, [accent, 0.12])`), and photo-promo's eyebrow keeps 4.5:1 (no canvas). Same method, 2026-11-19 07:49, master's templates (clock 1.2.2) against this branch's, no kit and the demo kit, before, after, after, before; playlists sport-drinks, energy, menu, clock and clock, photo-berries, photo-river; 60 s each.

| Content | Build | Runs | Overall | Playing | Loading next | Worst frame |
| --- | --- | --- | --- | --- | --- | --- |
| stress, no kit | before | 4 | 0.11-0.39% | 0.00-0.03% | 5.2-13.7% | 67 ms |
| | after | 4 | 0.28-0.36% | 0.00-0.03% | 10.7-12.5% | 83 ms |
| stress, demo kit | before | 4 | 0.17-0.25% | 0.00% | 8.1-9.4% | 67 ms |
| | after | 4 | 0.08-0.33% | 0.00-0.03% | 2.7-12.9% | 83 ms |

Clock prepares 182 / 180.5 ms (median before / after, 20 each, 144-268 / 146-266): the canvas read costs nothing measurable. photo-berries 215.5 / 216.5, photo-river 233 / 231.5. menu (menu-board) 200 / 217, the same gap as above. The rig was slower than in the night's runs for every spot (energy 298 ms against 225), so compare within this table only. Frames while playing are unchanged; the 83 ms frames are within what earlier sections record from run to run.

## Table bindings: menu-board fed by a CSV (issue #84, 2026-11-19)

menu-board's items from a table binding (1.3.0 here; measured on 1.2.2's bundle, before #104's contrast change, which the mapping does not touch: it runs in the player) (the contract's `tableItems`: column mapping, a filter, cut to `maxItems`, run by the player as the spot prepares) against the same template with its items typed. A scratch copy of `examples/stress` with two spots: `menu-typed`, 12 typed items, and `menu-table`, bound to a `TableFeed` snapshot of 24 rows (2x `maxItems`; every third price a JSON number, written in the screen's locale), filtered to one section that every row is in, so 12 are drawn. This branch's player at a subdirectory of the rig, the content beside it with the snapshot at `data/menu-table.json`; HTTP cache cleared and the service worker bypassed before each run, the soak logger stopped, `device/pi/isolate.py`'s measurement plus `__sf.prepares`, 60 s per run after 10 s to settle. A screenshot confirmed 12 rows from the table on screen, and `__sf.dataRejected` stayed empty.

| Spots | Transition | Runs | Overall | Playing | Loading next | Worst frame | Prepares (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| menu-typed | cut | 3 | 0.03-0.06% | 0.00-0.03% | 1.5-1.6% | 33 ms | 153-345, median 165 |
| menu-table | cut | 3 | 0.03% | 0.00-0.03% | 0.0-1.6% | 33 ms | 151-235, median 164 |
| menu-typed, photo-river | fade 600 | 2 | 0.14, 0.19% | 0.09, 0.06% | 2.9, 6.7% | 50, 67 ms | menu 165-375 |
| menu-table, photo-river | fade 600 | 2 | 0.28, 0.11% | 0.12, 0.06% | 7.6, 2.8% | 50, 50 ms | menu 168-254 |

Order alternated (cut: typed, table, table, typed, typed, table; fade: table first, then typed first). No cost: the ranges overlap run for run, and mapping 24 rows adds nothing visible to a prepare (medians 164 and 165 ms). Only `maxItems` rows reach the template, so a longer file costs the player one pass over its rows (the snapshot limit, 64 kB, bounds it). The one 67 ms frame was in a typed run. Nothing was skipped.

## Takeovers cut in and end offline (M3-19, 2026-11-19)

This branch's player (`m3-19-playlist-assignment`) on the rig, synced from a local API on the Mac over the LAN (`wrangler dev`, the screen's own credential, `?poll=10`), content pushed with `sf push`, which notifies the screen's socket as a publish does. Two playlists of one 60 s image spot each: `main`, the default, and `flash`. A takeover is a schedule entry for `flash` with `startsAt`/`endsAt`, priority 100. Times are the player's own `__sf.log` (`startedAt` of each spot) against the Mac's clock when `sf push` returned; the two clocks agreed to within the ssh round trip (about 0.2 s).

| Trial | Takeover pushed, on screen after | Cut, s into the 60 s spot | Takeover removed by a publish, `main` on screen after | Cut, s into the spot |
| --- | --- | --- | --- | --- |
| 1 | 0.42 s | 3.6 | 0.28 s | 27.0 |
| 2 | 0.41 s | 30.4 | 0.28 s | 38.1 |
| 3 | 0.18 s | 37.3 | 0.34 s | 24.2 |
| 4 | 0.10 s | 19.2 | 0.26 s | 35.1 |
| 5 | 0.20 s | 26.3 | 0.28 s | 21.1 |

Every change of takeover cut the spot on screen within half a second of the push, wherever the spot was; a publish that changes no takeover still waits for the spot's end (the CMS e2e checks that).

Ending offline: a takeover ending 100 s after it was pushed; once it played, the local API was stopped (04:21:56 UTC; the Pi then got no answer from it, and no sync succeeded after 04:21:45). `endsAt` was 04:23:24.000; `main` started at 04:23:24.016, 39 s into the flash spot. The player's `online` flag turned false only at its next sync, 04:26:17: it reports the last sync, not the socket, as before this change.

### Steady playback with no takeover (M3-19 review, 2026-11-20)

The change adds work at every spot boundary (`activeTakeover` twice more, a timer reset) and none per frame. #91's method, as in "After the merge" above: `examples/stress` built once from master and served to both players, each at `http://localhost:8090/m319/<build>/`, the full 16-spot playlist, cut, 120 s per run after 10 s to settle, HTTP cache cleared, the service worker bypassed and the origin's storage cleared before each run, the soak logger and the supervisor stopped, `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Master `fcee189` against the branch `eec8e29`, master/branch/branch/master, starting 01:00 at night. Every run drew about 7160 frames, and nothing was skipped.

| Build | Overall (`all%`) | Playing (`play%`) | Loading next | Worst frame | Prepares, median and max (13 each) |
| --- | --- | --- | --- | --- | --- |
| Master (`fcee189`) | 0.74, 0.44% | 0.17, 0.10% | 18.6, 12.4% | 300, 100 ms | 271 / 726, 230 / 528 ms |
| This branch (`eec8e29`) | 0.54, 0.50% | 0.14, 0.11% | 14.6, 13.3% | 100, 100 ms | 259 / 396, 256 / 465 ms |

No cost: playing is 0.10 to 0.17% in both, within the spread the sections above found for master alone; master's 300 ms frame was again in its first run after the cache was cleared.

## The eyebrow measured over the photo (issue #124, 2026-11-20)

photo-promo 1.3.0 measures its eyebrow over the photo under it: in `prepare` it draws the part of the photo under the text (wherever the push-in takes it) into a small canvas, one pixel per 4 px in the runs below (one per pixel as painted since the review: next section), paints the shade over it at the text's top and bottom, and reads it once (`readableOver`). Master's player at `http://localhost:8090/cpb124/` (its own origin, so the kiosk's caches are untouched), `examples/stress` built from master's templates (before, photo-promo 1.2.3) and this branch's (after), with no kit and with the demo kit's colours (a scratch copy with a `brand.json`). Playlist photo-berries (1080p photo), photo-river and photo-kitchen (4K photos); cut, HTTP cache and the origin's storage cleared before each run, 10 s to settle, the supervisor stopped, `device/pi/isolate.py`'s measurement plus `__sf.prepares`. Order alternated (before, after, after, before).

The first version awaited `img.decode()` before drawing (round 1, 90 s runs, 22 prepares per build and kit):

| Content | Build | Overall | Playing | Loading next | Worst frame | Prepare median | Range | Over 500 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no kit | before | 0.20, 0.26% | 0.00, 0.04% | 7.1, 7.6% | 50 ms | 225 ms | 194-343 | 0 |
| | after | 0.28, 0.31% | 0.04, 0.04% | 5.0, 5.9% | 50 ms | 372 ms | 324-461 | 0 |
| demo kit | before | 0.15, 0.19% | 0.00, 0.06% | 4.6, 4.9% | 33 ms | 213 ms | 195-345 | 0 |
| | after | 0.35, 0.44% | 0.02, 0.06% | 5.7, 8.2% | 67 ms | 409 ms | 346-576 | 1 |

Variants, no kit, 45 s runs, 12 prepares each (master 224 ms in the same set): awaiting the decode and reading the layout with no draw, 284 ms; `createImageBitmap(img, crop, { resizeWidth, resizeHeight })` in place of `drawImage`, 384 ms; a 256x256 canvas (large enough for Chromium to accelerate) with only the corner read back, 392 ms; drawing without awaiting `img.decode()` first, 302 ms. `drawImage` decodes the photo for the canvas itself, so a decode awaited first was a second one.

What ships draws without awaiting the decode (round 2, 60 s runs, 14 prepares per build and kit):

| Content | Build | Overall | Playing | Loading next | Worst frame | Prepare median | Range | Over 500 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no kit | before | 0.22, 0.25% | 0.03, 0.03% | 6.9, 8.0% | 50 ms | 230 ms | 211-276 | 0 |
| | after | 0.19, 0.67% | 0.03, 0.44% | 4.2, 5.7% | 267 ms | 304 ms | 279-622 | 2 |
| demo kit | before | 0.19, 0.28% | 0.03, 0.06% | 5.7, 7.2% | 50 ms | 241 ms | 194-332 | 0 |
| | after | 0.25, 0.31% | 0.00, 0.03% | 5.2, 7.1% | 50 ms | 343 ms | 296-477 | 0 |

A cost: the canvas decode adds about 75 to 100 ms to each photo-promo prepare (river, a 4K photo, most: 235 to 434 ms median with no kit), and two of 28 prepares went over 500 ms (449 and 622 ms, berries and river). One run had a 267 ms frame while playing; the other three after-runs were as before. Nothing was skipped. The decode is of the whole photo however small the part read; the template frame cannot fetch its own blob (`connect-src` is `'none'`) to decode a smaller copy off the main thread.

### Review fix: one sample per pixel as painted (2026-11-20)

One sample per 4 px averaged a photo's darkest and lightest detail away: in portrait, where a 4K photo is painted close to 1:1, the demo kit's orange was kept at 2.88:1 over kitchen-4k (PR #168's review). The canvas now has one pixel per pixel of the photo as painted at the push-in's start, over the region the push-in covers, with `willReadFrequently`. Same method with the demo kit's colours, landscape and portrait (portrait by `wlr-randr --transform 90`, restored afterwards), master's player at e55876e.

The first run of it cost far more than the PR's version (prepare median, 14 each: landscape 394 ms against 311, 5 over 500 ms; portrait 656 against 492, 11 over 500 ms), and sampling only the text's box helped little (326 and 533). The cost grew with the number of pixels read: `readableOver` linearised each channel with `**`, three times per pixel. A 256-entry table makes it about 20 times faster (120,000 pixels in 0.3 ms on a Mac, from 6.5). With the table, 50 s runs alternated with master (before) and the PR's previous version:

| Orientation | Build | Runs | Overall | Playing | Worst frame | Prepare median | Range | Over 500 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | master | 3 | 0.20-0.30% | 0.00-0.07% | 67 ms | 220 ms | 196-375 | 0 of 18 |
| | one per 4 px | 2 | 0.17-0.30% | 0.00-0.07% | 33 ms | 337 ms | 280-406 | 0 of 12 |
| | **one per pixel (ships)** | 2 | 0.10-0.27% | 0.00% | 50 ms | 322 ms | 294-399 | 0 of 12 |
| | text box only, both push-in ends | 2 | 0.73-0.87% | 0.03-0.52% | 333 ms | 337 ms | 280-694 | 1 of 12 |
| | text box only, push-in start | 2 | 0.20-0.27% | 0.00-0.03% | 50 ms | 330 ms | 286-432 | 0 of 12 |
| portrait | master | 3 | 0.47-0.80% | 0.03-0.14% | 67 ms | 362 ms | 298-565 | 3 of 18 |
| | one per 4 px | 2 | 0.70-1.10% | 0.00-0.14% | 83 ms | 596 ms | 442-691 | 8 of 12 |
| | **one per pixel (ships)** | 2 | 0.60-0.80% | 0.07% | 83 ms | 522 ms | 357-696 | 6 of 12 |
| | text box only, both push-in ends | 2 | 0.57% | 0.00-0.07% | 67 ms | 446 ms | 375-664 | 4 of 12 |
| | text box only, push-in start | 2 | 0.40-0.97% | 0.00-0.53% | 250 ms | 425 ms | 382-625 | 2 of 12 |

What ships costs no more than the version before the review: about 100 ms per prepare in landscape and 160 ms in portrait over master, the canvas decode of the photo. Portrait is slower for every build, master included (3 of its 18 prepares over 500 ms). Sampling only the text's box is not clearly cheaper, and with one end of the push-in it would not measure what the screen shows at the other. Nothing was skipped; the 333, 267 and 250 ms frames were single runs of the box variants.

## Photo samples: what #168's prepare cost was (issue #169, 2026-11-20/21)

#168's eyebrow measurement added about 90 ms to photo-promo's prepare in landscape and 160 ms in portrait. #169 gives each photo a sample, its darkest and lightest pixel per 16 px cell as a small PNG (`ManifestFile.sample`), for photo-promo to read instead of the photo. Same method as above: each build on its own player at `http://localhost:8090/cpb169/<build>/` with its own `examples/stress` content (the demo kit's colours, built for the screen's orientation, so portrait content has the 3413x1920 renditions), photo-berries, photo-river and photo-kitchen, cut, HTTP cache, service worker and origin storage cleared before each run, 10 s to settle, 45-50 s measured, supervisor stopped, `isolate.py`'s measurement plus `__sf.prepares`.

**Reading the sample alone did not help** (landscape, prepare medians pooled over runs of 6): master before #168 (`e55876e`) 226 ms, #168 (`75cb16a`) 310, the sample read after the photo loads 326. Variants on the branch's player: no eyebrow measurement 240; only the box read and `fonts.ready` 244; waiting for the photo's load, no canvas, 320; `await img.decode()` in prepare, no canvas, 284; the sample read without waiting for the photo 326.

**A trace** (CDP `Tracing.start` on the browser target, every process; marks at the start and end of the template's `prepare`):

- In every build the photo is decoded twice off the main thread before `ready`: once for the SDK's `img.decode()` in `settle`, once by the first raster (`ImageDecodeTask`, about 45-75 ms each for a 1080p photo). They take one lock and run one after the other.
- With no measurement, the SDK's decode is requested before the photo has loaded and runs first; `ready` follows it, and the raster's decode runs beside the first frames: init to ready 120-200 ms.
- #168's `prepare` takes 107-195 ms: 70 ms of it is the photo decoded on the main thread for the canvas (`OffscreenCanvasRenderingContext2D::FinalizeFrame`, `DecodingImageGenerator::getPixels`). The two decodes off the main thread come after.
- When `prepare` waits (for the photo's load, or a sample's decode), a frame commits with the loaded photo meanwhile, the raster's decode is scheduled first, and the SDK's `img.decode()` waits behind it: `ready` then waits for both decodes, about 80 ms more. Calling `img.decode()` at the start of prepare makes it worse (365 ms): each call decodes again.

**The fix** (photo-promo 1.4.0): the photo is `visibility: hidden` until `prepare` returns, so no frame paints it first, and with a sample its size is taken from the sample, to the cell, so prepare does not wait for it to load. Hiding the photo alone, in #168's version, does not help (329 ms): its main-thread decode stays.

| Orientation | Build | Runs | Prepare median | Run medians | Range | Over 500 ms | Playing | Worst frame |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | before #168 (`e55876e`) | 6 | 230 ms | 218-261 | 194-344 | 0 of 36 | 0.00-2.95% | 1300 ms |
| | master (`f9ddeba`, #168) | 6 | 318 ms | 300-327 | 264-613 | 1 of 36 | 0.00-0.23% | 383 ms |
| | **#169** | 6 | 259 ms | 243-277 | 227-679 | 1 of 36 | 0.00-0.04% | 333 ms |
| portrait | before #168 | 6 | 415 ms | 396-595 | 294-853 | 10 of 35 | 0.04-0.97% | 333 ms |
| | master | 6 | 683 ms | 586-1014 | 382-1668 | 20 of 31 | 0.00-1.00% | 417 ms |
| | **#169** | 6 | 427 ms | 415-487 | 329-905 | 10 of 33 | 0.04-0.32% | 350 ms |

Runs alternated (before, master, fix, fix, master, before, three times) on 2026-11-21 00:08-00:37; nothing was skipped. Against before #168: portrait +12 ms (95% bootstrap interval -68 to +49 ms, Mann-Whitney p 0.42), within noise; landscape +29 ms (1.5 to 47.5 ms, p 0.004), not. The landscape rest is the measuring's own main-thread work (a forced style and layout of about 12 ms, the sample's decode and canvas) not yet traced. The before runs' 1300 ms and 467-533 ms frames while playing were in three of its six landscape runs and none of the others'.

## The look kit (issue #190, 2026-11-21)

The kit's test template (`packages/template-looks/looks-test`) under each look. The layout: a headline, body, figure and meta beside a 1080p photo (berries-1080) that drifts, a crawl, a pulsing dot and a wobbling eyebrow, all switched on. The branch's player was at `http://localhost:8090/cpb190/` (its own origin) with content built per orientation, each look a spot of 10 s played on its own. Method: `device/pi/isolate.py`'s measurement pointed at that player, 10 s to settle and 30 s measured. The HTTP cache and the origin's storage were cleared and the service worker bypassed before each spec, the supervisor stopped, and `__sf.prepares` read after each spec. The five prepares of a spec include its first, which follows a cold load: 520 to 661 ms in every spec. Portrait was set with `wlr-randr --transform 90` and restored afterwards.

| Orientation | Transition | Look | Overall | Playing | Loading next | Worst frame | Prepares (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | cut | Pop | 0.28% | 0.00% | 8.6% | 50 ms | 562, 312, 311, 326, 308 |
| | | Poster | 0.50% | 0.00% | 10.3% | 67 ms | 637, 331, 343, 627, 456 |
| | | Night | 0.33% | 0.00% | 10.9% | 50 ms | 520, 280, 295, 293, 305 |
| | | Corporate | 0.39% | 0.00% | 12.1% | 67 ms | 629, 439, 319, 323, 286 |
| | fade | Pop | 0.78, 0.61, 0.67% | 0.12, 0.06, 0.00% | 13 to 19% | 117, 67, 67 ms | 533, 329, 414, 310, 326 |
| | | Poster | 0.33% | 0.00% | 9.5% | 50 ms | 661, 330, 328, 364, 344 |
| | | Night | 0.44% | 0.00% | 14.0% | 67 ms | 618, 308, 311, 294, 325 |
| | | Corporate | 0.39% | 0.00% | 13.7% | 50 ms | 551, 279, 278, 276, 275 |
| portrait | cut | Pop | 1.28% | 0.41% | 19.8% | 83 ms | 561, 626, 478, 446, 461 |
| | | Poster | 0.89% | 0.06% | 15.5% | 67 ms | 605, 507, 759, 441, 419 |
| | | Night | 1.06% | 0.06% | 19.0% | 67 ms | 588, 483, 665, 462, 453 |
| | | Corporate | 1.33% | 0.29% | 20.2% | 83 ms | 577, 466, 445, 655, 438 |
| | fade | Pop | 2.33% | 0.43% | 21.8% | 83 ms | 543, 728, 466, 445, 543 |
| | | Poster | 1.39% | 0.06% | 16.5% | 67 ms | 609, 649, 483, 498, 721 |
| | | Night | 1.39% | 0.12% | 15.9% | 83 ms | 542, 516, 486, 464, 506 |
| | | Corporate | 1.89% | 0.25% | 21.5% | 83 ms | 564, 474, 582, 446, 513 |

Prepare medians over cut and fade (10 each): landscape Pop 326, Poster 354, Night 307, Corporate 303 ms; portrait Pop 511, Poster 556, Night 496, Corporate 494 ms. While fading, landscape dropped 0 to 2.2% of frames and portrait 7.5 to 17.4%. The 117 ms frame came in one of three landscape Pop fade runs only. Nothing was skipped.

- **Decoding a look's fonts is not the cost.** In the player page, `new FontFace(name, url(<the bundle's data: URL>)).load()` takes 2 to 3 ms per family, median of 5, two rounds: Inter 2.4 to 3.3, Bricolage Grotesque 2.0 to 2.4, Instrument Serif's two faces 2.2 to 2.9, Unbounded 2.4 to 2.8, Space Mono's two faces 1.7 to 2.3, Inter Tight 2.2 to 2.3 ms. So a look's own faces cost under 10 ms: Night, with three families, the most.
- **A bundle with only Pop's faces, first A/B** (re-measured below, which corrects it). The same template with only Pop's faces in its bundle (139,470 bytes, against 369,674) was played alternately with the full one, Pop, cut, three runs each. Landscape: prepare median 323 against 475 ms (15 each), overall 0.28, 0.50, 0.72% against 0.61, 0.89, 0.83%. Portrait: 426 against 517 ms, overall 1.83 (one 300 ms frame while playing), 1.28, 1.11% against 1.55, 1.72, 1.78%. Part of it is the player's own reading of every bundle before it frames it (`containedFrames`, parse5 and a SHA-256 of the script), measured in the kiosk page: 43 to 47 ms for the full bundle, 13 to 16 ms for Pop's. The rest was put down to Chromium parsing the larger document; the trace below does not bear that out. Its landscape median (475 ms) also disagreed with the per-look table above, which measured the same full bundle and look at 326 ms.
- In portrait the test template is over 1% overall even with Pop's faces alone, and its prepares are near or over 500 ms. Its frames are dropped while the next spot loads (16 to 24%); while it only plays it stays at 0.06 to 0.43%. Each template built on the kit (#197 to #202) measures its own layout.

### Re-measured for the review (2026-11-21, 03:20 to 04:10)

The same player and method, the bundles rebuilt with the fonts' licence notice (375,031 and 144,827 bytes), Pop, cut, 10 s spots, 30 s measured after 10 s to settle. Medians leave out each run's first prepare, which follows a cold load; those are given apart.

**The A/B, alternated ABBA twice per orientation (four runs, 16 prepares each):**

| Orientation | Bundle | Prepare median | Per run, after the first | First prepare | Overall | Playing | Worst frame |
| --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | Pop's faces | 294 ms | 275-312 in every run | 417-425 ms | 0.28-0.33% | 0.00% | 33-67 ms |
| | all four looks | 415 ms | 309-388 (one 690), 421-468, 409-475, 326-344 | 544-646 ms | 0.50-1.44% | 0.00-0.06% | 67-300 ms |
| portrait | Pop's faces | 427 ms | 425-516, 406-648 (two runs) | 431-477 ms | 0.89, 1.28% | 0.35, 0.41% | 50-67 ms |
| | all four looks | 485 ms | 432-655, 443-555 (two runs) | 536-727 ms | 1.67, 1.94% | 0.35, 0.41% | 83-100 ms |

- **The full bundle's prepares are bimodal.** Its landscape runs sit either at the Pop-only bundle's level (326-344 ms) or about 130 ms higher (409-475 ms), a whole run at a time. The first per-look table caught the fast mode, the first A/B the slow one. With Pop's faces only, all four landscape runs were fast here.
- **The first prepare after a page loads** is about 180 ms slower with the full bundle in landscape (544-646 against 417-425 ms), every run.
- **The trace finds no thread doing more work for the full bundle.** This was a browser-wide trace (CDP `Tracing.start` on the browser target) over 22 s after 12 s to settle, two traces per bundle in landscape. Summed per prepare, task time per thread was the same within about 20 ms for both bundles: GPU main about 1,500 ms, viz compositor about 700, renderer main threads about 680-700, compositor about 490, browser main about 160, thread pool 78-104. On the renderers' main threads, style, layout and paint took the same time; HTML parsing took about 20 ms a prepare for the full bundle and under 17 ms for Pop's (out of its top 28 events). Under tracing both bundles fell into the slow mode at times: Pop's prepares reached 446 to 591 ms in two of its three traces. So beyond the player's parse and hash (43-47 against 13-16 ms) the gap is waiting, not work, and its cause is not found.
- **300 ms frames.** One came in the first landscape run of the full bundle, while the next spot was preparing (the 690 ms prepare). The other was in the first session's first Pop-only portrait run, while playing. Neither came again in 30 later runs.

**What takes portrait over 1%:** the same full bundle, Pop, with one part switched off at a time, two runs each, alternated (prepares after the first):

| Variant | Overall | Playing | Loading next | Prepares |
| --- | --- | --- | --- | --- |
| everything on | 1.94, 1.67% | 0.35, 0.41% | 25-30% | 432-655 ms |
| no photo drift (`.lk-drift`) | 0.67, 0.72% | 0.12, 0.17% | 12.4% | 430-650 ms |
| no ambient motion (drift, wobble, pulse, ping) | 0.94, 0.44% | 0.06% | 8-18% | 381-554 ms |
| no `will-change` on the kit's classes | 1.50, 1.28% | 0.35, 0.41% | 18-20% | 449-768 ms |
| no crawl (`showCrawl` off) | 1.22, 1.39% | 0.24, 0.41% | 16-18% | 478-841 ms |
| no photo (`showPhoto` off) | 0.89, 0.61% | 0.06% | 17-21% | 313-333 ms (531 once) |
| Pop's faces only | 1.28, 0.89% | 0.35, 0.41% | 12-20% | 406-648 ms |

- The ablation ran on Pop only; every look drifts its photo (22 to 32 s a cycle). Its "everything on" and "Pop's faces only" rows are the same runs as the portrait A/B above.
- The photo's drift is the largest part of what takes portrait over 1%: a photo the screen's width, rescaled every frame while the next spot loads. With the drift off the template stays under 1% with everything else on (0.67, 0.72%). It is not the only part: the four-look bundle drops more than one with Pop's faces only (1.67, 1.94% against 0.89, 1.28%), most of it while the next spot loads (25 to 30% against 12 to 20%), where its slower prepare falls. Two runs per variant, and earlier Pop-only portrait runs ranged from 0.89 to 1.83%.
- Since then the kit holds `.lk-drift` still in portrait (docs/template-spec.md, Looks).
- The photo is also most of the prepare: with it off, prepares fall from about 480 to about 330 ms, as photo-promo's decode cost (Photo samples, above).
- Dropping `will-change` does not help.

## Countdown (issue #198, 2026-11-21)

`templates/countdown` at `6524776`, each look a 10 s spot played on its own, in the screen's zone (New York): a countdown 12 days, 3 hours and minutes away, in days, hours and minutes (its minutes tick), with two facts and every toggle on, and a count-up 210 days since its target with a record of 301 (Poster's record panel, Night's record cards, Corporate's scale). The branch's player was at `http://localhost:8090/cp198/<orientation>/` with content built per orientation; portrait was set with `wlr-randr --transform 90` and restored afterwards. Method as for Room status: `device/pi/isolate.py`'s measurement pointed at that player, 10 s to settle and 30 s measured, the HTTP cache and the origin's storage cleared and the service worker bypassed before each spec, the supervisor and the soak logger stopped, `__sf.prepares` read after each spec. The first of a spec's five prepares follows a cold load.

| Orientation | Transition | Spot | Overall | Playing | Loading next | Worst frame | Prepares (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | cut | Pop, down | 0.50% | 0.00% | 17.3% | 67 ms | 623, 365, 326, 261, 259 |
| | | Poster, down | 0.39% | 0.00% | 13.7% | 67 ms | 564, 232, 250, 331, 257 |
| | | Night, down | 0.33% | 0.00% | 14.0% | 50 ms | 573, 245, 229, 232, 243 |
| | | Corporate, down | 0.44% | 0.00% | 20.0% | 50 ms | 668, 243, 213, 211, 226 |
| | | Pop, up | 0.50% | 0.11% | 12.7% | 67 ms | 584, 282, 378, 258, 259 |
| | | Poster, up | 0.39% | 0.00% | 14.6% | 67 ms | 579, 228, 228, 281, 276 |
| | | Night, up | 0.28% | 0.00% | 11.9% | 50 ms | 589, 248, 218, 230, 243 |
| | | Corporate, up | 0.28% | 0.00% | 11.6% | 50 ms | 659, 277, 212, 244, 242 |
| | fade | Pop, down | 0.39% | 0.06% | 12.5% | 50 ms | 656, 311, 262, 245, 276 |
| | | Poster, down | 0.39% | 0.00% | 12.5% | 67 ms | 604, 300, 301, 329, 296 |
| | | Night, down | 0.44% | 0.00% | 17.8% | 50 ms | 566, 230, 229, 280, 230 |
| | | Corporate, down | 0.28% | 0.00% | 11.6% | 50 ms | 559, 247, 247, 229, 229 |
| portrait | cut | Pop, down | 0.33% | 0.11% | 8.5% | 50 ms | 616, 225, 222, 302, 218 |
| | | Poster, down | 0.39% | 0.00% | 13.2% | 67 ms | 593, 287, 282, 296, 298 |
| | | Night, down | 0.22% | 0.00% | 9.5% | 50 ms | 585, 209, 210, 209, 260 |
| | | Corporate, down | 0.17% | 0.00% | 7.7% | 33 ms | 679, 208, 206, 206, 207 |
| | | Pop, up | 0.17% | 0.00% | 7.1% | 33 ms | 723, 244, 225, 222, 220 |
| | | Poster, up | 0.44% | 0.00% | 14.8% | 67 ms | 596, 298, 295, 295, 294 |
| | | Night, up | 0.17% | 0.00% | 7.7% | 33 ms | 716, 212, 211, 210, 209 |
| | | Corporate, up | 0.28% | 0.06% | 9.5% | 50 ms | 573, 231, 261, 208, 207 |
| | fade | Pop, down | 0.17% | 0.00% | 7.1% | 33 ms | 727, 272, 221, 224, 220 |
| | | Poster, down | 0.61% | 0.06% | 17.0% | 67 ms | 583, 287, 297, 277, 297 |
| | | Night, down | 0.72% | 0.06% | 9.1% | 50 ms | 587, 214, 215, 296, 207 |
| | | Corporate, down | 0.39% | 0.18% | 10.3% | 50 ms | 558, 209, 209, 208, 206 |

- Dropped frames: 0.17 to 0.72% overall, at most 0.18% while playing, nothing skipped.
- **The worst frame is over the 50 ms rule in 8 of 24 specs**: 67 ms in all six Poster specs and in Pop's two landscape cuts. In 6 of the 8 nothing was dropped while playing, and each long frame came while the next spot loaded, as with the kit's test template (67 to 117 ms) and Room status (67 ms in 17 of 24). Not accepted here: for the owner to accept, or to look at in the batch run (#203), Poster first, which has it in every spec and the slowest prepares.
- Prepares after the first (12 per look and orientation): landscape medians Pop 269, Poster 279, Night 231, Corporate 236 ms (211 to 378); portrait Pop 223, Poster 295, Night 211, Corporate 208 ms (206 to 302). None over 500 ms.
- First prepares, after a cold load of the page, were 558 to 727 ms: over the 500 ms budget, as for every template carrying the four looks (The look kit; Room status).
- **Portrait holds the ambient motion still.** An earlier build kept Pop's tile and stickers wobbling, its last dot and Night's live dot pulsing and pinging, and Night's ring sweeping in, in portrait too. Portrait cuts were under 1% (0.39 to 0.89%), but fades into a portrait countdown were not: Pop 1.11, 1.28, 1.78 and 1.61, 1.11% (the third with a 250 ms stall while playing), Night 0.94, 1.28 and 1.17, 1.33%, dropping 4 to 11% of frames while fading. The same build with the ambient motion held still in portrait: Pop 0.39, 0.22%; Night 0.67, 0.94%, and with the ring's sweep held too 0.61, 0.22%. Prepares fell with it, about 350 to about 230 ms in portrait (two runs each, interleaved, one session). The template now holds both still in portrait, as the kit holds `.lk-drift` (The look kit). Landscape keeps them: 0.28 to 0.56% in both builds.
- **Night's ring** is two half-discs, each rotated inside its own clipping half, with the end cap on a rotating arm: transforms only, no `stroke-dashoffset`. On the Pi the halves' meeting edge at 6 o'clock showed the track through as a 1 px hairline once the ring was past half: the ring is 70.4vmin, 760.32 px, so the centre line falls on a fraction of a pixel and both edges are smoothed there. A 0.4vmin strip of the fill over the join, shown as the left half starts, removes it; 12 o'clock is under the start cap. Screenshots on the Pi of a full ring and one at 52% after the fix show no seam at either.
## The Alert template (issue #200, 2026-11-21)

`templates/alert` at `99832a4`, each severity a 10 s spot with its defaults and a QR code, played on its own. The branch's player was at `http://localhost:8090/cp200/<orientation>/` with content built per orientation; portrait was set with `wlr-randr --transform 90` and restored afterwards. Method as for the look kit: `device/pi/isolate.py`'s measurement pointed at that player, 10 s to settle and 30 s measured, the HTTP cache and the origin's storage cleared and the service worker bypassed before each spec, the supervisor stopped (the soak logger was already off), `__sf.prepares` read after each spec. The first of a spec's five prepares follows a cold load.

| Orientation | Transition | Severity | Overall | Playing | Loading next | Worst frame | Prepares (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | cut | emergency | 0.11% | 0.00% | 6.1% | 33 ms | 476, 317, 171, 168, 170 |
| | | warning | 0.00% | 0.00% | 0.0% | 17 ms | 336, 163, 162, 149, 146 |
| | | advisory | 0.06% | 0.00% | 3.2% | 33 ms | 428, 204, 156, 173, 169 |
| | | notice | 0.00% | 0.00% | 0.0% | 17 ms | 322, 180, 161, 161, 224 |
| | fade | emergency | 0.17% | 0.00% | 8.8% | 33 ms | 323, 180, 179, 195, 177 |
| | | warning | 0.00% | 0.00% | 0.0% | 17 ms | 326, 163, 163, 147, 159 |
| | | advisory | 0.11% | 0.00% | 3.0% | 33 ms | 316, 180, 162, 161, 209 |
| | | notice | 0.00% | 0.00% | 0.0% | 17 ms | 326, 163, 161, 162, 145 |
| portrait | cut | emergency | 0.17% | 0.00% | 7.0% | 33 ms | 354, 229, 229, 244, 228 |
| | | warning | 0.06% | 0.00% | 3.1% | 33 ms | 364, 197, 158, 173, 173 |
| | | advisory | 0.11% | 0.00% | 5.4% | 33 ms | 328, 177, 250, 174, 172 |
| | | notice | 0.11% | 0.06% | 2.8% | 33 ms | 324, 178, 178, 222, 172 |
| | fade | emergency | 0.22% | 0.00% | 9.5% | 50 ms | 337, 214, 231, 231, 230 |
| | | warning | 0.00% | 0.00% | 0.0% | 17 ms | 399, 246, 206, 163, 159 |
| | | advisory | 0.17% | 0.00% | 0.0% | 33 ms | 363, 215, 228, 175, 172 |
| | | notice | 0.06% | 0.00% | 2.8% | 33 ms | 315, 163, 177, 228, 173 |

- Every case is far inside the budget: at most 0.22% of frames dropped overall, 0.06% while playing, no frame over 50 ms, nothing skipped.
- Prepares after the first: medians about 165 ms in landscape and 175 to 230 ms in portrait. First prepares were 315 to 476 ms. The 120 kB bundle carries two faces (Space Grotesk and Inter) and not the look kit, which is about half the time of the kit's test template (300 to 500 ms). An alert starts quickly.
- Emergency's pulse (the band's glow and its icon, every 2 s) costs nothing measurable while playing (0.00%). It drops a little more than the others while the next spot loads (6 to 10%), as its two layers keep animating under the load.

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


## Room status (issue #199, 2026-11-21)

`templates/room-status` at `94081df`, each look a 10 s spot played on its own: a day with four bookings, busy (a meeting in progress, with its organiser and the next one) and free (the next meeting in 90 minutes), the schedule and every toggle on. No photo. The bookings were placed around the session's start, so each state held throughout. The branch's player was at `http://localhost:8090/cp199/<orientation>/` with content built per orientation; portrait was set with `wlr-randr --transform 90` and restored afterwards. Method as for the look kit: `device/pi/isolate.py`'s measurement pointed at that player, 10 s to settle and 30 s measured, the HTTP cache and the origin's storage cleared and the service worker bypassed before each spec, the supervisor stopped (the soak logger was already off), `__sf.prepares` read after each spec. The first of a spec's five prepares follows a cold load.

| Orientation | Transition | Spot | Overall | Playing | Loading next | Worst frame | Prepares (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | cut | Pop, busy | 0.39% | 0.00% | 12.5% | 67 ms | 632, 285, 300, 282, 360 |
| | | Poster, busy | 0.33% | 0.00% | 12.2% | 50 ms | 714, 267, 266, 266, 277 |
| | | Night, busy | 0.44% | 0.00% | 14.6% | 67 ms | 724, 321, 303, 291, 307 |
| | | Corporate, busy | 0.44% | 0.00% | 13.6% | 67 ms | 611, 269, 410, 281, 273 |
| | | Pop, free | 0.44% | 0.00% | 14.3% | 67 ms | 569, 265, 262, 264, 385 |
| | | Poster, free | 0.28% | 0.00% | 9.4% | 50 ms | 662, 257, 256, 256, 341 |
| | | Night, free | 0.33% | 0.00% | 11.8% | 50 ms | 644, 286, 300, 284, 280 |
| | | Corporate, free | 0.44% | 0.00% | 15.7% | 67 ms | 588, 359, 337, 268, 251 |
| | fade | Pop, busy | 0.56% | 0.00% | 14.1% | 67 ms | 579, 316, 339, 366, 364 |
| | | Poster, busy | 0.33% | 0.00% | 12.0% | 50 ms | 594, 255, 254, 253, 326 |
| | | Night, busy | 0.44% | 0.00% | 14.8% | 67 ms | 605, 293, 283, 292, 306 |
| | | Corporate, busy | 0.44% | 0.06% | 13.7% | 67 ms | 582, 268, 280, 280, 282 |
| portrait | cut | Pop, busy | 0.61% | 0.06% | 14.3% | 67 ms | 681, 463, 388, 384, 401 |
| | | Poster, busy | 0.33% | 0.06% | 9.6% | 50 ms | 748, 290, 278, 286, 291 |
| | | Night, busy | 0.61% | 0.00% | 13.8% | 67 ms | 609, 414, 414, 429, 473 |
| | | Corporate, busy | 0.50% | 0.00% | 13.2% | 67 ms | 540, 367, 365, 364, 395 |
| | | Pop, free | 0.50% | 0.00% | 13.2% | 67 ms | 623, 406, 388, 368, 377 |
| | | Poster, free | 0.28% | 0.00% | 10.4% | 50 ms | 600, 273, 269, 268, 260 |
| | | Night, free | 0.56% | 0.06% | 12.3% | 67 ms | 678, 521, 399, 413, 389 |
| | | Corporate, free | 0.44% | 0.00% | 12.9% | 67 ms | 564, 349, 353, 348, 331 |
| | fade | Pop, busy | 0.67% | 0.00% | 11.6% | 67 ms | 608, 415, 411, 409, 586 |
| | | Poster, busy | 0.56% | 0.00% | 9.4% | 50 ms | 624, 272, 286, 284, 283 |
| | | Night, busy | 0.83% | 0.00% | 16.1% | 67 ms | 700, 582, 435, 417, 505 |
| | | Corporate, busy | 1.00% | 0.00% | 13.4% | 67 ms | 600, 382, 365, 519, 477 |

- Dropped frames: 0.28 to 0.67% overall in landscape and 0.28 to 1.00% in portrait, at most 0.06% while playing, nothing skipped. The one spec at 1.00% is Corporate busy, portrait fade, which dropped 7.7% while fading. The worst frames, 50 to 67 ms, came while the next spot loaded, as with the kit's test template.
- Prepares after the first (12 per look and orientation, cut and fade, busy and free):
  - Landscape medians: Pop 308, Poster 262, Night 293, Corporate 280 ms, all from 251 to 410 ms.
  - Portrait medians: Pop 404, Poster 281, Night 423, Corporate 365 ms.
  - 5 of 48 portrait prepares came in over the 500 ms budget: Night 505, 521 and 582, Corporate 519 and Pop 586 ms. Each was a single slow prepare in a spec whose others were 260 to 473 ms.
- First prepares, which follow a cold load of the page, were 540 to 748 ms in every spec, over the 500 ms budget. That is the four-look bundle's cold start (The look kit: 520 to 661 ms for its test template), not this layout.
- Poster is the quickest look in both orientations, and Night and Pop the slowest in portrait. Why was not measured.

## Info frame (issue #201, 2026-11-21)

`templates/info-frame` at `ab9802e0`, each look a 10 s spot played on its own over the stress set's 4K kitchen photo (`sf build` scales it to 1920x1080 for landscape and 3413x1920 for portrait), with everything on: the rail on the right with the clock, the weather and the three-day forecast, the caption with a price, the demo brand kit's logo, and the crawl of five headlines running along the bottom. The branch's player was at `http://localhost:8090/cp201/<orientation>/`, content built per orientation; portrait was set with `wlr-randr --transform 90` and restored. Method as for Room status: 10 s to settle and 30 s measured, the HTTP cache and the origin's storage cleared and the service worker bypassed before each spec, the supervisor stopped, `__sf.prepares` read after each spec. The first of a spec's five prepares follows a cold load.

| Orientation | Transition | Look | Overall | Playing | Loading next | Transition | Worst frame | Prepares (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| landscape | cut | Pop | 0.72% | 0.12% | 13.3% | 0.0% | 83 ms | 702, 414, 461, 457, 456 |
| | | Poster | 0.44% | 0.00% | 10.0% | 0.0% | 67 ms | 797, 584, 519, 402, 384 |
| | | Night | 0.67% | 0.17% | 10.7% | | 67 ms | 742, 449, 464, 461, 463 |
| | | Corporate | 0.50% | 0.12% | 9.5% | | 50 ms | 730, 448, 413, 413, 392 |
| | fade | Pop | **1.72%** | 0.19% | 15.6% | 15.2% | 67 ms | 722, 469, 443, 444, 591 |
| | | Poster | 0.44% | 0.00% | 11.1% | 0.0% | 67 ms | 737, 394, 393, 394, 391 |
| | | Night | **1.44%** | 0.19% | 13.6% | 11.8% | 67 ms | 846, 661, 535, 459, 456 |
| | | Corporate | 0.78% | 0.00% | 8.9% | 7.5% | 67 ms | 784, 586, 429, 439, 426 |
| portrait | cut | Pop | **1.44%** | 0.59% | 13.8% | 0.0% | 67 ms | 853, 630, 608, 653, 688 |
| | | Poster | 0.72% | 0.00% | 10.0% | | 67 ms | 869, 650, 650, 672, 827 |
| | | Night | 1.00% | 0.18% | 10.1% | 0.0% | 67 ms | 943, 783, 883, 871, 702 |
| | | Corporate | 0.67% | 0.06% | 9.3% | 0.0% | 67 ms | 837, 626, 689, 645, 654 |
| | fade | Pop | **3.50%** | 0.95% | 16.7% | 28.3% | 67 ms | 863, 645, 631, 924, 635 |
| | | Poster | **1.39%** | 0.00% | 12.7% | 10.0% | 83 ms | 843, 667, 651, 650, 792 |
| | | Night | **2.33%** | 0.44% | 11.4% | 22.0% | 83 ms | 861, 663, 780, 784, 628 |
| | | Corporate | **1.94%** | 0.50% | 7.9% | 18.7% | 67 ms | 1019, 922, 656, 659, 668 |

Over budget, stated plainly:

- **Dropped frames over 1%** in 7 of 16 specs: every portrait fade (1.39 to 3.50%), the landscape fades of Pop (1.72%) and Night (1.44%), and Pop's portrait cut (1.44%). While playing, every spec stayed at or under 0.95%; the drops come while the next spot loads and during the fade, with two frames on screen, each a full-screen photo under a crawl.
- **Prepares over 500 ms**: every portrait prepare (608 to 1,019 ms; medians after the first: Pop 640, Poster 659, Night 781, Corporate 657 ms), every first prepare after a cold load (702 to 1,019 ms, the four-look bundle's cold start as for Room status and the kit), and 6 of 32 later landscape prepares (519 to 661 ms). Landscape medians after the first: Pop 457, Poster 394, Night 462, Corporate 428 ms. The portrait photo is 6.6 megapixels against 2.1 in landscape, and the SDK waits for it to decode before `ready`.
- **Frames over 50 ms**: 67 or 83 ms (83 in three) in every spec but Corporate's landscape cut (50 ms), all while the next spot loaded, as for every template measured since the kit.

What the template changed between two sessions (the first at `b2270523`, the same spots): card inks were each resolved with a 1x1 canvas read and a forced style pass, about 40 of each per prepare, and the photo, a drifting layer of its own, was painted before `ready` in every look but Poster. Batching the inks into one style pass with no canvas, and keeping the photo unpainted until play in every look, took Pop's landscape cut from 2.11% (1.37% while playing) and prepares of 988 to 1,117 ms to the figures above, Night's from 733 to 858 ms and Corporate's from 572 to 786 ms; Poster, whose photo already waited, was 491 to 544 ms after the first. In the first session, portrait cuts were 0.72 to 2.83% and prepares 726 to 1,339 ms.

Ablations in the second session, as variant templates built beside it: Pop without its looping sticker wobble and glyph bob, and Pop and Night without any rounded clip (the panel's corners painted over it in the ground colour, cards not clipping). Neither moved the numbers past the run-to-run spread, which was 0.72 to 1.33% for the same landscape layout and 0.83 to 2.67% in portrait, so the canvas's wobble and rounded corners stay. The rail-off layout (the clock and the weather as a chip on the photo) was measured only in the first session, before the fixes: 0.33 to 1.83% landscape, as its rail-on spec.
