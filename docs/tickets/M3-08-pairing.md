# M3-08 Pairing

Status: open  ·  Size: M  ·  Depends on: M3-07

## Goal

An unpaired screen shows a code; claiming it gives the screen its credential.

## Read first

- docs/backend-plan.md#screens (pairing)
- docs/architecture.md#player (pairing)

## Scope

- `POST /v1/device/pair/start` and `/pair/poll` as in the plan; codes expire after 15 minutes; rate limited.
- A claim operation (API only here; the CMS form is M3-11) that creates the screen and binds the code.
- Player: with no credential, show the code full screen (large, OLED-safe: moves every minute) and poll; store the credential when it arrives.
- On revoke, the player behaves as the owner decides (see below).

## Out of scope

- CMS UI.

## Done when

- [ ] A freshly flashed Pi shows a code, is claimed with a `curl` call, and starts playing without a restart.
- [ ] Codes cannot be guessed faster than the rate limit allows: test it.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q2: a revoked screen wipes its cache and shows a pairing code, or keeps playing. Default if unanswered: wipe and show a code.
