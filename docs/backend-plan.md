# Milestone 3 plan: CMS and API

Status: draft for review, 2026-11-17. It builds on `architecture.md` and must produce exactly what `packages/contract` defines. The contract and player are measured and settled; the backend serves them.

The Cloudflare and Better Auth behaviour this plan relies on was checked against real Cloudflare and the Pi in M3-00 (2026-11-17); the evidence is in `spike/m3-platform/RESULTS.md`. One question is still open: whether auto-responded socket pings count as billable Durable Object requests (see **The screen's Durable Object**). R2 is not yet enabled on the account; it must be enabled in the dashboard before the first deploy.

## Two numbers that shape the design

- **The player's 30-second manifest poll cannot stay.** At 1,000 screens it is 86 million requests a month, about $23 over the $5 plan before any data polling. Screens instead sync over HTTP every 5 minutes and get a WebSocket nudge when a publish lands.
- **Durable Object time is the scarce resource.** Duration is billed only while an object is awake, at 128 MB, with no minimum per wake, so the paid plan's 400,000 GB-s allows about 107 seconds awake per screen per day at 1,000 screens. The screen socket must stay almost silent: keepalives answered by the runtime's auto-response, which does not wake the object (measured), and heartbeats, play logs and data on the HTTP sync, not the socket.

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

Two Workers on one hostname, so cookies stay same-origin. They are split because CMS deploys happen often, and a deploy of the Worker that hosts the Durable Objects resets any that are awake. A hibernated screen socket survives a deploy and the next message runs the new code (measured in M3-00), so an API deploy does not reconnect the whole fleet, but a screen mid-wake can still drop. The API Worker also hosts each player release as a content-addressed bundle. The screen does not load the player from Cloudflare: see **Where the player runs**.

## Data model (D1)

Text IDs and integer-millisecond timestamps. Every tenant table has `org_id NOT NULL`, its indexes lead with it, and foreign keys are composite `(org_id, id)` so a row cannot point into another org. D1 enforces foreign keys by default (`PRAGMA foreign_keys` is 1): a cross-org reference, a missing parent and deleting a restricted parent are all rejected, and a `batch()` with one bad row writes nothing. The schema is `packages/db/src/schema.ts`; its README lists the few deliberate exceptions.

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
2. **Fan out** through a Queue, 50 screens per batch. Per screen: one R2 write, one D1 row, one call to its Durable Object, so 150 calls per batch. D1, R2 and Durable Object calls share the per-invocation limit on calls to Cloudflare services: 1,000 on Free (measured), 10,000 by default on Paid. External `fetch` is limited separately, to 50 on Free. Write a batch's D1 rows in one `batch()` and make the Durable Object calls concurrently: done one at a time, a batch of 50 took 13 to 25 seconds.
3. **Timed publish.** A per-org Durable Object holds the alarm and serialises publishes for that org. It wakes only when a publish is due.

**Uploads**
- **Images** are scaled in the browser at upload with `createImageBitmap` and `OffscreenCanvas`, using the same cover-the-screen rule as `sf build`, into a landscape and a portrait rendition. The Worker checks the dimensions. Uploads with no browser (API, MCP) fall back to the Cloudflare Images binding, which works on Workers Free. It includes 5,000 unique transformations a month on both plans, then $0.50 per 1,000 on Paid; on Free, transformations past the allowance fail with error 9422 rather than charging.
- **Video** is checked by `packages/media-check` reading the MP4 header against `VIDEO_SPEC`: in the browser before upload, and again in the Worker over R2 range reads, because the client cannot be trusted. mp4box.js runs in workerd. Fed from R2 range reads, it fetches only the boxes it needs: one read when the moov comes first, and one more jump past the mdat when it comes last. The pixel format follows from the H.264 profile: allowing only Baseline, Main and High (profile_idc 66, 77, 100) rules out 10-bit and 4:2:2.
- **Transport.** Files go straight to R2 by presigned PUT, multipart for video. A finalize call re-hashes the file and marks it verified.

**Templates** are not built in a Worker. The server's checks on an uploaded bundle are a lint, not a boundary: the bundle contains the SDK, whose own `parent.postMessage` would trip the code denylist, so that list runs on the author's sources, uploaded alongside the bundle; and string checks can be evaded. The sandbox and its policy are the guarantee.

**Template keys** are namespaced by owner (`base/` or the org id) so a base template and an org template with the same id and version cannot collide in a manifest. `sf template push <dir> --api <url> [--org <id>] [--approve]` builds locally or in CI with `buildTemplate` and uploads the bundle (to `sys/b/` for a base template, the org's prefix otherwise) and the author's sources through `/admin`. The `register_template_version` tool then repeats the build's checks (`checkTemplateBundle`: manifest, forbidden CSS, size, network references on the bundle; forbidden code on the sources), stores the report on the version, and refuses a failure with each reason. Versions are immutable; a new one is a draft. Base templates belong to no org: their tools run from the platform registry with `platform(db)` and are audited in `platform_audit_log`. Building agent-submitted templates on a CI runner is Milestone 4.

**Deploying.** After applying migrations, seed the base templates: `SF_ADMIN_TOKEN=<ADMIN_TOKEN> pnpm seed:templates --api <url>`. It pushes every template in `templates/` as an approved base template. It is safe to run on every deploy: an unchanged template changes nothing, a retired one stays retired, and an edited template whose version was not bumped is refused.

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
- Until the CMS publishes, `sf push <out-dir> --screen <id> --api <url>` uploads an `sf build` output and makes it the screen's desired manifest. It uploads through a temporary `/admin` tree guarded by the `ADMIN_TOKEN` deploy secret (off when unset). The last step, making the manifest desired, runs the `publish_manifest_to_screen` tool through the dispatcher and is audited as the system actor `sf-push`. `/admin` goes once assets upload through the CMS (M3-14) and agents hold OAuth grants (Milestone 4).

**The screen's Durable Object** holds the desired and reported manifest IDs and one hibernating WebSocket.
- Keepalive pings get an automatic reply (`setWebSocketAutoResponse`) without waking it or billing duration. Whether those pings count as billed requests (incoming messages bill at 20:1) is not documented: at a 60-second ping and 1,000 screens the worst case is 2.2M requests a month, about $0.18 over the allowance. M3-06 reads the real count from analytics on the paid account and uses the longest keepalive that holds the connection.
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
- The page talks to the supervisor on loopback. From a public origin that becomes a cross-origin request to the local network, which Chromium gates behind a permission prompt a kiosk cannot answer. Checked on the Pi's Chromium 156: from a public https page, a fetch to `127.0.0.1:8090` hangs on the Local Network Access prompt.
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
- **Recurring events.** iCal recurrence is expanded with ical.js over the next 30 days, including exceptions and moved instances. Limits: 1 MB body, 500 iterations per event, 25 events out (ical.js 2.2.1 bundles for workerd with no shims, and expands RRULE, EXDATE and moved instances across time zones there).
- **Fetch safety.** Feed URLs are user-supplied, so fetching them is guarded:
  - HTTPS only, on default ports, and no IP addresses.
  - Hostnames that are, or resolve to, private or reserved addresses are rejected. A Worker cannot pin the address it checked, so this is a first filter, not the defence against DNS rebinding; that rests on Workers' outbound requests not reaching private networks.
  - Redirects are followed manually and re-checked, at most 3.
  - 5-second timeout.
  - Errors are reported by category, never by echoing the upstream body.
  
  Workers cannot reach private ranges (checked in M3-00). An IP-literal request to a loopback, private, link-local or CGNAT address returns Cloudflare's `403` with `error code: 1003`. A public name that resolves to one returns `530` with `error code: 1016`. Both come back as responses, not exceptions, so the fetcher reports them as a blocked address rather than the feed's answer.
- **Limits.** 10 sources per org, refresh no faster than 5 minutes, 2 concurrent fetches per host.

## Auth and tenancy

- **Three kinds of caller, on separate route trees:** users with a cookie on `/api`, screens with a bearer token on `/v1/device`, agents with OAuth on `/mcp`. No credential works on another's tree.
- **Org isolation.** D1 has no row-level security, so handlers never touch the database directly. Only a `scoped(db, orgId)` repository in `packages/db` queries tenant tables. A generated test replays every tool as org B against org A's IDs and expects not-found.
- **Better Auth on Workers:**
  - Build the instance per request from the environment. The CLI (the `auth` package) generates the schema from a separate static config with an in-memory `node:sqlite` database.
  - D1 has no interactive transactions. Better Auth 1.7 detects a D1 binding and turns transactions off. Sign-in by email code, creating an org, inviting and accepting all work on D1. A failure partway through a multi-step flow can leave a partial row: a failed org creation can leave an `organization` row with no member, which no one can make active or reach (tested in M3-09).
  - Password hashing exceeds the free plan's CPU limit. Sign-in is passwordless: email code plus GitHub or Google.
  - Rate limiting goes in the database or the rate-limit binding, not memory.
  - Turn on the session cookie cache. The client must take the new cookies `setActiveOrganization` returns; with the old cache cookie the server still sees no active org.
  - In 1.7.25, creating an org and accepting an invitation change the active org without reissuing the cache cookie. An after hook in `apps/api/src/auth/options.ts` reissues it.
  - Check membership of the active org on every request. `apps/api`'s `requireOrg` reads it fresh (`findMembership` in `packages/db`) and hands handlers `scoped(db, orgId)`; the cache cookie only says which org is active.
  - Email goes through an `EmailSender` interface: Cloudflare Email Sending by default (Q3 is open), a recorder in dev and tests.
- **Agents (Milestone 4).**
  - OAuth through Better Auth's provider plugin (`@better-auth/oauth-provider`). Its source has dynamic client registration (off by default) and S256 PKCE, required for public clients; it is first run in Milestone 4. A grant is bound to one org.
  - Scopes: `content:read`, `content:draft` (the default), `content:publish` (separate, off by default, never more than the user's role allows), `screens:manage`.
  - Without publish scope, the publish tool creates a pending publish for a person to approve.
  - The tool registry is built in Milestone 3 as the CMS's own API, and the audit log is written in its dispatcher, so the MCP server and WebMCP become thin adapters. It is `packages/tools`, served at `POST /api/tools/:name` (its README has the contract); on `/api` nothing else but Better Auth changes data, and a test enumerating the routes enforces it.

## Cost at 1,000 screens

| Resource | Included in the $5 plan | Overage | Estimated use per month |
| --- | --- | --- | --- |
| Worker requests | 10M | $0.30/M | about 9.3M (sync is 8.6M) |
| Worker CPU | 30M ms | $0.02/M ms | about 20M ms |
| Durable Object duration | 400k GB-s | $12.50/M GB-s | about 270k: tight |
| Durable Object requests | 1M | $0.15/M | under 0.3M, or up to 2.5M if auto-responded pings bill at 20:1 |
| D1 writes | 50M | $1.00/M | 16 to 20M; each index a write touches counts as another row |
| D1 reads | 25B | $0.001/M | about 30M |
| D1 storage | 5 GB | $0.75/GB-month | about 1 GB with 90 days of play counts |
| R2 | 10 GB, 1M Class A, 10M Class B | $0.015/GB-month, $4.50/M A, $0.36/M B | about 50 GB, about $0.60 |
| Queues | 1M operations (about 3 per message) | $0.40/M | about 0.1M |
| Images transformations | 5,000 | $0.50 per 1,000 | only uploads without a browser |

Estimate: **$5 to $7 a month**. The included amounts and prices were checked against Cloudflare's pricing pages on 2026-11-17 (M3-00). The use column is still an estimate.

The free plan allows 100,000 Worker requests a day, so it tops out near 340 screens on a 5-minute sync (288 a day each), which is plenty for development and the public demo. Free also limits a request to 10 ms of CPU, 50 external fetches and 1,000 calls to Cloudflare services, and Queues to 10,000 operations a day.

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
- Better Auth's OAuth provider is the least-proven piece; Better Auth on D1 is proven for sign-in and organizations, but runs multi-step flows without a transaction.
- An API deploy resets any screen Durable Object that is awake at the time, and a Cloudflare incident can drop every socket at once; reconnects need jitter.
- R2 is not enabled on the account yet. It is enabled in the dashboard, and nothing that stores files can deploy until it is.
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
