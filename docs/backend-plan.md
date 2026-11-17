# Milestone 3 plan: CMS and API

Status: draft for review, 2026-11-17. It builds on `architecture.md` and must produce exactly what `packages/contract` defines. The contract and player are measured and settled; the backend serves them.

Items marked **verify** depend on current Cloudflare or Better Auth behaviour that has not been checked yet. Each gets checked in the slice that first needs it.

## Two numbers that shape the design

- **The player's 30-second manifest poll cannot stay.** At 1,000 screens it is 86 million requests a month, about $23 over the $5 plan before any data polling. Screens instead sync over HTTP every 5 minutes and get a WebSocket nudge when a publish lands.
- **Durable Object time is the scarce resource.** The paid plan's included duration allows roughly 100 seconds awake per screen per day (**verify** the billing per wake). The screen socket must stay almost silent: keepalives answered without waking the object, and heartbeats, play logs and data on the HTTP sync, not the socket.

## Layout

```
apps/api       Hono Worker: /api (CMS), /v1/device (screens), /mcp (M4), both Durable Objects, cron, queue
apps/cms       TanStack Start Worker; talks to apps/api over a service binding
packages/db          Drizzle schema and the only code allowed to query tenant tables
packages/compiler    org data + screen -> ScreenManifest. Lifted from sf.ts, golden-tested against examples/
packages/media-check MP4 header check against VIDEO_SPEC, shared by browser and Worker
packages/feeds       iCal and RSS normalising, ported from datad.py with fixtures
packages/tools       one registry of operations (zod input, scope, role, handler); the CMS, MCP and WebMCP all call it
```

Two Workers on one hostname, so cookies stay same-origin. They are split because CMS deploys happen often, and redeploying the Worker that hosts the Durable Objects drops every screen's socket. The API Worker also hosts each player release as a content-addressed bundle. The screen does not load the player from Cloudflare: see **Where the player runs**.

## Data model (D1)

Text IDs and integer-millisecond timestamps. Every tenant table has `org_id NOT NULL`, its indexes lead with it, and foreign keys are composite `(org_id, id)` so a row cannot point into another org (**verify** D1 enforces foreign keys). The schema is `packages/db/src/schema.ts`; its README lists the few deliberate exceptions.

| Table | Key columns |
| --- | --- |
| Better Auth's own: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` | `organization` adds the default playlist and quotas. Roles: owner, editor, viewer. |
| `screens` | name, timezone, locale, orientation, `display_hours_json`, `desired_manifest_id`, `previous_manifest_id` (whose files stay servable while a screen switches), `reported_manifest_id`, last seen, player version, status |
| `screen_groups`, `screen_group_members` | |
| `screen_credentials` | screen, secret hash, last used, revoked at |
| `pairing_codes` | code, poll-token hash, expires at, claimed org and screen |
| `assets`, `asset_renditions` | kind, sha256, type, size, width, height, duration, status (pending, verified, rejected); landscape and portrait renditions |
| `templates`, `template_versions` | null org means a base template; version, manifest, bundle sha, status (draft, approved, retired), check report |
| `spots` | kind, template version, data, asset map, bindings, duration, plus the image, video or URL fields |
| `playlists`, `playlist_items` | transition; ordered spots |
| `schedule_entries` | playlist, priority, target, dates, days, window |
| `publishes`, `publish_screens` | status, publish at, actor; which manifest each screen got. Rollout status is a join against `screens.reported_manifest_id`. |
| `data_sources`, `data_snapshots` | format, encrypted URL (a private calendar URL is a secret), refresh, next poll at, ETag, failures; latest snapshot, at most 64 kB |
| `audit_log` | when, actor kind (user, agent, device, system), actor, action, target, detail |
| `play_counts` | screen, hour, spot: plays and milliseconds |

## Publishing

