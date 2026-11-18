# M3-37 Repo hygiene

Status: done (branch m3-37-repo-hygiene)  ·  Size: M  ·  Depends on: nothing

## Goal

What a reviewer sees first should look like product work (Fable). Pulled forward from M3-24.

## Read first

- docs/reviews/2026-11-17-full-review.md (A8, hygiene)
- apps/api/wrangler.jsonc

## Scope

- README: what it is, a screenshot, the architecture in a paragraph, how to run, the Pi numbers.
- CI on GitHub Actions: install, typecheck, lint, test (the browser tests from M3-26 included).
- A linter and formatter across the workspace, with the existing code passing.
- `dev` stops being the default deploy environment: a bare `wrangler deploy` fails or targets nothing; dev is an explicit opt-in.
- Remove the committed `.pyc` files and ignore `__pycache__`.
- The stress golden test says loudly when it skips for missing media.
- Docs brought current (A8): the bundle limit, how templates finish, where images are resized, `docs/architecture.md` through Milestone 3 so far.
- Note in `docs/backend-plan.md` what replaces the `/admin` tree and when.

## Done when

- [ ] CI is green on a pull request. Not ticked: the repo was not pushed during this work, so no pull request ran. The workflow (`.github/workflows/ci.yml`) was run step by step locally on macOS instead, all passing: `pnpm install --frozen-lockfile`, `playwright install chromium`, `pnpm typecheck --force` (20/20), `pnpm lint`, `pnpm format:check --since=m3-foundations` (the PR base here; 14 files, clean), `pnpm test --force` (21/21 tasks, including M3-26's 20 player browser tests and the CMS e2e run, 2 passed). Its first real run on Ubuntu is still to be seen.
- [x] A bare `wrangler deploy` in `apps/api` does not ship dev settings. Dev moved to `env.dev`; the top level has no entry point, name, vars or bindings. In `apps/api`, 2026-11-17:

  ```
  $ npx wrangler deploy --dry-run
  ▲ [WARNING] Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the deploy command.
  ✘ [ERROR] Missing entry-point to Worker script or to assets directory
  (exit 1)
  $ npx wrangler deploy --dry-run --env demo
  env.ENVIRONMENT ("demo")    Environment Variable
  --dry-run: exiting now.
  ```

  Moving only the vars was not enough: Wrangler 4.164 names a nameless Worker after the package, so a bare deploy would still have shipped an empty `signforge-api`.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass; docs touched by the change are updated. All three pass after merging `m3-foundations` (lint reports one warning, an unused type in `packages/tools/src/assets.ts` from M3-35; warnings do not fail). The stress golden passes with its media present and prints a SKIPPING line without it. Docs: `README.md` (new), `docs/architecture.md`, `docs/backend-plan.md`, `apps/cms/README.md`.

## Notes

- **The formatter checks changed files only.** `biome format` would rewrite about half the repo (175 of 345 files), which would collide with every ticket in flight, so `pnpm format:check` compares against a base branch (`master` by default; CI uses the PR's base). Run `pnpm format` before committing. When `m3-foundations` goes to `master` as one PR, every file M3 touched counts as changed: format them in their own commit then, or reformat the whole repo once in a quiet moment.
- **Lint rules that fight the house style are off** (non-null assertions, assignment in expressions, comma and `return void`, `forEach` one-liners, string concatenation); `any` is allowed in tests and in `packages/tools/src` (the registry's variance types). The rest of Biome's recommended set is on. Five reasoned `biome-ignore` comments cover the remaining intentional cases.
- **The CMS Worker still defaults to dev** (`apps/cms/wrangler.jsonc`). It holds no secrets (an `ENVIRONMENT` var and a service binding), so it was left; M3-24 should make it explicit the same way.
- **The README screenshot** is the Pi capture from `spike/pi-perf/results/shots/html.png` (gitignored there), saved as `docs/images/promo-on-pi.jpg`.
