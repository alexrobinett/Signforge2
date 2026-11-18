# M3-11 CMS: screens

Status: done (branch m3-11-cms-screens)  ·  Size: M  ·  Depends on: M3-10, M3-08

## Goal

Manage screens from the CMS: claim, list, edit, revoke, display hours.

## Read first

- docs/architecture.md#player (display hours)
- packages/contract (DisplayHours)

## Scope

- Claim a pairing code: name, time zone, orientation, groups, display hours.
- Screen list with online state, last seen, manifest rollout state, display state.
- Display hours editor: weekly windows and dated exceptions, validated with `player-core` so the CMS rejects what the player would.
- Revoke with confirmation.
- Display override (wake now, sleep now) as a `DisplayOverride` with `until` computed by the server: the next scheduled change, or a fixed limit when the screen has no display hours. Delivered by socket command and in the sync response; persisted on the screen.

- **From the design canvas (2026-11-17).** Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`.
  - Built on the CMS tokens and components in `cms-ui.md` (neutral white, Geist, status tokens with shapes); this ticket lands the token change.
  - Each row says what the screen should be showing now, resolved on the server from its desired manifest and schedule (`player-core`), shown as the spot's name and template thumbnail. Live rendered thumbnails wait for `PlayerStage` (M3-16).
  - Status as facts, never colour alone: online; updating; "Asleep · wakes 07:00" from display hours; "Unreachable 2 h · still playing <spot>" (calm grey) when it is on the latest version; red "Needs you" only when it is behind, revoked or has nothing playable. Locations roll up to their most urgent state.
  - A screen detail page: what it should be showing, its versions, cache state (`filesMissing`), display hours with exceptions, recent events, and Identify and Restart (new `DeviceCommand`s, contract first; Reboot waits for a supervisor endpoint).
  - The empty Screens page has one action, "Open a test screen" (M3-41), and the pairing-code input.
- **Owner decisions (2026-11-17).** Screens A's tile wall is the default view, with a toggle to a table view from B's layout on the light kit (dark only in dark mode). Geist and Geist Mono. Sign-in A (the render wall) is the sign-in: the existing page restyled with the new tokens, its auth behaviour unchanged. Not in M3: idea 8 (an agent's draft) and idea 9 (the time scrubber).

## Out of scope

- Groups management beyond assigning existing ones (M3-19).

## Done when

- [ ] The Pi's screen is claimed from the CMS and shows online.
  Not run: the rig lock was held by M3-25 (measurements, extended to 01:33) for the whole hour M3-11 waited, 2026-11-17 22:40 to 23:48; the Pi was not touched. Locally, `apps/cms/e2e/screens.spec.ts` does the same flow against a real API: a pairing started as the player starts one, claimed from the empty Screens page's code input, the screen syncs and reads "Needs you · Nothing is published to it yet", then sleep now (the next sync carries the override), identify, display hours, tiles, table, phone width, revoke (the screen's next sync is refused).
  To run it: take the lock; back up `www`, `device.credential`, `supervisor.py`, `kiosk.env` and `~/.kiosk-profile`; deploy this branch's player and `device/pi/supervisor.py` (the Pi still runs the pre-pairing supervisor, without `POST /credential`); point `kiosk.env` at a local `wrangler dev --env dev --ip 0.0.0.0`; remove the credential; pair from the CMS with the code the Pi shows; `sf push` a demo build to the new screen id; it should read Online. Then restore everything, `kiosk.env` = `kiosk.env.cloud`, and release.
- [ ] Changing display hours and publishing sleeps and wakes the Pi at the new times.
  Not run on the Pi, for the same reason. Until M3-18 the only publish is `sf push`, which takes display hours from the project's `screen.json`, so the check copies the hours set in the CMS (`get_screen`) into `screen.json` before `sf push`. The CMS's wake now and sleep now reach the screen at once over the socket (`apps/api/test/socket.test.ts`) and in the next sync (`apps/api/test/sync.test.ts`), and the player acts on them at once (`packages/player/browser/socket.test.ts`).
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Both pass after merging `origin/m3-foundations` (135e3cb): 22 of 22 turbo tasks, the CMS e2e included. `pnpm lint`, `pnpm knip`, `pnpm dupes`, `turbo boundaries`, the format check and `scripts/check-contract-commits.sh` pass too. Docs: `docs/architecture.md` (socket commands, display override), `docs/backend-plan.md` (sync and socket commands), `docs/proposals/cms-ui.md` (token change landed), `packages/tools/README.md` (screen view, new tools, `alwaysAudited`), `apps/cms/README.md` (data through tools, the look, layout, e2e).

## Notes

- Design review: a sub-agent compared light and dark screenshots at desktop and phone width with the canvas boards. Its fixes are in: the cache card when nothing is published, events in words, Troubleshoot on needs-you rows, needs-you in red in the summary, the board's disabled colours, code-box size.
- Owner's CMS rules, adopted mid-ticket: no `useState`/`useEffect`; the pairing flow and the screen page's actions, editors and drafts are a `screens` slice of the app store; the list's view and filters are typed search params. No polling for live status until the data-layer decision (`docs/research/cms-data-layer.md`).
- Not here: the rollout bar (M3-18), rendered thumbnails (M3-16), "Open a test screen" (M3-41: `EmptyFleet` takes `testScreenHref`), Reboot (needs a supervisor endpoint).
