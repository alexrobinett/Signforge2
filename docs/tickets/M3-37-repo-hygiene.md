# M3-37 Repo hygiene

Status: open  ·  Size: M  ·  Depends on: nothing

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

- [ ] CI is green on a pull request.
- [ ] A bare `wrangler deploy` in `apps/api` does not ship dev settings (shown in the PR).
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass; docs touched by the change are updated.
