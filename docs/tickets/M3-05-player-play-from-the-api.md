# M3-05 Player: play from the API

Status: done (branch t3/m3-05-player-from-api)  ·  Size: M  ·  Depends on: M3-04

## Goal

Point the player at the API: content base URL, credential, and conditional manifest requests. **First Pi demo of Milestone 3.**

## Read first

- packages/player/src/main.ts, store.ts, data.ts
- device/pi/kiosk.sh, scripts/deploy-pi.sh
- docs/architecture.md#player

## Scope

- Credential held by the supervisor (a 0600 file) and handed to the page over loopback the way the supervisor token is (`GET /token` in `device/pi/supervisor.py`): only to the player's origin, never in a URL. Sent as a bearer header on every device request.
- Manifest fetch sends `If-None-Match`; a 304 still runs the missing-file check against the cached manifest.
- The Pi's kiosk configuration selects the API base.
- Everything that works today against static files keeps working: offline start, atomic switch, data snapshots.
- A 401 is not offline: keep playing and show a small 'not authorised' state in the debug overlay until pairing (M3-08) handles it.

## Out of scope

- Sockets and sync (M3-06, M3-07). Pairing (M3-08).

## Done when

- [x] On the Pi: plays the stress playlist from the deployed or tunnelled Worker; pull the network cable and it keeps playing; reconnect and a new `sf push` is picked up on the next poll. (Run against `wrangler dev` on the LAN, with the API stopped in place of the cable: see Notes.)
- [x] `isolate.py` on the full playlist shows no regression against `spike/pi-perf/RESULTS.md` (fade, under 0.3% dropped). (0.29% from the API; no difference from the previous player on the same rig, though both measured 0.24 to 0.46% today against 0.20% in RESULTS: see Notes.)
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q8 in the backend plan: player served from Cloudflare and self-updating, or pinned in the Pi image. Decided in the backend plan (**Where the player runs**): served by the device. The supervisor fetching player releases is M3-24's; here the Pi keeps today's deploy script.

## Notes

