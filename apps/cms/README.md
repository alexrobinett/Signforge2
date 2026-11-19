# SignForge CMS

The web app people use to manage their screens: TanStack Start (React 19) with Tailwind and shadcn/ui, running as a Cloudflare Worker (`signforge-cms`). It holds no data of its own. Everything comes from the API Worker (`apps/api`).

## How it reaches the API

The CMS and the API are two Workers on one hostname, so the session cookie is same-origin (docs/backend-plan.md#layout).

- **The browser** calls `/api/...` on the page's own origin: Better Auth's client for sign-in and organizations. In a deployed environment, the API Worker's route takes `<host>/api/*` and the CMS takes the rest. If a request for `/api/*` reaches the CMS anyway, as it always does locally, `src/routes/api/$.ts` hands it to the API over the service binding unchanged. `/v1/device/*` is the same (`src/routes/v1/device/$.ts`), for the test screen.
- **The test screen** (M3-41) is the player build (`pnpm build:player`, in `dist/player`) at `/test-screen/`: `vite dev` serves it from there and `vite build` copies it into the site's assets (the `playerBuild` plugin in `vite.config.ts`, which serves the same build at `/player/` for the spot editor's stage). It talks to the device API on this origin, never with the session cookie (docs/architecture.md, "Browser test screen").
- **Server code** (loaders, server functions) calls the API over the `API` service binding with the browser's cookies (`src/server/api.server.ts`). Any cookie the API sets on the way, such as Better Auth's refreshed cache cookie, is passed back to the browser.

The CMS changes data only through Better Auth's endpoints (sign-in, sign-out, create and switch organization; members, invitations and the org's name; your name and sessions) and the API's tool registry: pages call `POST /api/tools/:name` from the browser (`src/lib/tools.ts`), and loaders read through the same tools as the member (`src/server/screens.functions.ts`). Do not add data routes here.

## Look

The tokens in `src/styles.css` follow `docs/proposals/cms-ui.md`: neutral white, Geist and Geist Mono, field edges at 3:1, and screen states that each have a colour, a word and a shape (online filled, updating an arc, asleep a half circle, offline hollow and grey, needs-you a triangle and the only red). `test/tokens.test.ts` checks every text pair at 4.5:1 and every edge, ring, status glyph and chart mark at 3:1, in both themes; change a colour and run it.

## Run it locally

Two terminals, from the repo root:

```sh
# 1. The API, on http://localhost:8787. Sign-in codes are printed here.
pnpm --filter @signforge/api exec wrangler d1 migrations apply DB --local --env dev   # first time, and after new migrations
pnpm --filter @signforge/api dev

# 2. The CMS, on http://localhost:3000.
pnpm --filter @signforge/cms dev
```

The spot editor's stage frames the player build at `/player/index.html?source=preview`, served as the test screen is (below): run `pnpm build:player` first. It is built with `CMS_ORIGIN` unset, so it takes drafts from the origin serving it: this one (docs/architecture.md, Content sources). The editor needs templates: with `ADMIN_TOKEN` set in `apps/api/.dev.vars`, `SF_ADMIN_TOKEN=<it> pnpm seed:templates --api http://localhost:8787` adds the base ones.

Open http://localhost:3000, enter any email address, and read the 6-digit code in the API's terminal (`[email] to you@example.com: Your SignForge code: 123456`). The sign-in page says this in dev. GitHub sign-in appears only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set in `apps/api/.dev.vars`.

The CMS's `API` binding finds the API's `wrangler dev` through Wrangler's local dev registry, so either can start first. Both must use the same registry: if you set `CLOUDFLARE_DEV_REGISTRY_PATH` for one, set it for both. Nothing is proxied by port.

## Checks