1. **Compile.** `packages/compiler` loads the org's data in about eight queries and builds each target screen's manifest. A manifest's ID is the hash of its body, so a screen whose content did not change is skipped.
2. **Fan out** through a Queue, 50 screens per batch, to stay under per-invocation subrequest limits (**verify**). Per screen: one R2 write, one D1 row, one call to its Durable Object.
3. **Timed publish.** A per-org Durable Object holds the alarm and serialises publishes for that org. It wakes only when a publish is due.

**Uploads**
- **Images** are scaled in the browser at upload with `createImageBitmap` and `OffscreenCanvas`, using the same cover-the-screen rule as `sf build`, into a landscape and a portrait rendition. The Worker checks the dimensions. Uploads with no browser (API, MCP) fall back to the Cloudflare Images binding (**verify** the free allowance).
- **Video** is checked by `packages/media-check` reading the MP4 header against `VIDEO_SPEC`: in the browser before upload, and again in the Worker over R2 range reads, because the client cannot be trusted (**verify** mp4box.js runs in workerd).
- **Transport.** Files go straight to R2 by presigned PUT, multipart for video. A finalize call re-hashes the file and marks it verified.

**Templates** are not built in a Worker. The server's checks on an uploaded bundle are a lint, not a boundary: the bundle contains the SDK, whose own `parent.postMessage` would trip the code denylist, and string checks can be evaded. The sandbox and its policy are the guarantee.

**Template keys** are namespaced by owner (`base/` or the org id) so a base template and an org template with the same id and version cannot collide in a manifest. `sf template push` builds locally or in CI with today's `buildTemplate` and uploads the result. The Worker repeats the string checks: manifest, forbidden CSS, size, network references. Building agent-submitted templates on a CI runner is Milestone 4.

**R2 layout**

```
o/<org>/b/<sha256>                    assets and template bundles
sys/b/<sha256>                        base templates
o/<org>/m/<screen>/<manifestId>.json  manifests
```

The per-org prefix keeps one org from probing whether another holds a file, and makes cleanup simple.

## Screens

**Pairing**
1. The screen calls `pair/start` and receives a 6-character code and a secret poll token, valid 15 minutes.
2. It shows the code and polls every 5 seconds.
3. A user claims the code in the CMS, choosing name, time zone, orientation, groups and display hours.
4. The next poll returns the screen's credential once. Only its hash is stored.

Pairing calls are rate limited. For zero-touch installs, the CMS mints a credential that the image script pre-seeds.

**Credential**
- An opaque token, `sfd_<screenId>.<32 random bytes>`, stored as a SHA-256. It is not a JWT.
- Revoking is one row update, then the Durable Object closes the socket.
- Until pairing exists, `pnpm --filter @signforge/api dev:screen [--content dist/content]` creates a screen in local D1, loads a build into local R2, and prints a credential.

**The screen's Durable Object** holds the desired and reported manifest IDs and one hibernating WebSocket.
- Keepalive pings get an automatic reply without waking it.
- Server to screen: new manifest, command, revoked.
- Screen to server: applied only, written through to D1. The CMS reads rollout from D1 and never calls 1,000 Durable Objects.

**Sync.** `POST /v1/device/sync`, every 5 minutes with jitter, the interval set by the server.
- **The screen sends:** player and manifest versions, cache state, display state, hourly play counts.
- **The server returns:** the desired manifest ID, any changed data snapshots, a short-lived socket ticket and the server time. The server time is there because a Pi has no battery-backed clock.

| Route | Purpose |
| --- | --- |
| `POST /v1/device/pair/start` | Get a code and poll token |
| `POST /v1/device/pair/poll` | Collect the credential |
| `GET /v1/device/manifest.json` | Desired manifest. Its ETag is the manifest ID. The player sends `If-None-Match` itself, since it fetches with `cache: 'no-store'`, so an unchanged manifest is a 304. |
| `GET /v1/device/blobs/:sha256` | File from R2, cached forever. Only files the screen's desired or previous manifest lists, from its own org's prefix (or `sys/b/` for a base template). |
| `GET /v1/device/data/:id.json` | Snapshot, for first load. Only sources the screen's manifest lists. |
| `POST /v1/device/sync` | Heartbeat, play counts, snapshot changes |
| `GET /v1/device/ws?ticket=` | Nudge socket |

