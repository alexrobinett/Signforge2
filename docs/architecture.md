# SignForge 2 Architecture

Status: Milestone 1 (the Pi spike) is done; its measurements are in `spike/pi-perf/RESULTS.md`. Milestone 2 (player core) is built and running on the test Pi. Milestone 3 (CMS and API) is in progress; what exists so far is under **Milestone 3 so far** below, and the plan is `docs/backend-plan.md`. The template contract is in `docs/template-spec.md` and `packages/contract`.

## Purpose and scale

SignForge 2 is a ground-up rebuild of a digital signage platform: a CMS, a player that runs on single-board computers, and an agent interface. It is a portfolio flagship built to product standard.

- Multi-tenant from the data model up.
- Sized for 1,000 screens across 100 orgs.
- Target running cost of about $5/month.
- Greenfield monorepo. No data is migrated from SignForge 1; the old C-Store promo is inspiration only.

## What v1 fixes from SignForge 1

| SignForge 1 | SignForge 2 |
| --- | --- |
| One template hardcoded into the player and the database schema | Templates are versioned bundles; a spot is a template version plus data |
| A message belongs to one player | Reusable playlists assigned to screens and groups by schedule |
| Player refetches everything each loop and breaks offline | Immutable manifest, local cache, schedule evaluated on the device |
| Image `src` swapped mid-animation | Two-slot playback; the next spot is ready before the swap |
| Fixed 1920x1080 | Fluid layout for landscape and portrait at any resolution |
| Player ID typed into a `prompt()`; playlist public | Pairing code and a revocable per-screen credential |
| Most API routes unauthenticated | Org-scoped auth and roles on every route |

## Domain model

- **Org**: the tenant. Owns everything below. Members are owner, editor or viewer.
- **Template**: a reusable animated design. Versioned; a published version is immutable.
- **Spot**: a slot of time in a playlist. One of four kinds:
  - template spot: a template version plus the data filled in for it
  - video spot
  - image spot
  - URL spot: online-only, skipped when unreachable
- **Playlist**: an ordered, reusable list of spots.
- **Screen**: one paired device. Has a time zone and an orientation.
- **Screen group**: a named set of screens.
- **Schedule**: assigns a playlist to screens, groups or the whole org for a time window.
- **Data source**: a feed polled by the server. JSON passes through; iCal calendars and RSS or Atom news feeds are converted to fixed shapes (`CalendarFeed`, `NewsFeed`). Any non-image template field, lists included, can bind to a path in one.
- **Asset**: an uploaded image or video, stored by content hash.

"Message" and "ad" from SignForge 1 are both called a spot.

### Schedule rules

- Times are local to each screen.
- When schedules overlap, higher priority wins. On a tie the more specific target wins: screen, then group, then org.
- Every org has a default playlist, so a screen is never blank.
- An instant send is a takeover: a top-priority schedule with an expiry that falls back automatically.

### Spot duration

- Template spot: within the range the template declares.
- Video spot: set on the spot, normally the video's length. A shorter duration cuts the video off; a longer one holds its last frame.
- Image and URL spots: set by the user.

## Templates

A template is a code bundle with a strict contract. Base templates and agent-built templates use the same spec.

Rive was evaluated as an alternative template format because it has a native Apple TV runtime. The same promo built in Rive ran at about 21 fps on the Pi 4 against 59 fps for the HTML version, so templates stay HTML. Details are in `spike/pi-perf/RESULTS.md`.

### Manifest

- name and version
- field schema (drives the CMS form and validates spot data)
- default, minimum and maximum duration
- supported orientations: landscape, portrait or both
- declared assets
- background to show when scaled onto an unsupported orientation

### Lifecycle

1. The player gives the template its data and the length of this play.
2. The template loads and decodes what it needs and reports ready.
3. The player tells it to play.
4. The player removes the template when the play's time is up. The template is not asked: it times its own outro from the duration it was given (`--sf-duration`).

