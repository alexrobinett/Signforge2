# CI

One job, `check`, in `.github/workflows/ci.yml`, on every pull request and every push to `master`. It runs Turbo's tasks (typecheck, test, the CMS end-to-end run and the CMS ESLint) and the repo-wide checks. A pull request runs only the tasks of the packages its diff affects. A push to `master` runs every task, so nothing a pull request skipped goes unchecked and the caches that pull requests read stay warm.

## What runs

1. Install, with the pnpm store restored from the cache.
2. The repo-wide checks, a few seconds each, on every run: Biome lint, the format check on changed files, knip, jscpd, `turbo boundaries` and the contract-commit check.
3. The plan: `turbo run … --affected --dry=json` lists the tasks that will run. Chromium is installed only if one of them is the test of a package that declares a Playwright dependency (today the player, the CMS, media and tools).
4. `turbo run typecheck test test:e2e lint --affected --summarize`, with Turbo's cache restored from earlier runs.
5. The timing summary on the run's page: each step's time, then each Turbo task's time and whether it came from the cache (`scripts/ci-summary.sh`).

## What "affected" means

`--affected` compares the pull request with the base it merges into (`TURBO_SCM_BASE`, the base's sha). It counts a package as affected when a file in it changed or a package it depends on is affected. So a docs-only change runs nothing, a player change runs the player's tests, and a contract change runs nearly everything.

A few changes mark every package affected:
- `turbo.json`, the workflow, `tsconfig.base.json`, `biome.jsonc` and `pnpm-workspace.yaml` (`globalDependencies` in `turbo.json`, plus Turbo's own rules);
- `fonts/` and `examples/`, which tests read but no package owns.

A lockfile change affects only the packages whose dependencies changed.

Turbo decides what is affected from the package graph alone. It ignores a task's `inputs` that point outside its package. So a test that reads another package's files has to declare that package as a dependency, or a change there will not run the test:
- The CMS e2e starts the API, so `apps/cms` has `@signforge/api` as a devDependency.
- The API's tests build every template with the SDK, and the player's browser tests play every template. So `apps/api` and `packages/player` list each `templates/*` package (and the API lists `@signforge/template-sdk`) as devDependencies. **A new template goes into both lists.** Until it does, a pull request that changes only that template skips those tests, and `master` catches what they would have.

knip lists these dependencies as ones it cannot see used.

One check sees more than the package graph does: packages/db's boundary test scans the whole repo for imports that reach past `@signforge/db`. A pull request runs it only when db is affected. On other pull requests, db's `exports` and `turbo boundaries` refuse those imports, and `master` runs the scan.

## Caches

- **pnpm store**: restored on every run, keyed by the lockfile, falling back to the newest store. It is saved only from `master`: an upload took up to a minute, and a pull request would pay that again on each new lockfile.
- **Playwright**: the headless shell (`playwright install --only-shell chromium`, which every browser test uses), keyed by the Playwright version in the lockfile. System packages are installed only when the shell links a library the runner lacks. On GitHub's Ubuntu 24.04 image none is missing, which saves the 15 s apt run.
- **Turbo**: `.turbo/cache`, saved under the commit's sha and restored from the newest entry, even after a failure, so a rerun replays the tasks that passed. Turbo caches every task but the e2e run (`cache: false`). A pull request can read its own earlier runs and `master`'s, but not other pull requests'.

A remote cache would share Turbo's cache with laptops and across pull requests. The README says how to move to one.

## Keeping it fast

- Declare what a test reads. A test that reads files outside its package needs that package as a dependency, or the directory in `globalDependencies` if no package owns it. Otherwise a change there either skips the test on pull requests or, with a warm cache, replays a stale result.
- Keep the repo-wide checks repo-wide only while they take seconds. Anything slower should become a Turbo task in the package it checks.
- Don't add `paths:` filters to the workflow. A skipped workflow never reports, so a required check would wait forever; `--affected` already skips what a change does not touch.
- The player's browser tests are the longest task: 2 m 30 s alone, about 3 min beside the rest of a full run. Any change to the player, the SDK, the CLI, the contract or a template runs them. Making them shorter, or splitting them across runners, is what would bring those pull requests down next.

## Measured

Wall time of each run, from creation to its last update, on GitHub's `ubuntu-24.04` runners, 2026-11-18. The baseline is the workflow before this change, which ran everything on every run. The docs, feeds and player rows are throwaway pull requests on top of this change (#9, #10, #11), each touching one place. They started with cold caches: a pull request reads only its own caches and `master`'s, and `master` has not run this workflow yet.

| Change | Wall time | What ran |
| --- | ---: | --- |
| Baseline, any change (runs 44237204249, 44237196981) | 4 m 57 s, 6 m 18 s | Everything. Tests took 3 m 06 s–3 m 31 s; the slower run also spent 65 s uploading the pnpm store. |
| This change, cold caches (44239478412) | 4 m 55 s | Everything: the change touches the workflow, a global dependency. 14 test and lint tasks, 20 typechecks, the e2e run. |
| This change again (44240106272) | 4 m 11 s | Everything again: the commit changed the workflow, so no Turbo cache entry matched. |
| Docs only (#9, 44240132884) | 52 s | No Turbo task, no browser: install and the repo-wide checks. |
| `packages/feeds` only (#10, 44240134887) | 4 m 27 s | feeds and what depends on it: cli, player, tools, api, and the CMS through the API (8 test and lint tasks, 19 typechecks, the e2e run). |
| Player only (#11, 44240138678) | 3 m 31 s | `player:test` (2 m 30 s) and the typechecks it depends on. |

Where the time goes now: setup and the repo-wide checks take about 50 s, then whichever affected test is slowest. That is the player's browser tests (2 m 30 s alone) or the API's workerd tests. Once `master` has run this workflow, a pull request starts from `master`'s Turbo cache, so the typechecks of packages it did not change replay instead of running.

## Required status check

`master` cannot require this check today. Branch protection and rulesets need GitHub Pro (or Team) for a private repository: the API answers 403, "Upgrade to GitHub Pro or make this repository public to enable this feature". On a plan that has them, require the `check` job. It runs on every pull request, even one that affects no package, so it never sits pending.