The device API's request and response shapes are in `packages/contract` (device API section). Changes the player needs, beyond pointing its content base at `/v1/device`:
- Send the bearer credential, and `If-None-Match` on the manifest; on a 304, still check the cached manifest for missing files.
- Replace the per-source data poll with snapshots delivered on sync. Left as it is, every screen sends a request per source per refresh, which the cost table does not include.
- Count plays per UTC hour, persist the counts, and send them with a batch number until acknowledged.
- Treat a 401 as revoked, not offline: show a pairing code (open question 2).
- Act on socket commands at once, including a display override.
- Correct its clock from server time.

Its service worker already leaves `/v1/` alone, so device API responses are never stored in the shell cache.

**Where the player runs.** The player is served by the device, from `http://127.0.0.1:8090`, and the supervisor updates it. Each sync reports the player version; the server names the release a screen should run, and the supervisor downloads, verifies by hash, and swaps it in between plays. Three reasons, all from the code as it stands:
- The page talks to the supervisor on loopback. From a public origin that becomes a cross-origin request to the local network, which recent Chromium gates behind a permission prompt a kiosk cannot answer (**verify** on the Pi's Chromium).
- Secrets stay off URLs. The screen's credential and the supervisor's token are handed to the page by the supervisor over loopback, only to the player's own origin. A template frame can read its parent's URL, so nothing secret goes there.
- The same local origin is what makes a web-page spot on a public site unable to reach the device: Chromium blocks public pages from requesting loopback.

**Clock.** A Pi has no battery-backed clock, and the schedule and display hours run on it. The player keeps the offset from the last sync's server time, persists it, and uses corrected time everywhere it reads the clock. Large drift is reported.

**Display power**
- **Hours.** Display hours are part of the screen's manifest, so a change is a publish and works offline. The player already enforces them (see `architecture.md`).
- **Commands.** The socket adds `wake now` and `sleep now`, a temporary override for someone standing at a dark screen. They expire at the next scheduled change.
- **Status.** The display's actual state and the power method that worked are reported on sync.

## Data sources

- **Polling.** A one-minute Cron Trigger selects the sources due by `next_poll_at`. Requests are conditional, back off up to 6 hours on failure, and write only when the data's hash changes.
- **Delivery.** Snapshots ride the sync response, so a screen is at most 5 minutes stale. There is no per-snapshot fan-out.
- **Recurring events.** iCal recurrence is expanded with ical.js over the next 30 days, including exceptions and moved instances. Limits: 1 MB body, 500 iterations per event, 25 events out (**verify** it bundles for workerd).
- **Fetch safety.** Feed URLs are user-supplied, so fetching them is guarded:
  - HTTPS only, on default ports, and no IP addresses.
  - Hostnames that are, or resolve to, private or reserved addresses are rejected. A Worker cannot pin the address it checked, so this is a first filter, not the defence against DNS rebinding; that rests on Workers' outbound requests not reaching private networks.
  - Redirects are followed manually and re-checked, at most 3.
  - 5-second timeout.
  - Errors are reported by category, never by echoing the upstream body.
  
  **Verify** whether Workers can reach private ranges at all.
- **Limits.** 10 sources per org, refresh no faster than 5 minutes, 2 concurrent fetches per host.

## Auth and tenancy

- **Three kinds of caller, on separate route trees:** users with a cookie on `/api`, screens with a bearer token on `/v1/device`, agents with OAuth on `/mcp`. No credential works on another's tree.
- **Org isolation.** D1 has no row-level security, so handlers never touch the database directly. Only a `scoped(db, orgId)` repository in `packages/db` queries tenant tables. A generated test replays every tool as org B against org A's IDs and expects not-found.
- **Better Auth on Workers:**
  - Build the instance per request from the environment; the CLI's schema generator gets a separate static config (**verify**).
  - D1 has no interactive transactions (**verify** the organization plugin's flows work with batches).
  - Password hashing exceeds the free plan's CPU limit. Sign-in is passwordless: email code plus GitHub or Google.
  - Rate limiting goes in the database or the rate-limit binding, not memory.
  - Turn on the session cookie cache.
  - Check membership of the active org on every request.
- **Agents (Milestone 4).**
  - OAuth through Better Auth's provider plugin (**verify** dynamic client registration and PKCE). A grant is bound to one org.
  - Scopes: `content:read`, `content:draft` (the default), `content:publish` (separate, off by default, never more than the user's role allows), `screens:manage`.
  - Without publish scope, the publish tool creates a pending publish for a person to approve.
  - The tool registry is built in Milestone 3 as the CMS's own API, and the audit log is written in its dispatcher, so the MCP server and WebMCP become thin adapters.

## Cost at 1,000 screens

| Resource | Included in the $5 plan | Estimated use per month |
| --- | --- | --- |
| Worker requests | 10M | about 9.3M (sync is 8.6M) |
| Worker CPU | 30M ms | about 20M ms |
| Durable Object duration | 400k GB-s | about 270k: tight |
| Durable Object requests | 1M | under 0.3M |
| D1 writes | 50M | 16 to 20M |
| D1 reads | 25B | about 30M |
| D1 storage | 5 GB | about 1 GB with 90 days of play counts |
| R2 | 10 GB, 1M writes, 10M reads | about 50 GB, about $0.60 |

Estimate: **$5 to $7 a month**. The free plan tops out near 340 screens, which is plenty for development and the public demo. Every figure here is **verify**.

## Build order

Each slice ends with something working on the real Pi.

1. **Pi on a Worker.** `apps/api` with R2 and a seeded credential. `sf push` uploads today's build output, and the player gets a content base URL and bearer header. Demo: the Pi plays from Cloudflare and survives a pulled network cable.
2. **Nudge.** The screen's Durable Object, its socket and the sync endpoint; the 30-second poll goes. Demo: `sf push` changes the Pi within seconds.
3. **Pairing.** A minimal CMS with Better Auth and orgs. Demo: claim the code on the Pi; revoking it drops the screen back to a code.
4. **Instant publish.** Assets, spots, playlists, the server compiler, browser image scaling, the tool registry. Demo: edit a price, publish, the Pi updates.
5. **Scheduling and display hours.** Groups, schedule entries, takeovers, timed publish, Queue fan-out, the rollout view, display hours, and the wake/sleep override.
6. **Video.** Multipart upload and the MP4 check.
7. **Data sources.** The cron poller and `packages/feeds`; `datad.py` retires.
8. **Hardening.** Isolation tests, audit view, quotas, file cleanup, dev, demo and prod environments.

## Risks

- Anything chatty on the screen socket blows the Durable Object budget.
- Re-checking uploaded media on the server is easy to skip and must not be.
- The schedule and display hours run on the device clock, and a Pi has no battery-backed clock. Sync returns server time so drift can be detected and reported.
- Without cleanup and per-org quotas, R2 only grows.
- Better Auth on D1, and its OAuth provider, are the least-proven pieces.
- Every API deploy reconnects every screen at once; reconnects need jitter.
- The contract has no expiry instant on a schedule entry, so a takeover is compiled into a dated window and capped under 24 hours, rather than changing the contract.

## Open questions

1. Does a timed publish ship content as it was when scheduled, or as it is when the time comes? The plan assumes the latter.
2. Should a revoked screen wipe its cache and show a pairing code, or keep playing what it has?
3. Is passwordless sign-in (email code, GitHub, Google) acceptable? Which email service?
4. Are 5-minute data freshness and roughly 10-minute offline detection acceptable?
5. Are hourly play counts enough, or is per-play proof of play needed?
6. Per-org limits on storage, screens and data sources, given there is no billing?
7. Can editors publish, or only owners? Can an agent with publish scope go live without a person approving?
8. ~~Should the player be served from Cloudflare and update itself, or be pinned in the Pi image?~~ Decided by the code: served by the device and updated by the supervisor (see **Where the player runs**). Confirm.
