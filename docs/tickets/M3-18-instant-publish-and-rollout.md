# M3-18 Instant publish and rollout

Status: done (branch t3/m3-18-instant-publish-rollout)  ·  Size: M  ·  Depends on: M3-17, M3-06, M3-34

## Goal

Publish compiles every affected screen, stores manifests, nudges screens, and shows rollout.

## Read first

- docs/backend-plan.md#publishing
- packages/compiler

## Scope

- Publish tool (`publish`, `packages/tools/src/publish.ts`): load the org graph, compile per screen, skip unchanged, write each changed manifest to R2, then commit in one batch: `publishOrg`'s writes (publish order and guarded promotions), `publishes.stage.insert`, `publishes.stage.addScreens` and `screens.stage.setDesiredManifest` (R09, #33). A `StaleVersionError` means another publish or an edit got there first: the dispatcher runs the tool again from a fresh read (tools with `publishes`, up to 3 times). A screen deleted during the publish is caught by a guard at the head of `addScreens`'s statements (the screens' rows guarded, owner decision 2026-11-19), so it fails as a stale read and is retried, never as D1's foreign-key error.
- **Owner decision (2026-11-19): a chosen set of drafts.** `publish` takes `drafts: { kind, id, version }[]` and promotes only those, refused `conflict` if any pinned draft changed or is gone; without it every changed draft is published. Milestone 4's publish requests (#114) depend on it.
- The default playlist: `set_default_playlist` (a playlist tool at `content:draft`, as `set_default_brand_kit`), and "Play on every screen" in the playlist editor (M3-17). Playlist views say `isDefault`. `delete_playlist` already refuses the default.
- Fan-out through a Queue in batches of 50 (`PUBLISH_NOTICES`, `apps/api/src/publish.ts`).
- Rollout view: per publish, each screen playing, switching, downloading, asleep, offline, fallen back, revoked or replaced (`get_publish`, `list_publishes`; the CMS's Publishes page and the Screens page's latest publish).
- Per-org publish serialised: the org's Durable Object (`OrgObject`) holds a lease lock (`Caller.publishLock`).
- Respect the editors-publish setting (Q7, #54): `publish` and `roll_back_publish` are `content:publish`, so an editor of an org where only owners publish is refused, and the CMS shows Publish only to a member whose tool list has it.
- Leftover data sources (from the #98 re-check): the spot editor deletes a weather source it made when a save stops binding it, but `delete_data_source` refuses while a published version still binds it, and nothing retried. A publish now deletes, in its batch and the org's scope, every editor-made source no draft and no published version binds once it commits (`packages/tools/test/publishing.test.ts`, `packages/db/test/data-sources.test.ts`; `apps/cms/test/registry/editor-sources.test.ts` keeps the CMS's and the server's idea of an editor-made source the same).
- `publish.finished`: the alert queue (#94) has not merged, so the five-minute cron marks finished rollouts (`finishPublishes`) and `finishRollouts` in `apps/api/src/alerts.ts` is the hook where the event is to be enqueued.

- **From the design canvas (2026-11-17).** Design: the design canvas (https://claude.ai/artifact/JUMHm7PCsat6RV8yDXNb3H), `docs/proposals/cms-ui.md` and `docs/research/cms-ux.md`.
  - The rollout bar says why each waiting screen waits: downloading (with `filesMissing`), asleep until a time, unreachable since a time.
  - Undo a publish: manifests are immutable, so undo points each screen's desired manifest back at the one from the previous publish and nudges it (`roll_back_publish`, a new publish that compiles nothing). The publish toast carries Undo; the publish history has "Roll back to vN". Confirmation dialogs stay only for revoking a screen and deleting an asset in use. A roll back leaves drafts and published versions as they are, so the next publish sends the current published content again; the toast says so.

## Out of scope

- Timed publish (M3-20).

## Done when

- [x] Edit a price in the CMS, publish, and the Pi shows it within 10 seconds.
  Run on the Pi 400 2026-11-19 at this branch, against a local `wrangler dev --env dev --ip 0.0.0.0` and the dev CMS (as M3-11's checks did). With its credential moved aside the Pi showed a pairing code; `claim_screen` claimed it, and a menu-board spot (three prices), a playlist made the default and a publish put it on the panel. Then, in the spot editor, the first price changed from $2.50 to $2.75 and Publish pressed (Playwright driving the CMS): the CMS answered in 0.13 s and the Pi's player switched to the new manifest 1.8 s after the click, the panel showing $2.75 (screenshot over DevTools). A second edit, to $2.95: 1.5 s. The Mac's and the Pi's clocks agreed within 0.1 s. The rollout read playing. The rig was restored: the cloud credential back, `kiosk.env` = `kiosk.env.cloud`, the kiosk restarted and playing the cloud manifest it had before, socket up; lock released. Locally the CMS e2e (`apps/cms/e2e/publishing.spec.ts`) has an edit published from the spot editor on a browser test screen in 5.7 to 6.1 s, asserted under 10.
- [x] Publishing with nothing changed touches no screen.
  `packages/tools/test/publishing.test.ts` "touches no screen and writes nothing when nothing changed": `publish: null`, every screen `unchanged`, no notice, no R2 write (`publish-scale.test.ts`: none of 1,000), the revision and the audit log unchanged. The e2e presses Publish again and gets "Nothing to publish", with no new publish in the history.
- [x] A simulated 1,000-screen org publishes inside the Worker limits: test with a fake binding.
  `packages/tools/test/publish-scale.test.ts`: 1,000 screens through a counting D1 and R2: 14 D1 queries (one batch of 1,051 statements; D1 counts a batch as one), 1,000 R2 writes, one notice, about 0.6 s in workerd. Under the Free plan's 50 D1 queries, and under Paid's 10,000 calls to Cloudflare services; over Free's 1,000 (docs/backend-plan.md#publishing says so). The fan-out: `apps/api/test/publish.test.ts` splits 120 screens into messages of 50, 50 and 20, tells every screen of a message at once and retries a message with a failed call; a consumer batch of 10 messages is at most 500 calls.
- [x] `pnpm typecheck` and `pnpm test` pass; docs touched by the change are updated.
  Both pass after merging origin/master (573e621), the CMS e2e on its own ports; `pnpm lint`, `pnpm knip`, `pnpm dupes` (0.93%), `turbo boundaries`, the format check and `scripts/check-contract-commits.sh` too. Docs: `docs/backend-plan.md` (Publishing, Deploying, the `/admin` table), `packages/tools/README.md` (the publish tools, callers, settings), `apps/cms/README.md` (layout, e2e), this ticket.

## Notes

- Migration `0024_publish_history` (`publishes.revision`, unique per org, and `publishes.restores_id`). It may need renumbering at merge.
- Deploying needs the queue first: `wrangler queues create signforge-publish-notices-<env>`; the Durable Object migration `v3` adds `OrgObject`.
- No contract change: nothing a screen sees changed.
- `/admin/screens/*` and `sf push` stay until #34 removes them.
