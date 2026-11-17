# M3-06 Screen Durable Object and nudge socket

Status: open  ·  Size: M  ·  Depends on: M3-05, M3-32

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

- [ ] A push reaches the Pi and plays within 5 seconds.
- [ ] Idle screens do not wake the object: measured over 10 minutes with the Pi connected.
- [ ] Revoking the credential closes the socket.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
