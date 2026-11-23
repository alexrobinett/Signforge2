# M3-00 platform verification: results

Run on 2026-11-17 against real Cloudflare (account on the **Workers Free** plan) and on the Pi test rig. Each section answers one **verify** item from `docs/backend-plan.md`.

**Versions tested**: wrangler 4.164.0, workerd 1.20261117.1 (local tests), compatibility date 2026-11-01 with `nodejs_compat`, better-auth 1.7.25, `auth` CLI 1.7.25, kysely 0.29.9, mp4box 2.5.0, ical.js 2.2.1, Chromium 156.0.8078.79 on the Pi (Raspberry Pi OS Trixie, arm64), ffmpeg 9.0.2 for fixtures, Node 26.13.1.

**How to rerun**
- Local proofs, inside workerd: `pnpm --filter @signforge/spike-m3-platform test` (part of `pnpm test`).
- Remote proofs: create the resources below, `wrangler d1 migrations apply sf-spike-db --remote -c wrangler.remote.jsonc`, `wrangler deploy -c wrangler.remote.jsonc`, then call the routes in `src/index.ts`. `scripts/hibernation.mjs` drives the socket; `scripts/pi-lna.mjs` drives the Pi's Chromium over a DevTools tunnel.
- `wrangler.remote.jsonc` is `wrangler.jsonc` without R2 (not enabled on the account) and with the Images binding.

## Summary

| Item | Answer |
| --- | --- |
| Better Auth + organization plugin on D1, no interactive transactions | **Yes** |
| Better Auth instance per request; CLI schema from a static config | **Yes** |
| Better Auth OAuth provider: dynamic client registration and PKCE (M4) | **Yes, from source** (not run; Milestone 4) |
| Auto-response pings do not wake a hibernating Durable Object | **Yes** |
| Duration billing per wake | Billed only while awake, 128 MB, no documented minimum. **Open:** whether auto-responded pings count as billable *requests* |
| A deploy drops every screen's socket | **No** for a hibernated socket (4b); not tested for an awake object |
| mp4box.js parses an MP4 header in workerd from R2 range reads | **Yes** in workerd with local R2. Remote R2 is **blocked**: R2 is not enabled on the account |
| ical.js bundles and expands RRULE in workerd | **Yes** |
| Worker `fetch` can reach private or loopback addresses | **No** |
| D1 enforces foreign keys | **Yes**, including composite keys and RESTRICT, with no PRAGMA |
| Queue fan-out at 50 screens per batch fits the subrequest limits | **Yes** |
| Images binding free allowance | **Yes**, 5,000 unique transformations a month; the binding works on Workers Free |
| Pi's Chromium gates public-origin requests to loopback | **Yes**: they hang on a permission prompt |
| Cost table figures | Checked against the pricing pages; corrected in the plan |

## 1. Better Auth with the organization plugin on D1

**Question.** Do the organization plugin's flows (create org, invite, accept) work on D1, which has no interactive transactions?

