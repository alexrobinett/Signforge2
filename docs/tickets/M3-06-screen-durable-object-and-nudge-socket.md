# M3-06 Screen Durable Object and nudge socket

Status: done (branch t3/m3-06-screen-durable-object-nudge-socket)  ·  Size: M  ·  Depends on: M3-05, M3-32

## Goal

Replace manifest polling with a push: each screen holds one hibernating WebSocket to its Durable Object.

## Read first

- docs/backend-plan.md#screens (Durable Object, socket ticket)
- spike/m3-platform/RESULTS.md (hibernation findings)

## Scope

- `ScreenDO` keyed by screen id: desired and reported manifest ids, `acceptWebSocket`, automatic ping/pong.
- `GET /v1/device/ws?ticket=`: ticket is a 60-second HMAC issued by sync, so the credential never appears in a URL.
- Messages server to screen: `manifest`, `command`, `revoked`. Screen to server: `applied`, written through to D1.
- Player: socket client with jittered reconnect; on `manifest` it syncs immediately. Polling stays only as the fallback when the socket is down.
- Add the message types to `packages/contract`.
- Commands arrive and act at once: a display override must not wait for `displayLoop`'s 15-second check.

## Out of scope

- Sync endpoint (M3-07) beyond issuing a ticket.

## Done when

Pi evidence was measured on the Pi 400 rig against the API run locally (`wrangler dev --env dev --ip 0.0.0.0` on a Mac on the same LAN), since this ticket could not deploy. The kiosk ran this branch's player with `content=http://<mac>:8787/v1/device`, then went back to the cloud config.

- [ ] A push reaches the Pi and plays within 5 seconds.
  **Reaches: yes. Plays: 6 of 7 trials.** `sf push` alternated two builds of `examples/demo`. Time from the publish response to the Pi adopting the manifest (`__sf.manifestId`, polled over DevTools every 100 ms; Pi clock about 130 ms ahead of the Mac): 120, 246, 237, 235, 291, 92 and 208 ms. With the socket open the manifest poll is 5 minutes, so only the socket could carry it that fast. Time to the first spot from the new manifest: 3.7, 3.7, 3.7, 3.7, 3.8 and 4.5 s, but **12.5 s** in the first trial. The player switches at the next spot boundary (by design, `architecture.md`), and the demo has a 12-second spot. Left unticked: meeting 5 s whatever the spot length means cutting the spot on screen when a nudge arrives. That is a playback decision for the owner, not built here.
- [x] Idle screens do not wake the object: measured over 10 minutes with the Pi connected.
  Local workerd (wrangler 4.164.0, workerd 1.20261117.1) hibernates like production, so this was measured locally. A temporary, uncommitted log line in the object's constructor and in `webSocketMessage` showed:
  - In the window 17:45:32–17:56:23Z, with the Pi's socket open throughout, there were no constructions, no messages and no reconnects. The only requests were two fallback manifest checks to the Worker, both 304.
  - The next publish then constructed a fresh object (17:56:30). The Pi's `applied` showed `getWebSocketAutoResponseTimestamp` = 17:55:48, so pings every 50 s were answered inside the window without running the object.
  - Between the publish trials (20 s apart) the object was constructed again each time: it hibernates within seconds.
  - Not measured: Cloudflare's billed request count for auto-responded pings, which needs a deploy and analytics on a paid account (backend-plan, Screens).
- [x] Revoking the credential closes the socket.
  `apps/api/test/socket.test.ts`, "closes the socket when its credential is revoked, and refuses the ticket after", runs `revoke_screen_credential` through the dispatcher against a real Durable Object and WebSocket in workerd. The socket gets `{ type: 'revoked' }` and is closed (code 4001), and the same still-unexpired ticket is refused (401). On the player, `browser/socket.test.ts` "treats revoked as not authorised" covers it. Not run against the Pi: the local org has no signed-in owner to call the tool as.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Typecheck and test pass after merging `m3-foundations`; `pnpm lint` (one warning, in an existing file) and format are clean. Docs updated: `docs/architecture.md`, `docs/backend-plan.md` (socket ticket, who tells the object, keepalive), `packages/tools/README.md` (`ctx.notify`), `packages/player/browser/README.md`.

## Notes

- Contract: `SyncResponse.desiredManifest` is optional (own commit), since a screen with nothing published still syncs for its ticket.
- `POST /v1/device/sync` is minimal here: it issues the ticket and returns the desired manifest and server time, with `ackSeq: 0`, no snapshots and no commands, and stores nothing. M3-07 builds the rest. The player's socket syncs on its own for a ticket; M3-07 should make one sync loop feed it.
- The `reboot` command is logged and ignored: the supervisor has no reboot endpoint.
- Nothing sends a `command` yet; `sendCommand` in `apps/api/src/device/screens.ts` is there for the CMS's display override (M3-11).