### Rules

- The shipped bundle is plain HTML, CSS and JS with no framework runtime. Any tooling is allowed at build time.
- Animation uses CSS and the Web Animations API, limited to transform and opacity. No layout changes mid-animation.
- `backdrop-filter` is not allowed over moving content; it is the one effect the spike found expensive on a Pi 4. Shadows, blur and glows are fine.
- At most about 50 DOM elements may animate at once. Denser effects such as particles go in a single 2D or WebGL canvas.
- Layout is fluid and sized relative to the screen, so one template is crisp at any resolution of an orientation it supports.
- The template runs in a sandboxed frame with no network access, no storage and no reach outside its frame, including by navigating it (see Template containment under Player). The build produces one self-contained HTML file per template; the player loads it from its cache into the frame and passes image files in with the spot's data, under a content security policy that blocks every request.
- Hard budgets, measured on a Pi 4 at 1080p 60 Hz: at most 1% dropped frames over a full play, no frame longer than 50 ms after play starts, and at most 500 ms to ready from cached files. A built bundle may be at most 600 kB, checked by `sf build` and again by the server.

### Submission and review

1. An agent or developer submits template source.
2. The server builds it.
3. Automated checks run: manifest and schema validity, bundle size, a headless render at each supported orientation, and the animation budget.
4. The result is a draft version, private to the org, with a check report and preview recordings.
5. A human reviews and approves it. Only then can a spot use it.

The CMS preview runs the same bundle the player runs.

The source checks (`FORBIDDEN_TEMPLATE_CODE` and the network-reference check) are a lint that catches mistakes; string matching can be evaded. Before agents can submit templates, add a runtime control: the headless render in step 3 runs with request and navigation logging, and any attempt fails the check. The sandbox and its policy stay the boundary on screens.

## Content delivery

- Editing in the CMS never changes a live screen.
- Publishing compiles one immutable manifest per screen: the schedule for the coming days, the spots, and the hash of every template bundle and asset. One compiler (`packages/compiler`) does this for the server and for `sf build`.
- A screen's manifest carries only what its schedule can reach: the playlists of the entries that target it, their spots, templates, files and data sources. Downloads stay small and no screen holds another's content.
- Template versions are referred to as `<owner>/<id>@<version>`, where the owner is `base` for the platform's templates or the org's id.
- Publish happens immediately or at a set time.
- The server nudges connected screens that a new manifest exists, over each screen's socket. Screens that were offline catch up when they reconnect.
- The player downloads and verifies every file, then switches to the new manifest in one step. A partial download is never played.
- The player evaluates the schedule on its own clock, corrected from server time (see Clock below), so a timed changeover happens with the network down.
- A takeover ends at an absolute instant (`endsAt` on its schedule entry, manifest schema 3), not after a duration, so it ends on time offline and in any time zone.
- Manifests carry a schema number. A player release plays schema N and N−1, and the server compiles each screen at the newest schema its player reports, so a screen updated while offline still plays the manifest it cached under the previous release.
- Data source snapshots reach screens separately from manifests: from the API, on each sync's response, which carries those newer than the screen reports holding, and for those it already holds, when the server last confirmed them (`checked`), so an unchanged feed is not sent again; from static content (the demo, `sf build`), by fetching `data/<id>.json` per source once a minute (`DataSource.refreshS` is the server's poll interval, not the screen's). Offline, a screen shows the last good value until the server has not confirmed it (`checkedAt`) for `SNAPSHOT_STALE_MS`, a day; then the spot's static fallback shows instead of old data. A snapshot that is malformed, larger than `MAX_SNAPSHOT_BYTES` (64 kB), or that fits none of the fields bound to it, never becomes the last good value; a bound value that does not fit its field leaves the spot's static fallback on screen. Refusals are counted per source (`__sf.dataRejected` on the player). The server applies the same fit rule before it stores a snapshot and before it sends one.

