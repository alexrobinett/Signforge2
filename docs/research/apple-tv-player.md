# Apple TV player: how to play SignForge templates on tvOS

Researched 2026-11-16. Status: research, not a decision. Claims are tagged **[verified]** (checked against a source this session, listed at the end), **[unverified]** (from memory or a secondary source, not confirmed), or **[estimate]** (my own arithmetic or judgement).

## Recommendation

**Do not try to run web templates on Apple TV. Play pre-rendered spots instead, and make the template contract deterministic now so that is possible.**

1. Keep the HTML/CSS/JS template spec for v1. Nothing on current tvOS can execute it in an App Store app.
2. Target Apple TV with a small native Swift app that plays **video renditions** of template spots through AVPlayer. A rendition is the same bundle, rendered by headless Chromium on the server with the spot's data, encoded to the existing strict video profile, and stored in R2 by content hash. The review pipeline already needs a headless render and preview recordings, so most of the render machinery is shared.
3. Share the non-visual engine, not the renderer. Put manifest handling and schedule evaluation in a DOM-free TypeScript core that the web player imports and that the tvOS app runs in JavaScriptCore (bundled in the app, not downloaded).
4. Treat Rive as the only credible "one renderer everywhere" alternative and keep it on watch. It would replace the template spec rather than extend it, so it is not worth the pivot before the web player exists.

