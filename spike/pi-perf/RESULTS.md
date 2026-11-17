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