## Player

The web player owns all content concerns and runs unchanged in any browser, including the public demo.

- **Cache**: every file is stored on the device under its SHA-256. A download runs in a worker, off the main thread, streams to disk and is hashed as it arrives, so memory stays flat even for video; it is stored under its hash only if the hash matches, and a download that receives nothing for 30 seconds is abandoned. Cleanup removes files the active manifest no longer names, except pinned ones: the spot on screen and the spot loading (with its brand kit's fonts and logo, for a template that reads them), which can belong to the manifest just replaced, and the files of the last known good manifest. A service worker keeps the player itself available offline.
- **Last known good**: the player keeps the last manifest that played a spot, with its files, until a newer manifest has played one. If nothing in a new manifest plays for a full pass of its playlist, the player falls back to the last good one and reports it (`fallback` in `__sf`, `manifest.fallbackFrom` in the heartbeat) until the server sends a newer manifest. A stored manifest this release's validator rejects (a dropped schema, a tightened rule) is still played when it can be run at all, since the release that stored it accepted it; one that cannot be read is ignored.
- **Content sources** (`src/source.ts`): the same playback loop, slots and frames play from one of two sources.
  - *Device*, the default: manifests and files from the content base (the device API with the screen's credential, or static files beside the player), verified and kept in the cache above.
  - *Preview* (`?source=preview`, `src/preview.ts`): the CMS editor frames the player and posts it a draft (`PreviewHostMessage` in the contract): a compiled manifest, the files not saved yet, and the latest data snapshots. Other files come from the CMS's `GET /api/blobs/:sha256` with the user's session. Nothing is stored, synced, reported or sent to a supervisor. A new draft of the spot on screen is shown at once in the same frame: `reset`, then `init` with the new data, then `play` (protocol 2); a protocol 1 bundle, another bundle or another kind of spot is loaded afresh in that slot. The channel is an inbound surface: the player listens only while the CMS origin is its parent, takes messages only from that parent window and origin, and replies only to it. The CMS origin is the build setting `CMS_ORIGIN`, the same as the API's; unset, it is the player's own origin, which is the CMS's when the CMS serves the player build on its hostname, as it does (`/player/`, the same build as the test screen's, served by the `playerBuild` plugin in `apps/cms/vite.config.ts`). The spot editor compiles the draft in the browser with the server's compiler (`get_spot_preview` gives it the template, brand kit and data sources) and posts it 40 ms after the last keystroke. A player served on another origin than the CMS cannot rely on the session cookie for the blob route, so the CMS posts every file.
- **Playback**: two stacked slots. The next spot loads and is fully drawn underneath the current one, and the swap happens only when it reports ready. Drawing it ahead of time matters: revealing an undrawn template cost about a second of stalled frames on the Pi. The next spot must also never be covered completely: Chromium sends a frame that has submitted more than 3 frames without being drawn one BeginFrame a second (`kUndrawnFrameLimit` in viz), and a frame under an opaque one is never drawn, so a template that needed a few frames to prepare (a 4K photo, brand fonts, an animation) waited a second or two for each of its last ones. The black behind each spot is therefore two layers with a 1 px gap at the centre, which the spot itself covers: the slot underneath is drawn through that column, out of sight, and renders at full rate. Loading at full rate costs the spot on screen a few more dropped frames than the throttled load did, but only for the few hundred ms the load now takes (spike/pi-perf/RESULTS.md, Brand fonts). A spot that fails to become ready within 2 seconds is skipped; three failures in a row show a holding message.
- **Brand**: a manifest with a brand kit (`brand`) has its fonts and logo among its files. For a protocol-2 template the player reads them once per manifest and sends the kit in `init` as `theme`, with the files as Blobs like `assets`; the SDK sets the `--sf-*` custom properties, loads the fonts the template uses (as `data:` URLs) and gives `$brand.logo` the logo (docs/template-spec.md, Brand). Brand fonts come from the curated catalogue in `fonts/`, stored once for every org under `sys/b/` and served to a screen whose manifest lists them.
- **Transitions**, set per playlist. Spots can be any length.
  - `cut`: instant. Templates animate their own intro and outro, so this already looks smooth.
  - `fade`: out to black, then in; one spot on screen at a time. The default.
  - `crossfade`: both spots on screen while one fades over the other. It doubles GPU work for its length, about 10% dropped frames on a Pi 4 during the fade, so it is offered as a choice and not a default.
- **Display hours**, set per screen: weekly hours plus dated exceptions such as holidays. The player evaluates them on its own clock like the schedule, so they work offline. Outside them the player stops drawing, keeps syncing, and asks the device supervisor to power the panel down. After powering the panel back on it waits 3 seconds before the first spot, so the panel has locked onto the signal and the intro is seen.
- **Pairing** (`src/pairing.ts`): from the API, a screen whose supervisor has no credential asks for a code (`POST /v1/device/pair/start`), shows it full screen and polls every 5 seconds. A member claims the code (`claim_screen`, the CMS form in M3-11), which creates the screen in their org; the next poll returns the screen's credential (a repeat poll, after a lost reply, gets a fresh one until the first is used), and the player hands it to the supervisor to keep, with the device API base it paired with, and starts syncing, with no restart. The code moves to a new place every minute (OLED), and an expired code (15 minutes) is replaced. A credential installed by hand while a code is shown is taken instead. Without a supervisor to ask (a browser) and with nothing cached, it pairs too, and the credential lasts until a reload; with content cached it keeps playing rather than cover it with a code.
- **Bound to its API**: the kiosk URL's `content=` names the API, and anyone who can open the player can name another. So the credential is sent only to the exact device API base it is bound to, which the supervisor keeps beside it. A player opened with another base, or holding a credential bound to none (stored before this rule), sends nothing, does not pair (which would replace the credential), keeps playing what it has cached and says "paired with another API". Data sources fetched from static content never carry it.
- **Browser test screen** (`?kind=browser`, M3-41): the CMS serves the player build at `/test-screen/` on its own hostname, and "Open a test screen" on the empty Screens page opens it in a new tab (no opener either way) with the device API on that origin (`?content=/v1/device`). It pairs as `kind: browser`, and the claim makes a screen of that kind, labelled a test screen in the CMS; it counts as a screen like any other. Its credential is kept in IndexedDB (`src/browser-credential.ts`) with the device API base it paired with, so it survives a reload, and it is bound to that base as a Pi's is (below): a tab opened on the CMS with another `content=` sends it nowhere and does not pair over it; no supervisor is asked, for a credential or for power, so a program on the computer's loopback cannot hand it one, and display power commands are ignored (the CMS offers no wake or sleep for it). The tab shares the CMS's origin and the user's session cookie, so every device request is sent with `credentials: 'omit'`: the API refuses a request with a session (the socket upgrade aside, see docs/backend-plan.md), and the player never acts as the person. Templates and URL spots run there as on a Pi, in frames on other origins (an opaque sandbox, or the page's own site, never the CMS's), so they reach neither the session nor the CMS. A revoke deletes the stored credential with everything else (see Revoked).
- **Revoked** (owner decision Q2, the default: wipe and show a code): a 401 on any device request made with a credential, or `revoked` on the socket, means the credential was revoked. The player deletes it from the supervisor (or, on a browser test screen, from IndexedDB), wipes the files, manifests (active and last good), unsent play counts, snapshots and any display override, reloads if it held any of them, and shows a code. A supervisor that still hands out the refused credential is not believed.
- **Sync**: content from the API is kept current by one loop (`syncLoop` in `src/main.ts`): `POST /v1/device/sync` every 5 minutes with 10% jitter (the server's `nextSyncS`) while the socket is open, every 2 minutes with jitter while it is down (the D1 write budget's bound, `src/sync-interval.ts`), at the poll interval after a failed sync, and at once on a nudge. It sends the heartbeat (player version and the manifest schemas and protocols it plays, the active manifest, `fallbackFrom`, files missing, display state and the supervisor's power methods, the clock, refused data per source) and finished hours' play counts; it takes the clock offset from the answer, fetches the manifest only when the sync names one other than the active one (or files are missing, or an hour has passed, to put back evicted files), keeps the snapshots it was sent and the `checked` times of those it holds, and runs its commands. `reload` is obeyed at most every 15 minutes, since the server repeats it while the player cannot play what it compiles. Static content has no sync: it polls the manifest and fetches each data source once a minute.
- **Socket**: content from the API comes with one WebSocket to the screen's Durable Object (`src/socket.ts`). The socket asks the sync loop for a ticket (each sync returns one, good for 60 seconds), so the credential never goes in a URL, and connects to `/v1/device/ws?ticket=`. It pings every 50 seconds (answered by the runtime without waking the object) and reconnects with exponential backoff and full jitter. A `manifest` message makes it fetch the manifest at once; a `command` acts at once (a display override wakes the display-hours check, `reload` reloads at most every 15 minutes, `restart` reloads every time because a person asked from the CMS, `identify` shows the screen's name in a bright frame for a few seconds, `reboot` is logged until the supervisor can reboot); `revoked` is treated like a 401 (see Revoked). It reports each manifest it switches to as `applied`, which the server writes to D1 as the reported manifest; a sync's heartbeat writes the same column, so it holds the latest report over either transport. While the socket is open the sync runs every 5 minutes; while it is down, every 2 minutes. A reconnect attempt or a drop forces a sync for its ticket only if the last one was that long ago; otherwise the attempt waits for the next sync's ticket.
- **Display override**: a command from the CMS (`set_display_override`: wake now, sleep now) turns the panel on or off until an absolute time the server computes: the next display-hours change, and at most 12 hours (the only limit on a screen without display hours). It is stored on the screen and sent over the socket at once, and in each sync while the screen reports another override, so a screen that missed the socket still gets it, and a cleared one is cleared. The player persists it, so a reload keeps it, and it ends by itself.
- **Reporting**: the heartbeat rides the sync (above). Plays are counted locally per UTC hour and spot (`src/plays.ts`, player-core `PlayLedger`), kept in Cache Storage, and sent once their hour has ended, so the server writes each hour's row about once.
- **Clock**: a Pi has no battery-backed clock, so the player keeps its own correction (player-core `Clock`, `src/clock.ts`, offset persisted in `localStorage`). The rules:
  - Each sync measures `offsetMs` (server time minus device time) and persists it with the corrected time it was measured at (`syncedAt`). Corrected time is device time plus `offsetMs`, and it is what the schedule, display hours, play counts and templates (`clock` in `init`, `now()` in the SDK) read.
  - While running, a jump in the device clock (it moves against `performance.now()` by more than 2 seconds, as when NTP steps it) is folded into `offsetMs`, so corrected time stays continuous until the next sync.
  - At start, before a sync: the persisted offset is used, but the clock is **not trusted** if the corrected time is earlier than `syncedAt` (time went backwards: a reboot without a clock) or earlier than the player's build time. With no persisted offset, the same build-time floor applies.
  - On an untrusted clock the screen keeps playing: the schedule's local windows still apply, but entries with absolute bounds (takeovers) do not (`resolvePlaylist` with `clockTrusted: false`), the display stays on whatever its hours say, and plays are not counted, since their hour is unknown. The first good sync makes it trusted again. Each sync reports `clock: { offsetMs, trusted }`.
- **Play counts** are sent with a `seq` until acknowledged: a batch keeps its seq, and its counts, until a sync acknowledges it, and plays made meanwhile wait for the next batch. A screen that loses its counter (re-imaged, storage cleared) makes a new random `epoch` and starts again at 1; the server keeps the highest acknowledged `seq` per epoch, so a repeat is ignored and a fresh counter is not.

### Template containment

Each template runs two frames deep. The slot holds a **wrapper frame**: a `srcdoc` document the player writes, on the player's origin, whose only content is a content security policy (`default-src 'none'` plus inline scripts and styles, `blob:`/`data:` media and `data:` fonts) and a one-line `relay` function. Inside it, the template's own frame has `sandbox="allow-scripts"` and the template's HTML as `srcdoc`.

- The template's frame inherits the wrapper's policy before any of its markup runs, and a document cannot drop a policy it was given. So the template cannot fetch, load media or fonts from the network, or open frames.
- Where the template's frame may navigate is decided by the **wrapper's** policy (`frame-src`, falling back to `'none'`), not by the template's. A template that sets `location`, follows a link, or adds a `<meta http-equiv=refresh>` gets an error page and no request is made. The player sees that frame load a second time, fails the spot (or blanks it if it is already playing) and moves on.
- The sandbox stops the rest: no popups, no form submission, no navigating the wrapper or the top page, and an opaque origin, so no access to the player's DOM, Cache Storage or local storage.
- The SDK accepts messages only from its `parent`, which is now the wrapper. The player posts through the wrapper's `relay`, so messages come from the right window, and listens for the template's messages on the wrapper's window. Published bundles are unchanged.

Alternatives considered:

- **Sandbox flags alone** (no `allow-top-navigation`, no `allow-popups`, no `allow-forms`): they stop navigating other frames, but a frame may always navigate itself, and the new document carries none of the old one's policy.
- **A policy in the template's own document** (the meta tag the player used to inject, or a header from the service worker on a template URL): it belongs to the document, so it dies when the template navigates away. The service worker is also missing on the first load, and it does not see an opaque-origin frame's requests.
- **A policy on the player page** cannot be strict enough: URL spots need `frame-src https:`.
- **A check after the fact** (counting the frame's `load` events, the old approach) fires after the request has been made, and never if the new page does not finish loading.

Browser tests in `packages/player/browser/containment.test.ts` try each way out. The wrapper adds one same-origin frame per slot; its cost on the Pi is in `spike/pi-perf/RESULTS.md`.

### Video

Uploaded video must match one strict profile (1080p H.264, capped bitrate). The CMS checks this in the browser at upload and rejects anything else with export guidance. There is no server-side transcoding in v1.

## Device

- **Baseline hardware**: Raspberry Pi 4 at 1080p 60 Hz. Performance budgets are set against it. The spike showed a Pi 4 cannot animate at 4K, so the device image forces 1080p output on Pi 4 class hardware and lets a 4K panel upscale. 4K needs stronger hardware, not yet tested.
- **Supervisor**: a small program on the Pi that owns device concerns only: display power, launching the kiosk, restarting a hung browser, reboot on command, and reporting serial number and temperature. Playback never depends on it. Today it is `device/pi/supervisor.py`, over a local HTTP API the player calls: it powers the panel, and holds the screen's API credential and the device API base it is bound to (`~/signforge/device.credential`, mode 0600, one per line), which it hands only to the player's own origin, never in a URL. The player stores what pairing gives it there (`POST /credential` with `{ credential, api }` and the supervisor's token; the base must be https, or http to the LAN for a development API) and deletes a revoked one (`DELETE /credential`). The player also beats it every 5 s (`POST /alive` with the token): the page's own watchdog runs in the renderer it watches, so with no beat for 30 s the supervisor restarts the kiosk. A beat arms that check and a restart disarms it until the next one, so a player that never beats is not restarted in a loop. Templates run in renderers of their own (Chromium's `IsolateSandboxedIframes`, on by default), so a template that wedges its frame does not stop the beat. Not caught yet: a hung GPU process while the renderer still runs (the page keeps beating), and a kiosk that hangs after a restart before its first beat (the check is disarmed). A kiosk stopped on purpose (`systemctl stop`) is started again by the next restart; use `systemctl disable --now` with the supervisor stopped.
- **Display power** uses two methods every time, because panels differ. HDMI-CEC standby and wake works on TVs and commercial displays. Turning the video signal off works on monitors, which ignore CEC, and on most TVs, which sleep without a signal. Tested on the Pi with an LG UltraGear monitor: CEC was not acknowledged, and turning the signal off and on worked. A CEC-capable TV has not been tested yet.
- **Setup script**: Raspberry Pi OS Lite, a minimal kiosk compositor with Chromium, a read-only root filesystem with a small writable cache area, the hardware watchdog and automatic security updates. Today it is `scripts/deploy-pi.sh` plus `device/pi/tune.sh` ([`device/pi/README.md`](../device/pi/README.md)): the cage kiosk and its services, the performance CPU governor, and a boot that does not wait for the network, since the player plays its cached manifest offline. First spot comes about 21 s after the kernel starts. The read-only root, watchdog and updates are not done yet.
- **Image**: a reproducible OS image built from the same setup script. The script comes first and is tuned during the spike; the image is the artifact that gets flashed. The script can pre-seed a credential for zero-touch installs.

## Platform

- **Cloudflare Workers**: API and MCP server.
- **D1 with Drizzle**: relational data.
- **R2**: assets, template bundles and manifests.
- **Durable Objects**: one per screen, holding a sleeping WebSocket; the desired manifest is in D1, and the one the screen reports is written through to D1. This gives the CMS rollout status per publish. Alarms drive timed publishes.
- **CMS**: TanStack Start, React 19, Tailwind, shadcn.
- **Auth**: Better Auth with its organization plugin.
- **Environments**: dev, demo and prod, each deployed with one command. Dev is local only and must be named (`--env dev`); a bare `wrangler deploy` of the API fails rather than shipping dev settings.
- **Images**: scaled down when they enter the system, to the smallest size that covers the screen: in the browser at upload (`packages/media`), into a landscape and a portrait rendition, and by `sf build` for local projects. The server checks the dimensions rather than resizing. A 4K photo is a quarter of the decoding work at 1080p.
- **Video**: one accepted profile, H.264 (Baseline, Main or High, up to level 4.2, 8-bit 4:2:0, progressive) at up to 1080p and 30 fps and 10 Mbit/s, and at most 500 MB, checked at upload (in the browser and again on the server, `packages/media-check`) and by `sf build`. The Pi 4 decodes it in hardware with about 1% of video frames dropped; 60 fps drops about 18%.

## Agents

- A remote MCP server is the primary agent interface, with OAuth and per-org scopes.
- WebMCP in the CMS exposes the same tools to an agent in a logged-in user's browser.
- Both are generated from one set of tool definitions.
- Agents can create and edit drafts by default. Publishing to live screens is a separate scope granted explicitly.
- Every agent action is written to an audit log.

## Public demo

- A demo org anyone can enter without signing up.
- A virtual screen in the browser runs the real player build.
- The visitor edits a spot, publishes and watches the screen update.
- The org resets on a timer. Agent template submission is disabled.

## Monorepo

pnpm and Turborepo, with packages for:

- template SDK
- each template
- player
- CMS
- API
- MCP server
- Pi supervisor and image build
- infrastructure

## Milestones

1. **Pi spike**: the old promo rebuilt under the template contract, measured on a Pi 4 at 1080p and 4K. Output: budget numbers and the fastest kiosk configuration. Throwaway code.
2. **Player core**: template SDK, the C-Store template, manifest loading, offline cache, two-slot playback.
3. **CMS and API**: orgs, assets, spots, playlists, schedules, publish, screen pairing.
4. **Agents**: MCP server, WebMCP, the template submission and review pipeline.
5. **Polish**: public demo org, Pi image, more base templates, archive the four SignForge 1 repos with a pointer here.

### Milestone 3 so far

Built (tickets in `docs/tickets/`):

- **API Worker** (`apps/api`, Hono on Workers): D1 through `packages/db`, whose scoped repositories are the only code that touches tenant tables, and R2 for blobs and manifests.
- **Device routes**: a screen authenticates with an opaque per-screen credential and fetches its manifest and files. The Pi plays from the API, and survives losing it. Pairing (M3-08) gives a screen its credential; `dev:screen` still makes one for local work.
- **Screen socket** (M3-06): a Durable Object per screen (`ScreenObject`) holds one hibernating WebSocket. A publish, a command or a revoked credential reaches the screen through it at once.
- **Sync** (M3-07): one periodic `POST /v1/device/sync` carries the heartbeat and play counts up, and the desired manifest id, data snapshots, a socket ticket, the server time and commands down.
- **Data sources** (M3-23): a one-minute Cron Trigger polls feeds in the Worker; screens get the snapshots on their next sync.
- **`sf push`**: publishes an `sf build` output to a screen through a temporary `/admin` tree (see the backend plan for what replaces it).
- **Auth and orgs**: Better Auth with email codes, GitHub and organizations; the CMS (TanStack Start) with sign-in, org creation and switching.
- **Tool registry**: every change is a tool with an input and output schema, a scope and a role; `GET /api/tools` lists them. A change and its audit row are written together, a retry with the same key does not repeat it (M3-33), and edits carry `ifVersion` so a person and an agent do not overwrite each other (M3-44).
- **Drafts** (M3-34): spots, playlists and schedule entries have a draft and a published state; a publish promotes the drafts that pass their checks and reports the rest.
- **Server compiler** (`packages/compiler`), golden-tested against `sf build`.
- **Assets** (M3-14, M3-21): presigned upload, browser-made renditions, a server-side check on finalize, and the library page. Video is checked against its one profile in the browser and again on the server.
- **Templates**: pushed, checked again on the server, versioned and approved; base templates are seeded on deploy.
- **Brand kits** (M3-38, M3-39, M3-25): several per org, applied by the compiler at publish; templates draw with the kit's colours, fonts and logo. There is no CMS page for them yet (M3-40).
- **CMS**: the Screens pages (claim, settings, display hours, wake and sleep now, identify, revoke; M3-11), a browser test screen (M3-41), org settings, members and offline alerts by email (M3-42), the command menu (M3-43), and the spot editor: a form made from the template's fields beside the real player (M3-16, first PR).
- **Player resilience** (M3-26 to M3-30, M3-36): browser tests, the wrapper frame around templates, last known good, pinned files and streamed downloads, checked live data, and the preview content source the spot editor uses.
- **Feed normalisers** (`packages/feeds`): iCal, RSS and Atom into fixed shapes.

Next: the playlist editor, publishing and rollout from the CMS, schedules and timed publish (M3-17 to M3-20), then hardening (M3-24). The follow-ups from the review of 2026-11-18 (`docs/reviews/2026-11-18-full-review.md`) are GitHub issue #28 and the issues under it.

## Out of v1

- Billing
- Multi-zone layouts
- A visual template editor
- Automatic video transcoding
- 4K video
- Reporting UI for play logs
- Smart-TV and BrightSign targets
- Apple TV. tvOS has no web view, so it cannot run the web player. Dropped as a target for now; the research is in `docs/research/apple-tv-player.md`.

## Open items

- Which hardware, if any, v1 supports for 4K. A Pi 5 is the obvious candidate and is untested.
- Current browser support for WebMCP has not been checked.
- Replacement artwork and fonts for the C-Store template: the SignForge 1 repo contains Petro-Points artwork and Gibson and Minion font files that should not be reused without a licence.
