# M3-18 Instant publish and rollout

Status: open  ·  Size: M  ·  Depends on: M3-17, M3-06, M3-34

## Goal

Publish compiles every affected screen, stores manifests, nudges screens, and shows rollout.

## Read first

- docs/backend-plan.md#publishing
- packages/compiler

## Scope

- Publish tool: load the org graph, compile per screen, skip unchanged, write manifest to R2 and `publish_screens`, update desired id, call each `ScreenDO`.
- Fan-out through a Queue in batches of 50.
- Rollout view: per publish, screens pending, applied, offline.
- Per-org publish serialised (an org Durable Object or a D1 lock).

## Out of scope

- Timed publish (M3-20).

## Done when

- [ ] Edit a price in the CMS, publish, and the Pi shows it within 10 seconds.
- [ ] Publishing with nothing changed touches no screen.
- [ ] A simulated 1,000-screen org publishes inside the Worker limits: test with a fake binding.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
