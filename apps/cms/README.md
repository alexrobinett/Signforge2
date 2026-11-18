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
| `pnpm --filter @signforge/cms typecheck` | `wrangler types --env dev`, then `tsc` |
| `pnpm --filter @signforge/cms lint` | ESLint with the React rules below. Root `pnpm lint` runs Biome, then this |
| `pnpm --filter @signforge/cms test` | Unit tests (Vitest) |
| `pnpm --filter @signforge/cms test:e2e` | Playwright against a real local API and CMS: sign in with an email code, create two orgs, switch, navigate, sign out, and the phone-width drawer. It starts its own API (port 8797) and CMS (port 3997) with a fresh database and dev registry, so it does not touch servers you have running. Set `E2E_SCREENSHOTS=<dir>` to save screenshots. Root `pnpm test` runs it too (Turbo task `test:e2e`, never cached). Its ports are fixed, so two checkouts cannot run it at the same time. First run: `pnpm --filter @signforge/cms exec playwright install chromium`. |
| `CLOUDFLARE_ENV=demo pnpm --filter @signforge/cms build` | Production build into `dist/` for that environment. Without `CLOUDFLARE_ENV` it fails: there is no default environment |

## Layout

```
src/routes/__root.tsx     document, theme script, fonts
src/routes/sign-in.tsx    email code, and GitHub when the API offers it
src/routes/_app.tsx       signed-in layout: redirects signed-out visitors, picks or creates an org
src/routes/_app/*.tsx     Overview, Screens, Spots, Playlists, Schedule, Assets (placeholders)
src/routes/api/$.ts       `/api/*` handed to the API Worker
src/server/               server-only: the API binding, the shell's server functions
src/state/                the app store: one slice per area (see State below)
src/components/ui/        shadcn/ui components (components.json is set up for the shadcn CLI)
```

## React rules

`eslint.config.js` adds what Biome cannot check. Biome still formats and lints the whole repo.

- **No `useState`, and no `useEffect`, `useLayoutEffect` or `useInsertionEffect`.** Effects and state scattered across components are where UI bugs hide: a value copied into state goes stale, and an effect that syncs it runs at the wrong time or not at all. Instead:
  - App and flow state goes in the app store (next section). `useReducer` is allowed only for state that belongs to one component and never leaves it, as a small typed reducer.
  - Work caused by an event goes in the event handler or a store action.
  - DOM work such as focus goes in a ref callback. Make it a stable function (see `focusOnMount` in `routes/sign-in.tsx`): an inline one runs on every render.
  - A value that follows from props, loader data or the store is derived during render, not kept in sync.
  - Outside state, such as storage or a media query, is read with `useSyncExternalStore` or kept in the store, which subscribes once (see `connectUi` in `state/ui.ts`).
  - The ban needs named imports (`import { useId } from 'react'`); a namespace import of React is reported too.
- **No `create` from `zustand`.** It makes one store for the whole server, shared between requests. Use `useAppStore`.
- **React hooks rules** (`eslint-plugin-react-hooks`, recommended).
- **Slop rules** (`eslint-plugin-slop`, every rule, whole files): no em dashes, no inflated words, non-JSDoc comments of 50 words at most, `/** */` on exported things, no trivial wrappers or type aliases.
- **Typed rules** (typescript-eslint, with type information): no floating or misused promises, no condition the types say is always true or false (a fallback for a field that is required), no assertion that changes nothing, every case of a union switch and no needless `default`, only `Error`s thrown (TanStack's `redirect()` and `notFound()` excepted), and no deprecated APIs (React's `FormEvent`: use `SubmitEvent`). They add about 2 s to the lint.

If a rule must be broken, use `// eslint-disable-next-line <rule> -- <why>`: a disable without a reason, or one that no longer silences anything, is an error. There are none today.

typescript-eslint, which parses TypeScript for ESLint, cannot load TypeScript 7. So this package's `typescript` devDependency is an alias for `@typescript/typescript6`, the TypeScript 6 API, as the TypeScript 7 release notes recommend. `tsc` still runs TypeScript 7, from the repo root.

## State

Where each kind of state lives:

- **Server data** (the shell, orgs, later screens and spots) comes from route loaders and the API. It is never copied into the store.
- **Anything a link should carry** (list view, filters, search, selected tab) lives in the route's typed search params (`validateSearch`). The URL is state too.
- **UI and in-progress state** (the drawer, the theme, the sign-in steps, form drafts, later the spot editor's draft) lives in the app store, `src/state/`.

The store is Zustand, built with `createStore` from `zustand/vanilla`. `getRouter()` in `src/router.tsx` makes one store per router, which is one per request on the server and one per page in the browser, and its `Wrap` provides it. Components read it with `useAppStore(selector)`, select one value or action at a time (a selector that builds a new object re-renders forever), and call actions. They hold no state of their own.

Keeping it in one place means every change to the UI's state is in `src/state/`, as named actions, where a person or an agent can read them all.

To add a slice:

1. Make `src/state/<area>.ts` with its state under one key (`ui`, `signIn`, `orgs`) and its actions, typed as `SliceCreator<YourSlice>`.
2. Name actions as verbs on the domain (`openDrawer`, `startSignIn`, `createOrg`) and write each transition inside them with `set((s) => ...)`. Do not add a generic `patch` or `setField` action: that is `useState` under another name.
3. Actions that call the API use the helpers in `src/lib/` and the router from the store's deps (`router.invalidate()` after a change).
4. Add the slice to `AppState` and `createAppStore` in `src/state/store.ts`. If it must start from browser state, set that in a browser-only hook like `connectUi`, which changes the current state but not the initial one, so hydration still matches the server.

## Deploying

Nothing is deployed yet. `wrangler.jsonc` has no default environment, as apps/api has none: `dev` is local only, and `demo` and `prod` each bind `API` to that environment's API Worker. Build with `CLOUDFLARE_ENV=<env>`; the build writes the deployable config for that environment. Routes are added when hostnames exist (M3-24): the API Worker gets `<host>/api/*` (and `/v1/*`, `/health`), this Worker gets `<host>/*`.
