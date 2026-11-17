# SignForge CMS

The web app people use to manage their screens: TanStack Start (React 19) with Tailwind and shadcn/ui, running as a Cloudflare Worker (`signforge-cms`). It holds no data of its own. Everything comes from the API Worker (`apps/api`).

## How it reaches the API

The CMS and the API are two Workers on one hostname, so the session cookie is same-origin (docs/backend-plan.md#layout).

- **The browser** calls `/api/...` on the page's own origin: Better Auth's client for sign-in and organizations. In a deployed environment, the API Worker's route takes `<host>/api/*` and the CMS takes the rest. If a request for `/api/*` reaches the CMS anyway, as it always does locally, `src/routes/api/$.ts` hands it to the API over the service binding unchanged.
- **Server code** (loaders, server functions) calls the API over the `API` service binding with the browser's cookies (`src/server/api.server.ts`). Any cookie the API sets on the way, such as Better Auth's refreshed cache cookie, is passed back to the browser.

The CMS changes data only through Better Auth's endpoints (sign-in, sign-out, create and switch organization). Every other change will go through the API's tool registry (M3-12); do not add data routes here.

## Run it locally

Two terminals, from the repo root:

```sh
# 1. The API, on http://localhost:8787. Sign-in codes are printed here.
pnpm --filter @signforge/api exec wrangler d1 migrations apply DB --local --env dev   # first time, and after new migrations
pnpm --filter @signforge/api dev

# 2. The CMS, on http://localhost:3000.
pnpm --filter @signforge/cms dev
```

Open http://localhost:3000, enter any email address, and read the 6-digit code in the API's terminal (`[email] to you@example.com: Your SignForge code: 123456`). The sign-in page says this in dev. GitHub sign-in appears only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set in `apps/api/.dev.vars`.

The CMS's `API` binding finds the API's `wrangler dev` through Wrangler's local dev registry, so either can start first. Both must use the same registry: if you set `CLOUDFLARE_DEV_REGISTRY_PATH` for one, set it for both. Nothing is proxied by port.

## Checks

| Command | What it runs |
| --- | --- |
| `pnpm --filter @signforge/cms typecheck` | `wrangler types`, then `tsc` |
| `pnpm --filter @signforge/cms test` | Unit tests (Vitest) |
| `pnpm --filter @signforge/cms test:e2e` | Playwright against a real local API and CMS: sign in with an email code, create two orgs, switch, navigate, sign out, and the phone-width drawer. It starts its own API (port 8797) and CMS (port 3997) with a fresh database and dev registry, so it does not touch servers you have running. Set `E2E_SCREENSHOTS=<dir>` to save screenshots. Root `pnpm test` runs it too (Turbo task `test:e2e`, never cached). Its ports are fixed, so two checkouts cannot run it at the same time. First run: `pnpm --filter @signforge/cms exec playwright install chromium`. |
| `pnpm --filter @signforge/cms build` | Production build into `dist/` |

## Layout

```
src/routes/__root.tsx     document, theme script, fonts
src/routes/sign-in.tsx    email code, and GitHub when the API offers it
src/routes/_app.tsx       signed-in layout: redirects signed-out visitors, picks or creates an org
src/routes/_app/*.tsx     Overview, Screens, Spots, Playlists, Schedule, Assets (placeholders)
src/routes/api/$.ts       `/api/*` handed to the API Worker
src/server/               server-only: the API binding, the shell's server functions
src/components/ui/        shadcn/ui components (components.json is set up for the shadcn CLI)
```

## Deploying

Nothing is deployed yet. Each environment (`--env demo`, `--env prod`) binds `API` to that environment's API Worker. Routes are added when hostnames exist (M3-24): the API Worker gets `<host>/api/*` (and `/v1/*`, `/health`), this Worker gets `<host>/*`.
