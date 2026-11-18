# @signforge/db

The D1 schema, its migrations, and the only code allowed to query tenant tables.

## Using it

```ts
import { scoped } from '@signforge/db';

const org = scoped(env.DB, orgId);
await org.screens.get(screenId);        // undefined if the screen is another org's
await org.playlists.setItems(id, spotIds); // throws NotInOrgError if any id is not this org's
```

Every repository query is filtered by the scope's org, and every row it writes is stamped with that org whatever the caller passes. A call made for org B with org A's ids reads nothing and changes nothing. Templates and template versions with a null org are base templates: every org can read them, none can change them.

The table objects (`src/schema.ts`) are not exported. `test/node/boundary.test.ts` fails if anything outside this package imports them; code elsewhere imports `@signforge/db`, and tests may also import `@signforge/db/testing`.

`@signforge/db/testing` has `seedTwoOrgs(db)`: two orgs, `org-a` and `org-b`, each with one of everything, for isolation tests. `seedOrganization(db, orgId)` writes just the `organization` row, which every tenant row needs.

Code that has to find a row before it knows the org (device auth by screen id, pairing, the data-source poller) gets a narrow function here, added by the ticket that needs it. It does not get the tables. So far:

- `findMembership(db, orgId, userId)`: re-checks the active org on every `/api` request.
- `findDeviceScreen(db, screenId)` (`src/device.ts`): a screen's org, desired and previous manifest ids, and the hashes of its unrevoked credentials (each with whether it was used yet) (none if the screen is revoked). The device API checks the secret against them, then uses `scoped(db, orgId)`.
  The temporary `/admin` upload routes (M3-04) also use it to find a screen's org, behind the deploy secret. The publish they end with goes through the tool registry with `scoped(db, orgId)`.

- `claimDueDataSources(db, now, { limit, leaseMs })` (`src/poller.ts`): the poller's (`apps/api/src/data`). It claims the sources whose `next_poll_at` has come, in every org, by moving it on by the lease in one statement, so overlapping runs never fetch a source twice, and returns only each one's org and id. The poll then reads and saves through `scoped(db, orgId)`.
- `organizationExists(db, orgId)`: the `/admin` template routes check the org they are told to write to.
- `findAlertWork(db, now, defaultUnreachableMs)` (`src/alerts.ts`) and `orgMembers(db, orgId)`: the API's offline alert check (M3-42). The first lists, across orgs, screens with a live credential silent past their org's threshold and no open incident, and open incidents whose screen has been heard from since; the second, an org's members with their address and role. The check then writes through `scoped(db, orgId).incidents`: `open(screenId, lastSeenAt, now)` and `clear(incidentId, now)` each return whether that call made the change, so of two overlapping checks only one emails. `screen_incidents` allows one open incident per screen (a partial unique index).
- `expireIdempotencyKeys(db, now)` (`src/retention.ts`): the API's daily retention job (F13). It deletes, in every org, idempotency keys older than about 7 days, and reads nothing. The audit log has no retention yet: its period is the owner's to choose.
- `startPairing(db, { code, pollTokenHash, now })` and `collectPairing(db, pollTokenHash, now, mint)` (`src/pairing.ts`): the screen's half of pairing. `startPairing` stores a code for 15 minutes (`PAIRING_TTL_MS`), sweeping codes past their time in the same batch, and returns false if the code is in use. `collectPairing` answers `waiting` or `expired` until the code is claimed; then it mints the credential and stores it with `scoped(db, claimedOrg).pairing.collect(...)`, the org being the one the claim stored on the code, never one the screen names. A repeat poll (a lost reply) replaces that credential with a fresh one while it is unused and the first collect was under `PAIRING_TTL_MS` ago; each step of the batch is guarded on the code still naming the credential it replaces, so of two racing polls one writes. `org.screens.credentials.markUsed(id, now)` records a credential's first use (device auth, once per credential): a used credential is never replaced.

