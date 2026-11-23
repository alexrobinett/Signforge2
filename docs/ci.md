# CI

One job, `check`, in `.github/workflows/ci.yml`, on every pull request and every push to `master`. It runs Turbo's tasks (typecheck, test, the CMS end-to-end run and the CMS ESLint) and the repo-wide checks.

- **A pull request** runs typecheck, test and lint for the packages its diff affects. It does not run the CMS end-to-end run (`test:e2e`): run that locally before opening or updating the pull request, on your own ports (`E2E_API_PORT=... E2E_CMS_PORT=... pnpm --filter @signforge/cms test:e2e`), and say in the pull request that it passed.
- **A push to `master`** runs every task, the CMS end-to-end run included, so nothing a pull request skipped goes unchecked and the caches that pull requests read stay warm. A red `master` run is fixed first, before more merges.

## What runs

1. Install, with the pnpm store restored from the cache.
2. The repo-wide checks, a few seconds each, on every run: Biome lint, the format check on changed files, knip, jscpd, `turbo boundaries`, the contract-commit check and the template-dependency check.
3. The plan: `turbo run … --dry=json` lists the tasks that will run (`--affected` and no `test:e2e` on a pull request). Chromium is installed only if one of them is the test of a package that declares a Playwright dependency (today the player, the CMS, media, tools and template-check).
4. The stress media, only if the cli's or the tools' tests run (see [Stress media](#stress-media)).
5. `turbo run typecheck test lint --affected --summarize` on a pull request, or `turbo run typecheck test test:e2e lint --summarize` on `master`, with Turbo's cache restored from earlier runs. The job may run 60 minutes: on `master` with cold caches (a contract change rebuilds nearly everything) the tests take about 16 minutes and the CMS e2e about 20 (2026-11-21).
6. The timing summary on the run's page: each step's time, then each Turbo task's time and whether it came from the cache (`scripts/ci-summary.sh`).

## What "affected" means

`--affected` compares the pull request with the base it merges into (`TURBO_SCM_BASE`, the base's sha). It counts a package as affected when a file in it changed or a package it depends on is affected. So a docs-only change runs nothing, a player change runs the player's tests, and a contract change runs nearly everything.

A few changes mark every package affected:
- `turbo.json`, the workflow, `tsconfig.base.json`, `biome.jsonc` and `pnpm-workspace.yaml` (`globalDependencies` in `turbo.json`, plus Turbo's own rules);
- `fonts/` and `examples/`, which tests read but no package owns.

A lockfile change affects only the packages whose dependencies changed.

Turbo decides what is affected from the package graph alone. It ignores a task's `inputs` that point outside its package. So a test that reads another package's files has to declare that package as a dependency, or a change there will not run the test:
- The CMS e2e starts the API, so `apps/cms` has `@signforge/api` as a devDependency.
- The cli's and the API's tests build every template with the SDK (the cli's also check that no bundle changed without a new version: [template-spec.md](template-spec.md#rules)), and the player's browser tests and the runtime check's tests (`apps/template-check`) play every template. So `packages/cli`, `apps/api`, `packages/player` and `apps/template-check` list each `templates/*` package and `@signforge/template-sdk` as devDependencies. **A new template goes into all four lists**: the repo-wide step `scripts/check-template-deps.sh` fails until it does. The check's container tests (`pnpm --filter @signforge/template-check test:container`) need Docker and do not run in CI.

knip lists these dependencies as ones it cannot see used.

One check sees more than the package graph does: packages/db's boundary test scans the whole repo for imports that reach past `@signforge/db`. A pull request runs it only when db is affected. On other pull requests, db's `exports` and `turbo boundaries` refuse those imports, and `master` runs the scan.

## Stress media

`examples/stress` plays photos and a video that are not in git: they are large, and the photos are third-party. The canonical set is the tarball on the release `stress-media-v1`, and `examples/stress/media.sha256` lists each file's sha256. `sh scripts/stress-media.sh` downloads it with `gh` (logged in, or `GH_TOKEN` set) and checks every file; with the media already in place it only checks.

The stress golden (`packages/cli/test/golden/stress.json`) is built from exactly those bytes, and the tools' publishing test compares against that golden. The cli's golden test checks the media against `media.sha256` first. Without the canonical set it fails in CI (`CI` set) and skips elsewhere, saying so on stderr and in the test name.

CI fetches the media when the plan includes the cli's or the tools' tests, with the job's `GITHUB_TOKEN`, and caches it under the hash of `media.sha256`. `media.sha256` is under `examples/`, a global dependency, so a new version reruns every task.

A new version (new photos, a re-encoded video) is a new release and a regenerated golden, in one pull request:
1. `rm -rf examples/stress/media && sh scripts/stress-media.sh --generate` makes a set with curl and ffmpeg, or put the files there by hand. ffmpeg's output differs by machine and version, which is why the set is published rather than generated.
2. In `examples/stress/media`: `tar -czf ../stress-media-v2.tar.gz *` and `shasum -a 256 * > ../media.sha256`.
3. `gh release create stress-media-v2 examples/stress/stress-media-v2.tar.gz --latest=false`, then delete the local tarball. Keep the old releases: older commits fetch them.
4. Set `release=stress-media-v2` in `scripts/stress-media.sh`.
5. Run `sf build examples/stress` and save its `manifest.json` as `packages/cli/test/golden/stress.json`, without `generatedAt`, keys sorted, two-space indent.

## Caches

- **pnpm store**: restored on every run, keyed by the lockfile, falling back to the newest store. It is saved only from `master`: an upload took up to a minute, and a pull request would pay that again on each new lockfile.
- **Playwright**: the headless shell (`playwright install --only-shell chromium`, which every browser test uses), keyed by the Playwright version in the lockfile. System packages are installed only when the shell links a library the runner lacks. On GitHub's Ubuntu 24.04 image none is missing, which saves the 15 s apt run.
- **Stress media**: `examples/stress/media`, keyed by the hash of `examples/stress/media.sha256`.
- **Turbo**: the remote cache below, once it is set up. Until then, `.turbo/cache`, saved under the commit's sha and restored from the newest entry, even after a failure, so a rerun replays the tasks that passed. A pull request can read its own earlier runs and `master`'s, but not other pull requests', so the push that merges a pull request runs again what the pull request just ran. Turbo caches every task but the e2e run (`cache: false`).

### Remote cache

`infra/turbo-cache` is a Worker in front of an R2 bucket that speaks Turbo's remote cache API: `GET`, `HEAD` and `PUT /v8/artifacts/:hash` and `GET /v8/artifacts/status`, the calls turbo 2.11 makes when it runs tasks. It leaves out two calls, which turbo copes with:
- `POST /v8/artifacts`, the batch lookup that only `--dry` uses: on a 404, turbo sends a `HEAD` per hash instead.
- `POST /v8/artifacts/events`, Vercel's usage analytics: turbo ignores the failure.

With it, `master`, pull requests and laptops replay each other's results. The merge push replays every task whose inputs match the pull request's.

- **Tokens.** `TURBO_TOKEN` reads and writes. CI uses it, on pull requests too: in this single-owner repository the pull requests are the owner's and the owner's agents, and their writes are what the merge push replays. `TURBO_READ_TOKEN` only reads. The Worker's status call tells turbo so, and turbo then skips uploads without a warning. If outside contributors ever push branches, give pull requests the read token, or `TURBO_CACHE=local:rw,remote:r`, and let only `master` write.
- **Signatures.** `remoteCache.signature` in `turbo.json` makes turbo sign each artifact with `TURBO_REMOTE_CACHE_SIGNATURE_KEY` and check the signature on every hit. An entry changed on the server fails the check, and the task runs instead. The Worker stores the tag and never sees the key. Use at least 32 bytes (`openssl rand -hex 32`); turbo warns below that.
- **Expiry.** The bucket's lifecycle rule deletes entries 30 days after they are written. A miss just runs the task. The cache holds logs and small outputs, about 1.4 MB per full run (2026-11-22).
- **CI.** The `check` job passes the repository variables `TURBO_API` and `TURBO_TEAM` and the secrets `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` to Turbo. The token is passed only when `TURBO_API` is set, so it never reaches Turbo's default server, which is Vercel's. While `TURBO_API` is unset, Turbo says "Remote caching disabled", and the job carries `.turbo/cache` with `actions/cache` as before. Once the remote cache has run green on `master`, drop those two steps and `TURBO_CACHE_DIR`.
- **Laptops.** Read-only, with the read token. Keep it out of the repository, for example in `~/.config/signforge/turbo.env`, mode 600:

  ```sh
  export TURBO_API=https://signforge-turbo-cache.<subdomain>.workers.dev
  export TURBO_TEAM=signforge
  export TURBO_TOKEN=<the read token>
  export TURBO_REMOTE_CACHE_SIGNATURE_KEY=<the signature key>
  ```

  `. ~/.config/signforge/turbo.env` before `pnpm typecheck` or `pnpm test`. Turbo reads the cache and keeps writing only its local `.turbo/cache`.
- **Setting it up or rotating a secret** (the owner, with `wrangler login`; from `infra/turbo-cache`):
  1. `pnpm exec wrangler r2 bucket create signforge-turbo-cache`
  2. `pnpm exec wrangler r2 bucket lifecycle add signforge-turbo-cache expire-30-days --expire-days 30 --force`
  3. Generate each secret into a file only you can read, and never paste it into a chat, an issue or a log: `umask 077; mkdir -p ~/.config/signforge; for s in TURBO_TOKEN TURBO_READ_TOKEN TURBO_REMOTE_CACHE_SIGNATURE_KEY; do openssl rand -hex 32 > ~/.config/signforge/$s; done`
  4. `pnpm exec wrangler secret put TURBO_TOKEN < ~/.config/signforge/TURBO_TOKEN`, and the same for `TURBO_READ_TOKEN`. The Worker never sees the signature key.
  5. `pnpm exec wrangler deploy`. It prints the Worker's URL.
  6. GitHub: `gh secret set TURBO_TOKEN < ~/.config/signforge/TURBO_TOKEN`, `gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY < ~/.config/signforge/TURBO_REMOTE_CACHE_SIGNATURE_KEY`, `gh variable set TURBO_TEAM --body signforge`, and last `gh variable set TURBO_API --body <the URL>`, which turns it on.

  Rotating a secret: repeat steps 3, 4 and 6 for that secret. A new signature key turns every entry into a miss until CI has written them again.

## Keeping it fast

- Declare what a test reads. A test that reads files outside its package needs that package as a dependency, or the directory in `globalDependencies` if no package owns it. Otherwise a change there either skips the test on pull requests or, with a warm cache, replays a stale result.
- Keep the repo-wide checks repo-wide only while they take seconds. Anything slower should become a Turbo task in the package it checks.
- Don't add `paths:` filters to the workflow. A skipped workflow never reports, so a required check would wait forever; `--affected` already skips what a change does not touch.
- The player's browser tests are the longest task: 2 m 30 s alone, about 3 min beside the rest of a full run. Any change to the player, the SDK, the CLI, the contract or a template runs them. Making them shorter, or splitting them across runners, is what would bring those pull requests down next.

## The API's workerd tests: no module cache on disk

`apps/api/vitest.config.ts` sets `fsModuleCache: false`. Vitest 5 turns that cache on by default, and with it the API's suite crashed ("Worker exited unexpectedly during started state") whenever a worker started after another had finished. That happens when there are more test files than workers, or with `--maxWorkers`. Each file still gets a fresh worker and its own workerd. The trouble is the start of the second one:
- With the cache on, a new worker asks Vitest for every module it already has on disk (`fetchWarmModules`). Vitest answers with paths to the cached files.
- workerd cannot read those paths. So `@cloudflare/vitest-plugin` (1.8.4) reads them in Node and inlines all the code into one WebSocket message.
- For the API that message was 32.35 MiB: 2,199 modules, measured 2026-11-18. That is over workerd's 32 MiB message limit, so workerd closes the socket (code 1009, "Message is too large") and Vitest reports the worker as exited.

Without the cache on disk, the warm list is empty, and each module is fetched on its own (the largest is 1.5 MiB). packages/tools' warm message was 11 MiB and packages/db's under 0.25 MiB, so they keep the cache. If either one starts to crash the same way, give it the same setting. The bug is in the plugin: drop the setting once the plugin sends warm modules in pieces.

## Measured

Wall time of each run, from creation to its last update, on GitHub's `ubuntu-24.04` runners, 2026-11-18. The baseline is the workflow before this change, which ran everything on every run. The docs, feeds and player rows are throwaway pull requests on top of this change (#9, #10, #11), each touching one place. They started with cold caches: a pull request reads only its own caches and `master`'s, and `master` had not run this workflow yet.

| Change | Wall time | What ran |
| --- | ---: | --- |
| Baseline, any change (runs 44237204249, 44237196981) | 4 m 57 s, 6 m 18 s | Everything. Tests took 3 m 06 s–3 m 31 s; the slower run also spent 65 s uploading the pnpm store. |
| This change, cold caches (44239478412) | 4 m 55 s | Everything: the change touches the workflow, a global dependency. 14 test and lint tasks, 20 typechecks, the e2e run. |
| This change again (44240106272) | 4 m 11 s | Everything again: the commit changed the workflow, so no Turbo cache entry matched. |
| This change merged with its base (44244442985) | 4 m 40 s | Everything; the merge brought new code into most packages. |
| The same commit rerun, warm Turbo cache (44244442985, attempt 2) | 1 m 41 s | All 34 cacheable tasks replayed from the cache; only the e2e run (45 s, never cached) ran. |
| Docs only (#9, 44240132884) | 52 s | No Turbo task, no browser: install and the repo-wide checks. |
| `packages/feeds` only (#10, 44240134887) | 4 m 27 s | feeds and what depends on it: cli, player, tools, api, and the CMS through the API (8 test and lint tasks, 19 typechecks, the e2e run). |
| Player only (#11, 44240138678) | 3 m 31 s | `player:test` (2 m 30 s) and the typechecks it depends on. |

Where the time goes now: setup and the repo-wide checks take about 50 s, then whichever affected test is slowest. That is the player's browser tests (2 m 30 s alone) or the API's workerd tests. Once `master` has run this workflow, a pull request starts from `master`'s Turbo cache, so the typechecks of packages it did not change replay instead of running.

## Required status check

`master` cannot require this check today. Branch protection and rulesets need GitHub Pro (or Team) for a private repository: the API answers 403, "Upgrade to GitHub Pro or make this repository public to enable this feature". On a plan that has them, require the `check` job. It runs on every pull request, even one that affects no package, so it never sits pending.
