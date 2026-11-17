# M3-04 `sf push`: publish from the CLI

Status: done (branch t3/m3-04-sf-push-publish)  ·  Size: S  ·  Depends on: M3-03

## Goal

Upload what `sf build` produces to the API, so the Pi can play real content from Cloudflare before the CMS exists.

## Read first

- packages/cli/src/sf.ts
- docs/backend-plan.md#publishing (R2 layout)

## Scope

- `sf push <out-dir> --screen <id>`: upload blobs missing from R2 (ask the API which exist), upload the manifest, set it as the screen's desired manifest.
- An admin route protected by a deploy secret, removed or replaced once M3-12 exists.
- R2 keys follow the plan's layout.

## Out of scope

- The server compiler (M3-13).

## Done when

- [x] Pushing twice uploads no blobs the second time.
- [x] After a push, `GET /v1/device/manifest.json` returns the pushed manifest.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Notes

- Code: `apps/api/src/admin/` (the `/admin` tree and its auth), `packages/cli/src/push.ts` (the client, no Node imports), `sf push` in `packages/cli/src/sf.ts`. Tests: `apps/api/test/admin.test.ts`, which drives the real client against the routes inside workerd and reads the result back through `/v1/device`.
- Protocol, all under `/admin` with `Authorization: Bearer <ADMIN_TOKEN>`:
  1. `POST /screens/:screen/missing` with the manifest: validates it, returns the files R2 lacks, each with its scope (`org` or `base`).
  2. `PUT /screens/:screen/blobs/:sha` (org prefix) or `PUT /base/blobs/:sha` (`sys/b/`): the body's SHA-256 must equal `:sha`, else 400 and nothing is stored. The content type is kept as R2 metadata.
  3. `PUT /screens/:screen/manifest`: `validateManifest` (from `packages/player-core`, the same check the compiler and player run), then the id must be the hash of the body (`manifestIdInput`), then every file must already be in R2 (409 with the list otherwise). The body is stored byte for byte at `o/<org>/m/<screen>/<id>.json` and set with `setDesiredManifest`. Re-pushing the same id changes nothing, so `previous_manifest_id` is kept.
- Which prefix: a file is a base template's HTML if a `base/` template in the manifest names it, and goes to `sys/b/`; everything else goes to `o/<org>/b/`. The server decides from the manifest, the same rule the device blob route reads with.
- The screen's org comes from `findDeviceScreen`, so `sf push` needs only the screen id. No migration and no change to `packages/db` code.
- Auth: `ADMIN_TOKEN` is a Worker secret, locally in `apps/api/.dev.vars` (gitignored; `.dev.vars.example` documents it). Unset or empty, the whole tree is 404. The presented and expected tokens are both SHA-256'd and compared with `crypto.subtle.timingSafeEqual`, so neither content nor length leaks. A device credential is a 401 here and the admin token is a 401 on `/v1/device`. `sf push` reads it from `SF_ADMIN_TOKEN` and never prints it.
- Temporary: M3-12 retires the tree (its scope already says so). Nothing here is for production publishing: no audit log, no per-org authority.
  - **Since M3-12:** the manifest step no longer sets the desired manifest itself. It runs the `publish_manifest_to_screen` tool through the dispatcher, audited as the system actor `sf-push`. The upload routes stay; see the M3-12 notes for why.
- A build's `screen.id` is whatever `screen.json` says (`stress-screen`), not the target screen's id. `sf push` notes the mismatch and pushes the build as is: rewriting it would change the manifest id, and nothing on the player reads that field for targeting (the compiler already resolved the schedule).
- Fixed in passing: `dev:screen` promised a stdout holding only the credential, but once `.dev.vars` exists wrangler's `getPlatformProxy` prints "Using secrets defined in .dev.vars" to stdout. The script now sends `console.log` to stderr.

### Demo against `wrangler dev`

From empty local state (`.wrangler/state` removed). `examples/stress/media` copied in (`sh scripts/stress-media.sh` makes it). The admin token and the credential stay in files and are never printed; a grep of the captured output for either finds nothing.

```sh
pnpm exec tsx packages/cli/src/sf.ts build examples/stress --out dist/content
#   manifest efeb18adef8ffeea: 16 spots, 1 playlists, 18 files, 11317 kB
cd apps/api
(umask 077; openssl rand -base64 32 | sed 's/^/ADMIN_TOKEN=/' > .dev.vars)
pnpm dev:screen > "$TMPDIR/cred.txt"            # a screen with nothing published; stdout is only the credential
#   screen scr_4qo5b6q4p62h6odp6mhcxksv in org dev
pnpm exec wrangler dev --port 8787 &    # logs: env.ADMIN_TOKEN ("(hidden)")
cd ../..
export SF_ADMIN_TOKEN=$(sed -n 's/^ADMIN_TOKEN=//p' apps/api/.dev.vars)
CRED=$(cat "$TMPDIR/cred.txt"); SCR=scr_4qo5b6q4p62h6odp6mhcxksv; API=http://127.0.0.1:8787; D=$API/v1/device
```

```text
$ sf push dist/content --screen $SCR --api $API
  note: the build is for screen "stress-screen"; pushing it to scr_4qo5b6q4p62h6odp6mhcxksv as it is
Pushing .../dist/content to scr_4qo5b6q4p62h6odp6mhcxksv
  18 files in manifest efeb18adef8ffeea, 0 already on the server, 18 to upload
    uploaded 02003e52669a (base template) 68 kB
    uploaded 047882e8d18d (base template) 68 kB
    uploaded 0953077a5ef9 199 kB
    ... (18 lines; 7 base templates)
    uploaded 8e2718f87b44 9375 kB
  manifest efeb18adef8ffeea is now the desired manifest of scr_4qo5b6q4p62h6odp6mhcxksv
  done: 18 of 18 files uploaded (11317 kB)

$ curl -sD - -o m.json -H "Authorization: Bearer $CRED" $D/manifest.json
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "efeb18adef8ffeea6f48636ea4dd9e2577f513dc14041e0988132041f11fa74d"
$ cmp m.json dist/content/manifest.json && echo identical
identical

$ curl -sD - -o b.bin -H "Authorization: Bearer $CRED" $D/blobs/8e2718f87b448dbedf268356aaabe3ba109b4efcdfc0f4266f4ce0b52e32c169
HTTP/1.1 200 OK
Content-Length: 9600472
Content-Type: video/mp4
Cache-Control: public, max-age=31536000, immutable
$ cmp b.bin dist/content/blobs/8e2718f8...c169 && echo identical
identical
$ curl ... $D/blobs/02003e52669a...8232      # a base template's HTML, from sys/b/
200 text/html 69472 bytes

$ sf push dist/content --screen $SCR --api $API        # again
  18 files in manifest efeb18adef8ffeea, 18 already on the server, 0 to upload
  scr_4qo5b6q4p62h6odp6mhcxksv was already on manifest efeb18adef8ffeea; nothing changed
  done: 0 of 18 files uploaded (0 kB)

$ SF_ADMIN_TOKEN=wrong sf push dist/content --screen $SCR --api $API
sf push failed: POST /admin/screens/scr_4qo5b6q4p62h6odp6mhcxksv/missing: 401
unauthorized
```