- Code: `packages/player/src/credential.ts` (collects the credential from the supervisor), `store.ts` (`If-None-Match`, 304, `UnauthorisedError`), `data.ts` and `main.ts` (headers on every device request, the 401 state). `device/pi/supervisor.py` adds `GET /credential`. Tests: `packages/player/src/store.test.ts`, run with fakes for Cache Storage and the device API.
- **Content base.** `?content=` in the kiosk URL. When it is on another origin than the player, it is treated as the API (`http://<api>/v1/device`) and every manifest, file and data request carries `Authorization: Bearer <credential>`. Content on the player's own origin (the default `./content`, the demo) gets no credential, so the credential never goes to a static server. The URL holds no secret.
- **Credential.** `~/signforge/device.credential`, mode 0600, installed by hand until pairing (M3-08). The supervisor reads it on each request (no restart needed), tightens it to 0600 if it was left readable, and serves it at `GET /credential` under the same rule as `/token`: the player's origin and a loopback Host, `cache-control: no-store`, 404 when there is none. Checked on the Pi: origin `http://127.0.0.1:8090` gets 200; origin `null`, another origin, or a foreign Host gets 403. The player holds it in memory only.
- **Manifest.** `If-None-Match: "<current manifest id>"` (the API's ETag is the id). On a 304 the store reads the active manifest from its cache and runs the same missing-file check; if that cached manifest has gone, it asks again without the condition.
- **401.** `UnauthorisedError` from the manifest or a file. The player stays `online`, keeps playing, sets `__sf.auth` to `not authorised` (or `no credential` when the supervisor had none) and shows it on the overlay's first line. It forgets the credential and collects it again on the next poll, so installing a new one recovers without a restart. Data requests that get a 401 fail silently, as all data failures do.
- **Fixed in passing:** `dev:screen` failed since M3-09 (the `organization` foreign key; org `dev` did not exist). It now creates the org with `seedOrganization` from `@signforge/db/testing` first.

### Demo on the Pi against `wrangler dev` on a Mac

R2 is not enabled on the Cloudflare account, so this ran against local dev on the LAN. Neither the credential nor the admin token was printed.

```sh
sh scripts/stress-media.sh       # or copy examples/stress/media from another checkout
pnpm exec tsx packages/cli/src/sf.ts build examples/stress --out dist/content
cd apps/api
(umask 077; openssl rand -base64 32 | sed 's/^/ADMIN_TOKEN=/' > .dev.vars)
(umask 077; pnpm dev:screen --content ../../dist/content --data <dir of data snapshots> > "$TMPDIR/cred.txt")
#   screen scr_dqgym2fa5qkvfytqb5yyfzum in org dev
pnpm exec wrangler dev --ip 0.0.0.0 --port 8787 &
cd ../..
SF_ADMIN_TOKEN=$(sed -n 's/^ADMIN_TOKEN=//p' apps/api/.dev.vars) \
  pnpm exec tsx packages/cli/src/sf.ts push dist/content --screen scr_dqgym2fa5qkvfytqb5yyfzum --api http://127.0.0.1:8787
ssh alex@signforge-pi.local 'umask 077; cat > ~/signforge/device.credential' < "$TMPDIR/cred.txt"
pnpm build:player && sh scripts/deploy-pi.sh
```

**Switching the Pi between local content and the API.** The Pi is left on local static content, so it does not break when the Mac sleeps. `~/signforge/kiosk.env.api` holds the API URL (`KIOSK_URL=http://127.0.0.1:8090/index.html?debug=1&poll=10&content=http://192.168.1.149:8787/v1/device`; change the address to the API's). To switch: `cp ~/signforge/kiosk.env ~/signforge/kiosk.env.static && cp ~/signforge/kiosk.env.api ~/signforge/kiosk.env && sudo systemctl restart signforge-kiosk`; back: copy `kiosk.env.static` over `kiosk.env` and restart. The credential is still installed.

What happened, read from `__sf` (`sfstate.py`) and the wrangler log:
- **Cold start from the API.** Player caches cleared, page reloaded: 18 of 18 files fetched from `/v1/device/blobs`, manifest `99d4ba31063fe3cd` active, the three data snapshots served by the API, 0 skipped. Every later poll (10 s) is `304`, preceded by a CORS preflight.
- **401.** A bogus credential installed and the page reloaded: kept playing the cached manifest, `online`, overlay `NOT AUTHORISED`. The real credential put back: next poll accepted, state cleared, no restart.
- **API stopped** (instead of the cable): `online: false`, still playing, 0 skipped. Started again; a build with the meeting-room title changed to "Room 4B via API" pushed (`699194e5d1012666`, 0 files uploaded). Polls before the push were 304; the next poll after it was a 200, and the player was on `699194e5…` 9 s after the push, with the new title in its active manifest.

### Frame pacing: `isolate.py 150 fade600 <the full 16-spot playlist>`

`signforge-soak` resets `__sf.frames` every 60 s, so with it running an `isolate.py` result covers only the last 0 to 60 s of a run (the first measurements here, 0.32 to 0.79%, were taken that way and are discarded). Stop soak while measuring. Interleaved, soak stopped, the `HEAD` player served from `/head/` on the same Pi with the same content:

| Run | HEAD player (before) | This player, static content |
| --- | --- | --- |
| 1 | 0.43% | 0.42% |
| 2 | 0.46% | 0.37% |
| 3 | 0.27% | 0.24% |

This player with content from the API: **0.29%** (playing 0.04%, worst frame 67 ms). No regression: the API path draws the same as static content, and this player the same as the one before it. Every run today, the old player included, is above the 0.20% in `spike/pi-perf/RESULTS.md`, with transitions at 2 to 4% against 1.5% then. That gap predates this change and is worth a look on its own.

### Odd things

- `sf push` after `dev:screen --content` uploaded 7 files: `dev:screen` stores base-template HTML under the org prefix, the push puts it under `sys/b/`. Harmless; `dev:screen` could follow the push's rule.
- Copying a new player build onto the Pi without restarting the kiosk can leave Chromium serving the old `index.html` from its HTTP cache for a URL it has loaded before (python's `http.server` sends `Last-Modified`, so it is heuristically fresh). `deploy-pi.sh` restarts the kiosk, so normal deploys are fine; for A/B tests clear it over CDP (`Network.clearBrowserCache`).
- The Pi's local content is now this checkout's build of `examples/stress` (`99d4ba31…`, the same playlist) rather than `efeb18ad…`.