| Command | What it runs |
| --- | --- |
| `pnpm --filter @signforge/cms typecheck` | `wrangler types --env dev`, then `tsc` |
| `pnpm --filter @signforge/cms lint` | ESLint with the React rules below. Root `pnpm lint` runs Biome, then this through Turbo (task `lint`, cached) |
| `pnpm --filter @signforge/cms test` | Unit tests (Vitest). `test/registry/` checks the command menu against the tool registry, under its own tsconfig: the tools package needs Workers types, which the CMS's DOM types do not load |
| `pnpm --filter @signforge/cms test:e2e` | Playwright against a real local API and CMS: sign in with an email code, create two orgs, switch, navigate, sign out, and the phone-width drawer; and on Screens, pair a screen (a pairing started on the API as a player would), see it sync, sleep and wake it, identify it, set its display hours, the tile and table views at desktop and phone width, and revoke it; on an open Screens page, see a new publish and then a screen that stops syncing (its last sync moved back in the run's local D1) turn unreachable without a reload, and the poll failing from the first and after a good one (the page says its status is not current, holds it through each retry, and clears on the next good poll) and the session ending (to sign-in); a signed-out visit to any page, and a session that ends before a link is followed or on Spots and the spot editor, go to sign-in with the way back in a handful of requests; and on Assets, upload images (scaled in the browser, PUT to the API's local bucket, checked by the server), search them, see which a spot uses, and delete one no spot uses; and on Spots, make a spot from a template, see the real player redraw as you type (and hold its last frame while a field is invalid), save the draft, keep someone else's change, and configure and preview every base template; and on Playlists, make a playlist, add spots and see the real player play the loop (and say which spot it leaves out, and why), reorder by dragging and with the move buttons, remove a spot and put it back from the toast, choose a crossfade, keep someone else's change, and delete it; and the command menu by keyboard alone (open, filter, pair a screen from a tool's form, run a tool at once, a refusal, a field it cannot read taking focus, go to a page, close); and Settings: an owner saves the org's name, time zone, locale, hours, alert wait and alert rules, invites an editor who follows the email's link and joins, sees the settings read-only, loses the command menu's publish tool while the owner turns off Who publishes (and gets it back when it is on again), is made a viewer and removed; then the account page's name and theme. At each page it screenshots, axe (`@axe-core/playwright`, WCAG 2.1 A and AA) checks the light and the dark theme and fails on any violation (`axe` in `e2e/helpers.ts`; the spot editor's preview, the real player showing each base template, included). The screens, assets, command-menu and settings specs sign in straight against the API, each under its own `cf-connecting-ip` (`signInAs` in `e2e/helpers.ts`), so each sign-in has its own rate limit (through the dev CMS every request has one address, and the other specs use that budget). It builds the player, starts its own API (port 8797) and CMS (port 3997) with a fresh database and dev registry, seeds the base templates through `/admin` with the run's token (`e2e/servers.ts`), so it does not touch servers you have running. Set `E2E_SCREENSHOTS=<dir>` to save screenshots. Root `pnpm test` runs it too (Turbo task `test:e2e`, never cached). Its ports are fixed, so two checkouts cannot run it at the same time. First run: `pnpm --filter @signforge/cms exec playwright install chromium`. |
| `CLOUDFLARE_ENV=demo pnpm --filter @signforge/cms build` | Production build into `dist/` for that environment. Without `CLOUDFLARE_ENV` it fails: there is no default environment |

## Layout