"The same engine" is not achievable for rendering on tvOS without changing the engine on every platform. "The same spots, the same manifests, the same schedule logic" is achievable and cheap, provided the spec decisions in [What to change in the template spec now](#what-to-change-in-the-template-spec-now) are made before templates are written.

The main cost of this route is live data: a video cannot update itself, so every data change means a re-render. That is acceptable for menus, prices and promos, and wrong for clocks and tickers. Those templates stay web-only unless a later renderer is added.

## Comparison

Effort is for a solo developer, on top of the planned v1. Fidelity is relative to the Chromium player.

| Option | Feasible on tvOS today | Fidelity | Live data | Forces spec change | Effort | Review risk | Offline |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Web view / TVMLKit | No | n/a | n/a | n/a | n/a | High (private API) | n/a |
| 1b. Embedded Blink (Igalia port) | Experimental only | Same engine, no JIT | Yes | None | Very high, ongoing | High, untested | Yes |
| 2. JavaScriptCore + custom native renderer | Yes, for a tiny subset | Low to medium | Yes | Total: templates become a restricted DSL | 3 to 6+ months | Low to medium | Yes |
| 3a. Rive as the template format | Yes (tvOS 16+) | Identical across platforms | Yes (data binding) | Total: replaces HTML templates | 2 to 3 months, plus Pi re-spike | Low | Yes |
| 3b. Lottie / dotLottie | Yes (tvOS 13+) | Good for motion, poor for layout and text | Slots only | Total, and loses fluid layout | 2 to 3 months | Low | Yes |
| 3c. Custom scene/timeline JSON | Yes | Medium (text layout differs) | Yes | Total | 3 to 6+ months | Low | Yes |
| **4. Pre-render to video, AVPlayer** | **Yes** | **Pixel-level, minus compression** | **Re-render per change** | **Small: determinism rules** | **3 to 6 weeks** | **Lowest** | **Yes** |
| 5. React Native tvOS / Flutter / Skia / wgpu host | Hosts exist | Depends on what you write | Yes | Same as 2 or 3 | Same as 2 or 3 | Low | Yes |
| 6. AirPlay or HDMI from another device | Yes | Same as source | Yes | None | Days | None | No (AirPlay) |

## Per-option notes

### 1. Web rendering surfaces on tvOS

- **WKWebView is not available to third-party tvOS apps.** An Igalia engineering post from May 2026 states that tvOS provides no WebKit web view for third-party applications **[verified, secondary source]**. Apple's own WKWebView page could not be parsed for its availability list this session, so the absence of tvOS there is **[unverified]** against the primary source.
- **TVML is deprecated** in tvOS 18 and later; Apple says to use SwiftUI or UIKit **[verified]**. The TVMLKit framework page itself shows availability "tvOS 9.0 and later" with no deprecation banner **[verified]**, but TVMLKit only renders TVML templates. It never offered HTML, CSS, canvas or the Web Animations API, so it was never a route for these templates.
- **Private web view classes** fail guideline 2.5.1 ("Apps may only use public APIs") **[verified]**.
- **Embedded Blink (1b).** Igalia has upstreamed an experimental Chromium port for tvOS. `content_shell` runs on real Apple TV hardware, in single-process mode, with no JIT (WebAssembly is interpreted) and hardware H.264/HEVC decode. The authors call it experimental, say the build breaks frequently, and say nothing about App Store distribution **[verified]**. Guideline 2.5.6 requires apps that browse the web to use WebKit, with alternative-engine entitlements only for the EU and Japan **[verified]**; whether a signage app that embeds Blink to render its own content falls under that rule is untested **[unverified]**. This is the only path to literally the same engine. It is not maintainable solo today. Worth re-checking yearly.

### 2. JavaScriptCore plus a custom native renderer

- JavaScriptCore is public API on tvOS 9.0 and later **[verified]**. It runs without JIT inside third-party apps on iOS; I found no tvOS-specific statement, so interpreter-only on tvOS is an inference **[unverified]**.
- JSC gives a JavaScript engine and nothing else: no DOM, no CSS, no layout, no text shaping, no canvas, no Web Animations API. Running a template means reimplementing the parts of a browser that templates use. A template restricted enough to make that tractable is no longer "plain HTML, CSS and JS"; it is a custom DSL (see 3c).
- JSC is the right tool for one thing: running the shared, DOM-free player core (manifest parsing, schedule evaluation, play-log logic). That workload is tiny and does not need JIT.
- Review: guideline 2.5.2 forbids downloading code that changes app functionality; 4.7 permits HTML5/JS mini apps not embedded in the binary, under conditions **[verified]**. Bundle the core JS inside the app to stay clear of both.

### 3. A declarative cross-platform format as the template source

**3a. Rive**

- The Apple runtime supports tvOS 16.0+ (also iOS 14, macOS 13.1, visionOS 1) **[verified]**. The runtime was recently rewritten around Swift Concurrency; the old and new APIs are incompatible **[verified]**, which signals some churn.
- Data binding covers strings, numbers, booleans and, since a later release, images, lists and artboards. On Apple, images are decoded with `decodeImage(from:)` and assigned to an `ImageProperty`; data binding requires the new Swift API **[verified]**. Fonts and images can also be supplied out of band **[verified]**.
- Rive has layouts (flex-style), a text engine, and Luau scripting **[verified]**. The same C++ renderer runs on web (WASM + WebGL2) and natively, so fidelity is identical by construction.
- Agent authoring is now plausible: Rive Markup Language (RML) is an XML text form of a Rive file, compiled to `.riv` by the Rive CLI, with `--verify`, `inspect --json` and `--screenshot` commands aimed at coding agents **[verified]**. Not stated in the docs: release status, Linux/headless CI support, and whether the CLI needs a paid plan **[unverified]**. Rive's own docs warn that a clean build does not guarantee correct appearance and some errors fail silently **[verified]**.
- Costs: it replaces the template spec, the SDK, the checks and the CMS preview. Agents have far less prior knowledge of RML than of HTML/CSS **[estimate]**. The editor and CLI are a single vendor's proprietary tools; runtimes are open source (MIT, not re-checked this session **[unverified]**). Rive's WASM/WebGL2 runtime has not been measured on a Pi 4 **[unverified]**, and the Pi is the primary player.
- Verdict: the only option that delivers one renderer, live data and native frame rates on Apple TV. Too large a pivot to take on speculation. Revisit if Apple TV becomes a real customer requirement and live data on it matters.

**3b. Lottie / dotLottie**

- Airbnb's lottie-ios supports tvOS; LottieFiles' dotlottie-ios declares tvOS 13.0+ **[verified]**. dotLottie has slots for colour, text and image replacement, with themes embedded in the `.lottie` archive **[verified]**. Slot behaviour on tvOS specifically is not documented **[unverified]**.
- Lottie is a keyframe playback format with no layout engine: text does not reflow, and there is no fluid layout across resolutions or orientations. Hand-writing Lottie JSON is impractical for a person and error-prone for an agent **[estimate]**.
- Verdict: wrong shape for data-driven, fluid templates. Fine as an asset type inside a template later.

**3c. Custom scene/timeline JSON**

- You would own both renderers: DOM on web, Core Animation or Skia on tvOS. The existing rule "animate transform and opacity only" maps directly onto `CALayer` animations, which is encouraging.
- The hard part is not animation, it is layout and text. Chromium and CoreText wrap and measure text differently, so pixel parity is not realistic **[estimate]**. Agents lose HTML/CSS, the thing they are best at.
- A variant worth remembering, **layer bake**: at render time, headless Chromium lays out the template with its data, rasterises each animated element to an image, and exports the keyframes from `document.getAnimations()`. The tvOS app composites those layers natively. It would be crisp at any resolution, far smaller than video, and cheap to re-render on data change. It only works if animations are declarative and introspectable, and it breaks on canvas, clipping and blend modes. This is my own idea and is unproven **[estimate]**; the spec rules below keep it possible.

### 4. Pre-render each spot to video

**How it works.** For each (template bundle hash, data hash, orientation, resolution, duration), a render job loads the real bundle in headless Chromium, drives it frame by frame on a virtual clock, encodes the frames, and writes the file to R2 under a content hash. The publish step adds the rendition to the manifest of any screen whose capability profile says it cannot run web templates. To the tvOS app, a template spot is a video spot.

**Fidelity.** It is Chromium's own output, so layout and motion match exactly. Losses are compression artefacts on text edges and gradients, and a fixed frame rate. Sharp vector text needs a generous bitrate; the Apple TV 4K decodes H.264 and HEVC (Main and Main 10) up to 2160p60 **[verified]**.

**Live data.** This is the real limitation. Each new data source snapshot that changes a bound field requires a new render and a download. Workable when data changes a few times a day. Not workable for clocks, countdowns or per-minute feeds. Offline behaviour is naturally correct: the screen keeps the last good rendition, which matches "offline, a screen shows the last good value".

**Storage [estimate].** A 10 s 1080p60 spot at 8 Mbps is about 10 MB. A screen with 30 template spots holds about 300 MB. In R2, 1,000 distinct renditions is about 10 GB, roughly $0.15/month at R2's standard storage rate **[unverified rate]**. Content hashing dedupes identical spots across screens.

**Where rendering runs on Cloudflare.**

- **Workers**: cannot do it. No browser, no native ffmpeg, tight memory and CPU limits.
- **Browser Run** (renamed from Browser Rendering): real Chromium over Puppeteer, Playwright or CDP. Paid plan includes 10 browser hours a month, then $0.09 per hour **[verified]**. Its "session recording" is rrweb DOM events, not video **[verified]**. I found no documentation that the Puppeteer fork supports `page.screencast()` or that virtual-time CDP commands are exposed **[unverified]**, and it has no encoder. Good for the layout checks and still screenshots in the review pipeline; not enough alone for video.
- **Containers**: the practical choice. One image with `chrome-headless-shell` and ffmpeg, scale to zero, triggered from a Queue or Workflow at publish, one Durable Object per container. Workers Paid includes 375 vCPU-minutes and 25 GiB-hours a month; beyond that $0.000020 per vCPU-second and $0.0000025 per GiB-second **[verified]**. Instance types go up to 4 vCPU / 12 GiB **[verified]**. Whether Containers has left beta is **[unverified]**.
- **Cost [estimate]**: frame-by-frame capture runs slower than real time. Assuming 60 s of a 4 vCPU instance per 10 s spot, a render costs about $0.007, and the included allowance covers roughly 90 renders a month. A hundred static spots are nearly free. A feed that changes every 5 minutes across 20 spots is about 170,000 renders a month, around $1,200: this is why fast-changing fields must be excluded from pre-rendering by rule, not by hope.
- **Outside Cloudflare**: the same container image runs on any CI runner or the owner's machine. Keep the renderer a plain container so it is portable.
- Encoding H.264/HEVC with x264/x265 carries GPL and patent-licensing considerations for a commercial product **[unverified]**.

**tvOS app.** Swift, AVFoundation, two `AVPlayerLayer`s for the same two-slot swap the web player uses, `URLSession` downloads verified by hash, `URLSessionWebSocketTask` for the nudge socket. Small and conventional.

**Bonus.** The same renditions unblock every other non-web target listed under "Out of v1" (smart TVs, BrightSign), and give weak hardware a fallback.

### 5. Cross-platform UI runtimes

- **React Native tvOS**: maintained fork, supported by Expo. react-native-skia documents tvOS support from 1.9.0, with the caveat that not everything is tested on TV **[verified]**. It includes Skottie for Lottie playback **[verified]**.
- **Flutter**: no official tvOS support; a community embedder (`flutter_tvos`) exists **[verified, secondary]**.
- **Rust/wgpu** renderers and Servo on tvOS: not investigated **[unverified]**.
- None of these executes HTML/CSS/JS templates. They are hosts for a renderer you would still have to write (option 2 or 3c) or for Rive/Lottie (which have native Swift runtimes anyway). For a video player they add weight and nothing else.

### 6. Sidestepping tvOS

- A Pi behind the same TV on another HDMI input is the honest answer when the customer just wants a screen running.
- AirPlay mirroring from a Mac or iPad needs a second always-on device and a network, so it has no offline story and no place in a product.

## Apple TV as kiosk hardware

- **Single-app lock**: the App Lock payload (`com.apple.app.lock`) pins the device to one app and requires supervision; available on Apple TV since tvOS 10.2 **[verified]**. MDM vendor docs say the device returns to the locked app on wake and reboot without showing the Home Screen **[verified, vendor docs]**. So a real deployment needs an MDM (or Apple Configurator, which erases the device) and Apple Business Manager for zero-touch.
- One vendor (Hexnode) says only enterprise apps can be used in its Apple TV kiosk mode **[verified for that vendor]**. Whether App Store apps work under App Lock with other MDMs is **[unverified]** and matters for distribution.
- **Sleep**: Settings has "Sleep After: Never" **[verified, secondary]**. A developer reports that on tvOS 26 `AVPlayer.preventsDisplaySleepDuringVideoPlayback` stops working after being toggled, with no Apple reply **[verified that the report exists]**. Plan to set the idle timer off in the app and the sleep setting by hand or MDM, and test on the current OS.
- **Power**: an Apple TV boots when power is applied **[unverified]**. HDMI-CEC control of the panel changed in tvOS 26 according to user reports **[unverified]**.
- **Storage**: tvOS gives apps no guaranteed persistent storage. Archived Apple guidance cites 500 KB of persistent defaults and a purgeable Caches directory; an Apple forum answer says cached data is safe while the app is running and may be deleted after it exits **[verified, old sources]**. A locked single app is always running, so the cache should hold, but the app must survive a cold start with an empty cache: keep the credential in the keychain, re-download, and ship a bundled fallback slide. Behaviour on current tvOS is **[unverified]**.
- **Orientation**: tvOS has no portrait mode **[unverified]**. For portrait panels the rendition must be rendered pre-rotated, or the player layer rotated.
- **No supervisor equivalent**: remote reboot and display power go through MDM commands, not our own code.
- **Hardware support window**: a June 2026 headline says tvOS 27 drops some Apple TV models **[unverified, headline only]**.
- **App Store review**: a player that downloads and plays video and images is ordinary. The pairing-code flow should work with the Siri Remote alone (guideline 2.4.3 **[verified]**), which it does since the code is typed in the CMS.

## What to change in the template spec now

These are cheap today and expensive after templates exist. Most also improve the automated checks and preview recordings already planned.

1. **Deterministic time.** A template takes time only from the document timeline (CSS and Web Animations) or from the `requestAnimationFrame` timestamp via the SDK. Ban `Date.now()`, `performance.now()`, `setTimeout`/`setInterval`-driven animation and unseeded `Math.random()`. The SDK supplies a clock and a seeded random. A render harness can then step the template frame by frame and get the same pixels every time.
2. **A spot is a pure function of declared inputs.** Output depends only on bundle, data, viewport, duration, locale and time zone. No ambient inputs. Wall-clock time, if a template needs it, is a declared field the player supplies, not something the template reads.
3. **Data is fixed for the length of a play.** The player gives data once, before ready. A new data source snapshot applies from the next play, never mid-play. This makes a pre-rendered play equivalent to a live one and removes a class of mid-animation bugs on the Pi.
4. **Duration is known before play.** "Done" fires at the duration the player set, within the manifest's range. No open-ended or data-dependent endings.
5. **Declare volatility per field.** Each field is `static`, `bound` (data source, with a minimum refresh interval) or `realtime` (clock, countdown). The build derives whether a template is pre-renderable. Realtime templates are marked web-only, and the CMS can say so when a spot is scheduled to a video-only screen.
6. **Declare capabilities in the manifest.** For example `uses: ["canvas", "webgl", "audio"]`. Prefer declarative CSS/WAAPI keyframes over JS-driven loops, and say so in the authoring guide, so a later layer bake or native renderer has something to read.
7. **Opaque, full-frame, no input.** A template paints every pixel (the manifest already declares a background), takes no user input, and does not own transitions between spots. The player owns transitions, so a native player can reproduce them (cut or crossfade).
8. **Fonts ship in the bundle.** No system fonts. Required for deterministic renders and for any future native renderer.
9. **Spots have renditions.** In the per-screen manifest, a template spot carries its bundle and data and may also carry pre-rendered renditions (`codec`, `width`, `height`, `fps`, `hash`). Spot identity and play logs are independent of which rendition played.
10. **Screens have a capability profile.** `runtime: web | video`, codecs, maximum resolution, orientation handling. The publish compiler picks renditions from it. Do not let the manifest assume a browser.
11. **Renditions use the existing video profile.** Rendering to the strict 1080p H.264 profile means a rendition is just a video spot and the Pi can play it too. Decide on HEVC later.
12. **A DOM-free player core.** Manifest parsing and verification rules, schedule evaluation and play-log batching live in a package with no DOM, `fetch` or service worker imports; the host injects IO. Publish JSON test vectors for the schedule rules. The web player and a tvOS app (via JavaScriptCore) then share the code that is most dangerous to duplicate.
13. **A plain device protocol.** Pairing, credential, heartbeat, nudge socket and content fetch use HTTPS and WebSocket with a bearer credential and hash-addressed URLs. No cookies, no browser-only auth, nothing that needs a service worker on the server side of the contract.

Change to `architecture.md` when this is accepted: the "Apple TV" line under "Out of v1" should say the native player reads the same manifests and plays pre-rendered renditions, and the Templates rules should gain items 1 to 8.

## Open questions

1. Can headless Chromium in a Cloudflare Container capture the C-Store template deterministically at 1080p60, and how long does a 10 s render take? This sets the real cost. A one-day spike answers it.
2. Does Browser Run expose virtual-time or `beginFrame` CDP commands? If so, capture could run there with only encoding in a container.
3. Are Cloudflare Containers generally available, and do their limits fit a Chromium plus ffmpeg image?
4. Can an App Store app be the locked app under App Lock on tvOS, or does a kiosk deployment need Custom Apps through Apple Business Manager?
5. Does a locked app's Caches directory survive reboot and OS update on current tvOS?
6. Is the tvOS 26 display-sleep regression fixed, and does `isIdleTimerDisabled` cover it?
7. How good does small text look at the capped H.264 bitrate? May force HEVC or a higher cap for renditions.
8. How fast do real customers' bound fields change? This decides whether video-only Apple TV is enough or whether Rive or layer bake is needed.
9. How does Rive's web runtime perform on a Pi 4 at 1080p60? Only worth measuring if question 8 comes back "fast".
10. Rive CLI: licence, plan requirement, Linux support and release status.

## Sources

Apple
- TVML (deprecation notice): https://developer.apple.com/documentation/tvml
- TVMLKit: https://developer.apple.com/documentation/tvmlkit
- WKWebView (availability not readable this session): https://developer.apple.com/documentation/webkit/wkwebview
- JSContext (tvOS 9.0+): https://developer.apple.com/documentation/javascriptcore/jscontext
- App Store Review Guidelines (2.4.3, 2.5.1, 2.5.2, 2.5.6, 4.7): https://developer.apple.com/app-store/review/guidelines/
- AppLock device management payload: https://developer.apple.com/documentation/devicemanagement/applock
- Apple Platform Deployment, Apple TV: https://support.apple.com/guide/deployment/dep027e1d5a0/web
- Apple TV 4K technical specifications: https://www.apple.com/uk/apple-tv-4k/specs
- Forum: tvOS 26 `preventsDisplaySleepDuringVideoPlayback`: https://developer.apple.com/forums/thread/801791
- Forum: how the tvOS cache folder is removed: https://developer.apple.com/forums/thread/84131
- Forum: no local storage on tvOS: https://developer.apple.com/forums/thread/16967

Chromium on tvOS
- Igalia, "Blink for Apple tvOS: 2026 Update" (2026-05-15): https://blogs.igalia.com/gyuyoung/?p=1031
- Igalia, "Introduce Blink for Apple tvOS": https://blogs.igalia.com/gyuyoung/?p=1019

Rive
- Apple runtime: https://rive.app/docs/runtimes/apple
- Apple data binding: https://rive.app/docs/runtimes/apple/data-binding
- Apple loading assets: https://rive.app/docs/runtimes/apple/loading-assets
- Migrating from the legacy Apple runtime: https://rive.app/docs/runtimes/apple/migrating-from-legacy
- Feature support: https://rive.app/docs/feature-support
- Rive Markup Language: https://rive.app/docs/runtimes/advanced-topic/rml
- Rive CLI: https://rive.app/docs/cli/overview
- CLI and coding agents: https://rive.app/docs/cli/agents
- Data binding: lists, images and artboards: https://rive.app/blog/data-binding-supercharged-lists-images-and-artboards
- Scripting: https://rive.app/blog/scripting-is-live-in-rive

Lottie
- dotlottie-ios: https://swiftpackageregistry.com/LottieFiles/dotlottie-ios
- dotLottie themes and slots (native): https://docs.lottiefiles.com/en/runtimes/distributions/native/v0.x/theming-and-slots
- dotLottie iOS methods: https://developers.lottiefiles.com/docs/dotlottie-player/dotlottie-ios/methods
- dotlottie-web: https://github.com/lottiefiles/dotlottie-web

Cloudflare
- Browser Run pricing: https://developers.cloudflare.com/browser-run/pricing/
- Browser Run limits: https://developers.cloudflare.com/browser-run/limits/
- Browser Run session recording: https://developers.cloudflare.com/browser-run/features/session-recording/
- Browser Run changelog: https://developers.cloudflare.com/changelog/product/browser-run/
- Containers pricing: https://developers.cloudflare.com/containers/pricing/
- Puppeteer `page.screencast`: https://pptr.dev/api/puppeteer.page.screencast

Cross-platform runtimes
- Expo, building for TV: https://docs.expo.dev/guides/building-for-tv
- react-native-skia installation (tvOS): https://shopify.github.io/react-native-skia/docs/getting-started/installation
- react-native-skia Skottie: https://shopify.github.io/react-native-skia/docs/skottie
- flutter_tvos: https://pub.dev/packages/flutter_tvos

Kiosk and MDM (vendor documentation)
- Jamf, tvOS configuration profiles: https://docs.jamf.com/technical-papers/jamf-pro/managing-apple-tv/10.4.0/tvOS_Configuration_Profiles.html
- Hexnode, kiosk mode for Apple TV: https://www.hexnode.com/mobile-device-management/help/kiosk-mode-for-apple-tv-complete-guide/
- App Lock payload notes: https://mosen.github.io/profiledocs/payloads/applock.html
- Sleep settings in tvOS 26: https://appleworld.today/2026/01/how-to-change-the-sleep-settings-on-an-apple-tv-set-top-box-in-tvos-26/
- tvOS 27 model support (headline only): https://thedesk.net/2026/06/tvos-27-to-end-support-for-some-apple-tv-models/
