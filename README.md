# SignForge 2

Digital signage that keeps playing when the network does not. A CMS publishes immutable content manifests; an offline-first web player on a Raspberry Pi 4 plays them, animated templates included, at 1080p 60 Hz.

![A price promo template playing on the test Pi](docs/images/promo-on-pi.jpg)

*The C-Store promo template, captured on the test Pi (Raspberry Pi 400, Chromium kiosk, 1080p). The CMS so far is the signed-in shell in [`docs/tickets/M3-10/`](docs/tickets/M3-10/06-overview.png).*

## How it works

Content is made of **spots** (a template plus its data, an image, a video or a web page) in **playlists**, which **schedules** assign to **screens**. Publishing compiles one immutable **manifest** per screen: the schedule for the coming days, every spot, and the SHA-256 of every file it needs (`packages/compiler`, shared by the server and the `sf` CLI). The player downloads and verifies every file before switching manifests, evaluates the schedule on its own clock, and loads the next spot fully drawn underneath the current one, so playback survives a pulled network cable and never shows a half-loaded template. Templates are self-contained HTML bundles that run in a sandboxed frame with no network. The backend is two Cloudflare Workers on one hostname: a Hono API (D1, R2, Better Auth with organizations, one tool registry for the CMS and agents) and a TanStack Start CMS. Every shape a screen sees is defined in `packages/contract`.

The full design is in [`docs/architecture.md`](docs/architecture.md); the backend plan in [`docs/backend-plan.md`](docs/backend-plan.md); the template rules in [`docs/template-spec.md`](docs/template-spec.md).

## Measured on the Pi

All numbers are from a Raspberry Pi 400 (Pi 4 class) at 1080p 60 Hz, from [`spike/pi-perf/RESULTS.md`](spike/pi-perf/RESULTS.md). A laptop draws every template without dropping a frame, so it is not used to judge performance.

The real player, a 16-spot playlist (price and photo promos, 1080p30 video, live weather, clock, calendar agendas, an RSS crawl, a menu board), 150 s per run:

| Transition | Dropped frames overall | While playing | Worst frame |
| --- | --- | --- | --- |
| Cut | 0.16% | 0.00% | 17 ms |
| Fade through black, 600 ms | 0.20% | 0.01% | 50 ms |
| Crossfade, 600 ms | 0.94% | 0.10% | 50 ms |

- Template budgets: at most 1% dropped frames over a play, no frame over 50 ms after play starts, ready within 500 ms from cache, and a 600 kB bundle.
- Time from load to ready: 100 to 230 ms.
- Video is decoded in hardware: 1080p30 drops about 1% of video frames, so that is the one accepted profile.
- The same promo built in Rive ran at 21.5 fps against 59.4 fps for HTML, so templates stay HTML.
- A Pi 4 cannot animate at 4K (16 to 33% dropped frames), so the kiosk outputs 1080p and lets a 4K panel upscale.

## Repository

```
apps/api            Cloudflare Worker: CMS API, device API, (later) MCP
apps/cms            TanStack Start CMS
packages/contract   every shape a screen sees: manifest, template protocol, budgets, checks
packages/player     the web player; packages/player-core holds its pure logic
packages/template-sdk  what a template imports to talk to the player
packages/compiler   org data and a screen into a manifest
packages/cli        `sf`: build, push and seed templates and content
packages/db, tools, media, feeds   tenancy-scoped data access, the tool registry, image handling, feed normalising
templates/          the base templates
device/pi           kiosk, supervisor and measurement scripts for the Pi
spike/              measurement spikes and their results
docs/               design, plans, tickets and reviews
```

## Running it

Needs Node 26 and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Play the demo content in a browser, with no backend:

```sh
pnpm build                                  # player into dist/player, examples/demo into dist/content
python3 -m http.server -d dist 8000         # any static server
# open http://localhost:8000/player/?content=../content
```

Run the API and CMS locally (sign-in codes are printed in the API's terminal): see [`apps/cms/README.md`](apps/cms/README.md). The API's Wrangler config has no default environment, so local work opts in with `--env dev` (the package scripts do), and deploys name `--env demo` or `--env prod`.

Put the player on the test Pi: `pnpm build && pnpm deploy:pi`. Measure playback there with `sh scripts/pi-measure.sh`, and one template in isolation with `device/pi/isolate.py`.

## Conventions

- `pnpm lint` runs Biome across the workspace, where a warning fails like an error, then ESLint on the CMS for its React rules ([`apps/cms/README.md`](apps/cms/README.md#react-rules)). The formatter checks only files a change touches (`pnpm format:check`, against `master`; `pnpm format` fixes them), so the existing code is formatted as it is edited rather than in one sweeping commit.
- Type assertions that narrow (`x as T`) fail lint outside tests, `packages/db/src` and the contract's validators. Files that had them when the rule came in are listed in `biome.jsonc`; that list only shrinks. Parse with the contract or annotate instead.
- `pnpm knip` reports unused files, exports and dependencies. `knip.jsonc` lists what knip cannot see (entry files loaded by a CLI or a bundler, fonts read from CSS), each with its reason.
- CI (`.github/workflows/ci.yml`) runs install, typecheck, lint, knip, the format check, the tests and the CMS end-to-end run.
- In Claude Code, a Stop hook (`.claude/settings.json`, `.claude/hooks/stop-checks.sh`) runs `pnpm lint` and `pnpm typecheck` when the agent finishes, and sends it back to work while either fails, up to three times in a row. Turbo caches typecheck, so a run with nothing changed takes a few seconds.
- Work is cut into tickets in [`docs/tickets/`](docs/tickets/README.md); `AGENTS.md` has the rules that are not written down elsewhere.
