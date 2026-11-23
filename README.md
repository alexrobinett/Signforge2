# SignForge 2

Digital signage that keeps playing when the network does not. A CMS publishes immutable content manifests; an offline-first web player on a Raspberry Pi 4 plays them, animated templates included, at 1080p 60 Hz.

![A price promo template playing on the test Pi](docs/images/promo-on-pi.jpg)

*The C-Store promo template, captured on the test Pi (Raspberry Pi 400, Chromium kiosk, 1080p). What the CMS does so far is in [`docs/architecture.md`](docs/architecture.md#milestone-3-so-far).*

## How it works

Content is made of **spots** (a template plus its data, an image, a video or a web page) in **playlists**, which **schedules** assign to **screens**. Publishing compiles one immutable **manifest** per screen: the schedule for the coming days, every spot, and the SHA-256 of every file it needs (`packages/compiler`, shared by the server and the `sf` CLI). The player downloads and verifies every file before switching manifests, evaluates the schedule on its own clock, and loads the next spot fully drawn underneath the current one, so playback survives a pulled network cable and never shows a half-loaded template. Templates are self-contained HTML bundles that run in a sandboxed frame with no network. The backend is two Cloudflare Workers on one hostname: a Hono API (D1, R2, Better Auth with organizations, one tool registry for the CMS and agents) and a TanStack Start CMS. Every shape a screen sees is defined in `packages/contract`.

The full design is in [`docs/architecture.md`](docs/architecture.md); the backend plan in [`docs/backend-plan.md`](docs/backend-plan.md); the template rules in [`docs/template-spec.md`](docs/template-spec.md).

## Measured on the Pi

All numbers are from a Raspberry Pi 400 (Pi 4 class) at 1080p 60 Hz, from [`spike/pi-perf/RESULTS.md`](spike/pi-perf/RESULTS.md). A laptop draws every template without dropping a frame, so it is not used to judge performance.

Template budgets: at most 1% dropped frames over a play, no frame over 50 ms after play starts, ready within 500 ms from cache, and a 600 kB bundle.

The latest full run, 2026-11-18 (RESULTS, Linux tuning, "Final: everything kept"): the player and templates at 0d4b75a, on a Pi set up with `device/pi/tune.sh`, playing the 16-spot stress playlist (`examples/stress`, no brand kit: price and photo promos, 1080p30 video, weather, clock, calendar agendas, an RSS crawl, a menu board), 290 s per run.

| Measure | Result | Budget |
| --- | --- | --- |
| Dropped frames overall, cut (3 runs) | 0.35, 0.37, 0.43% | 1% |
| Dropped frames overall, fade 600 ms (3 runs) | 0.43, 0.44, 0.46% | 1% |
| Dropped during the fade | 1.14% | |
| Dropped while the next spot loads | 8.1–11.5% | |
| Prepare (load to ready), median per run | 220–233 ms | 500 ms |
| First prepare after a kiosk restart (5 restarts) | 596–850 ms, median 622 | 500 ms |
| Worst frame | 300 ms | 50 ms |
| Kernel start to first spot | 22.0 s | |
| Peak temperature | 56.4 C, never throttled | |

Over budget:

- **The first prepare after a kiosk restart**: 596–850 ms with the kept settings, 547–998 ms across every Linux setting tried; the second prepare is 219–243 ms. Most of it is starting the template renderer process. A blank sandboxed frame made at boot is the proposed fix ([#38](https://github.com/alexrobinett/Signforge2/issues/38)).
- **News with brand fonts, loading under a playing video**: 1421–1622 ms on the first prepare after video-pan, then about 550 ms (M3-25's branch, merged in b658899; fade 600 ms, 290 s runs). The video layer is opaque and covers the 1 px gap that keeps the loading spot drawn, so Chromium throttles it ([M3-45](docs/tickets/M3-45-prepare-under-a-playing-video.md)).
- **One frame of 300–383 ms on the first weather-rain prepare after Chromium starts**, in 5 of the 8 first runs after a fresh start (0d4b75a). Not traced.
- **Frames over 50 ms**: apart from that frame, the worst frame was up to 133 ms in the tuning runs (0d4b75a) and 83–167 ms in M3-25's runs.

Since those runs, M3-25 made a video spot ready at `canplaythrough`: video-pan prepared in 843–963 ms in the tuning runs and in 254–399 ms after the fix.

Earlier baselines, each from an older build and workload:

- **Third round** (301eee9, 2026-11-17): the Milestone 2 player before the wrapper frame and brand fonts, the 16-spot playlist, 150 s, one run each: 0.16% dropped overall with cuts, 0.20% with a 600 ms fade, 0.94% with a 600 ms crossfade, which drops 10% during its fade. Crossfade is offered but not the default.
- **Video** (third round): 1080p30 is decoded in hardware and drops about 1% of video frames, so it is the one accepted profile; 1080p60 drops about 18%.
- **Milestone 1 spike** (2026-11-16): one template, the C-Store promo, in the spike's harness, 20 s per run. Load to ready took 100 to 230 ms. The same promo built in Rive ran at 21.5 fps against 59.4 fps for HTML, so templates stay HTML. At 4K the Pi drops 16 to 33% of frames, so the kiosk outputs 1080p and lets a 4K panel upscale.

## Repository

```
apps/api            Cloudflare Worker: CMS API, device API, (later) MCP
apps/cms            TanStack Start CMS
apps/template-check Worker and container: the runtime check of uploaded templates
packages/contract   every shape a screen sees: manifest, template protocol, budgets, checks
packages/player     the web player; packages/player-core holds its pure logic
packages/template-sdk  what a template imports to talk to the player
packages/template-looks  the four looks a template can offer: type, fonts, motion and toggles
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
sh scripts/stress-media.sh                  # the stress example's photos and video, from a GitHub release (needs gh)
pnpm typecheck && pnpm lint && pnpm test
```

Without the stress media the stress golden test skips, loudly; CI fetches it and fails without it ([`docs/ci.md`](docs/ci.md#stress-media)).

Play the demo content in a browser, with no backend:

```sh
pnpm build                                  # player into dist/player, examples/demo into dist/content
python3 -m http.server -d dist 8000         # any static server
# open http://localhost:8000/player/?content=../content
```

Run the API and CMS locally (sign-in codes are printed in the API's terminal): see [`apps/cms/README.md`](apps/cms/README.md). The API's Wrangler config has no default environment, so local work opts in with `--env dev` (the package scripts do), and deploys name `--env demo` or `--env prod`. Registering an org template locally needs the runtime check running too: [`apps/template-check/README.md`](apps/template-check/README.md).

Put the player on the test Pi: `pnpm build && pnpm deploy:pi`. Measure playback there with `sh scripts/pi-measure.sh`, and one template in isolation with `device/pi/isolate.py`.

## Conventions

- `pnpm lint` runs Biome across the workspace, where a warning fails like an error, then ESLint on the CMS for its React rules ([`apps/cms/README.md`](apps/cms/README.md#react-rules)), as the Turbo task `lint`. The formatter checks only files a change touches (`pnpm format:check`, against `master`; `pnpm format` fixes them), so the existing code is formatted as it is edited rather than in one sweeping commit.
- Type assertions that narrow (`x as T`) fail lint outside tests, `packages/db/src` and the contract's validators. Files that had them when the rule came in are listed in `biome.jsonc`; that list only shrinks. Parse with the contract or annotate instead.
- `pnpm knip` reports unused files, exports and dependencies. `knip.jsonc` lists what knip cannot see (entry files loaded by a CLI or a bundler, fonts read from CSS), each with its reason.
- `pnpm dupes` (jscpd, `.jscpd.json`) fails when copied code passes 1% of `apps/` and `packages/` (0.7% when it came in). It catches large copy-paste, not small: a new 30-line copy moves it about 0.1 point.
- `pnpm exec turbo boundaries` fails an import that leaves its package or names a package not in its `package.json`, and any workspace dependency of `packages/contract` (its `contract` tag, in `turbo.json`). `sh scripts/check-contract-commits.sh <base>` fails a commit that changes `packages/contract` and anything else but the lockfile or generated files. `sh scripts/check-template-deps.sh` fails while a `templates/*` package is missing from the devDependencies of `apps/api`, `packages/cli`, `packages/player` or `apps/template-check`.
- CI (`.github/workflows/ci.yml`) runs lint, knip, the duplication, boundaries, contract-commit, template-dependency and format checks, then typecheck, the tests, the CMS end-to-end run and its ESLint. A pull request runs only those tasks for the packages its diff affects; `master` runs them all. [`docs/ci.md`](docs/ci.md) says how it decides and how to keep it fast.
- Turbo's remote cache is a Worker in front of an R2 bucket (`infra/turbo-cache`). With it, CI's `master`, pull requests and laptops replay each other's task results, and turbo signs every artifact and checks it on each hit. CI writes to it. A laptop reads it with the read-only token: set `TURBO_API`, `TURBO_TEAM`, `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` in the shell, from a file outside the repository. Until the owner sets the `TURBO_API` repository variable, CI keeps its local `.turbo/cache` with `actions/cache`. [`docs/ci.md`](docs/ci.md#remote-cache) has the setup steps and how laptops use it.
- In Claude Code, a Stop hook (`.claude/settings.json`, `.claude/hooks/stop-checks.sh`) runs `pnpm lint` and `pnpm typecheck` when the agent finishes, and sends it back to work while either fails, up to three times in a row. Turbo caches typecheck, so a run with nothing changed takes a few seconds.
- Work is cut into tickets in [`docs/tickets/`](docs/tickets/README.md); `AGENTS.md` has the rules that are not written down elsewhere.
