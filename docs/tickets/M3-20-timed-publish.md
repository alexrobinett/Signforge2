# M3-20 Timed publish

Status: open  ·  Size: S  ·  Depends on: M3-18

## Goal

Schedule a publish for later; it fires on time.

## Read first

- docs/backend-plan.md#publishing (timed publish)

## Scope

- Publish at a time; an alarm fires it; cancel before it fires.
- Shown in the rollout view as scheduled.

## Out of scope

- Recurring publishes.

## Done when

- [ ] A publish set two minutes ahead reaches the Pi within a minute of its time.
- [ ] Cancelling stops it.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.

## Owner decision

Q1: content as it was when scheduled, or as it is when the time comes. Default if unanswered: as it is when the time comes.
