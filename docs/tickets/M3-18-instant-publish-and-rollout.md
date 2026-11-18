# M3-18 Instant publish and rollout

Status: open  ·  Size: M  ·  Depends on: M3-17, M3-06, M3-34

## Goal

Publish compiles every affected screen, stores manifests, nudges screens, and shows rollout.

## Read first

- docs/backend-plan.md#publishing
- packages/compiler

## Scope

- Publish tool: load the org graph, compile per screen, skip unchanged, write manifest to R2 and `publish_screens`, update desired id, call each `ScreenDO`. Commit in one batch: `publishOrg`'s writes (publish order and guarded promotions), `publishes.stage.insert`, `publishes.stage.addScreens` and `screens.stage.setDesiredManifest` (R09, #33). A `StaleVersionError` means another publish or an edit got there first: load and compile again. A screen deleted during the publish fails the batch with D1's foreign-key error from `publish_screens`, not a conflict: treat it as one too (load and compile again), or guard the screen rows.
- Fan-out through a Queue in batches of 50.
- Rollout view: per publish, screens pending, applied, offline.
- Per-org publish serialised (an org Durable Object or a D1 lock).

- **From the design canvas (2026-11-17).** Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`.
  - The rollout bar says why each waiting screen waits: downloading (with `filesMissing`), asleep until a time, unreachable since a time.
  - Undo a publish: manifests are immutable, so undo points each screen's desired manifest back at the one from the previous publish and nudges it. The publish toast carries Undo; the publish history has "Roll back to vN". Confirmation dialogs stay only for revoking a screen and deleting an asset in use.

## Out of scope

- Timed publish (M3-20).

## Done when

- [ ] Edit a price in the CMS, publish, and the Pi shows it within 10 seconds.
- [ ] Publishing with nothing changed touches no screen.
- [ ] A simulated 1,000-screen org publishes inside the Worker limits: test with a fake binding.
- [ ] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
