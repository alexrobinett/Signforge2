# M3-05 Player: play from the API

Status: open  ·  Size: M  ·  Depends on: M3-04

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

- [ ] On the Pi: plays the stress playlist from the deployed or tunnelled Worker; pull the network cable and it keeps playing; reconnect and a new `sf push` is picked up on the next poll.
- [ ] `isolate.py` on the full playlist shows no regression against `spike/pi-perf/RESULTS.md` (fade, under 0.3% dropped).
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q8 in the backend plan: player served from Cloudflare and self-updating, or pinned in the Pi image. Decided in the backend plan (**Where the player runs**): served by the device. The supervisor fetching player releases is M3-24's; here the Pi keeps today's deploy script.
