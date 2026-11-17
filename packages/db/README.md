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

`@signforge/db/testing` has `seedTwoOrgs(db)`: two orgs, `org-a` and `org-b`, each with one of everything, for isolation tests.

Code that has to find a row before it knows the org (device auth by screen id, pairing, the data-source poller) gets a narrow function here, added by the ticket that needs it. It does not get the tables. So far:

- `findDeviceScreen(db, screenId)` (`src/device.ts`): a screen's org, desired and previous manifest ids, and the hashes of its unrevoked credentials (none if the screen is revoked). The device API checks the secret against them, then uses `scoped(db, orgId)`.
  The temporary `/admin` push routes (M3-04) also use it to find a screen's org, behind the deploy secret, until M3-12 replaces them.

`org.screens.setDesiredManifest(screenId, manifestId)` keeps the manifest it replaces as `previous_manifest_id`, whose files a screen mid-switch may still fetch.

## Schema rules

From `docs/backend-plan.md#data-model-d1`, checked against the migrated database by `test/schema.test.ts`:

- Text ids matching the contract's `ID_PATTERN`; `newId(prefix)` makes them. Integer millisecond timestamps.
- Every tenant table has `org_id NOT NULL`; its indexes lead with `org_id`; every row is unique on `(org_id, id)`.
- References between tenant rows are composite `(org_id, x_id)` foreign keys.

Deliberate exceptions: `pairing_codes` is not a tenant table (a code exists before an org claims it); `templates` and `template_versions` allow a null org for base templates; `spots.template_version_id` references a version by id alone, because it may be a base one, and the repository checks it. `org_id` does not reference an organizations table yet: M3-09 adds Better Auth's tables.

Local D1 enforces foreign keys (`PRAGMA foreign_keys` is 1, and a test shows a cross-org row is refused). Production is verified in M3-00. Isolation does not depend on it: the repositories filter every query.

## Migrations

After changing `src/schema.ts`:

```sh
pnpm --filter @signforge/db generate         # writes migrations/NNNN_*.sql
cd apps/api && pnpm exec wrangler d1 migrations apply DB --local
```

`apps/api/wrangler.jsonc` points `migrations_dir` here. Tests in both packages apply the same migrations to their local D1 before running.
