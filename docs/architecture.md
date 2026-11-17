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
- The template runs in a sandboxed frame with no network access, no storage and no reach outside its frame. The build produces one self-contained HTML file per template; the player loads it from its cache into the frame and passes image files in with the spot's data, under a content security policy that blocks every request.
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
- The server nudges connected screens that a new manifest exists. Screens that were offline catch up when they reconnect.
- The player downloads and verifies every file, then switches to the new manifest in one step. A partial download is never played.
- The player evaluates the schedule on its own clock, so a timed changeover happens with the network down.
- Data source snapshots are pushed to screens separately from manifests. Offline, a screen shows the last good value.

## Player

The web player owns all content concerns and runs unchanged in any browser, including the public demo.

- **Cache**: every file is stored on the device under its SHA-256 and verified on download. A service worker keeps the player itself available offline.
- **Playback**: two stacked slots. The next spot loads and is fully drawn underneath the current one, and the swap happens only when it reports ready. Drawing it ahead of time matters: revealing an undrawn template cost about a second of stalled frames on the Pi. A spot that fails to become ready within 2 seconds is skipped; three failures in a row show a holding message.
- **Transitions**, set per playlist. Spots can be any length.
  - `cut`: instant. Templates animate their own intro and outro, so this already looks smooth.
  - `fade`: out to black, then in; one spot on screen at a time. The default.
  - `crossfade`: both spots on screen while one fades over the other. It doubles GPU work for its length, about 10% dropped frames on a Pi 4 during the fade, so it is offered as a choice and not a default.
- **Display hours**, set per screen: weekly hours plus dated exceptions such as holidays. The player evaluates them on its own clock like the schedule, so they work offline. Outside them the player stops drawing, keeps syncing, and asks the device supervisor to power the panel down. After powering the panel back on it waits 3 seconds before the first spot, so the panel has locked onto the signal and the intro is seen.
- **Pairing**: an unpaired screen shows a short code. A user enters it in the CMS and assigns the screen to an org. The screen receives its own credential, which the CMS can revoke.
- **Reporting**: heartbeat with player version, manifest version and cache state. Play logs are recorded locally and uploaded in batches.

### Video

Uploaded video must match one strict profile (1080p H.264, capped bitrate). The CMS checks this in the browser at upload and rejects anything else with export guidance. There is no server-side transcoding in v1.

## Device

- **Baseline hardware**: Raspberry Pi 4 at 1080p 60 Hz. Performance budgets are set against it. The spike showed a Pi 4 cannot animate at 4K, so the device image forces 1080p output on Pi 4 class hardware and lets a 4K panel upscale. 4K needs stronger hardware, not yet tested.
- **Supervisor**: a small program on the Pi that owns device concerns only: display power, launching the kiosk, restarting a hung browser, reboot on command, and reporting serial number and temperature. Playback never depends on it. Today it is `device/pi/supervisor.py`, over a local HTTP API the player calls: it powers the panel, and holds the screen's API credential (`~/signforge/device.credential`, mode 0600), which it hands only to the player's own origin, never in a URL.
- **Display power** uses two methods every time, because panels differ. HDMI-CEC standby and wake works on TVs and commercial displays. Turning the video signal off works on monitors, which ignore CEC, and on most TVs, which sleep without a signal. Tested on the Pi with an LG UltraGear monitor: CEC was not acknowledged, and turning the signal off and on worked. A CEC-capable TV has not been tested yet.
- **Setup script**: Raspberry Pi OS Lite, a minimal kiosk compositor with Chromium, a read-only root filesystem with a small writable cache area, the hardware watchdog and automatic security updates.
- **Image**: a reproducible OS image built from the same setup script. The script comes first and is tuned during the spike; the image is the artifact that gets flashed. The script can pre-seed a credential for zero-touch installs.

## Platform

- **Cloudflare Workers**: API and MCP server.
- **D1 with Drizzle**: relational data.
- **R2**: assets, template bundles and manifests.
- **Durable Objects**: one per screen, holding a sleeping WebSocket and both the manifest version the screen should be on and the one it reports. This gives the CMS rollout status per publish. Alarms drive timed publishes.
- **CMS**: TanStack Start, React 19, Tailwind, shadcn.
- **Auth**: Better Auth with its organization plugin.
- **Environments**: dev, demo and prod, each deployed with one command. Dev is local only and must be named (`--env dev`); a bare `wrangler deploy` of the API fails rather than shipping dev settings.
- **Images**: scaled down when they enter the system, to the smallest size that covers the screen: in the browser at upload (`packages/media`), into a landscape and a portrait rendition, and by `sf build` for local projects. The server checks the dimensions rather than resizing. A 4K photo is a quarter of the decoding work at 1080p.
- **Video**: one accepted profile, H.264 at up to 1080p and 30 fps and 10 Mbit/s, checked at upload and by `sf build`. The Pi 4 decodes it in hardware with about 1% of video frames dropped; 60 fps drops about 18%.

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
- **Device routes**: a screen authenticates with an opaque per-screen credential and fetches its manifest and files. The Pi plays from the API, and survives losing it. Until pairing (M3-08), credentials are made with `dev:screen` and installed by hand, and the player polls every 30 seconds.
- **`sf push`**: publishes an `sf build` output to a screen through a temporary `/admin` tree (see the backend plan for what replaces it).
- **Auth and orgs**: Better Auth with email codes, GitHub and organizations; a CMS shell (TanStack Start) with sign-in, org creation and switching.
- **Tool registry**: every change is a tool with an input and output schema, a scope and a role, audited. List tools page.
- **Server compiler** (`packages/compiler`), golden-tested against `sf build`.
- **Assets**: presigned upload, browser-made renditions and a server-side check on finalize. The library page waits for the CMS design.
- **Templates**: pushed, checked again on the server, versioned and approved; base templates are seeded on deploy.
- **Feed normalisers** (`packages/feeds`): iCal, RSS and Atom into fixed shapes.

After the full review of 2026-11-17 (`docs/reviews/2026-11-17-full-review.md`), foundations come next: player resilience with browser tests, contract fixes, write safety, then the screen socket, sync and pairing, before the spot and playlist editors.

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
