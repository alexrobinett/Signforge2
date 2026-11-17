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
packages/media       image renditions in the browser (createImageBitmap, OffscreenCanvas), hashing, and the image-header reader the server checks with
packages/media-check MP4 header check against VIDEO_SPEC, shared by browser and Worker
packages/feeds       iCal and RSS normalising, ported from datad.py with fixtures
packages/tools       one registry of operations (zod input, scope, role, handler); the CMS, MCP and WebMCP all call it
```

Two Workers on one hostname, so cookies stay same-origin. They are split because CMS deploys happen often, and a deploy of the Worker that hosts the Durable Objects resets any that are awake. A hibernated screen socket survives a deploy and the next message runs the new code (measured in M3-00), so an API deploy does not reconnect the whole fleet, but a screen mid-wake can still drop. The API Worker also hosts each player release as a content-addressed bundle. The screen does not load the player from Cloudflare: see **Where the player runs**.

## Data model (D1)

Text IDs and integer-millisecond timestamps. Every tenant table has `org_id NOT NULL`, its indexes lead with it, and foreign keys are composite `(org_id, id)` so a row cannot point into another org. D1 enforces foreign keys by default (`PRAGMA foreign_keys` is 1): a cross-org reference, a missing parent and deleting a restricted parent are all rejected, and a `batch()` with one bad row writes nothing. The schema is `packages/db/src/schema.ts`; its README lists the few deliberate exceptions.

| Table | Key columns |
| --- | --- |
| Better Auth's own: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` | `organization` adds quotas. Roles: owner, editor, viewer. |
| `org_settings` | one row per org: the default playlist (see Publishing) |
| `screens` | name, timezone, locale, orientation, `display_hours_json`, `desired_manifest_id`, `previous_manifest_id` (whose files stay servable while a screen switches), `reported_manifest_id`, last seen, player version, status |
| `screen_groups`, `screen_group_members` | |
| `screen_credentials` | screen, secret hash, last used, revoked at |
| `pairing_codes` | code, poll-token hash, expires at, claimed org and screen, collected credential |
| `assets`, `asset_renditions` | kind, sha256, type, size, width, height, duration, status (pending, verified, rejected); landscape and portrait renditions |
| `templates`, `template_versions` | null org means a base template; version, manifest, bundle sha, status (draft, approved, retired), check report |
| `spots` | kind, template version, data, asset map, bindings, duration, plus the image, video or URL fields; the published version (see Publishing) |
| `playlists`, `playlist_items` | transition; ordered spots; the published version, with its items |
| `schedule_entries` | playlist, priority, target, dates, days, window; the published version |
| `publishes`, `publish_screens` | status, publish at, actor; which manifest each screen got. Rollout status is a join against `screens.reported_manifest_id`. |
| `data_sources`, `data_snapshots` | format, encrypted URL (a private calendar URL is a secret), refresh, next poll at, ETag, failures; latest snapshot, at most 64 kB |
| `audit_log` | when, actor kind (user, agent, device, system), actor, action, target, detail |
| `idempotency_keys` | key, action, input hash, the first result: a retried creation returns it and writes nothing |
| `play_counts` | screen, hour, spot: plays and milliseconds |
| `brand_kits` | name, colours, shape, display and body font (catalogue ids), logo assets. Keyed `(org_id, id)` with server-made ids (see Brand kits) |
| `brand_assignments` | which kit the org (its default), a group or a screen uses; at most one per target |

## Publishing

1. **Compile.** `loadOrg` (`packages/tools/src/publishing.ts`) reads the org's data in one round of about a dozen parallel queries, promotes drafts (below), and `packages/compiler` builds each target screen's manifest from the published graph. A manifest's ID is the hash of its body, so a screen whose content did not change is skipped. A screen that cannot compile keeps its manifest and is reported; the others publish.
2. **Fan out** through a Queue, 50 screens per batch. Per screen: one R2 write, one D1 row, one call to its Durable Object, so 150 calls per batch. D1, R2 and Durable Object calls share the per-invocation limit on calls to Cloudflare services: 1,000 on Free (measured), 10,000 by default on Paid. External `fetch` is limited separately, to 50 on Free. Write a batch's D1 rows in one `batch()` and make the Durable Object calls concurrently: done one at a time, a batch of 50 took 13 to 25 seconds.
3. **Timed publish.** A per-org Durable Object holds the alarm and serialises publishes for that org. It wakes only when a publish is due.