`org.pairing.open(code, now)` says whether a code can be claimed now (unknown, expired and claimed are all false), and `org.pairing.stage.claim(code, screenId, now)` binds it to a screen staged before it in the same batch. Its second statement makes the whole batch fail, writing nothing, if the code was not open when it ran.

Base templates are written by `platform(db)` (`src/platform.ts`), the one scope that is not an org's. It reads and writes only rows with a null org: `templates`, `template_versions`, and the `platform_audit_log` that records each change. Its `templates` has the same shape as an org scope's, so one tool serves both. Only `/admin` uses it, through the tool dispatcher's platform registry. `org.templates.ownByKey(key)` and `org.templates.versions.ownVersion(templateId, version)` return the scope's own rows only, never base ones.

`org.screens.setDesiredManifest(screenId, manifestId)` keeps the manifest it replaces as `previous_manifest_id`, whose files a screen mid-switch may still fetch.

`org.screens.sync(screenId, write)` is a screen's sync in one atomic batch: its heartbeat, last-seen time and active manifest, and its hourly play counts added if the batch's `seq` is above the highest stored in its `epoch`. Each epoch keeps its own mark (`sync_epochs`), so after a re-image retries from the old and new epochs count once in any order. The repeat check is inside the SQL, so a retried or doubled request counts once. It returns the highest stored `seq` and the rows D1 wrote. `org.screens.reportManifest(screenId, id, { observedAt, arrivedAt })` is the socket's report of the active manifest. Both replace the reported manifest only with one the screen observed later (`reported_manifest_at`); a report without a trusted time is ordered by arrival. Neither moves the screen's version.

`org.dataSources.savePoll(id, { source, snapshot?, checkedAt? })` saves what one poll found in one batch: the source's patch (next poll, failures, error category, ETag), and either a changed snapshot or, for a feed that still says the same, only the snapshot's new `checked_at`. `org.dataSources.snapshots(ids)` returns each snapshot with its `checkedAt`, which sync sends a screen.

`org.screenGroups.setMembers(groupId, screenIds)` replaces a group's members in one batch, after checking the group and every screen are the org's (`NotInOrgError` otherwise, changing nothing). Staged, `stage.setMembers(group, screenIds, { newGroup?, ifVersion? })`, `stage.addMembers(group, screenIds, ifVersion?)` and `stage.removeMembers(group, screenIds, ifVersion?)` take the group as read and move its version on.

`org.assets.usage(assetIds?)` maps each asset to the ids of the spots that use it, through an image or video spot's `asset_id` or a template spot's asset map. Unused assets are absent. The asset tools use it for usage counts and to refuse deleting an asset in use.

### Staged writes

D1 has no interactive transactions, but a `batch()` is atomic. So each repository also has a `stage` (`src/writes.ts`): `org.screens.stage.update(row, patch)`, `org.assets.stage.insert(values)`, `org.screenGroups.stage.setMembers(group, screenIds)` and so on build the statements of a change without running them. They return `{ row, writes }`: the row as it will be once written (ids, timestamps and column defaults are fixed when staged, so it is exact), and opaque `Write`s, stamped with the scope's org like every other write. `org.commit(writes)` runs them in one batch: all take effect, or none. `platform(db)` has the same `stage` on `templates` and `templates.versions`, and its own `commit`.

The tool dispatcher (`packages/tools`) is what commits: a tool stages its change, and the dispatcher commits it with its audit row (`org.auditLog.stage(...)`) and, for a keyed creation, its idempotency record. `org.auditLog.append(...)` writes a row on its own, with no change to commit it with: the API's membership hook (`membershipAudit` in `apps/api/src/auth/options.ts`) uses it for the changes Better Auth makes, which run outside our batches, and tests use it to seed. Each audit row records the actor kind and id, the client id (`client_id`: `cms`, `sf-push`, an agent's OAuth client), the action, the target and a redacted detail.

### Row versions

