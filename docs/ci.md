# CI

One job, `check`, in `.github/workflows/ci.yml`, on pull requests that are ready for review, on pushes to `master`, nightly and by hand. It runs Turbo's tasks (typecheck, test, the CMS end-to-end run and the CMS ESLint) and the repo-wide checks.

- **A pull request** runs typecheck, test and lint for the packages its diff affects. It does not run the CMS end-to-end run (`test:e2e`): run that locally before marking the pull request ready or pushing to it, on your own ports (`E2E_API_PORT=... E2E_CMS_PORT=... pnpm --filter @signforge/cms test:e2e`), and say in the pull request that it passed.
- **A draft pull request** runs nothing: the job is skipped. Marking it ready (`gh pr ready <n>`) starts the run.
- **A push to `master`** runs every task, the CMS end-to-end run included, of the packages affected since the newest `master` commit whose CI passed. Each green run vouches for the one before it, so what a red or cancelled run did not get through runs again on the next push. When none of the 20 newest green non-PR runs is on a commit HEAD contains, or the Actions API cannot be read (the log says why), it runs everything, and so it does when the root `package.json` or the lockfile's root importer changed since that commit (see [What "affected" means](#what-affected-means)). A red `master` run is fixed first, before more merges.
- **The nightly run** (07:30 UTC) and **a manual run** (Actions, CI, "Run workflow", or `gh workflow run ci.yml`) run every task, so nothing an affected run leaves out goes untested for long. Tasks whose inputs did not change replay from the Turbo cache; the e2e always runs. The nightly run does nothing when the last nightly run passed on the same commit.
- **A change to docs and Markdown only** (`docs/**`, `**/*.md`, but not `fonts/README.md`, which the compiler's fonts test checks) starts no run, on a pull request or on `master`. `gh pr checks` then says "no checks reported", which on such a pull request is a pass.

**Agents** open pull requests as drafts (`gh pr create --draft`), run their local checks (`pnpm lint`, `pnpm typecheck`, the tests of what they touched and the CMS e2e), push their fixes, and only then mark the pull request ready. Every push to a ready pull request runs CI, and a new push cancels the run in progress, so push to a ready pull request only what it needs. Runs are grouped by event and ref, so a push to `master` cancels an older push's run but never the nightly or a manual run.

## What runs

1. Install, with the pnpm store restored from the cache.
2. The repo-wide checks, a few seconds each, on every run: Biome lint, the format check on changed files, knip, jscpd, `turbo boundaries`, the contract-commit check, the template-dependency check and packages/db's import-boundary scan.
3. The plan picks the base `--affected` compares against (a pull request's base; on `master`, the newest commit whose CI passed, found with the Actions API; none on a nightly or manual run), then `turbo run … --dry=json` lists the tasks that will run (no `test:e2e` on a pull request). Chromium is installed only if one of them is the test of a package that declares a Playwright dependency or the template harness (today the player, the CMS, media, tools, template-check, the look kit and every template).
4. The stress media, only if the cli's or the tools' tests run (see [Stress media](#stress-media)).
5. `turbo run typecheck test lint --affected --summarize` on a pull request, `turbo run typecheck test test:e2e lint --affected --summarize` on a push to `master`, and the same without `--affected` on a nightly or manual run, with Turbo's cache restored from earlier runs. The job may run 60 minutes: a run that covers everything with cold caches takes about 30 (2026-11-21: the player's tests about 18 minutes, the CMS e2e about 20, side by side). The CMS e2e alone takes about 6 minutes since #283 ([The CMS e2e's workers](#the-cms-e2es-workers)).
6. The timing summary on the run's page: each step's time, then each Turbo task's time and whether it came from the cache (`scripts/ci-summary.sh`).

## What "affected" means

`--affected` compares the commit with a base (`TURBO_SCM_BASE`): on a pull request the base it merges into, on `master` the newest commit whose CI passed. It counts a package as affected when a file in it changed or a package it depends on is affected. So a docs-only change runs nothing, a player change runs the player's tests, and a contract change runs nearly everything.

A few changes mark every package affected:
- `turbo.json`, the workflow, `tsconfig.base.json`, `biome.jsonc` and `pnpm-workspace.yaml` (`globalDependencies` in `turbo.json`, plus Turbo's own rules);
- `fonts/`, which tests read but no package owns, and `scripts/stress-media.sh`, which puts the stress media in `examples/` for the cli's and the tools' tests.

A lockfile change affects only the packages whose dependencies changed.

Turbo puts two things in no package, so `--affected` plans nothing for a change to them: the root `package.json` (the TypeScript compiler that every package but the CMS typechecks with, `tsx`, which runs `pnpm seed:templates` for the CMS e2e, and the root scripts) and the lockfile's root importer (those versions, and pnpm's own). `ci.yml` is a global dependency, and the other workflows run no task, so a change to one of them runs nothing extra. When either changed since the base, the plan drops `--affected` and runs everything, on a pull request and on `master`. A lockfile change below the root importer only (a root devDependency's own dependencies, with its version unchanged) is still invisible to the graph: the nightly run covers it.

Turbo decides what is affected from the package graph alone. It ignores a task's `inputs` that point outside its package. So a test that reads another package's files has to declare that package as a dependency, or a change there will not run the test:
- The CMS e2e starts the API, so `apps/cms` has `@signforge/api` as a devDependency.
- The cli's golden and video tests build and read `examples/`, so `examples/` is a package, `@signforge/examples`, and `packages/cli` lists it as a devDependency. A change there (a template's new stress spot, say) runs the cli's tests and those of what depends on the cli: the API, the CMS and the tools, whose publishing test compares against the cli's stress golden. It no longer runs the contract's, db's, feeds' or media's tests. The package has no scripts: Turbo still hashes its files into the tasks that depend on it, so a warm cache never replays a result built from older examples.
- The cli's and the API's tests build every template with the SDK (the cli's also check that no bundle changed without a new version: [template-spec.md](template-spec.md#rules)), and the runtime check's tests (`apps/template-check`) play every template. So `packages/cli`, `apps/api` and `apps/template-check` list each `templates/*` package and `@signforge/template-sdk` as devDependencies. **A new template goes into all three lists, and gets browser tests of its own** (below): the repo-wide step `scripts/check-template-deps.sh` fails until it does. The check's container tests (`pnpm --filter @signforge/template-check test:container`) need Docker and do not run in CI.
- Each template's browser tests are its own package's `test` task (`templates/<id>/test`, on the harness in [`packages/template-test`](../packages/template-test/README.md)), and the look kit's are `packages/template-looks`'s. So a change to one template runs only its own browser tests, beside the cli's, the API's and the runtime check's. A change to the harness, the template builder (`packages/template-build`), the SDK, the contract or media runs every template's; one to the look kit runs its own and those of the templates on it. The player keeps its own browser tests (playback, sync, takeovers, files and the rest), which run when the player, player-core, the contract, the SDK or the Alert template change: its takeover test plays the Alert, so the player lists `@signforge/template-alert`.

knip lists these dependencies as ones it cannot see used.

One check sees more than the package graph does: packages/db's boundary test (`test/node/boundary.test.ts`) scans the whole repo for imports that reach past `@signforge/db`, above all production code that imports `@signforge/db/testing`, a public export that neither `exports` nor `turbo boundaries` refuses. So it runs on every run as a repo-wide step (`pnpm --filter @signforge/db exec vitest run --project node`, about 2 s), whatever is affected, and again inside `db#test` when db is.

## Stress media

`examples/stress` plays photos and a video that are not in git: they are large, and the photos are third-party. The canonical set is the tarball on the release `stress-media-v1`, and `examples/stress/media.sha256` lists each file's sha256. `sh scripts/stress-media.sh` downloads it with `gh` (logged in, or `GH_TOKEN` set) and checks every file; with the media already in place it only checks.

The stress golden (`packages/cli/test/golden/stress.json`) is built from exactly those bytes, and the tools' publishing test compares against that golden. The cli's golden test checks the media against `media.sha256` first. Without the canonical set it fails in CI (`CI` set) and skips elsewhere, saying so on stderr and in the test name.

CI fetches the media when the plan includes the cli's or the tools' tests, with the job's `GITHUB_TOKEN`, and caches it under the hash of `media.sha256`. The media itself is in `.gitignore`, so Turbo does not hash it. A new version changes `media.sha256`, in the `@signforge/examples` package, and the release named in `scripts/stress-media.sh`, a global dependency, so it reruns every task.

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
- **Turbo**: the remote cache below. Pull requests, `master` and the nightly run read and write the same entries, so the push that merges a pull request replays what the pull request ran, and a rerun replays the tasks that passed. Turbo caches every task but the e2e run (`cache: false`).

### Remote cache

`infra/turbo-cache` is a Worker in front of an R2 bucket that speaks Turbo's remote cache API: `GET`, `HEAD` and `PUT /v8/artifacts/:hash` and `GET /v8/artifacts/status`, the calls turbo 2.11 makes when it runs tasks. It leaves out two calls, which turbo copes with:
- `POST /v8/artifacts`, the batch lookup that only `--dry` uses: on a 404, turbo sends a `HEAD` per hash instead.
- `POST /v8/artifacts/events`, Vercel's usage analytics: turbo ignores the failure.

With it, `master`, pull requests and laptops replay each other's results. The merge push replays every task whose inputs match the pull request's.

- **Tokens.** `TURBO_TOKEN` reads and writes. CI uses it, on pull requests too: in this single-owner repository the pull requests are the owner's and the owner's agents, and their writes are what the merge push replays. `TURBO_READ_TOKEN` only reads. The Worker's status call tells turbo so, and turbo then skips uploads without a warning.
- **Who can read the secrets.** A pull request from a branch in this repository runs the `ci.yml` on that branch. Anyone who can push a branch can therefore change the workflow to print or send the write token and the signature key. Pull requests from forks get no secrets.
  If anyone but the owner and the owner's agents gets push access:
  - move `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` into a GitHub environment that only `master` can use, and give pull requests the read token;
  - note that turbo checks every hit with the signature key, so a pull request without it replays nothing. The key alone cannot plant an entry, since writing takes the write token too, so pull requests may keep a copy of the key, or run without the remote cache.
- **Uploads.** An artifact may be up to 64 MiB; CI's are about 8 KB. The Worker refuses a larger one (413), one without `Content-Length` (411) and a tag that is not a signature (400), and stores nothing.
- **Signatures.** `remoteCache.signature` in `turbo.json` makes turbo sign each artifact with `TURBO_REMOTE_CACHE_SIGNATURE_KEY` and check the signature on every hit. An entry changed on the server fails the check, and the task runs instead. The Worker stores the tag and never sees the key. Use at least 32 bytes (`openssl rand -hex 32`); turbo warns below that.
- **Expiry.** The bucket's lifecycle rule deletes entries 30 days after they are written. A miss just runs the task. The cache holds logs and small outputs, about 1.4 MB per full run (2026-11-22).
- **CI.** The `check` job passes the repository variables `TURBO_API` and `TURBO_TEAM` and the secrets `TURBO_TOKEN` and `TURBO_REMOTE_CACHE_SIGNATURE_KEY` to Turbo. The token is passed only when `TURBO_API` is set, so it never reaches Turbo's default server, which is Vercel's. While `TURBO_API` is unset, Turbo says "Remote caching disabled" and every task runs. A pull request from a fork gets no secrets, so its tasks run without the cache.
- **Laptops.** Read-only, with the read token. Keep it out of the repository, for example in `~/.config/signforge/turbo.env`, mode 600:

  ```sh
  export TURBO_API=https://signforge-turbo-cache.signforge-spike-m3-platform.workers.dev
  export TURBO_TEAM=signforge
  export TURBO_TOKEN=$(cat ~/.config/signforge/TURBO_READ_TOKEN)
  export TURBO_REMOTE_CACHE_SIGNATURE_KEY=$(cat ~/.config/signforge/TURBO_REMOTE_CACHE_SIGNATURE_KEY)
  ```

  `. ~/.config/signforge/turbo.env` before `pnpm typecheck` or `pnpm test`. Turbo reads the cache and keeps writing only its local `.turbo/cache`.
- **Setting it up.** Done on 2026-11-23: the Worker is `https://signforge-turbo-cache.signforge-spike-m3-platform.workers.dev`. To build it again, the owner runs these from `infra/turbo-cache`, after `wrangler login`:
  1. `pnpm exec wrangler r2 bucket create signforge-turbo-cache`
  2. `pnpm exec wrangler r2 bucket lifecycle add signforge-turbo-cache expire-30-days --expire-days 30 --force`
  3. Generate each secret into a file only you can read, and never paste it into a chat, an issue or a log: `(umask 077; mkdir -p ~/.config/signforge; for s in TURBO_TOKEN TURBO_READ_TOKEN TURBO_REMOTE_CACHE_SIGNATURE_KEY; do openssl rand -hex 32 > ~/.config/signforge/$s; done)`
  4. `pnpm exec wrangler secret put TURBO_TOKEN < ~/.config/signforge/TURBO_TOKEN`, and the same for `TURBO_READ_TOKEN`. The Worker never sees the signature key.
  5. `pnpm exec wrangler deploy`. It prints the Worker's URL.
  6. GitHub: `gh secret set TURBO_TOKEN < ~/.config/signforge/TURBO_TOKEN`, `gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY < ~/.config/signforge/TURBO_REMOTE_CACHE_SIGNATURE_KEY`, `gh variable set TURBO_TEAM --body signforge`, and last `gh variable set TURBO_API --body <the URL>`, which turns it on.

- **Rotating one secret.** Regenerate only that one: `(umask 077; openssl rand -hex 32 > ~/.config/signforge/<NAME>)`. Then put it where it is used:
  - `TURBO_TOKEN`: `pnpm exec wrangler secret put TURBO_TOKEN < ~/.config/signforge/TURBO_TOKEN` (from `infra/turbo-cache`), then `gh secret set TURBO_TOKEN < ~/.config/signforge/TURBO_TOKEN`. A CI run between the two gets a 401 and runs its tasks without the remote cache.
  - `TURBO_READ_TOKEN`: `pnpm exec wrangler secret put TURBO_READ_TOKEN < ~/.config/signforge/TURBO_READ_TOKEN`. Laptops pick it up from the file the next time they source `turbo.env`.
  - `TURBO_REMOTE_CACHE_SIGNATURE_KEY`: `gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY < ~/.config/signforge/TURBO_REMOTE_CACHE_SIGNATURE_KEY`. The Worker never sees it. Every entry fails its check until CI has written it again, so the next runs rerun everything once.

## Keeping it fast

- Declare what a test reads. A test that reads files outside its package needs that package as a dependency, or the directory in `globalDependencies` if no package owns it (better: make it a package, as `examples/` is). Otherwise a change there either skips the test on pull requests and on pushes to `master`, until the nightly run, or, with a warm cache, replays a stale result.
- Keep the repo-wide checks repo-wide only while they take seconds. Anything slower should become a Turbo task in the package it checks.
- Keep the workflow's `paths:` filter to files no test reads. A file a test reads that the filter leaves out (as `fonts/README.md` is put back) would change without a run.
- The player's tests were the longest task: about 14 minutes on GitHub's two-core runner (2026-11-22), most of it `browser/templates.test.ts` (about 13.5 min), which played every template, so any template change ran all of it. Each template's browser tests are now their own task (#272, [below](#per-template-tests-272)), so a pull request that changes one template runs only that one. The slowest is the Info frame's, about 4 m 40 s on a laptop, for its 288 rail × crawl × toggle settings; the rest take 5 s to 1 min. The player's own browser tests are about 2 min on a laptop. A change to the harness, the builder, the SDK or the contract still runs every template's, each in its own task.
- Every template change adds a spot to `examples/stress/spots`. While `examples/**` was a global dependency, the push that merged it reran every task of every package: of five `master` runs measured on 2026-11-21 and 22, three replayed nothing from the cache, one replayed 2 of 43 tasks and one 26 of 43. Now `examples/` is a package ([What "affected" means](#what-affected-means)), so such a push reruns the cli's tests and those of its dependents, not the contract's, db's, feeds' or media's.

## The API's workerd tests: no module cache on disk

`apps/api/vitest.config.ts` sets `fsModuleCache: false`. Vitest 5 turns that cache on by default, and with it the API's suite crashed ("Worker exited unexpectedly during started state") whenever a worker started after another had finished. That happens when there are more test files than workers, or with `--maxWorkers`. Each file still gets a fresh worker and its own workerd. The trouble is the start of the second one:
- With the cache on, a new worker asks Vitest for every module it already has on disk (`fetchWarmModules`). Vitest answers with paths to the cached files.
- workerd cannot read those paths. So `@cloudflare/vitest-plugin` (1.8.4) reads them in Node and inlines all the code into one WebSocket message.
- For the API that message was 32.35 MiB: 2,199 modules, measured 2026-11-18. That is over workerd's 32 MiB message limit, so workerd closes the socket (code 1009, "Message is too large") and Vitest reports the worker as exited.

Without the cache on disk, the warm list is empty, and each module is fetched on its own (the largest is 1.5 MiB). packages/tools' warm message was 11 MiB and packages/db's under 0.25 MiB, so they keep the cache. If either one starts to crash the same way, give it the same setting. The bug is in the plugin: drop the setting once the plugin sends warm modules in pieces.

## The CMS e2e's workers

`apps/cms/playwright.config.ts` runs the e2e's specs side by side, three at a time, on a laptop and on CI, but each spec's own tests in order (`fullyParallel: false`). It runs against the built CMS: `global-setup.ts` builds it (about 3 s) and serves the built Worker with `vite preview`. Under `vite dev` each module compiled on its first request, which is what the warm-up, the 30 s hydration waits and most of the specs' `test.setTimeout` calls were for (#283).

GitHub's `ubuntu-24.04` runner has 4 cores for this repository since it went public (2026-11-23). On it, every run below passed. Each is the CMS e2e alone on its own runner, from the `e2e-measure` workflow #283 used and then removed (Playwright's own time):

| Setup | 1 worker | 2 workers | 3 workers | 4 workers |
| --- | --- | --- | --- | --- |
| `vite dev`, as on `master` before #283 (run 45124512959) | 18.5, 16.3 min | 10.2, 10.2 | 11.8, 8.7 | |
| Built CMS (run 45125869629) | 15.2, 16.5 | 8.1, 7.8 | 6.6, 7.2 | |
| Built CMS, cheaper `axe`, orgs through the API (runs 45146239608, 45147142350) | | | 5.9, 6.0, 7.5, 5.9, 6.0, 5.9, 7.4, 7.7 | 5.3, 5.4, 6.1, 5.3 |

In a full run of every task with the remote cache warm (45147984299, on this branch), the e2e took 6.2 min beside the others and the job 11 m 51 s. CI keeps 3 workers: 8 runs of 8 passed at 3. Four saved under a minute, and leave the API, the CMS and Chromium's GPU process no core of their own. Sharding does not pay: Playwright shards by spec when tests are not fully parallel, so two shards split the run 69 tests to 1 (6.9 min against 0.5), and each shard job repeats the install and the setup. On an 18-core Mac, 3 workers take 3.8–4.6 min (5.6 under `vite dev`).

What #283 changed beside the build, and why:
- `axe()` reads the CMS's own document once in each theme with the players' frames left out, and the frames alone, in the light theme, inside the fade guard. The guard used to cover the whole page, and on CI that one analysis outlasted a 4 s spot, so a fade began during each of its 5 tries (`playlists.spec.ts`, 2 runs of 7).
- Specs make their orgs through Better Auth's endpoint (`createOrg` in `e2e/helpers.ts`); only `sign-in-and-orgs.spec.ts` makes one through the page.
- No test sleeps or asserts on elapsed time: the waits are on requests, the page's state, or the page's clock (`page.clock` in `session-ended.spec.ts`).
- A failed test keeps its trace. Playwright 1.65 starts a trace chunk on every open context at each test, so the contexts a serial spec makes in `beforeAll` are traced too. CI's e2e artifact has the HTML report (`playwright-report`), with each test's time.
- The setup refuses an API or CMS port something already holds, found by binding it on 127.0.0.1 and ::1 (`portTaken`): an HTTP probe of 127.0.0.1 missed a CMS on ::1. Teardown kills each server's process group after SIGTERM.

On a 2-core runner (#249, 2026-11-22, runs 45107471407 and 45109633670), 2 or 3 workers failed 7 runs of 8, on timeouts and fades, and 1 worker took 22–26 min: Chromium drawing the real player on the stages used most of the CPU.

## Measured

On GitHub's `ubuntu-24.04` runner, 2026-11-22. It has four cores for a public repository, as this one is since 2026-11-23, and two for a private one; the measurements below are from the two-core runner. On two cores Vitest runs one test file at a time unless a config asks for more, and the `turbo run` step passes `--concurrency=100%`, one task per core: with Turbo's default of 10, the 13 template test tasks each start a Chromium at once and browser tests miss their waits. Times are the job's, from its start to its end; Turbo is the `turbo run` step.

The week before this workflow (2026-11-15 to 22, from the Actions API): 333 pull request runs, 2,602 minutes (2,760 billed, each job rounded up to a minute), and 105 `master` runs, 1,230 minutes (1,284 billed). Setup and the repo-wide checks take about 45 s of each run (checkout 2–6 s, pnpm 8–11 s, Node 4–7 s, store 6–9 s, install 3–6 s, the checks about 10 s). The rest is Turbo's tasks.

| Run | Before | After |
| --- | ---: | ---: |
| Draft pull request | the affected tasks on every push | job skipped, 0 minutes (45108818670) |
| Docs-only pull request or push | about a minute on a pull request, every task on `master`: 10 such runs, 43 minutes in the week | no run (#255) |
| Pull request, every task with a cold cache (no e2e) | 21 m 01 s, Turbo 19 m 58 s (#201, 44979171863) | 15 m 07 s, Turbo 14 m 06 s (#254, 45108976002) |
| `player:test` in that run | 1,168 s, one file at a time | 817 s, two files at a time (`templates.test.ts` 809 s beside the other 22) |
| Pull request, typical | about 4 min (#195 4 m 24 s, #246 3 m 55 s: 45069709571, 45104405919) | the same: what it affects |
| Push to `master` | every task: 14–31 min (44944143395 30 m 11 s, 44976726090 31 m 05 s, 45070332774 13 m 43 s, whose e2e failed after 10 min) | the tasks affected since the last green commit. In the week, 62 of the 105 pushes (741 minutes) changed no global dependency, template, contract, SDK, player or CLI |
| Nightly | none | every task, the Turbo cache replaying what did not change; skipped when the last nightly passed on the same commit |

The slowest tasks with cold caches (44944143395): `player:test` 1,161 s, the CMS e2e about 27 min beside them (one Playwright worker then; 6–7.5 min with three since #283: [The CMS e2e's workers](#the-cms-e2es-workers)), `api:test` 481 s, `tools:test` 248 s, `template-check:test` 157 s, `db:test` 126 s, `cms:lint` 153 s. The API's 28 files spend 103 s in their tests and the rest in each file's module transform (no module cache on disk, above) and setup.

TypeScript is 7.0.2, the native compiler, so there is nothing to gain from `@typescript/native-preview`: `tsc -p apps/api` takes 0.98 s on a laptop against 4.2 s with TypeScript 5.9.3, and every typecheck in the repo takes 7 s. In CI a typecheck takes 1–80 s only because it shares two cores with the tests.

Bun would not help. Install and setup are about 30 s of the run, and the slow tasks run in workerd (the API, tools and db through Cloudflare's Vitest pool), in Chromium (the player, the CMS e2e, template-check) and in Node, whatever installs the packages.

## Per-template tests (#272)

Before, `packages/player/browser/templates.test.ts` played every template inside `player:test`, so any template change ran all of it: 809 s of an 817 s `player:test` on CI's runner (#254, run 45108976002), and 517 s of 519 s on a laptop (2026-11-22). Now each template's tests are its own package's task, on the harness in `packages/template-test`. On the same laptop, at the PR's head:

| Task | Time | Tests |
| --- | ---: | ---: |
| `player:test` before (with templates.test.ts) | 519 s | 321 |
| `player:test` after | 114 s | 183 |
| All 13 template tasks together, `--force` | 4 m 48 s | 283 |
| `template-info-frame:test` | 282 s | 27 |
| `template-photo-promo:test` | 58 s | 37 |
| `template-countdown:test`, `template-room-status:test` | 43 s each | 18, 11 |
| `template-clock:test` | 5 s | 20 |

A change to `templates/clock` alone now runs `template-clock:test` (5 s) beside the cli's, the API's, the tools', the runtime check's and the CMS unit tests, and no longer `player:test`. The template tasks have more tests than templates.test.ts had (283, from 138) because the brand-colour checks that played six templates in one test now run per template.

## Required status check

`master` cannot require this check today. Branch protection and rulesets need GitHub Pro (or Team) for a private repository: the API answers 403, "Upgrade to GitHub Pro or make this repository public to enable this feature". So nothing waits on `check`: a docs-only pull request, which starts no run, merges as any other.

On a plan that has them, requiring `check` needs one change first. A draft's skipped job counts as passed, but a docs-only pull request starts no run at all, so a required `check` would sit pending on it forever. Either drop the workflow's `paths:` filter (the run then only installs and runs the repo-wide checks, about 50 s, billed as a minute) or add a second workflow with the same job name that runs on exactly those paths and passes.
