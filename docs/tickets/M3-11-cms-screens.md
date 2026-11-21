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
  - Status as facts, never colour alone: online; updating; "Asleep · wakes 07:00" from display hours; "Unreachable 2 h · still playing <spot>" (calm grey) when it is on the latest version; red "Needs you" only when it is behind, revoked or has nothing playable. Locations rolled up to their most urgent state; since #183 the Screens page shows only the groups with a screen that needs you (Needs attention).
  - A screen detail page: what it should be showing, its versions, cache state (`filesMissing`), display hours with exceptions, recent events, and Identify and Restart (new `DeviceCommand`s, contract first; Reboot waits for a supervisor endpoint).
  - The empty Screens page has one action, "Open a test screen" (M3-41), and the pairing-code input.
- **Owner decisions (2026-11-17).** Screens A's tile wall is the default view, with a toggle to a table view from B's layout on the light kit (dark only in dark mode). Geist and Geist Mono. Sign-in A (the render wall) is the sign-in: the existing page restyled with the new tokens, its auth behaviour unchanged. Not in M3: idea 8 (an agent's draft) and idea 9 (the time scrubber).

## Out of scope

- Groups management beyond assigning existing ones (M3-19).

## Done when

- [x] The Pi's screen is claimed from the CMS and shows online.
  Run on the Pi 2026-11-18 at master 84d704a, against a local `wrangler dev --env dev --ip 0.0.0.0` and the dev CMS: with its credential moved aside the Pi showed a pairing code; the code typed into the empty Screens page and "Pair" claimed it; the Pi collected a credential bound to the local device API (device trust, two lines) and synced within seconds. After `sf push` of the demo build to the new screen id, its page read Online, playing the published manifest, clock trusted, player `0.0.0+84d704a`. The rig was then restored to the cloud demo (credential, profile, `kiosk.env` = `kiosk.env.cloud`).
- [x] Changing display hours and publishing sleeps and wakes the Pi at the new times.
  Same run. `update_screen_settings` (the CMS's tool, with the session) set a dated exception for that day, on 00:00–13:47 and 13:51–24:00 America/New_York; those hours were copied into the project's `screen.json` and published with `sf push` (the only publish until M3-18). The supervisor log: `display off` at 13:47:13 and `display on` at 13:51:14; the player showed no spot while off and resumed the playlist on waking.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Both pass after merging `origin/m3-foundations` (135e3cb): 22 of 22 turbo tasks, the CMS e2e included. `pnpm lint`, `pnpm knip`, `pnpm dupes`, `turbo boundaries`, the format check and `scripts/check-contract-commits.sh` pass too. Docs: `docs/architecture.md` (socket commands, display override), `docs/backend-plan.md` (sync and socket commands), `docs/proposals/cms-ui.md` (token change landed), `packages/tools/README.md` (screen view, new tools, `alwaysAudited`), `apps/cms/README.md` (data through tools, the look, layout, e2e).

## Notes

- Design review: a sub-agent compared light and dark screenshots at desktop and phone width with the canvas boards. Its fixes are in: the cache card when nothing is published, events in words, Troubleshoot on needs-you rows, needs-you in red in the summary, the board's disabled colours, code-box size.
- Owner's CMS rules, adopted mid-ticket: no `useState`/`useEffect`; the pairing flow and the screen page's actions, editors and drafts are a `screens` slice of the app store; the list's view and filters are typed search params. No polling for live status until the data-layer decision (`docs/research/cms-data-layer.md`).
- Not here: the rollout bar (M3-18), rendered thumbnails (M3-16), "Open a test screen" (M3-41: `EmptyFleet` takes `testScreenHref`), Reboot (needs a supervisor endpoint).
