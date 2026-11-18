# CMS data layer: where server data lives in the CMS, and how it stays live

Researched 2026-11-17. Status: research, not a decision. It feeds the screens that come after M3-11: the spot editor (M3-16), playlists (M3-17), publish and rollout (M3-18), and the agent drafts of Milestone 4.

Claims are tagged **[verified]** (checked this session against the primary source linked beside the claim), **[measured]** (measured this session; the method is given), **[unverified]** (could not be confirmed against a primary source this session), or **[judgement]** (my own reading, with no source behind it). Every link is listed again at the end. No benchmark here comes from anywhere but the source cited or my own measurement.

## Recommendation

**Use TanStack Query for server data, Zustand for UI and flow state, and the URL for anything a link carries. Write every read as a tool call wrapped in `queryOptions`, so TanStack DB's Query collection can take over the editors later without new fetch code. Keep fleet status on polling for now; when a push channel is needed, add one per-org Durable Object with hibernating WebSockets that sends "this changed" hints, never data.**

1. **TanStack Query now.** It is the only option that covers SSR, optimistic edits with rollback, invalidation, pagination over cursors and polling, and is stable (5.108.0, released today) and small (11.6 kB gzip, measured). Router and Start have a first-party integration that creates the client per request and dehydrates it into the stream. Its query keys and functions are exactly what TanStack DB's Query collection takes, so moving to DB later reuses them.
2. **Zustand keeps what it is good at.** It holds the per-request store the owner already chose: editing buffers, pending flags, toasts with Undo, the publish flow, the preview channel. Its actions are the domain verbs. The actions that change data call the tool and update the Query cache, so every transition still lives in one place.
3. **TanStack DB later, for the editors.** Its model fits our needs best: imperative transactions outside React, optimistic state layered per row, debounced ("paced") mutations, live queries across collections. But it went 1.0 RC on 2026-10-29, has shipped six RC builds in two weeks, and costs about 83 kB gzip before any adapter (measured). Look at it again when 1.0 is stable and the playlist editor needs joins across spots, playlists and assets.
4. **No local-first sync engine.** Zero and Electric need Postgres with logical replication; we are on D1. LiveStore makes events the source of truth, and says it does not fit an app with an existing database as the source of truth. Any of the three would add a second write path beside the tool registry, which the backend plan forbids.
5. **Live fleet status by polling at first.** A screen reports over HTTP every 5 minutes, so "online" and "unreachable" can change no faster than that. A 15-second Query `refetchInterval`, paused while the tab is hidden, matches what M3-11 already does through `router.invalidate()`, and calls fewer endpoints. Add the org change channel when rollout progress (M3-18's "applied within 10 seconds") or agents editing next to people need it.

The rest of this note covers each option, how it handles our cases, a ranked list, and a sketch of the recommended layer.

## What we have today

- **`main` (M3-10).** Route loaders call server functions (`src/server/shell.functions.ts`), which call the API Worker over the `API` service binding with the browser's cookies (`src/server/api.server.ts`). The `_app` loader has `staleTime: 30_000`. Writes go through Better Auth's client, then `router.invalidate()` (`src/lib/orgs.ts`).
- **`m3-11-cms-screens` (not merged).**
  - `src/server/screens.functions.ts` reads `list_screens` and `list_groups` through the tool route, following `next` until it is null, and returns everything with `at: Date.now()`.
  - `src/lib/tools.ts` is the browser's `callTool(name, input)`: `POST /api/tools/:name`, throwing `ToolCallError(code, message, details)` on a refusal.
  - `src/lib/live.ts` re-reads the page every 15 s while the tab is visible, by calling `router.invalidate()` from a `useSyncExternalStore` subscription (no effect). A 10-second clock store lets "Unreachable 2 h" age without a refetch.
  - Mutations are `useReducer` for pending and error, then `callTool`, then `router.invalidate()`. Nothing is optimistic.
- **`t3/cms-react-lint` (in progress).** It adds `zustand@^5.1.0`, ESLint with `eslint-plugin-slop` and `react-hooks`, and bans `useState`, `useEffect`, `useLayoutEffect` and `useInsertionEffect`. The org actions become plain functions taking the router (`switchOrganization(router, id)`). `src/state/` exists but is empty, so the store's shape here is taken from the owner's rules, not from code: a vanilla `createStore` per request behind a context, `useAppStore(selector)`, one slice per area, actions named as domain verbs.

Two facts from this code matter for the choice:

- **`router.invalidate()` reloads everything.** Without a filter it reruns `beforeLoad` and every loader "regardless of freshness" [verified] ([Router API, RouterType](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterType)). So the 15-second poll on Screens also reruns the `_app` loader's `getShell` (session plus organization list) each time, not only the screens. [judgement, from reading the code]
- **Every read is a tool, and the tools page.** Each `list_*` tool takes `limit` (default 50, at most 200) and an opaque `cursor`, and returns `next`; the repositories still read the whole list and the tool cuts the page (`packages/tools/README.md`). Refusals are `{ error, message, details? }` with fixed codes, including `409 conflict`.

## The cases every option is judged on

| Case | What it needs from the data layer |
| --- | --- |
| **SSR** | The first paint on a Worker has the data. Nothing leaks between requests: state is per request. |
| **Optimistic edit and rollback** | Rename, reorder or retime shows at once (under 0.1 s, `cms-ux.md` §1.1), and reverts with the tool's message on a refusal. |
| **Undo publish** | A server operation (M3-18: point each screen back at the previous manifest). The client needs the toast's window, the call, and fresh rollout data afterwards. It should not be optimistic: the server says what was held. |
| **Live fleet status** | Online, updating, asleep, unreachable and rollout progress, current to within seconds to minutes, cheaply (`backend-plan.md`: the CMS reads rollout from D1 and never calls 1,000 Durable Objects). |
| **100 ms preview** | A keystroke reaches the stage within 100 ms (M3-16) through debounced `draft` messages to the player iframe (M3-36). The preview must never wait on the network. |
| **Agent editing at the same time** | A draft an agent changes shows up in the person's view, without overwriting what the person is typing, and the person's save does not silently undo the agent's. |
| **Pagination** | `{ items, next }` with opaque cursors, for assets, templates, the audit log. Screens and groups are small per org (about 10 screens per org at 1,000 screens over 100 orgs) and the fleet roll-ups need all of them. |

And two rules: **state central for agents** (every transition readable in one place) and **no effects, no `useState`**.

## Options

### 1. Router and Start loaders alone (today)

**How it works.** Each route's loader fetches through a server function; the router's own stale-while-revalidate cache holds the result per match; writes call the tool and then `router.invalidate()`.

**What the router says about its own cache.** It is fine for "most smaller to medium applications", and lists what it lacks: "No persistence adapters/model", "No shared caching/deduping between routes", "No built-in mutation APIs", "No built-in cache-level optimistic update APIs" [verified] ([Router, Data Loading](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading)). It calls the router "a perfect coordinator for external data fetching and caching libraries" [verified] ([External Data Loading](https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading)).

| Case | Fit |
| --- | --- |
| SSR | Good. It works today. |
| Optimistic edit | None in the cache. It would need a Zustand overlay of pending edits merged over loader data on every screen that shows the row. |
| Undo publish | Works: call, then `invalidate`. |
| Live fleet | Polling by `invalidate()`, which reloads every active match (above). A filter narrows it, but then each page has to name its matches. |
| 100 ms preview | Independent of this choice (see the editor note below). |
| Agent concurrency | Only at the next reload. Data shared by two routes (a screen in the list and in its detail) is fetched and cached twice. |
| Pagination | By hand, in the loader or in a store. |

- **Central state and no effects.** Data sits in the router, flow state in Zustand. Fine, but every optimistic edit becomes a hand-written overlay.
- **Maturity and size.** No new code: already shipped.
- **Workers.** Works today.
- **Migration.** None.
- **Verdict.** Right for M3-10 and M3-11. It stops scaling at the first screen with optimistic edits (M3-17's reorder and retime with an Undo toast), and its polling reloads more than the page needs.

### 2. TanStack Query, with the Router and Start integration

**How it works.**

- **One `QueryClient` per request.** `@tanstack/react-router-ssr-query`'s `setupRouterSsrQueryIntegration({ router, queryClient })` dehydrates the server's cache and hydrates it in the browser, streams queries that resolve during the render, turns a `redirect()` thrown by a query or mutation into a navigation, and wraps the app in `QueryClientProvider`. The docs say: "Ensure a fresh `QueryClient` is created per request in SSR environments", and show it made in `getRouter()` and passed through router `context` [verified] ([Router, TanStack Query integration](https://tanstack.com/router/latest/docs/integrations/query)).
- **Loaders seed the cache.** A loader calls `context.queryClient.query({ ...options, staleTime: 'static' })`; the component reads with `useSuspenseQuery`. `ensureQueryData`, `fetchQuery` and `prefetchQuery` are now deprecated in favour of `queryClient.query` [verified] ([QueryClient reference](https://tanstack.com/query/latest/docs/reference/QueryClient)). Older tutorials that use `ensureQueryData` still work, but should not be copied.
- **Optimistic updates, two ways.** "Via the UI": render the mutation's `variables` while it is pending, with no cache change, best when the change shows in one place. "Via the cache": `cancelQueries`, snapshot with `getQueryData`, `setQueryData`, roll back in `onError`, `invalidateQueries` in `onSettled`, best when "several parts of the screen need the update" [verified] ([Optimistic Updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)).
- **Mutations.** Not retried by default. Mutations with the same `scope.id` run one after another; offline mutations resume in order [verified] ([Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations)). A scope per screen keeps a rename and a settings change from racing.
- **Polling.** `refetchInterval` refetches on a timer, and does not run in a background tab unless `refetchIntervalInBackground` is set [verified] ([useQuery reference](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)).
- **Pagination.** `useInfiniteQuery` with `initialPageParam` and `getNextPageParam`; returning `null` or `undefined` ends it. A refetch fetches the pages "sequentially, starting from the first one", which suits opaque cursors that hold the last sort key [verified] ([Infinite Queries](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries)).
- **Streams.** `experimental_streamedQuery` turns an `AsyncIterable` into a query [verified] ([streamedQuery](https://tanstack.com/query/latest/docs/reference/streamedQuery)). It is marked experimental by its name, so do not build on it yet.

| Case | Fit |
| --- | --- |
| SSR | Good. First-party integration with streaming. |
| Optimistic edit | Good: the cache pattern, with rollback. |
| Undo publish | Good: a call, then invalidate the publish, rollout and screens queries. |
| Live fleet | Good: `refetchInterval` per query, paused in background tabs. Push hints map to `invalidateQueries` on a key prefix. |
| 100 ms preview | Independent of this choice. |
| Agent concurrency | Next refetch, window focus, or a push hint. Shared data is one cache entry, so the list and the detail agree. |
| Pagination | Good: infinite queries for long lists; "every page" in the query function for screens and groups. |

- **Central state and no effects.** Query is a second central store, beside Zustand, and that should be said plainly: server data is in the `QueryClient`, everything else is in the app store. Both are created together per request and both are reachable from the router context. `useQuery` subscribes through React's external-store mechanism, not an effect, so it does not break the lint rule [judgement]. To keep "every transition in one place", the store's actions own the mutations (sketch below) instead of `useMutation` calls spread over components. `useMutation` remains available for one-off forms.
- **Maturity.** v5 is stable; 5.108.0 was published on 2026-11-17 [verified] ([npm](https://www.npmjs.com/package/@tanstack/react-query)). `@tanstack/react-router-ssr-query` is 1.167.3 and needs `@tanstack/react-router >= 1.170.33`; the CMS has `^1.170.46` [verified] (npm registry metadata).
- **Size.** `@tanstack/react-query` with the exports we would use is 39.4 kB minified, 11.6 kB gzip. The SSR integration adds 1.9 kB gzip [measured].
- **Workers.** `@tanstack/query-core` has no dependencies [verified] (its `package.json`). The per-request client is the one rule that matters on a Worker, since one isolate serves many requests.
- **Migration.** Small. Add the package and the integration in `src/router.tsx`; turn `getShell`, `getScreens` and `getScreen` into `queryOptions`; replace `useLiveData` with `refetchInterval`; replace `router.invalidate()` after a tool call with `invalidateQueries` on the keys it touched. The server functions stay as they are.
- **Verdict. Recommended.**

### 3. TanStack DB

**What it is.** "The reactive client store for your API". Typed collections are filled from a source; live queries over them update incrementally (differential dataflow, through `d2ts`), with joins; mutations are optimistic and roll back if their handler throws [verified] ([DB overview](https://tanstack.com/db/latest/docs/overview)). The overview cites about 0.7 ms to update one row in a sorted 100,000-row collection on an M1 Pro. That is the project's own number and was not checked here [unverified].

**Sources (collection types).**

- **Query collection.** Fetched through TanStack Query: `queryKey`, `queryFn`, `queryClient`, `getKey`. The `queryFn` result is the collection's whole state: "Items present in the collection but not in the query result will be deleted", and an empty array deletes everything. The `{ refetch: false }` return value is gone: handlers now await `collection.utils.refetch()` or direct writes, or their optimistic change reverts when the transaction settles. Direct writes (`writeInsert`, `writeUpdate`, `writeUpsert`, `writeDelete`, `writeBatch`) apply pushes "from WebSockets or server-sent events" straight to the synced rows. For robust real time, the docs recommend "a collection backed by a sync engine that owns snapshot and change-stream ordering". Paged endpoints use `syncMode: 'on-demand'`, which passes the query's predicates to the `queryFn`, and `createCursorPager` for opaque cursors [verified] ([Query collection](https://tanstack.com/db/latest/docs/collections/query-collection)).
- **Sync engines.** Electric (Postgres), PowerSync, RxDB and TrailBase. **Local:** IndexedDB, LocalStorage and LocalOnly. **Custom:** your own, through the `Collection` interface [verified] ([DB overview](https://tanstack.com/db/latest/docs/overview)).

**Mutations.**

- **Transactions.** They go `pending`, `persisting`, `completed` or `failed`. "TanStack DB does not automatically retry failed mutations" [verified] ([DB mutations](https://tanstack.com/db/latest/docs/guides/mutations)).
- **Layering.** Optimistic state is layered per row: "The latest contributing whole-row snapshot supplies the visible row; fields are not independently merged" [verified] (same page).
- **Kinds.** `createOptimisticAction` (`onMutate` plus `mutationFn`) for a server call with its own logic, such as a tool; `createTransaction({ autoCommit: false })` to group changes and commit or roll back once; `usePacedMutations` / `createPacedMutations` with `debounceStrategy`, where "Multiple rapid changes merge into a single transaction" [verified] (same page). The paced kind is the spot editor's save, as the library would write it.

**SSR.** The 1.0 RC adds a `DbClient` per request, collection descriptors (`collectionOptions(id, factory)`), `dehydrate` and `hydrate`, `preloadLiveQuery`, and `@tanstack/react-router-with-db`, whose `routerWithDbClient(router, dbClient)` streams live queries found by Suspense during a TanStack Start render [verified] ([DB SSR guide, in the repo](https://github.com/TanStack/db/blob/main/docs/guides/ssr.md)). `@tanstack/react-router-with-db` is 1.0.0-rc.1, published 2026-10-29 [verified] (npm).

**Maturity.**

- **The core is a release candidate.** `@tanstack/db` and `@tanstack/react-db` went from 0.x to `1.0.0-rc.1` on 2026-10-29, with RC builds up to `1.0.0-rc.1.5` (2026-11-11). npm's `latest` tag points at that RC [verified] (npm registry metadata).
- **Two adapters are already 1.x.** The RC migration guide says `@tanstack/query-db-collection` and `@tanstack/offline-transactions` "were both accidentally released as 1.0 before the RC" (query collection 1.5.2 needs `@tanstack/db@^1.0.0-rc.0`) [verified] ([migration guide](https://github.com/TanStack/db/blob/main/docs/guides/migrate-to-1-0-rc.md)).
- **No stable date.** No date for 1.0 stable was found [unverified].
- **The RC still breaks things.** It removed `$synced` and the dependency-array form of `useLiveQuery` [verified] (migration guide, SSR guide).

| Case | Fit |
| --- | --- |
| SSR | Supported in the RC, through `DbClient` and the Router adapter. Newest part, least proven. |
| Optimistic edit | Best of the options: built in, with rollback, multi-collection transactions and per-row layering. |
| Undo publish | A `createOptimisticAction` with no optimistic part, or a plain call and `refetch`. No better than Query. |
| Live fleet | Polling through the Query collection, or `writeBatch` from a socket. Each refetch replaces the collection, so the screens collection must always be fetched whole. |
| 100 ms preview | Independent of this choice. A paced mutation fits the save behind it well. |
| Agent concurrency | Good: synced rows change underneath while the person's pending transaction stays on top until it settles. |
| Pagination | `on-demand` mode plus `createCursorPager`: more machinery than an infinite query, and the result must be complete for each requested window. |

- **Central state and no effects.** Close to the owner's model: collections and transactions are plain objects, mutations are called outside React, and live queries read like a store selector. It is still a second store beside Zustand.
- **Size.** `@tanstack/react-db` with `createCollection`, `useLiveQuery`, `createOptimisticAction`, `eq` and `localOnlyCollectionOptions` is 277 kB minified, **82.8 kB gzip**. With the Query collection and query-core it is 347 kB minified, 104.6 kB gzip. The Electric adapter alone is another 35.6 kB gzip [measured]. That is roughly seven times Query.
- **Workers.** No Node APIs in its dependencies (`@tanstack/db-ivm`, `@tanstack/pacer-lite`, `@standard-schema/spec`) [verified] (`package.json`). Running it on Workers with Start's SSR was not tried [unverified].
- **Migration.** From Query it is incremental: a Query collection takes the same `queryKey`, `queryFn` and `QueryClient`. From today's code it is larger: descriptors, a `DbClient` per request, and mutations rewritten as collection handlers.
- **Verdict.** The best model for the editors, but too new for the base layer. Revisit when 1.0 is stable, starting with the spot and playlist editors, where cross-collection live queries and paced, layered mutations pay for the bundle.

### 4. Zustand alone for server data

**How it works.** Loaders or actions fetch tools and put the results in store slices; actions do optimistic updates by hand.

**Why it is usually discouraged.** TanStack Query's maintainers put it this way: Redux, MobX and Zustand "can be used to store asynchronous data, albeit inefficiently" compared with a server-state library, and once server state moves out, the client state left over "is usually very tiny", except in apps such as a visual designer [verified] ([Does TanStack Query replace client state?](https://tanstack.com/query/latest/docs/framework/react/guides/does-this-replace-client-state)). Everything a server-state library does would have to be written again: deduplicating identical requests, staleness, garbage collection, retries, refetch on focus, cancelling a fetch that a newer one superseded, polling paused in background tabs, and SSR dehydration [judgement]. Zustand's own SSR guide asks for a store per request, created with `createStore` and shared through context, since "the store should not be shared across requests" [verified] ([Zustand, Next.js guide](https://zustand.docs.pmnd.rs/learn/guides/nextjs)). Our store already does that, so SSR is the one part that comes cheap: seed the store from loader data.

| Case | Fit |
| --- | --- |
| SSR | Possible: seed the per-request store from loader data. |
| Optimistic edit | By hand, per action. |
| Live fleet | By hand: a timer subscription, visibility, stale responses. |
| Agent concurrency | By hand. |
| Pagination | By hand. |

- **Central state and no effects.** The most central: one store holds everything.
- **Maturity and size.** Zustand 5.1.0 is 0.4 kB gzip [measured].
- **Workers.** Fine.
- **Migration.** Small at first, with the cost growing on every new screen.
- **Verdict.** No. The one place it is best, central state, is better served by store actions that drive the Query cache.

### 5. Combination: Query or DB for server state, Zustand for UI and flow, URL for shareable state

This is option 2 or 3 with the owner's rules kept. What goes where:

| Kind of state | Home | Examples |
| --- | --- | --- |
| Anything a link carries | Router search params, typed by `validateSearch` | Screens view (tiles or table), `q`, group, status filter, the selected spot, the editor's orientation and fit toggles, an asset search |
| Server data | `QueryClient` (later, DB collections for the editors) | `list_screens`, `get_screen`, `list_groups`, templates, assets, brand kits, publish history and rollout |
| Flow and UI state | Zustand slices | Editing buffers (a spot's field values while typed, with the server `updatedAt` they started from); pending and error per action; the Undo toast (what to undo, until when); the publish flow; the preview channel (the iframe, the last valid frame); the theme |
| One component's own state | `useReducer` | A pairing-code input's characters |

Its risk is two sources of truth for one value: for example, a screen's name in both the editing buffer and the cache. The rule that avoids it: a buffer exists only while a form is open, is created from the cache, and is dropped on save or cancel [judgement].

- **Verdict. Recommended, with Query** (option 2).

## Live updates for fleet status

**What changes, and how fast.**

- **Screens.** A screen syncs over HTTP every 5 minutes, and the server writes its last-seen time and heartbeat to D1 then. A screen's Durable Object writes "applied" to `screens.reported_manifest_id` as soon as the screen reports it (`backend-plan.md`, The screen's Durable Object; Sync).
- **What the CMS can know.** "Online" versus "unreachable" can change no faster than the 5-minute sync, and the client clock already ages "Unreachable 2 h" without a refetch (`src/lib/live.ts` on M3-11). Only rollout progress, pairing, and another person's or agent's edits change within seconds.

**What the platform gives.**

- **Hibernating WebSockets.** A Durable Object that accepts sockets with `ctx.acceptWebSocket()` can hibernate without disconnecting them, and "Billable Duration (GB-s) charges do not accrue during hibernation". A Worker can proxy an upgrade request to the object with `stub.fetch(request)` [verified] ([DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- **When an object hibernates.** It hibernates after 10 seconds idle, if no request is being processed, no standard WebSocket API is in use, and no `waitUntil` work or timers are pending [verified] ([DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
- **What a socket costs.** Opening a socket is a request. Outgoing messages and incoming protocol pings are free. Incoming messages bill at 20:1. Auto-responses do not add duration [verified] ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- **Streams keep objects awake.** "Durable Objects remain active while a request, RPC call, response stream, WebSocket, or pending I/O is in flight". A Worker streaming a response "remains active", and HTTP-triggered Workers have no hard duration limit while the client stays connected [verified] ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)).

**The three ways.**

| | Polling with Query | Server-Sent Events | WebSocket to a per-org Durable Object |
| --- | --- | --- | --- |
| How | `refetchInterval: 15_000` on the screens and rollout queries, off in background tabs | A stream from a Worker or an object | Each CMS tab opens one socket to its org's object; the tool dispatcher and the screen objects tell the org object what changed; it broadcasts to the org's sockets |
| Latency | Up to the interval | Push | Push |
| Cost | One tool call (or two: screens and groups) per tab per interval while visible | A stream held open keeps a Durable Object awake, billed for duration, per open tab. A plain Worker has no event source to stream from without one | Idle sockets cost no duration while hibernated; broadcasts are outgoing, so free; one request per connect |
| Fits our rules | Yes. Data still comes through the tools, scoped by `packages/db` | It would need its own auth on a long request | Yes, if messages are hints ("`rename_screen` changed screen X", "screen Y applied manifest Z") and the client refetches through the tools. Data never flows over the socket, so org isolation stays in one place |
| Work | None beyond the Query move | Medium | Medium: an org Durable Object (the backend plan already wants one per org, to hold publish alarms and serialise publishes), a `ticket` on the socket as screens have, a hint after commit in the dispatcher (beside `ctx.notify`), and a client that maps hints to `invalidateQueries` |

**Verdict.**

- **Now.** Polling. It is what M3-11 does, minus reloading the shell.
- **The org channel.** Build it as M3-18 or Milestone 4 work, once rollout progress or concurrent agents need seconds, not 15 s. Use hibernating WebSockets.
- **Never SSE from a Durable Object.** It keeps the object awake per tab.
- **Browser client.** For reconnects with jitter (which `backend-plan.md` already asks of screens), `partysocket` 1.3.0 is a reconnecting WebSocket from Cloudflare's PartyKit, 4.1 kB gzip [measured]. A small hand-written client is also fine.
- **Unchecked.** Whether a WebSocket upgrade passes through the CMS's `/api/*` forward over the service binding is not stated in the service-binding docs [unverified]. In a deployed environment the API Worker's route takes `/api/*` directly, so only local development depends on it.

## Local-first sync engines

| Engine | What it needs | Fit with D1 and the tool registry | Verdict |
| --- | --- | --- | --- |
| **Zero** (`@rocicorp/zero` 1.12.0) | "Zero requires Postgres v15.0 or higher, and support for logical replication", with `wal_level = logical`. "Today only Postgres is supported." A `zero-cache` server replicates Postgres [verified] ([Connecting to Postgres](https://zero.rocicorp.dev/docs/connecting-to-postgres)). Writes are mutators run first on the client, then on your server's mutate endpoint in a transaction against the database [verified] ([Mutators](https://zero.rocicorp.dev/docs/mutators)) | No D1. The mutate endpoint could call our dispatcher, but `zero-cache` must replicate the database the tools write to, so tenant data would move to Postgres, outside D1 and outside the $5 budget | No |
| **Replicache** (15.3.0) | "Now in maintenance mode"; users "should migrate to Zero as they are able" [verified] ([replicache.dev](https://replicache.dev/)) | Bring-your-own backend, so it could sit on our tools, but no new features | No |
| **Electric** (`@electric-sql/client` 1.5.28) | "A read-path sync engine for Postgres", syncing "Shapes" over HTTP; writes go "back through your API" [verified] ([Electric intro](https://electric.ax/docs/intro)) | Postgres only. Writes through our API would fit; reads would not | No |
| **LiveStore** (0.5.0) | Event-sourced; sync providers include Cloudflare Workers (`@livestore/sync-cf`) and Electric [verified] ([LiveStore docs](https://docs.livestore.dev/)). Not a fit if "you have an existing database which is the source of truth of your data", or for "a more traditional client-server application" [verified] ([When to use LiveStore](https://docs.livestore.dev/evaluation/when-livestore/)) | Our source of truth is D1 behind the tools, so it is excluded by its own guidance | No |
| **Cloudflare Agents state sync** (`agents` 0.33.0) | One JSON state per Agent, "stored in SQLite, survives restarts and hibernation, and syncs to every connected client"; `useAgent` clients can push changes, checked by `validateStateChange()`; read-only connections exist [verified] ([Store and sync state](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/)) | Client-set state would be a write path beside the tool registry. Read-only, it is a heavier way to build the org hint channel above | Not for data. Possible later for the M4 agent session itself |
| **D1** | No change feed or change-data capture was found in the D1 docs this session [unverified] | Changes are known only where we write them: the dispatcher and the screen objects. That is why the hint channel is fed from there | n/a |

All of these solve a problem we do not have yet, offline editing in the CMS, and each brings a second write path. The tool registry is the single audited write path for people and agents (`packages/tools/README.md`; `backend-plan.md`, Agents), and that rules them out [judgement].

## Agents editing at the same time as people

None of the options solves this alone. Three things are needed, and only the first depends on the data layer:

1. **See their change.** Refetch on interval and focus now; push a hint after commit later (above). The audit row already names the actor, action and target, which is the hint's content.
2. **Do not clobber what the person is typing.** The editing buffer in Zustand keeps the fields being edited; when a refetch brings a newer `updatedAt` from someone else, the form shows "Claude changed this draft · Review" rather than overwriting. This is Figma's rule of dropping incoming changes that conflict with unacknowledged local edits (`cms-ux.md` §1.2). DB's per-row layering does part of this on its own.
3. **Do not let one save undo another.** Today a tool overwrites what it is given. `set_group_members` replaces the whole list, and M3-11's settings form sends `[...g.screenIds, screen.id]` built from what the page loaded, so a member added by an agent in between is lost. A fix belongs in the tools, not the CMS: an optional `ifUnchangedSince: updatedAt` (or a revision) on update tools, refused with the existing `409 conflict`, and add/remove tools for set-like fields. This is a proposal for `packages/tools` [judgement].

## The 100 ms preview

This is not a data-layer question, and every option above handles it the same way.

1. A keystroke runs a store action that updates the editing buffer.
2. The preview slice, given the iframe by a ref callback (no effect), posts a debounced `draft` message to the player (M3-36, frame protocol 2). The preview never waits for the network. If the field is invalid, the stage keeps the last valid frame (M3-16).
3. Separately, the save to the server is debounced longer (Query: a timer in the store action; DB: a paced mutation) and goes through the spot draft tool.

The 100 ms budget is spent between the keystroke and the player's frame, and nothing in it is network. A Pi measurement does not apply here: the stage runs in the editor's browser, not on a screen [judgement].

## Comparison

Sizes are gzip, measured this session (method under Sources).

| | Loaders only | **Query + Zustand + URL** | DB + Zustand + URL | Zustand only | Local-first engine |
| --- | --- | --- | --- | --- | --- |
| SSR | Yes | Yes, first-party | Yes, RC | By hand | Varies; none on D1 |
| Optimistic plus rollback | By hand | Yes | Best | By hand | Yes |
| Undo publish | Yes | Yes | Yes | Yes | n/a |
| Live fleet | Reload everything | Per-query polling; hints to invalidate | Polling or socket writes | By hand | Built in, but needs Postgres |
| 100 ms preview | Same for all | Same | Same, plus paced save | Same | Same |
| Agent concurrency | Next reload | Refetch or hint, plus buffer | Layered rows, plus hint | By hand | Built in |
| Cursor pages | By hand | Infinite queries | On-demand plus pager | By hand | n/a |
| Central state, no effects | Yes | Two stores, actions in one | Two stores, actions outside React | One store | Engine's own |
| Maturity | Shipped | Stable v5 | 1.0 RC since 2026-10-29 | Stable | Postgres-bound, or 0.x |
| Added size | 0 | 11.6 kB + 1.9 kB | 82.8 kB (104.6 kB with the Query collection) | 0.4 kB | n/a |
| Workers | Yes | Yes | Likely; untested | Yes | No (Postgres, `zero-cache`) |
| Migration from M3-11 | None | Small | Medium | Small, growing | Large |

## Ranked

1. **TanStack Query for server data, Zustand for flow, URL for links, polling for fleet status** (options 2 and 5). It covers every case today, is stable and small, and leaves the way to DB open.
2. **The same, plus a per-org Durable Object with hibernating WebSockets sending hints.** The same layer, done when rollout progress or concurrent agents need it.
3. **TanStack DB (Query collection) for the editors, on top of 1.** When 1.0 is stable and the playlist editor needs cross-collection live queries.
4. **Loaders alone.** Fine as it is for read-only pages; not enough for optimistic editing.
5. **Zustand alone for server data.** Rebuilds a server-state library by hand.
6. **A local-first engine (Zero, Electric, LiveStore, Replicache).** Needs Postgres or event sourcing, and a second write path.

## How it would look

Where each kind of state lives is in the table under option 5. The code below is a sketch against the M3-11 branch (its `getScreens` server function, `callTool`, and `ScreenView`), not tested.

**Per request: router, query client and store, made together.**

```ts
// src/router.tsx
import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { createAppStore } from '~/state/store';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });
  const store = createAppStore({ queryClient }); // one per request, like the QueryClient
  const router = createRouter({ routeTree, context: { queryClient, store }, defaultPreload: 'intent', scrollRestoration: true });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}
```

**A query: every screen of the active org, kept live by polling.** The key starts with the org id, so switching org never shows the last org's rows. Writes invalidate by prefix.

```ts
// src/queries/screens.ts
import { queryOptions } from '@tanstack/react-query';
import { getScreens } from '~/server/screens.functions'; // list_screens + list_groups, every page

export const screenKeys = {
  all: (orgId: string) => ['org', orgId, 'screens'] as const,
};

export const screensQuery = (orgId: string) =>
  queryOptions({
    queryKey: screenKeys.all(orgId),
    queryFn: () => getScreens(),
    refetchInterval: 15_000, // stops in background tabs (refetchIntervalInBackground is false)
  });

// src/routes/_app/screens/index.tsx
export const Route = createFileRoute('/_app/screens/')({
  validateSearch, // view, q, group, status: unchanged from M3-11
  loader: ({ context }) => context.queryClient.query({ ...screensQuery(context.orgId), staleTime: 'static' }),
  component: ScreensPage,
});

function ScreensPage() {
  const { orgId } = Route.useRouteContext();
  const { data } = useSuspenseQuery(screensQuery(orgId)); // replaces useLoaderData + useLiveData
  // ...
}
```

`context.orgId` is the active org from the `_app` route's `beforeLoad` (the shell), so it needs `getShell` moved into `beforeLoad` or its own query; that is part of the migration.

**A mutation: `rename_screen` as a store action.** It is optimistic, rolls back with the tool's own message, and offers Undo. The tool's shape is `POST /api/tools/rename_screen` with `{ screenId, name }`, returning `{ screen }` or `{ error, message, details? }`.

```ts
// src/state/screens.ts: one slice of the app store
import type { StateCreator } from 'zustand';
import { screenKeys } from '~/queries/screens';
import { callTool, ToolCallError } from '~/lib/tools';
import type { ScreenView } from '~/lib/screen-types';

type ScreensData = { screens: ScreenView[]; groups: unknown[]; at: number };

export const screensSlice: StateCreator<AppState, [], [], ScreensSlice> = (set, get) => ({
  pending: {},                 // `${action}:${id}` -> true, for spinners and disabled buttons
  notice: null,                // { message, undo? } for the toast

  async renameScreen(screenId: string, name: string) {
    const { queryClient: qc, orgId } = get().deps;
    const key = screenKeys.all(orgId);
    const before = qc.getQueryData<ScreensData>(key)?.screens.find((s) => s.id === screenId)?.name;
    const setName = (to: string) =>
      qc.setQueryData<ScreensData>(key, (d) => d && { ...d, screens: d.screens.map((s) => (s.id === screenId ? { ...s, name: to } : s)) });

    await qc.cancelQueries({ queryKey: key }); // a poll in flight must not overwrite the guess
    setName(name);                              // optimistic: list and detail both read this entry
    set((s) => ({ pending: { ...s.pending, [`rename:${screenId}`]: true } }));
    try {
      await callTool<{ screen: { id: string; name: string } }>('rename_screen', { screenId, name });
      set({ notice: before ? { message: `Renamed to ${name}`, undo: () => get().renameScreen(screenId, before) } : null });
    } catch (err) {
      if (before) setName(before);              // roll back this field only, not the whole snapshot
      set({ notice: { message: err instanceof ToolCallError ? err.message : 'Could not rename the screen.' } });
    } finally {
      set((s) => ({ pending: { ...s.pending, [`rename:${screenId}`]: false } }));
      void qc.invalidateQueries({ queryKey: key }); // the server's view wins once it answers
    }
  },
});
```

Notes on the sketch:

- **Rollback restores one field, not the whole snapshot.** Restoring the snapshot would drop an agent's change that arrived meanwhile.
- **Undo is a new tool call, not a cache trick.** It is audited like any other change, which is what the audit log is for.
- **Publish works the same way, but not optimistically.** `publishOrg()` (later `undoPublish()`) calls the publish tool, shows "Publishing…" from `pending`, then invalidates `['org', orgId, 'publishes']` and the screens key. The toast's Undo calls the rollback tool (M3-18).
- **Long lists page with `useInfiniteQuery`.** Assets, templates and the audit log use `initialPageParam: null` and `getNextPageParam: (last) => last.next`. Every input but `cursor` goes in the key, since the README says a cursor is valid only "with the same filters".
- **Later, a push channel slots in.** Each hint maps to `qc.invalidateQueries({ queryKey: ['org', orgId, <kind>] })`, and nothing above changes.
- **Moving to TanStack DB later.** `screensQuery(orgId)` becomes a `queryCollectionOptions({ queryKey, queryFn, queryClient, getKey: (s) => s.id })`, and `renameScreen`'s body becomes a `createOptimisticAction` whose `mutationFn` is the same `callTool`.

## Open questions

1. **Whether the API should take an expected revision on update tools.** This is the "agents at the same time" item 3 above. It is a `packages/tools` change, decided before M3-16 saves drafts every second.
2. **How reads reach the API from the browser.** Through the CMS server function (two Workers per call, as M3-11 does), or `POST /api/tools/list_screens` directly (one Worker)? `createIsomorphicFn` in Start runs one implementation on the server and another in the browser [verified] ([Start, environment functions](https://tanstack.com/start/latest/docs/framework/react/guide/environment-functions)). Whether it keeps `api.server.ts`'s `cloudflare:workers` import out of the client bundle was not tried [unverified].
3. **How short a refetch interval the budget allows once the org channel exists.** With push hints, the poll can drop to a minute, or go away.

## Sources

**TanStack Router and Start**
- Router, Data Loading (built-in cache, its limits): https://tanstack.com/router/latest/docs/framework/react/guide/data-loading
- Router, External Data Loading: https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading
- Router, TanStack Query integration (`setupRouterSsrQueryIntegration`): https://tanstack.com/router/latest/docs/integrations/query
- Router API, RouterType (`invalidate`): https://tanstack.com/router/latest/docs/framework/react/api/router/RouterType
- Router API, RouteOptions (`onEnter`, `onLeave`, `staleTime`): https://tanstack.com/router/latest/docs/framework/react/api/router/RouteOptionsType
- Start, Environment functions (`createIsomorphicFn`): https://tanstack.com/start/latest/docs/framework/react/guide/environment-functions

**TanStack Query**
- Optimistic Updates: https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates
- Mutations: https://tanstack.com/query/latest/docs/framework/react/guides/mutations
- Infinite Queries: https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries
- QueryClient reference (`query`, deprecations): https://tanstack.com/query/latest/docs/reference/QueryClient
- useQuery reference (`refetchInterval`): https://tanstack.com/query/latest/docs/framework/react/reference/useQuery
- streamedQuery: https://tanstack.com/query/latest/docs/reference/streamedQuery
- Does TanStack Query replace client state?: https://tanstack.com/query/latest/docs/framework/react/guides/does-this-replace-client-state
- npm, @tanstack/react-query: https://www.npmjs.com/package/@tanstack/react-query

**TanStack DB**
- Overview: https://tanstack.com/db/latest/docs/overview
- Query collection: https://tanstack.com/db/latest/docs/collections/query-collection
- Mutations: https://tanstack.com/db/latest/docs/guides/mutations
- SSR and Hydration (repo): https://github.com/TanStack/db/blob/main/docs/guides/ssr.md
- Migrating to the 1.0 RC (repo): https://github.com/TanStack/db/blob/main/docs/guides/migrate-to-1-0-rc.md
- Releases: https://github.com/TanStack/db/releases
- npm, @tanstack/db: https://www.npmjs.com/package/@tanstack/db

**Zustand**
- Next.js guide (store per request): https://zustand.docs.pmnd.rs/learn/guides/nextjs

**Cloudflare**
- Durable Objects, WebSockets and hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Durable Objects, lifecycle: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- Durable Objects, pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Workers, limits (streaming, duration): https://developers.cloudflare.com/workers/platform/limits/
- Workers, service bindings over HTTP: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/
- Agents, store and sync state: https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/

**Sync engines**
- Zero, Connecting to Postgres: https://zero.rocicorp.dev/docs/connecting-to-postgres
- Zero, Mutators: https://zero.rocicorp.dev/docs/mutators
- Zero, docs index: https://zero.rocicorp.dev/llms.txt
- Replicache: https://replicache.dev/
- Electric, intro: https://electric.ax/docs/intro
- LiveStore, docs: https://docs.livestore.dev/
- LiveStore, When to use LiveStore: https://docs.livestore.dev/evaluation/when-livestore/

**Versions** are from the npm registry's metadata on 2026-11-17 (`https://registry.npmjs.org/<package>`): `@tanstack/react-query` 5.108.0, `@tanstack/react-router-ssr-query` 1.167.3, `@tanstack/db` and `@tanstack/react-db` 1.0.0-rc.1.5, `@tanstack/query-db-collection` 1.5.2, `@tanstack/electric-db-collection` 1.0.0-rc.1.5, `@tanstack/react-router-with-db` 1.0.0-rc.1, `zustand` 5.1.0, `@rocicorp/zero` 1.12.0, `replicache` 15.3.0, `@electric-sql/client` 1.5.28, `@livestore/livestore` 0.5.0, `agents` 0.33.0, `partysocket` 1.3.0.

**Size method.** Packages were installed with `--ignore-scripts` in a scratch directory. Each entry re-exported only the named APIs listed in the text, and was bundled with esbuild 0.28.2 (`--bundle --minify --format=esm --platform=browser`, `process.env.NODE_ENV="production"`), with React, React DOM and TanStack Router external, then compressed with `gzip -9`. Real app bundles differ with what is imported and how the bundler splits chunks.

**Repo sources:** `docs/backend-plan.md`, `docs/architecture.md`, `packages/tools/README.md`, `docs/research/cms-ux.md`, `docs/proposals/cms-ui.md`, `docs/tickets/M3-11`, `M3-16`, `M3-18`, `M3-36`, `apps/cms` on `m3-foundations`, the `m3-11-cms-screens` worktree (`src/lib/tools.ts`, `src/lib/live.ts`, `src/server/screens.functions.ts`, `src/routes/_app/screens/`), and the `t3/cms-react-lint` worktree (`eslint.config.js`, `src/lib/orgs.ts`).

## Decision (owner, 2026-11-17)

TanStack Query for server data; Zustand for UI and flow state (mutations are store actions that call the tool and update the Query cache); the URL for anything a link carries. Fleet status polls for now. Reads are written with `queryOptions` keys and fetch functions so TanStack DB collections (Query collection, then a per-org Durable Object change stream) can take over for the editors and the fleet once DB 1.0 is stable. Lost updates are fixed in the tools first (M3-44).