**Answer: yes.** Better Auth 1.7 recognises a D1 binding passed directly as `database` (it checks for `batch`, `exec` and `prepare`) and uses its own D1 Kysely dialect with `transaction = false` (`@better-auth/kysely-adapter/dist/index.mjs`; that dialect's `beginTransaction` throws "D1 does not support interactive transactions"). With transactions off, the adapter runs each step as separate statements, and the whole flow completes.

**Evidence.** `GET /auth-flow` on the deployed Worker, against real D1 `sf-spike-db`. It uses email OTP sign-in, the plan's owner/editor/viewer roles via `createAccessControl`, and the session cookie cache turned on:

```json
{"ok":true,"steps":["signed in owner-mwkqoqbd@spike.test","created org 4jeisYMoeLW3EcnvlrRAR5I4mVFoWUuR","invited editor-mwkqoqbd@spike.test as editor; invitation email hook got true","signed in editor-mwkqoqbd@spike.test","accepted: member N9zxI5PYaw5NgKdHBHek8OxYYIVHPFNT role editor","editor may delete the org: false","editor may publish: true","members: editor-mwkqoqbd@spike.test:editor, owner-mwkqoqbd@spike.test:owner"]}
```

The same flow passes locally in workerd (`test/spike.test.ts`). It ran on the Free plan's 10 ms CPU limit without a CPU error, because email OTP does no password hashing.

**Found on the way.** With `session.cookieCache` on, a request that still carries the old `session_data` cookie after `setActiveOrganization` sees "No active organization", because the cache cookie is read before the database. The CMS client must take the `Set-Cookie` headers that `setActiveOrganization` returns; a browser does this anyway, but server-side callers and tests must merge them (`src/auth-flow.ts`).

**Not a problem, but note.** Without transactions, a failure in the middle of a multi-step flow (for example, creating an org and then its owner member) can leave a partial row. Better Auth doesn't compensate for this. M3-09 should test that a failed org creation leaves nothing usable behind, or accept it.

## 2. Better Auth instance per request; CLI from a static config

**Answer: yes.** `src/auth.ts` builds `betterAuth({...})` per request from `env.DB`. The CLI moved to the `auth` package; `auth.config.ts` gives it the same plugins and an in-memory `node:sqlite` database:

```
$ npx auth generate --config auth.config.ts --output migrations/0001_better_auth.sql --yes
🚀 Schema was generated successfully!
```

The output (`migrations/0001_better_auth.sql`, tables `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation`) applied cleanly to remote D1 with `wrangler d1 migrations apply`. The generated schema uses camelCase column names and `date` column types; `packages/db` will hold it as a migration like any other.

## 3. Better Auth OAuth provider: DCR and PKCE (Milestone 4)

**Answer: yes, from source; not run.** `@better-auth/oauth-provider` 1.7.25 has `allowDynamicClientRegistration` (default `false`) and `allowUnauthenticatedClientRegistration` (default `false`). It supports only `S256` for `code_challenge_method`, and PKCE "is always required for public clients" (`requirePKCE` per client, `clientRegistrationRequirePKCE` for registered confidential clients). It was not exercised end to end here; M4-01 ran it end to end on workerd with real MCP clients (`spike/m4-oauth/RESULTS.md`).

## 4. Durable Object WebSocket hibernation

### 4a. Do auto-response pings wake the object, and how is duration billed?

**Answer: pings do not wake it.** `SpikeScreen` (`src/screen.ts`) sets `setWebSocketAutoResponse(ping → pong)` and counts each construction (`constructs`) and each `webSocketMessage` (`messages`) in SQLite. `scripts/hibernation.mjs` opened one socket and sent a ping every 20 s for 4 minutes:

```
13:39:58.789Z stats at start {"instance":"2503f668","counters":{"constructs":1,"accepts":1,"messages":1},"lastAutoResponse":null}
13:40:18.803Z ping 1 -> pong in 13 ms
...
13:43:58.948Z ping 12 -> pong in 11 ms
13:43:59.151Z stats at end {"instance":"3755f7a6","counters":{"constructs":2,"accepts":1,"messages":2},"lastAutoResponse":"2026-11-17T13:43:58.941Z"}
```

Across 12 pings, `messages` rose only for the two `stats` calls, and `constructs` rose once: the final `stats` woke a new instance (the id changed). So the object hibernated, and pings were answered without running it. Pong round trip was 9–21 ms. The second run (4b) gave the same counts.

**Billing (from Cloudflare's docs; the Durable Object analytics in GraphQL returned no rows for this Free account, so duration was not measured):**
- "If a request is received matching the provided request then the auto-response will be returned without waking WebSockets in hibernation and incurring billable duration charges." ([state API](https://developers.cloudflare.com/durable-objects/api/state/))
- "Billable Duration (GB-s) charges do not accrue during hibernation." ([WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/))
- "Durable Objects that are idle and eligible for hibernation are not billed for duration, even before the runtime has hibernated them." Duration is charged for 128 MB "regardless of actual usage". ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/))
- No minimum billed time per wake is documented. A wake costs the wall time the handler runs, at 128 MB: 1 s awake = 0.125 GB-s.
- Paid includes 400,000 GB-s a month: 3.2M awake-seconds, about **107 s per screen per day** at 1,000 screens. Free includes 13,000 GB-s a day.

**Open (for M3-06).** Incoming WebSocket messages are billed as requests at 20:1. The docs do not say whether auto-responded messages count toward that. Worst case, a 60 s ping is 1,440 messages a day per screen, so 72 billed requests a day, or 2.2M a month at 1,000 screens: about $0.18 over the included 1M. That is cheap but breaks the plan's "under 0.3M" line. M3-06 should read the Durable Object request count from analytics on a paid account, and use the longest keepalive interval that holds the connection.

### 4b. Does a deploy drop a hibernated socket?

The plan splits the API and CMS Workers because "redeploying the Worker that hosts the Durable Objects drops every screen's socket". Tested: the stats reply carries a `DEPLOY_MARK` var, the socket was opened on version A, and version B was deployed while it was open:

```
13:46:37.492Z stats at start {"deployMark":"A","instance":"7c7b6736","counters":{"constructs":1,"accepts":1,"messages":1},...}
   (wrangler deployments list: version B created 2026-11-17T13:47:30.984Z)
13:47:37.556Z ping 3 -> pong in 22 ms
...
13:48:37.927Z stats at end {"deployMark":"B","instance":"17e81180","counters":{"constructs":2,"accepts":1,"messages":2},...}
13:48:37.949Z closed 1000 bye        (the client's own close)
```

**Answer: no, for a hibernated socket.** It stayed open through the deploy, and the next message ran the new version's code on the same connection. An earlier unplanned deploy during the 4a run behaved the same. Not tested: an object that is *awake* when the deploy lands. The docs say a code update resets running objects, so a screen mid-wake can still be dropped. The split stays worthwhile, since most CMS deploys then touch no screen at all, and reconnects still need jitter. But a routine API deploy does not reconnect the whole fleet.

## 5. MP4 header parsing in workerd from R2 range reads

**Answer: yes in workerd; remote R2 blocked.** `src/mp4.ts` reads with `bucket.get(key, { range })` and feeds `mp4box.createFile().appendBuffer()`. mp4box returns the next byte it needs, so a file with the moov at the end costs one read of the head and one past the mdat, not the whole body. It reads codec, profile, level, size, frame rate and bitrate, and checks them against `VIDEO_SPEC`.

**Evidence.** `test/spike.test.ts`, inside workerd 1.20261117.1 with local R2. Fixtures were made with ffmpeg 9.0.2 (`testsrc` 320x180, 2 s, libx264):

| Fixture | Result |
| --- | --- |
| High 4.2, yuv420p, 30 fps, `-movflags +faststart` | accepted, `avc1.64002a`, one 4 kB range read |
| Main, moov at the end | accepted; second read jumps past the mdat (offset > 8,000) |
| High 10, yuv420p10le, 60 fps | rejected: `profile 110 is not Baseline, Main or High`, `60 fps > 30` |

The pixel format is inferred from the profile. 10-bit and 4:2:2 H.264 need High 10 or High 4:2:2 (profile_idc 110 or 122), so allowing only 66, 77 and 100 enforces 8-bit 4:2:0.

**Blocked.** `wrangler r2 bucket create sf-spike-media` returned `Please enable R2 through the Cloudflare Dashboard. [code: 10042]`. The ticket says not to enable it, so the range reads ran against workerd's local R2 implementation, not real R2. **R2 must be enabled on the account before M3-01's first deploy** (it is free up to the included allowance but is enabled in the dashboard).

## 6. ical.js bundling and RRULE expansion in workerd

**Answer: yes.** ical.js 2.2.1 is ESM and bundles with wrangler/esbuild with no shims. `src/ical.ts` expands a weekly `America/New_York` event with an `EXDATE` and a moved instance (`RECURRENCE-ID`) over 30 days, with the plan's limits (1 MB, 500 iterations, 25 out). `GET /ical` deployed:

```json
[{"summary":"Standup","start":"2026-11-26T14:00:00.000Z"},
 {"summary":"Standup (moved)","start":"2026-12-10T19:00:00.000Z"},
 {"summary":"Standup","start":"2026-12-17T14:00:00.000Z"}]
```

3 Dec is dropped by the EXDATE, 10 Dec moved to 14:00 local, and the times carry the VTIMEZONE's EST offset. The same assertion passes in the local workerd test.

## 7. Can a Worker's fetch reach private or loopback addresses?

**Answer: no.** `GET /fetch-probe` deployed (`src/fetch-probe.ts`). Nothing reached a private network. Cloudflare answers with its own error page as a normal response; `fetch` does not throw:

| Target | Result |
| --- | --- |
| `127.0.0.1`, `localhost`, `[::1]`, `0.0.0.0`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `https://127.0.0.1` | `403`, `server: cloudflare`, body `error code: 1003` (direct IP access), within 1–2 ms |
| `localtest.me`, `127.0.0.1.nip.io`, `10.0.0.1.nip.io`, `192.168.1.1.nip.io`, `https://10.0.0.1.nip.io` (public names that resolve to private addresses) | `530`, body `error code: 1016` (origin DNS error) |
| Controls: `http://1.1.1.1/`, `https://example.com/` | `301`, `200` |

So DNS rebinding to a private address gets nothing back. The feed fetcher should treat a `403` with body `error code: 1003` or a `530` with `error code: 1016` from Cloudflare as "blocked address", not as the upstream's answer. The hostname filter stays as a first, clearer error.

## 8. D1 foreign-key enforcement

**Answer: yes, on by default.** `GET /fk` deployed (`src/fk.ts`): `PRAGMA foreign_keys` is `1` with nothing set by the app. With `FOREIGN KEY (org_id, asset_id) REFERENCES fk_assets (org_id, id) ON DELETE RESTRICT`:

| Attempt | Result |
| --- | --- |
| same-org reference | accepted |
| reference to a missing asset | `FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY` |
| orgA spot pointing at orgB's asset id | rejected, same error. The composite key does stop cross-org references |
| delete a referenced asset | rejected (`SQLITE_CONSTRAINT_TRIGGER`) |
| `batch()` with one good and one bad insert | whole batch rejected; the good row was not kept |

Local workerd D1 behaves the same (test).

## 9. Queue fan-out and subrequest limits

**Answer: yes, 50 screens per batch fits on both plans.**

**Measured limits per invocation (Free plan)**, `GET /subrequests`:

```json
{"kind":"fetch","requested":60,"completed":50,"error":"Too many subrequests by single Worker invocation. ..."}
{"kind":"d1","requested":1100,"completed":1000,"error":"Too many API requests by single Worker invocation. ..."}
{"kind":"do","requested":1100,"completed":1000,"error":"Too many API requests by single Worker invocation. ..."}
```

External `fetch` is capped at 50 on Free. Calls to D1 **and Durable Object RPC** share a separate 1,000 cap ("subrequests to internal services"). On Paid, both default to 10,000 and can be raised with `limits.subrequests` ([limits](https://developers.cloudflare.com/workers/platform/limits/)). R2 calls count with D1 per the docs; that was not measured, because R2 is blocked.

**Fan-out.** `GET /fanout?n=150` sent 150 messages; the consumer (`max_batch_size: 50`) did one D1 insert and one Durable Object RPC per message:

```json
{"run":"f150","screens":{"n":150},"batches":[
 {"batch_size":50,"subrequests":100,"error":null},
 {"batch_size":50,"subrequests":100,"error":null},
 {"batch_size":50,"subrequests":100,"error":null}]}
```

With R2's write added, it is 150 internal calls per batch, well under 1,000. Queue limits ([docs](https://developers.cloudflare.com/queues/platform/limits/)): max batch 100 messages, 128 KB per message, 15 min consumer wall time, 30 s CPU by default; on Free, retention is fixed at 24 h and 10,000 operations a day (a delivered message is about 3 operations).

**Found on the way.** The serial consumer took about 13–25 s per batch of 50. Each batch took two internal calls per screen, one at a time, and created 50 new Durable Objects. At 1,000 screens, run serially, that is minutes. M3-18 should write the batch's D1 rows in one `db.batch()` and make the Durable Object calls concurrently.

## 10. Images binding free allowance

**Answer: yes.** The Images binding works on Workers Free. `POST /images` with a 640x360 PNG:

```json
{"info":{"fileSize":2607,"width":640,"height":360,"format":"image/png"},"outType":"image/webp","outBytes":4324}
```

Allowance ([Images pricing](https://developers.cloudflare.com/images/pricing/)): 5,000 unique transformations a month on Free; beyond it, new transformations fail with error `9422` and nothing is charged. Paid: 5,000 included, then $0.50 per 1,000. Binding transformations count as Images Transformed; `.info()` is not billed.

## 11. Pi Chromium: public origin to loopback

**Answer: yes, it is gated.** `scripts/pi-lna.mjs` opened `https://sf-spike-m3.<sub>.workers.dev/lna` in the kiosk's Chromium 156 over DevTools, which fetched the device's player port with `mode: 'no-cors'`:

```json
{"permission":"prompt","loopbackPermission":"prompt",
 "http://127.0.0.1:8090/":"blocked: TimeoutError: signal timed out after 8001 ms",
 "http://localhost:8090/":"blocked: TimeoutError: signal timed out after 8001 ms"}
```

The requests hang on a Local Network Access prompt that a kiosk cannot answer. Serving the player from `http://127.0.0.1:8090`, as the plan says, stands. The tab was closed after the run.

## 12. Cost table

Figures were checked against the pricing pages on 2026-11-17 ([Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Queues](https://developers.cloudflare.com/workers/platform/pricing/#queues)):

| Resource | Free | Paid ($5/month) included | Paid overage |
| --- | --- | --- | --- |
| Worker requests | 100,000/day | 10M/month | $0.30/M |
| Worker CPU | 10 ms per invocation | 30M ms/month | $0.02/M ms |
| Subrequests per invocation | 50 external, 1,000 internal | 10,000 (configurable) | — |
| DO requests | 100,000/day | 1M/month | $0.15/M |
| DO duration | 13,000 GB-s/day | 400,000 GB-s/month | $12.50/M GB-s |
| DO storage (SQLite) | 5 GB | 5 GB-month | $0.20/GB-month |
| D1 rows read | 5M/day | 25B/month | $0.001/M |
| D1 rows written | 100,000/day | 50M/month | $1.00/M |
| D1 storage | 5 GB | 5 GB | $0.75/GB-month |
| R2 storage | 10 GB-month | 10 GB-month | $0.015/GB-month |
| R2 Class A / B | 1M / 10M a month | same | $4.50/M, $0.36/M |
| Queues | 10,000 ops/day | 1M ops/month | $0.40/M |
| Images transformations | 5,000/month | 5,000/month | $0.50 per 1,000 |

Changes to the plan: D1 counts a write to each index the row touches as another row written, and the Queues line was missing. The free-plan ceiling of about 340 screens holds: 100,000 requests a day / 288 syncs a screen = 347.

## Resources created and deleted

| Resource | Created | Deleted |
| --- | --- | --- |
| Worker `sf-spike-m3` (with its `SpikeScreen` Durable Object namespace) | yes | yes (after removing it as the queue consumer) |
| D1 database `sf-spike-db` | yes | yes |
| Queue `sf-spike-fanout` | yes | yes |
| R2 bucket `sf-spike-media` | **no**: blocked, R2 not enabled (10042) | — |
| Account workers.dev subdomain `signforge-spike-m3-platform` | registered by `wrangler deploy` because the account had none | **not deleted**: an account setting, not a resource. Rename it in the dashboard (Workers → Subdomain) when choosing the real one |
