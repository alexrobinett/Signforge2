# M3-10 CMS scaffold

Status: done (branch `t3/m3-10-cms-scaffold`)  ·  Size: M  ·  Depends on: M3-09

## Goal

Create `apps/cms`, a TanStack Start app on Workers that signs in and talks to the API.

## Read first

- docs/backend-plan.md#layout
- docs/architecture.md#platform

## Scope

- TanStack Start, React 19, Tailwind, shadcn. Same hostname as the API; API reached by service binding.
- Sign-in page, org switcher, an empty dashboard shell with navigation for Screens, Spots, Playlists, Schedule, Assets.
- WebMCP is not wired yet, but leave the tool registry (M3-12) as the only way pages change data.

## Out of scope

- Any feature page.

## Done when

- [x] Runs locally against the local API; signs in; switches org. `pnpm --filter @signforge/cms test:e2e` (Playwright) starts the API and the CMS, signs in with an email code read from the API's terminal output, creates two orgs, switches between them, survives a reload, visits every section, changes theme, signs out, and repeats the core flow at phone width. Screenshots from that run are in [M3-10/](M3-10/).
- [x] Lighthouse accessibility score of 95 or more on the shell: **100** on Overview, Screens, Assets and Sign-in, with mobile and desktop presets, in light and dark themes (Lighthouse 13.6.0, against `vite dev`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated (`apps/cms/README.md` is new).

## What was built

- **`apps/cms`**, the `signforge-cms` Worker: TanStack Start 1.169 with React 19, Tailwind 4 and shadcn/ui (new-york, `components.json` set up for the CLI), on Workers through `@cloudflare/vite-plugin`. `apps/cms/README.md` explains how to run it.
- **Hosting.** The `API` service binding goes to `signforge-api` (`-demo` and `-prod` per environment). Server code calls the API over the binding with the browser's cookies, and passes back any cookie the API sets (`src/server/api.server.ts`). The browser calls `/api/*` on its own origin. Deployed, the API Worker's route on the shared hostname takes those requests. Locally, `src/routes/api/$.ts` hands them over the binding unchanged, so dev uses the same single origin. No routes are configured yet because no hostnames exist (M3-24).
- **Sign-in page.** Email, then a 6-digit code, then back to the page that was asked for (`?redirect=`, which accepts only paths on this site). The GitHub button appears only when the API reports GitHub is configured. In dev, a notice says the code is printed in the API's terminal.
- **Org switcher.** Lists the user's orgs, switches with `organization/set-active`, and creates an org from a dialog. A user with no active org gets a page to pick one or create their first.
- **Dashboard shell.** A sidebar with the org switcher, navigation (Overview, Screens, Spots, Playlists, Schedule, Assets) and an account menu (theme: light, dark or system; sign out). At phone width the sidebar becomes a drawer. Each section is an empty placeholder. Signed-out visitors are redirected to sign-in.
- **Data changes.** Only Better Auth's endpoints: send code, sign in, sign out, create org, set active org. There are no other data routes. Reads are `/api/session`, `/api/auth/organization/list` and `/api/sign-in-options`.

## Notes

- **One API change: `GET /api/sign-in-options`.** It is public, returns `{ emailCode, github, codesInTerminal }`, and is tested in `apps/api/test/sign-in-options.test.ts`. The CMS cannot read the API's secrets, and Better Auth has no endpoint that lists configured providers.
- **Local dev uses the dev registry, not a port proxy.** The CMS's `API` binding finds the API's `wrangler dev` through Wrangler's local dev registry. Because the request keeps the CMS origin, Better Auth sees a same-origin request, as it will in production. A port proxy would have changed the origin and needed `CMS_ORIGIN` set in dev. Both processes must share a registry. Miniflare reads `CLOUDFLARE_DEV_REGISTRY_PATH`; the Vite plugin ignores Wrangler's older `WRANGLER_REGISTRY_PATH`. The e2e run sets its own registry and its own database, so a dev server already running is neither used nor disturbed.
- **The e2e run fits Better Auth's rate limits.** Locally every test comes from one address: Miniflare overwrites `cf-connecting-ip`, so a test cannot pose as another client. The limits are 3 codes a minute and 3 sign-in attempts per 10 seconds, and a rejected attempt keeps the window open. The run uses 2 codes and 3 attempts. The off-site redirect check is a unit test (`test/paths.test.ts`) rather than a third browser sign-in.
- **Runtime types.** `wrangler types --include-runtime=false`. The Workers runtime types clash with the DOM types the React code needs. The CMS declares the two pieces it uses (`Fetcher` and `cloudflare:workers`'s `env`) in `src/cloudflare.d.ts`.
- **Org slugs are not shown yet.** A slug is made from the name. If the slug is taken, a 4-character suffix is added and creation is retried once.
- **Not built:** the invitation link (`/accept-invitation/<id>`) that the API's invitation email points to, member management, and WebMCP. Each belongs to a later ticket.
- **Lighthouse method.** Lighthouse 13.6.0 ran with Playwright's Chromium headless shell, with `--extra-headers` carrying a signed-in session cookie, and `--force-dark-mode` for the dark runs. Every page scored 100, with no failing audits, scored or unscored, after the account and org buttons' accessible names were made to contain their visible text.
