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
- `findDeviceScreen(db, screenId)` (`src/device.ts`): a screen's org, desired and previous manifest ids, and the hashes of its unrevoked credentials (none if the screen is revoked). The device API checks the secret against them, then uses `scoped(db, orgId)`.
  The temporary `/admin` upload routes (M3-04) also use it to find a screen's org, behind the deploy secret. The publish they end with goes through the tool registry with `scoped(db, orgId)`.

- `organizationExists(db, orgId)`: the `/admin` template routes check the org they are told to write to.

Base templates are written by `platform(db)` (`src/platform.ts`), the one scope that is not an org's. It reads and writes only rows with a null org: `templates`, `template_versions`, and the `platform_audit_log` that records each change. Its `templates` has the same shape as an org scope's, so one tool serves both. Only `/admin` uses it, through the tool dispatcher's platform registry. `org.templates.ownByKey(key)` and `org.templates.versions.ownVersion(templateId, version)` return the scope's own rows only, never base ones.

`org.screens.setDesiredManifest(screenId, manifestId)` keeps the manifest it replaces as `previous_manifest_id`, whose files a screen mid-switch may still fetch.

`org.screenGroups.setMembers(groupId, screenIds)` replaces a group's members in one batch, after checking the group and every screen are the org's (`NotInOrgError` otherwise, changing nothing).

`org.assets.usage(assetIds?)` maps each asset to the ids of the spots that use it, through an image or video spot's `asset_id` or a template spot's asset map. Unused assets are absent. The asset tools use it for usage counts and to refuse deleting an asset in use.

### Staged writes

D1 has no interactive transactions, but a `batch()` is atomic. So each repository also has a `stage` (`src/writes.ts`): `org.screens.stage.update(row, patch)`, `org.assets.stage.insert(values)`, `org.screenGroups.stage.setMembers(groupId, screenIds)` and so on build the statements of a change without running them. They return `{ row, writes }`: the row as it will be once written (ids, timestamps and column defaults are fixed when staged, so it is exact), and opaque `Write`s, stamped with the scope's org like every other write. `org.commit(writes)` runs them in one batch: all take effect, or none. `platform(db)` has the same `stage` on `templates` and `templates.versions`, and its own `commit`.

The tool dispatcher (`packages/tools`) is what commits: a tool stages its change, and the dispatcher commits it with its audit row (`org.auditLog.stage(...)`) and, for a keyed creation, its idempotency record. `org.auditLog.append(...)` writes a row on its own and is for seeding tests only. Each audit row records the actor kind and id, the client id (`client_id`: `cms`, `sf-push`, an agent's OAuth client), the action, the target and a redacted detail.

### Drafts and published versions

Spots, playlists and schedule entries have a draft and a published version (`src/drafts.ts`, docs/backend-plan.md#publishing). The row's columns are the draft: `insert`, `update` and `stage.update` change only them, and drop `publishedJson` and `publishedAt` if a caller passes them. `org.spots.stage.publish(row)`, `org.playlists.stage.publish(row, items)` and `org.scheduleEntries.stage.publish(row)` stage copying the row's content as read (a playlist's with its items) into `published_json`. `published(row)` returns the published version shaped as the row (a playlist's with `items`), or undefined if it was never published; `draftChanged(row, items?)` says whether the draft differs from it.

`org.playlists.allItems()` and `org.screenGroups.allMembers()` read every playlist's items and every group membership in one query each, for a publish. `org.settings.get()` and `org.settings.stage.set({ defaultPlaylistId })` hold the org's default playlist, refused (`NotInOrgError`) for a playlist the org does not have. `org.assets.usage` counts a spot's draft and its published version, so an asset a screen still plays counts as used.

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
- Every tenant table has `org_id NOT NULL`; its indexes lead with `org_id`; every row is unique on `(org_id, id)`.
- References between tenant rows are composite `(org_id, x_id)` foreign keys.

Deliberate exceptions: `pairing_codes` is not a tenant table (a code exists before an org claims it); nor is `platform_audit_log` (changes made outside any org); `templates` and `template_versions` allow a null org for base templates; `spots.template_version_id` references a version by id alone, because it may be a base one, and the repository checks it. Every tenant `org_id` references Better Auth's `organization(id)`, without cascade.

Local D1 enforces foreign keys (`PRAGMA foreign_keys` is 1, and a test shows a cross-org row is refused). Production is verified in M3-00. Isolation does not depend on it: the repositories filter every query.

## Migrations

After changing `src/schema.ts`:

```sh
pnpm --filter @signforge/db generate         # writes migrations/NNNN_*.sql
cd apps/api && pnpm exec wrangler d1 migrations apply DB --local
```

`apps/api/wrangler.jsonc` points `migrations_dir` here. `0002_better_auth` rebuilds every tenant table to add the `organization` foreign key; it is safe only on a database with no tenant rows, which held for every environment when it was written. Tests in both packages apply the same migrations to their local D1 before running.