Screens, screen groups, brand kits, data sources, spots, playlists and schedule entries have a `row_version` (`rowVersion`): 1 when inserted (a draft made again with a deleted one's id continues from its last, below), and one more with every `update`, `stage.update` and `stage.touch`, and for a playlist with `setItems` (no caller sets it; heartbeats, `setDesiredManifest`, `dataSources.savePoll` and a draft's `stage.publish` leave it alone). `stage.update(row, patch, ifVersion)` and `stage.touch(row, ifVersion)` refuse a change made from an old read: they throw `StaleVersionError` (`{ id, version }`, the version now) at once if `row` is already another version, and otherwise stage a first statement that fails the batch if the row is no longer `ifVersion` when it runs. `commit` then throws `StaleVersionError` too (`NotInOrgError` if the row is gone), and nothing in the batch is written. `stage.touch` moves a row's version and `updatedAt` on without changing its fields, for a change to what belongs to it (a group's members). The column is not `version` because a template version already has one, its semver.

### Drafts and published versions

Spots, playlists and schedule entries have a draft and a published version (`src/drafts.ts`, docs/backend-plan.md#publishing). The row's columns are the draft: `insert`, `update` and `stage.update` change only them, and drop `publishedJson` and `publishedAt` if a caller passes them. `org.spots.stage.publish(row)`, `org.playlists.stage.publish(row, items)` and `org.scheduleEntries.stage.publish(row)` stage copying the row's content as read (a playlist's with its items) into `published_json`. Each is guarded by the row's version as read, as `stage.update` is, and by its `incarnation`, a random id fixed at insert (null on rows made before migration 0019), a second check now that versions never repeat (below). A draft edited since (a playlist's items too), deleted, or deleted and made again, fails the batch with `StaleVersionError` (version 0 for one that is gone, so a publish gets `conflict` and can load again, not `not_found`) and nothing is written. Publishing is not an edit: the version stays, and `updated_at` is left as stored. `published(row)` returns the published version shaped as the row (a playlist's with `items`), or undefined if it was never published; `draftChanged(row, items?)` says whether the draft differs from it.

Versions of a draft's id never repeat within an org (#64). Deleting a spot, playlist or schedule entry, by any path (`delete`, `stage.delete`, or a schedule entry's cascade when its screen or group goes), leaves a tombstone, its id and last version (`draft_tombstones`, written by `AFTER DELETE` triggers from migration 0020); `insert` and `stage.insert` of that id start one above it, so an edit or publish guarded by a version read before the delete is refused. Another org's same id starts at 1. `stage.insert` on these three is async: it reads the tombstone to return the row's version, exact unless a delete of the same id commits in between or is staged earlier in the same batch, when the stored version is higher (an edit from the returned row is then refused, never let through). Tombstones are never pruned: one small row per deleted id per org, about 200 MB per million deletes against D1's 10 GB. drizzle-kit does not model triggers, so a migration that rebuilds one of these tables (as 0010 did) must create its trigger again, and renumbering 0020 must keep the hand-written triggers.

`org.playlists.allItems()` and `org.screenGroups.allMembers()` read every playlist's items and every group membership in one query each, for a publish. `org.settings.get()` and `org.settings.stage.set(patch)` hold the org's settings: the default playlist, refused (`NotInOrgError`) for a playlist the org does not have, and since M3-42 the defaults for new screens, the update window, the alert threshold and the alert rules (`packages/tools` `src/settings.ts` reads them with their defaults). `stage.set` changes only the fields given and moves the settings' `row_version` on; `stage.set(patch, ifVersion)` is guarded as `stage.update` is, counting an org with no row as version 1. The row also holds the org's publish revision (`publish_revision`, 0 with no row), which only `org.publishes.stage.advance(revision)` moves: it stages a guard that fails the batch (`StaleVersionError`, id `publish revision`) unless the revision is still the one the publish read, and moves it on without touching the settings' version or `updatedAt`. An org with no row gets one, at revision 1, every setting at its default and the version at 1, so the first publishes are ordered too; its `updatedAt` is that publish's time. Committed in one batch with a publish's screen switches, it puts publishes in order: one that read before another committed writes nothing. `org.publishes.stage.addScreens(publishId, rows)` stages a publish's rollout rows (`publish_screens`) for that batch, after the publish's own `stage.insert`, so a refused publish leaves no row, no rollout and no switch behind. `org.assets.usage` counts a spot's draft and its published version, so an asset a screen still plays counts as used.