```
src/routes/__root.tsx     document, theme script, fonts
src/routes/sign-in.tsx    email code, and GitHub when the API offers it
src/routes/_app.tsx       signed-in layout: redirects signed-out visitors, picks or creates an org
src/routes/_app/*.tsx     Overview, Schedule (placeholders); Assets, the image library
src/routes/_app/spots/    Spots: the list, and one spot's editor (the form beside the live stage)
src/routes/_app/playlists/ Playlists: the list, and one playlist's editor (its spots in order and its transition beside the stage, which plays the loop)
src/routes/_app/screens/  Screens: tile wall or table (?view=table), and one screen's page
src/routes/_app/settings/ Settings: General, Members & roles, Screens & groups, Notifications (owners change them; others read)
src/routes/_app/account.tsx  Your account: name, sign-in methods, sessions, theme
src/routes/accept-invitation.$invitationId.tsx  where an invitation email's link lands; outside the org gate
src/components/screens/   status shapes and pills, thumbnails, pairing, display hours
src/components/assets/    asset tiles, search, uploading images, and AssetPicker (the library in a dialog)
src/components/spots/     FieldForm (a template's fields as a form), PlayerStage (the real player in an iframe, for a spot or a playlist), the new-spot dialog
src/components/playlists/ the new-playlist dialog, and SpotPicker (the org's spots in a dialog, to add to a playlist)
src/queries/              server data as TanStack Query options: keys and the tool reads behind them
src/lib/spots.ts          the spot tools' outputs, and a draft (a spot's, or a playlist's) compiled in the browser for the stage
src/lib/playlists.ts      the playlist tools' outputs, a loop's length, a transition in words
src/components/command-menu.tsx  ⌘K: go to a section, or run a tool (entries from src/lib/command-menu.ts)
src/lib/screen-status.ts  a screen's state in words (the state itself comes from the screen tools)
src/lib/fleet-status.ts   how the Screens page's poll joins the list it loaded, and when the list is out of date
src/server/screens.functions.ts  the Screens loaders: tools called as the member, through one helper
public/sign-in/           spots the player rendered (scripts/spot-shots.ts), for the sign-in wall
src/routes/api/$.ts       `/api/*` handed to the API Worker
src/routes/v1/device/$.ts `/v1/device/*` handed to the API Worker, for the test screen
src/server/               server-only: the API binding, the shell's server functions
src/state/                the app store: one slice per area (see State below)
src/components/ui/        shadcn/ui components (components.json is set up for the shadcn CLI)
```

## Command menu

⌘K or Ctrl+K on any signed-in page, or "Search and actions" in the sidebar, opens it. It lists:

- **Every section of the sidebar** (`SECTIONS` in `src/lib/sections.ts`). A new page gets its "Go to" entry by being added there, with nothing to change in the menu.
- **Every tool the member's role allows**, read with the shell from `GET /api/tools` (the registry's `describeTools`, the list an agent gets), named from the first sentence of the tool's description. A tool with a required input opens a form built from its input's JSON Schema (text, number, choice, checkbox, or JSON for lists and objects; an idempotency key is filled in); one without runs at once. A field named like a route param (`screenId` on a screen's page) starts with the page's value. Results and refusals are toasts (`sonner`); a refusal keeps the form open.

It opens with no motion (docs/research/cms-ux.md). State is the `commandMenu` slice (`src/state/command-menu.ts`).

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
- **Errors keep their cause.** A new error thrown inside a `catch` passes the caught one as `{ cause }` (`preserve-caught-error`; Biome's `useErrorCause` does the same for the rest of the repo).

If a rule must be broken, use `// eslint-disable-next-line <rule> -- <why>`: a disable without a reason, or one that no longer silences anything, is an error. There are none today.

typescript-eslint, which parses TypeScript for ESLint, cannot load TypeScript 7. So this package's `typescript` devDependency is an alias for `@typescript/typescript6`, the TypeScript 6 API, as the TypeScript 7 release notes recommend. `tsc` still runs TypeScript 7, from the repo root.

## State

Where each kind of state lives:

- **Server data** comes from the API through the tools. The shell, screen detail and assets pages read it in route loaders. The Screens list and the spot and playlist pages read it through TanStack Query (docs/research/cms-data-layer.md, Decision): `src/queries/` holds each read as `queryOptions`, keyed `['org', orgId, ...]` so another org's rows never show after a switch, with a server function behind each fetch. A loader fills the cache (`queryClient.query(...)`), the component reads it with `useSuspenseQuery`, and the cache is made per request and streamed to the browser (`setupRouterSsrQueryIntegration` in `src/router.tsx`). Server data is never copied into the store; a store action that changes it writes the tool's answer into the cache (`setQueryData`) or invalidates the keys it touched. The Screens list polls `list_screen_status` every 15 seconds while the tab is visible and lays what each screen is doing over the list it loaded (`src/queries/screens.ts`), so a screen that stops syncing turns unreachable on an open page; it reads the full list again (settings, what each should be showing) only when the poll sees a screen, a publish or a change of state (a screen waking, say) that the list does not have, and on every load (`src/lib/fleet-status.ts`). A poll fails when two tries in a row do; while it fails, the page says its status is not current and when SignForge last answered, until the next good poll (Query's `errorUpdatedAt` later than its `dataUpdatedAt`; `isError` goes back to pending on each retry of a poll that has never succeeded). A read whose session has ended throws a redirect to sign-in that carries the page to come back to (`tool` in `src/server/tools.server.ts`: the page load's own URL, or a server function call's `Referer`), so it keeps the way back whether it or the shell's redirect wins. A loader follows it as any redirect; a query that gets it (the poll, or a refetch when the tab is shown again) is followed once by the router's Query integration (`setupRouterSsrQueryIntegration`, which handles redirects by default). The server functions over tool outputs set `strict: { output: false }`: tool outputs are JSON, but template data is typed `unknown`, which Start's serialization check cannot prove.
- **Anything a link should carry** (list view, filters, search, selected tab) lives in the route's typed search params (`validateSearch`). The URL is state too.
- **UI and in-progress state** (the drawer, the theme, the sign-in steps, form drafts, later the spot editor's draft) lives in the app store, `src/state/`.

The store is Zustand, built with `createStore` from `zustand/vanilla`. `getRouter()` in `src/router.tsx` makes one store per router, which is one per request on the server and one per page in the browser, and its `Wrap` provides it. Components read it with `useAppStore(selector)`, select one value or action at a time (a selector that builds a new object re-renders forever), and call actions. They hold no state of their own.

Keeping it in one place means every change to the UI's state is in `src/state/`, as named actions, where a person or an agent can read them all.

To add a slice:

1. Make `src/state/<area>.ts` with its state under one key (`ui`, `signIn`, `orgs`, `screens`) and its actions, typed as `SliceCreator<YourSlice>`.
2. Name actions as verbs on the domain (`openDrawer`, `startSignIn`, `createOrg`) and write each transition inside them with `set((s) => ...)`. Do not add a generic `patch` or `setField` action: that is `useState` under another name.
3. Actions that call the API use the helpers in `src/lib/`, and the router and Query client from the store's deps (`router.invalidate()` after a change to loader data; `queryClient.setQueryData` or `invalidateQueries` after a change to Query data). An edit of a row sends the version it opened with as `ifVersion` (`packages/tools` README, Conditional updates); when `isStale(err)`, the action says "This changed since you opened it" and offers a reload (`saveScreenSettings` in `state/screens.ts`). A change to a list uses the tool's add and remove forms, never a replace built from what the page loaded; an ordered list a tool takes whole, a playlist's spots, is sent with the `ifVersion` it was read at, so a replace from an old read is refused.
4. Add the slice to `AppState` and `createAppStore` in `src/state/store.ts`. If it must start from browser state, set that in a browser-only hook like `connectUi`, which changes the current state but not the initial one, so hydration still matches the server.

## Deploying

Nothing is deployed yet. `wrangler.jsonc` has no default environment, as apps/api has none: `dev` is local only, and `demo` and `prod` each bind `API` to that environment's API Worker. Build with `CLOUDFLARE_ENV=<env>`; the build writes the deployable config for that environment. Routes are added when hostnames exist (M3-24): the API Worker gets `<host>/api/*` (and `/v1/*`, `/health`), this Worker gets `<host>/*`.
