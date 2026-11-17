# M3-11 CMS: screens

Status: open  ·  Size: M  ·  Depends on: M3-10, M3-08

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

## Out of scope

- Groups management beyond assigning existing ones (M3-19).

## Done when

- [ ] The Pi's screen is claimed from the CMS and shows online.
- [ ] Changing display hours and publishing sleeps and wakes the Pi at the new times.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