`org.idempotency.get(key)` and `org.idempotency.stage({ key, action, inputSha256, outputJson })` read and stage the `idempotency_keys` record of a creating tool call, keyed `(org_id, key)`: a second record of the same key fails its whole batch.

## Better Auth's tables

`user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` and `rateLimit` are defined in `src/schema.ts` as Better Auth's CLI generates them for `apps/api`'s options (camelCase columns, `date` columns holding ISO strings), and migrated like any other table. Better Auth reads and writes them itself through the D1 binding. `apps/api/test/auth-platform.test.ts` asks Better Auth whether anything is missing, so a plugin or option change that needs a new column fails there. To see what Better Auth wants:

```sh
cd apps/api && pnpm exec auth generate --config auth.config.ts --output /tmp/better-auth.sql --yes
```

Then mirror the change in `src/schema.ts` and run `generate`.

## Schema rules

From `docs/backend-plan.md#data-model-d1`, checked against the migrated database by `test/schema.test.ts`:

- Text ids matching the contract's `ID_PATTERN`; `newId(prefix)` makes them. Integer millisecond timestamps.
- Content rows (`spots`, `playlists`, `schedule_entries`, `data_sources`, `brand_kits`) are keyed `(org_id, id)`. Content and manifests name spot, playlist, entry and data-source ids, so `insert` takes a caller's id for them (any `ID_PATTERN` id; two orgs may use the same). Every other tenant table keeps a global `id` primary key, and `insert` always makes the id itself, ignoring one the caller passes: a screen's id must be unique across orgs (its credential and its Durable Object name it alone), and nothing else needs a chosen id. `platform(db)` makes base template ids the same way. Tests that need a screen with a fixed id (a golden manifest's) use `seedScreen(db, orgId, screen)` from `@signforge/db/testing`.
- Every tenant table has `org_id NOT NULL`; its indexes lead with `org_id`; every row is unique on `(org_id, id)`.
- References between tenant rows are composite `(org_id, x_id)` foreign keys.

Deliberate exceptions: `pairing_codes` is not a tenant table (a code exists before an org claims it); nor is `platform_audit_log` (changes made outside any org); `templates` and `template_versions` allow a null org for base templates; `spots.template_version_id` references a version by id alone, because it may be a base one, and the repository checks it; it checks too that the assets a template spot's `asset_map_json` names are the org's. Every tenant `org_id` references Better Auth's `organization(id)`, without cascade. `brand_kits` is keyed `(org_id, id)` and its ids are always the server's. `brand_assignments` has no id; it is unique per target (the org, a group, a screen) by partial indexes.

Local D1 enforces foreign keys (`PRAGMA foreign_keys` is 1, and a test shows a cross-org row is refused). Production is verified in M3-00. Isolation does not depend on it: the repositories filter every query.

## Migrations

After changing `src/schema.ts`:

```sh
pnpm --filter @signforge/db generate         # writes migrations/NNNN_*.sql
cd apps/api && pnpm exec wrangler d1 migrations apply DB --local
```

`apps/api/wrangler.jsonc` points `migrations_dir` here. `0002_better_auth` rebuilds every tenant table to add the `organization` foreign key; it is safe only on a database with no tenant rows, which held for every environment when it was written. `0010_content_ids` rebuilds the four content tables with their new keys and keeps every row: D1 cannot turn foreign keys off, and dropping a parent fires its `ON DELETE CASCADE`, so it copies `playlist_items` and `data_snapshots` aside and puts them back (checked on a local D1 seeded before it ran). A later rebuild of a table with cascading children must do the same. Tests in both packages apply the same migrations to their local D1 before running.
