# M3-03 Device auth and content routes

Status: done (branch t3/device-auth-content-routes)  ·  Size: M  ·  Depends on: M3-02

## Goal

Serve a screen its manifest, files and data snapshots from the Worker, authenticated by its credential.

## Read first

- docs/backend-plan.md#screens (credential, route table)
- packages/player/src/store.ts, data.ts (what the player fetches)

## Scope

- Device bearer middleware: parse `sfd_<screenId>.<secret>`, compare the SHA-256 against `screen_credentials`, reject revoked. Constant-time compare.
- `GET /v1/device/manifest.json`: the screen's desired manifest from R2, ETag = manifest id, 304 on `If-None-Match`.
- `GET /v1/device/blobs/:sha256`: streamed from R2, `cache-control: immutable`, only blobs listed in the screen's current or previous manifest.
- `GET /v1/device/data/:id.json`: latest snapshot for a source the screen's manifest lists.
- A script that creates a screen and prints a credential, for the Pi until pairing exists.
- Use the device API types in `packages/contract`; ids follow `ID_PATTERN`.
- Finding a screen from its credential happens before the org is known: add one narrow lookup inside `packages/db` for it (see `packages/db/README.md`); never export the tables.

## Out of scope

- Pairing, sync, sockets.

## Done when

- [x] Tests cover: no token, bad token, revoked token, another org's blob, 304 path.
- [x] With `curl` and a seeded credential, the three routes return what `dist/content` holds.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Notes

- Code: `apps/api/src/device/` (credential, bearer middleware, routes), `apps/api/src/r2.ts` (R2 keys), `packages/db/src/device.ts` (`findDeviceScreen`, the one lookup by screen id alone). Tests: `apps/api/test/device.test.ts`, `packages/db/test/device.test.ts`.
- Route trees: `/v1/device` is its own Hono app with its own middleware, mounted at the root; nothing authenticates at the root. The middleware reads only `Authorization: Bearer`, so a cookie does nothing there, and no other tree reads that header. A test sends a valid credential to `/api/...` and `/mcp` and gets 404.
- Every auth failure is the same 401 `{"error":"unauthorized"}`. The secret is hashed even when the screen is unknown, and compared with `crypto.subtle.timingSafeEqual` against every live credential.
- "Previous manifest": a new `screens.previous_manifest_id` (migration `0001`), set by `scoped(...).screens.setDesiredManifest()`, which M3-04 and later publishes should call. The data route accepts sources from either manifest too.
- Manifest summaries (file list, base template HTML, data sources) are cached per isolate by R2 key. Safe because a manifest's key includes its content hash.
- Blobs come from `o/<org>/b/<sha>`; `sys/b/<sha>` is tried only for the HTML of a `base/` template in the manifest. A file another org holds is never reachable, even if a manifest named it.
- CORS: the device tree allows any origin with `authorization` and `if-none-match` and exposes `ETag`. The player runs on `http://127.0.0.1:8090` and needs this for M3-05. No cookies are involved, so `*` is safe.
- `last_used_at` is not updated: that would be a D1 write on every blob request. Sync (M3-07) is the place for it.
- The test screen goes in org `dev` (any id with `--org`): there is no organizations table until M3-09, and `screens.org_id` is NOT NULL.
- Fixed in passing: `test/health.test.ts` expected manifest schema 1; it now reads `MANIFEST_SCHEMA`.

### Demo against `wrangler dev`

`dist/content` built from `examples/stress` (it has data sources; `sh scripts/stress-media.sh` first). The weather snapshot is a hand-written sample. The credential stays in a file and is never printed.

```sh
pnpm exec tsx packages/cli/src/sf.ts build examples/stress --out dist/content
cd apps/api
pnpm dev:screen --content ../../dist/content --data /path/to/data > cred.txt   # stdout is only the credential
#   screen scr_hmulwlhecj4ph7nia2vwn55g in org dev
#   manifest 99d4ba31063fe3cd and 18 files loaded into local R2
#   data source weather: snapshot loaded
pnpm exec wrangler dev --port 8787 &
CRED=$(cat cred.txt); API=http://127.0.0.1:8787/v1/device
```

```text
$ curl -sD - -o m.json -H "Authorization: Bearer $CRED" $API/manifest.json
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-cache
ETag: "99d4ba31063fe3cd7de9f9acfe882fb34823fe94a55686e858e11d02d09330eb"
$ cmp m.json ../../dist/content/manifest.json && echo identical
identical

$ curl -sD - -o /dev/null -H "Authorization: Bearer $CRED" -H 'If-None-Match: "99d4ba31…30eb"' $API/manifest.json
HTTP/1.1 304 Not Modified
ETag: "99d4ba31063fe3cd7de9f9acfe882fb34823fe94a55686e858e11d02d09330eb"

$ curl -sD - -o b.bin -H "Authorization: Bearer $CRED" $API/blobs/3280490f2c962ba8e241b1b6593a3b400df88a2f9f1d0b50fc7442d9029d4a04
HTTP/1.1 200 OK
Content-Length: 639
Content-Type: image/svg+xml
Cache-Control: public, max-age=31536000, immutable
$ # every file the manifest lists, compared with dist/content/blobs: 18 of 18 byte-identical (largest 9,593,301 bytes)

$ curl -s -H "Authorization: Bearer $CRED" $API/data/weather.json
{"id":"weather","fetchedAt":"2026-11-17T13:55:48.728Z","data":{"current":{"temperature_2m":61.3,"weather_code":2,"is_day":1},"daily":{"temperature_2m_max":[68.4],"temperature_2m_min":[49.1]}}}

$ curl -s -w ' %{http_code}' -H "Authorization: Bearer $CRED" $API/data/unlisted.json
{"error":"data source not found"} 404
$ curl -s -w ' %{http_code}' -H "Authorization: Bearer $CRED" $API/blobs/39c37180…19fb   # in dist/content/blobs from an older build, not in the manifest
{"error":"file not found"} 404
$ curl -s -w ' %{http_code}' $API/manifest.json
{"error":"unauthorized"} 401
$ curl -s -w ' %{http_code}' -H "Authorization: Bearer ${CRED%.*}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" $API/manifest.json
{"error":"unauthorized"} 401
```