**Drafts.** One broken or unfinished spot must not block every screen. Spots, playlists and schedule entries each have a draft and a published version: the row's columns are the draft, which every edit changes, and `published_json` is a copy of the draft's content (a playlist's with its items) taken when a publish promoted it. A publish checks each draft that differs from its published version, in order: spots, then playlists (every item must be a published spot), then schedule entries (their playlist must be published). It checks a draft by compiling a probe screen that plays it, so the problems are the ones a screen would get. A new or changed spot may use only an approved template version; one already published with a version that was since retired keeps it. A draft that passes is published; one that fails keeps its published version, if it has one, and is reported for the CMS to show. The compiler then checks only what each screen reaches. Deleting a row deletes its published version too, so the tools that delete spots and playlists (M3-16, M3-17) must refuse one a published playlist or entry still uses; assets already count a published spot's use (`assets.usage`).

**Default playlist.** Owner decision, taken by the simplest sound option: it is an org setting, in `org_settings`, one row per org with a composite foreign key to the org's playlist, so it cannot point into another org or at a deleted playlist. Not a column on Better Auth's `organization` table, which is Better Auth's and outside the `scoped` repositories, and not per screen group, which would need a rule for a screen in two groups. A screen or group that needs other content uses a schedule entry. Changing it takes effect at the next publish, like any content change; until it has a published version, no screen can publish.

**Brand kits** (M3-38). An org keeps several kits; one is its default. A screen uses its own kit, else its groups' kit, else the default (`chooseBrandKit` in `packages/compiler`); a screen in two groups that chose different kits, with no kit of its own, is a publish problem for that screen only. The compiler freezes the chosen kit into the manifest's `brand` and resolves token defaults (`"$brand.accent"`) into plain field values, so a screen never sees a token; with no kit, tokens take `DEFAULT_BRAND_COLORS` and the manifest has no `brand`. Kits have no drafts: a publish reads each kit as it is then, and an edit changes nothing on screens until the next publish (each kit view lists the screens it will reach). `onPrimary` and `onAccent` left unset are derived at publish as black or white, whichever reaches 4.5:1; pairs below 4.5:1 are warnings, not problems. A logo is its asset's rendition for the screen's orientation, SVG or PNG. Fonts come from a catalogue with an owner, like templates (`FONTS` in `packages/compiler/src/fonts.ts`): `base/<id>` holds the curated OFL fonts, and org uploads will use `<orgId>/<id>`. The catalogue's WOFF2 files are not added yet, so a kit's font is left out of the manifest until they are; they will be base blobs (`sys/b/`), at most 150 kB per family.

Kit ids are always made by the server (`bk_...`) and the table is keyed `(org_id, id)`. The older tenant tables take caller-chosen ids under a global primary key, so two orgs can collide on one; brand kits do not repeat that.

**Uploads**
- **Images** are scaled in the browser at upload with `createImageBitmap` and `OffscreenCanvas`, using the same cover-the-screen rule as `sf build`, into a landscape and a portrait rendition. The Worker checks the dimensions. Uploads with no browser (API, MCP) fall back to the Cloudflare Images binding, which works on Workers Free. It includes 5,000 unique transformations a month on both plans, then $0.50 per 1,000 on Paid; on Free, transformations past the allowance fail with error 9422 rather than charging.
- **Video** is checked by `packages/media-check` reading the MP4 header against `VIDEO_SPEC`: in the browser before upload, and again in the Worker over R2 range reads, because the client cannot be trusted. mp4box.js runs in workerd. Fed from R2 range reads, it fetches only the boxes it needs: one read when the moov comes first, and one more jump past the mdat when it comes last. The pixel format follows from the H.264 profile: allowing only Baseline, Main and High (profile_idc 66, 77, 100) rules out 10-bit and 4:2:2.
- **Transport.** Files go straight to R2 by presigned PUT, multipart for video. The URL signs the content type and length and writes to `up/<org>/<asset>/<sha256>`, never to a content-addressed key. A finalize call re-hashes the file, checks its type and size against the screen box, and moves it to `o/<org>/b/<sha256>`; a file that fails is deleted. Presigned PUT is verified against `wrangler dev`'s local S3 API, not yet against R2 on the account (R2 is not enabled there). Deploying needs an R2 API token's S3 keys as secrets, a CORS rule on the bucket allowing PUT with `content-type` from the CMS origin, and a lifecycle rule expiring `up/` after a day (see `apps/api/src/uploads.ts`).

**Templates** are not built in a Worker. The server's checks on an uploaded bundle are a lint, not a boundary: the bundle contains the SDK, whose own `parent.postMessage` would trip the code denylist, so that list runs on the author's sources, uploaded alongside the bundle; and string checks can be evaded. The sandbox and its policy are the guarantee.

**Template keys** are namespaced by owner (`base/` or the org id) so a base template and an org template with the same id and version cannot collide in a manifest. `sf template push <dir> --api <url> [--org <id>] [--approve]` builds locally or in CI with `buildTemplate` and uploads the bundle (to `sys/b/` for a base template, the org's prefix otherwise) and the author's sources through `/admin`. The `register_template_version` tool then repeats the build's checks (`checkTemplateBundle`: manifest, forbidden CSS, size, network references on the bundle; forbidden code on the sources), stores the report on the version, and refuses a failure with each reason. Versions are immutable; a new one is a draft. Base templates belong to no org: their tools run from the platform registry with `platform(db)` and are audited in `platform_audit_log`. Building agent-submitted templates on a CI runner is Milestone 4.

**Deploying.** After applying migrations, seed the base templates: `SF_ADMIN_TOKEN=<ADMIN_TOKEN> pnpm seed:templates --api <url>`. It pushes every template in `templates/` as an approved base template, and the brand font catalogue (`fonts/`) to `sys/b/` (also `sf fonts push`). It is safe to run on every deploy: an unchanged template changes nothing, a retired one stays retired, and an edited template whose version was not bumped is refused.

**R2 layout**

```
o/<org>/b/<sha256>                    assets and template bundles
sys/b/<sha256>                        base templates
o/<org>/m/<screen>/<manifestId>.json  manifests
up/<org>/<asset>/<sha256>             asset uploads until finalize checks them
```

The per-org prefix keeps one org from probing whether another holds a file, and makes cleanup simple.

## Screens

**Pairing** (M3-08: `apps/api/src/device/pairing.ts`, `packages/db/src/pairing.ts`, the `claim_screen` tool)
1. The screen calls `pair/start` and receives a 6-character code (32 letters and digits without 0/O or 1/I, about a billion codes) and a secret poll token, valid 15 minutes. Only the token's hash is stored.
2. It shows the code and polls every 5 seconds.
3. A member (editor or owner) claims the code with `claim_screen`, giving name, time zone, orientation and optionally locale and display hours; the CMS form is M3-11, and groups are set after with the group tools. The claim creates the screen and binds the code in one batch, which fails, writing nothing, if another claim got the code first or it expired; the loser gets the same `not_found` as for a code that was never open (`refuseFailedCommit`). An unknown, expired and claimed code get the same answer.
4. The next poll mints the credential, stores its hash for the claimed screen and records it on the code in one batch, and returns it. A reply can be lost, so a repeat poll mints a fresh credential and replaces the earlier one while that one is unused (device auth records a credential's first use in `last_used_at`) and the first collect was under 15 minutes ago; after that a poll gets `expired`. At most one credential from a code is live.

Rate limits (Workers rate limiting bindings, per Cloudflare location, a minute's window): `pair/start` 10 per address, `pair/poll` 600 per address (a shop of screens behind one address polls 12 times a minute each), and claims 10 per member and 10 per address, counted right or wrong, before the code is looked at (`apps/api/test/pairing.test.ts`). With 10 codes open at once, 10 guesses a minute find one about once in 20 years per member and address (10^9 / 100 minutes); many accounts on one address share its 10, so guessing faster takes many addresses as well as many accounts, and each guess needs a signed-in member. A claim over the limit is `429 rate_limited`. Codes past their time are swept by the next `pair/start`, claimed ones uncollected after a day.

For zero-touch installs, the CMS mints a credential that the image script pre-seeds.

**Credential**
- An opaque token, `sfd_<screenId>.<32 random bytes>`, stored as a SHA-256. It is not a JWT.
- Revoking is one row update, then the Durable Object closes the socket.
- Pairing gives a screen its credential. For local work without a screen, `pnpm --filter @signforge/api dev:screen [--content dist/content]` still creates a screen in local D1, loads a build into local R2, and prints a credential.
- Until the CMS publishes, `sf push <out-dir> --screen <id> --api <url>` uploads an `sf build` output and makes it the screen's desired manifest. It uploads through a temporary `/admin` tree guarded by the `ADMIN_TOKEN` deploy secret (off when unset). The last step, making the manifest desired, runs the `publish_manifest_to_screen` tool through the dispatcher and is audited as the system actor `sf-push`. `/admin` goes once assets upload through the CMS (M3-14) and agents hold OAuth grants (Milestone 4).

**What replaces `/admin`, and when.** No new routes go under `/admin`; each group has a replacement and goes with it:

| Routes | Used by | Replaced by | When |
| --- | --- | --- | --- |
| `/admin/screens/:screen/*` (missing, blobs, manifest) | `sf push` | Publishing from the CMS through the compiler and the tool registry, with the nudge socket and sync carrying it to the screen. Pairing (M3-08) replaces `dev:screen` credentials. | M3-18 (instant publish), with M3-06 to M3-08 before it |
| `/admin/orgs/:org/*` (blobs, templates) | `sf template push --org` | The same tools over `/mcp` with an OAuth grant, for agents and the CLI; the CMS already pushes assets through `/api` (M3-14). | Milestone 4 |
| `/admin/base/*` (blobs, templates) | `pnpm seed:templates` on deploy | A deploy step in each environment's pipeline that runs the platform registry with a deploy credential, not a long-lived `ADMIN_TOKEN` on a public route. | M3-24 (environments) |

Until then the tree answers 404 wherever `ADMIN_TOKEN` is unset.

**The screen's Durable Object** holds the desired and reported manifest IDs and one hibernating WebSocket.
- Keepalive pings get an automatic reply (`setWebSocketAutoResponse`) without waking it or billing duration. Whether those pings count as billed requests (incoming messages bill at 20:1) is not documented: at a 60-second ping and 1,000 screens the worst case is 2.2M requests a month, about $0.18 over the allowance. The player pings every 50 seconds, under the usual 100-second proxy and NAT idle timeouts, and treats a ping without a pong in 10 seconds as a dead connection. The billed count is still to be read from analytics on a paid account (M3-06 could not deploy); lengthen the ping if it shows pings are billed and connections hold.
- Server to screen: new manifest, command, revoked.
- Screen to server: applied only, written through to D1. The CMS reads rollout from D1 and never calls 1,000 Durable Objects.
- **Socket ticket.** `GET /v1/device/ws?ticket=` takes a ticket, not the credential, since a browser cannot put a header on a WebSocket and URLs end up in logs. Sync issues it: `<screenId>.<credentialId>.<expiresMs>.<HMAC-SHA256 under AUTH_SECRET>`, good for 60 seconds. The route checks it and that its credential is still live, then hands the socket to the object tagged with that credential, so revoking a credential closes exactly its sockets.
- **Who tells the object.** The tool dispatcher, after a change commits: `publish_manifest_to_screen` sends `manifest`, `revoke_screen_credential` sends `revoked` and closes. The object writes `applied` to `screens.reported_manifest_id` through the org's scope.

**Sync.** `POST /v1/device/sync`, every 5 minutes with jitter, the interval set by the server.
- **The screen sends:** player version and the manifest schemas and frame protocols it plays, the active manifest (and the one it fell back from), files missing, display state and power methods, its clock and offset, snapshot versions held, data refused per source, and hourly play counts.
- **The server returns:** the desired manifest ID, any changed data snapshots, a short-lived socket ticket, the server time and commands. The server time is there because a Pi has no battery-backed clock. `reload` is sent while the screen's player cannot play the desired manifest's schema or a template's protocol.
- **What it stores** (`apps/api/src/device/sync.ts`, `scoped(...).screens.sync`): on the screen row, the last-seen time, the player version, the heartbeat (`heartbeat_json`, with the drift between server and device clocks) and the play count `(epoch, seq)`; and the counts, added to `play_counts` in the same D1 batch unless the seq is already stored in its epoch. The repeat check is in the SQL, so two copies of one request racing count once. Play counts carry no manifest: which manifest a screen had when is in its publish history.
- **D1 writes per sync**, measured in `packages/db/test/device.test.ts` from D1's `rows_written`: 1 for a sync with no counts (the screen row; none of its indexed columns change), plus 3 for each count of a new (hour, spot) row (the row, its key and the org-hour index) or 1 for one added to an existing row. The screen sends an hour's counts once the hour has ended, so each (hour, spot) row is written once: at 1,000 screens on a 5-minute sync, 8.6M writes a month for heartbeats plus about 3 per spot played per screen per hour (10 spots: 21.6M), about 30M in all against the 50M included. Sending the running hour on every sync would cost twelve times as much for counts.

| Route | Purpose |
| --- | --- |
| `POST /v1/device/pair/start` | Get a code and poll token (no credential; rate limited) |
| `POST /v1/device/pair/poll` | `{ pollToken }`: waiting, expired, or the credential (a fresh one on a repeat poll until the first is used; no credential; rate limited) |
| `GET /v1/device/manifest.json` | Desired manifest. Its ETag is the manifest ID. The player sends `If-None-Match` itself, since it fetches with `cache: 'no-store'`, so an unchanged manifest is a 304. |
| `GET /v1/device/blobs/:sha256` | File from R2, cached forever but `private` (it needs the credential, so no shared cache keeps it). Only files the screen's desired or previous manifest lists, from its own org's prefix (or `sys/b/` for a base template). |
| `GET /v1/device/data/:id.json` | Snapshot of one source. Only sources the screen's manifest lists. The player takes snapshots from the sync; this route is for debugging and tools. |
| `POST /v1/device/sync` | Heartbeat, play counts, snapshot changes |
| `GET /v1/device/ws?ticket=` | Nudge socket |

The device API's request and response shapes are in `packages/contract` (device API section). Changes the player needs, beyond pointing its content base at `/v1/device`:
- Send the bearer credential, and `If-None-Match` on the manifest; on a 304, still check the cached manifest for missing files. Done in M3-05: `?content=<api>/v1/device` in the kiosk URL, the credential from the supervisor's `GET /credential`.
- Replace the per-source data poll with snapshots delivered on sync. Done in M3-07: from the API the player fetches no source itself.
- Count plays per UTC hour, persist the counts, and send them with a batch number until acknowledged. Done in M3-07.
- Treat a 401 as revoked, not offline: wipe what it holds and show a pairing code (open question 2, the default). Done in M3-08.
- Act on socket commands at once, including a display override.
- Correct its clock from server time. Done in M3-07.

Its service worker already leaves `/v1/` alone, so device API responses are never stored in the shell cache.

**Where the player runs.** The player is served by the device, from `http://127.0.0.1:8090`, and the supervisor updates it. Each sync reports the player version; the server names the release a screen should run, and the supervisor downloads, verifies by hash, and swaps it in between plays. Three reasons, all from the code as it stands:
- The page talks to the supervisor on loopback. From a public origin that becomes a cross-origin request to the local network, which Chromium gates behind a permission prompt a kiosk cannot answer. Checked on the Pi's Chromium 156: from a public https page, a fetch to `127.0.0.1:8090` hangs on the Local Network Access prompt.
- Secrets stay off URLs. The screen's credential and the supervisor's token are handed to the page by the supervisor over loopback, only to the player's own origin. A template frame can read its parent's URL, so nothing secret goes there.
- The same local origin is what makes a web-page spot on a public site unable to reach the device: Chromium blocks public pages from requesting loopback.

**Clock.** A Pi has no battery-backed clock, and the schedule and display hours run on it. The player keeps the offset from the last sync's server time, persists it, and uses corrected time everywhere it reads the clock. Large drift is reported. The rules, including what a screen does when it cannot trust its clock, are in `architecture.md` (Player, Clock); a sync's `seq` carries an `epoch` so a screen that lost its counter is not ignored.

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
- **Files for users.** `GET /api/blobs/:sha256` serves a file the session's org can see, for the editor preview: from the org's own R2 prefix, or from `sys/b/` only when the hash is a base template version's bundle (`templates.versions.baseBundle` in the scoped repository). `private`, cached forever. Template HTML and SVG are org markup on the CMS's origin, so every blob response here and on `/v1/device/blobs` carries `nosniff`, a `sandbox; default-src 'none'` CSP, and `content-disposition: attachment` for markup types (`blobHeaders` in `apps/api/src/r2.ts`): opening one never runs its script with the session. The preview and the player fetch the bytes, never navigate to them. `test/blobs.test.ts` checks one org cannot fetch another's file.
  - Email goes through an `EmailSender` interface: Cloudflare Email Sending by default (Q3 is open), a recorder in dev and tests.
- **Agents (Milestone 4).**
  - OAuth through Better Auth's provider plugin (`@better-auth/oauth-provider`). Its source has dynamic client registration (off by default) and S256 PKCE, required for public clients; it is first run in Milestone 4. A grant is bound to one org.
  - Scopes: `content:read`, `content:draft` (the default), `content:publish` (separate, off by default, never more than the user's role allows), `screens:manage`.
  - Without publish scope, the publish tool creates a pending publish for a person to approve.
  - The tool registry is built in Milestone 3 as the CMS's own API, and the audit log is written in its dispatcher, so the MCP server and WebMCP become thin adapters. Tools stage their writes; the dispatcher runs them with the audit row in one atomic D1 batch, so no change lands unrecorded, and creating tools take an idempotency key. It is `packages/tools`, served at `POST /api/tools/:name` (its README has the contract); on `/api` nothing else but Better Auth changes data, and a test enumerating the routes enforces it.

## Cost at 1,000 screens

| Resource | Included in the $5 plan | Overage | Estimated use per month |
| --- | --- | --- | --- |
| Worker requests | 10M | $0.30/M | about 9.3M (sync is 8.6M) |
| Worker CPU | 30M ms | $0.02/M ms | about 20M ms |
| Durable Object duration | 400k GB-s | $12.50/M GB-s | about 270k: tight |
| Durable Object requests | 1M | $0.15/M | under 0.3M, or up to 2.5M if auto-responded pings bill at 20:1 |
| D1 writes | 50M | $1.00/M | about 30M (measured per sync, see Screens: Sync); each index a write touches counts as another row |
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
- A takeover ends at an absolute instant (`ScheduleEntry.endsAt`, manifest schema 3). A schema-2 player ignores it, so a takeover published to a screen still on schema 2 must also be compiled into a dated window.

## Open questions

1. Does a timed publish ship content as it was when scheduled, or as it is when the time comes? The plan assumes the latter.
2. Should a revoked screen wipe its cache and show a pairing code, or keep playing what it has? Built with the default, wipe and show a code (M3-08).
3. Is passwordless sign-in (email code, GitHub, Google) acceptable? Which email service?
4. Are 5-minute data freshness and roughly 10-minute offline detection acceptable?
5. Are hourly play counts enough, or is per-play proof of play needed?
6. Per-org limits on storage, screens and data sources, given there is no billing?
7. Can editors publish, or only owners? Can an agent with publish scope go live without a person approving?
8. ~~Should the player be served from Cloudflare and update itself, or be pinned in the Pi image?~~ Decided by the code: served by the device and updated by the supervisor (see **Where the player runs**). Confirm.
