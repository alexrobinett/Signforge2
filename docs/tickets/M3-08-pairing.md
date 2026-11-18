# M3-08 Pairing

Status: done (branch t3/m3-08-device-pairing)  ·  Size: M  ·  Depends on: M3-07

## Goal

An unpaired screen shows a code; claiming it gives the screen its credential.

## Read first

- docs/backend-plan.md#screens (pairing)
- docs/architecture.md#player (pairing)

## Scope

- `POST /v1/device/pair/start` and `/pair/poll` as in the plan; codes expire after 15 minutes; rate limited.
- A claim operation (API only here; the CMS form is M3-11) that creates the screen and binds the code.
- Player: with no credential, show the code full screen (large, OLED-safe: moves every minute) and poll; store the credential when it arrives.
- On revoke (socket `revoked`, or a 401 on any device request), the player behaves as the owner decides (see below).

## Out of scope

- CMS UI.

## Done when

- [x] A freshly flashed Pi shows a code, is claimed with a `curl` call, and starts playing without a restart.
  Pi 400, 2026-11-17, against a local `wrangler dev --env dev --ip 0.0.0.0`, with no `device.credential` and an empty Chromium profile (both put back afterwards). Within 20 s of the kiosk starting it showed `LDK FBN` full screen (`__sf.auth` `pairing`); a minute later the card had moved from (358, 545) to (933, 167). One `curl` to `POST /api/tools/claim_screen` with a signed-in session claimed it; the next poll, under a second later, collected the credential, the supervisor stored it (0600, `sfd_<new screen>.…`) and the socket opened. `sf push` of the demo to the new screen: playing 15 s later (2 spots, 0 skipped). `performance.timeOrigin` and the kiosk's start time never changed: no reload, no restart.
  Revoke, also on the Pi: `revoke_screen_credential` by curl. Within 12 s the player had reloaded, deleted the credential from the supervisor, emptied `sf-blobs-v1` (7 files before) and the stored manifests, and showed a new code, which paired and played again. The Pi was then restored to the cloud demo (`kiosk.env` = `kiosk.env.cloud`, its credential, player and supervisor as they were) and played it.
- [x] Codes cannot be guessed faster than the rate limit allows: test it.
  `apps/api/test/pairing.test.ts` (workerd, the real rate-limit bindings): a member's 11th claim in a minute is `429 rate_limited`, the right code included, and the code stays open; two accounts on one address share 10; `pair/start` allows 10 per address a minute (then 429, `retry-after: 60`), `pair/poll` 600. Claims count before the code is read, and unknown, expired and claimed codes get one answer. With ~10^9 codes, 10 guesses a minute per member and address (docs/backend-plan.md#screens has the numbers).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Both pass after merging `m3-foundations`. Docs: `docs/architecture.md` (Pairing, Revoked, supervisor, device routes), `docs/backend-plan.md` (pairing steps, rate limits, routes, open question 2), `packages/tools/README.md`, `packages/db/README.md`, `packages/player/browser/README.md`, `device/pi/supervisor.py`'s header.

## Notes

- Owner decision Q2 built with its default: a revoked screen wipes its cache and shows a code. A 401 counts as revoked only when the request carried a credential; with no supervisor to ask and content cached, the screen keeps playing rather than cover it with a code.
- The claim (`claim_screen`) takes name, time zone, orientation, locale and display hours. Groups are not part of it: add the screen to groups afterwards with the group tools (M3-11's form can do both).
- Two claims racing for one code: the loser's batch fails and writes nothing, and the loser gets `not_found`, as for a code that was never open (`refuseFailedCommit`, since 4f018c3; test: `claim_screen racing` in `packages/tools/test/dispatch.test.ts`).
- Rate limits use Workers rate limiting bindings (`PAIR_START_LIMIT`, `PAIR_POLL_LIMIT`, `PAIR_CLAIM_LIMIT` in every wrangler env; namespace ids 801x/811x/821x). They count per Cloudflare location. M3-24 should confirm the ids are free on the account before deploying.

## Owner decision

Q2: a revoked screen wipes its cache and shows a pairing code, or keeps playing. Default if unanswered: wipe and show a code.
