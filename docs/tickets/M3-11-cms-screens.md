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
- [ ] Changing display hours and publishing sleeps and wakes the Pi at the new times.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
