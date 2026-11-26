/**
 * Test helpers: `@signforge/db/testing`. Not for production code.
 *
 * `testScope(db, orgId)` is `scoped(db, orgId)` with direct writes, so a test can set up a row in
 * one line. `seedTwoOrgs(db)` fills a migrated D1 with two orgs holding one of everything, plus
 * one base template, so an isolation test can call org B's scope with org A's ids and expect nothing.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { AGENT_GRANT_IDLE_MS } from './agent-grants';
import { scoped, type NewRow, type RowPatch } from './scoped';
import * as schema from './schema';
import { commit, type Staged, type Write } from './writes';

type StagedRow<T extends SQLiteTable> = Staged<T['$inferSelect']> | Promise<Staged<T['$inferSelect']>>;
/** A repository's read of one row and its staged writes, which `testScope` commits at once. */
interface Staging<T extends SQLiteTable> {
  get(id: string): Promise<T['$inferSelect'] | undefined>;
  stage: {
    insert(values: NewRow<T>): StagedRow<T>;
    update(current: T['$inferSelect'], patch: RowPatch<T>, ifVersion?: number): StagedRow<T>;
    delete(id: string): Staged;
  };
}

/**
 * `scoped(db, orgId)` with `insert`, `update` and `delete` on each repository, for tests and local
 * scripts. Each is the repository's `stage` write, committed at once, so it checks and stamps rows
 * exactly as a tool's write does, and each says what D1 did with it, even when another write lands
 * between its read and its commit. Production code stages and commits instead.
 */
export function testScope(db: D1Database, orgId: string) {
  const o = scoped(db, orgId);
  /** The row as written. */
  const insert =
    <T extends SQLiteTable>(stage: (values: NewRow<T>) => StagedRow<T>) =>
    async (values: NewRow<T>): Promise<T['$inferSelect']> => {
      const { row, writes } = await stage(values);
      await o.commit(writes);
      return row;
    };
  /**
   * Whether the last of `writes` changed its row, committed as the scope commits. D1 counts the
   * rows its triggers and cascades change too, so it is whether any changed.
   */
  const changedRow = async (writes: readonly Write[]) => ((await commit(drizzle(db), writes)).at(-1) ?? 0) > 0;
  const direct = <T extends SQLiteTable>(repo: Staging<T>) => ({
    insert: insert<T>(repo.stage.insert),
    /**
     * The row as changed, or undefined if the org has no such row (a base template is readable but
     * not its own). A versioned row's change is guarded by the version read, so the version
     * returned is the one D1 stored: a change that landed in between refuses it (`StaleVersionError`).
     * An empty patch changes nothing.
     */
    update: async (id: string, patch: RowPatch<T>): Promise<T['$inferSelect'] | undefined> => {
      const current = await repo.get(id);
      if (!current) return undefined;
      const { orgId: owner, rowVersion } = current as { orgId: string | null; rowVersion?: number };
      const { row, writes } = await repo.stage.update(current, patch, rowVersion);
      if (!writes.length) return owner === orgId ? row : undefined;
      return (await changedRow(writes)) ? row : undefined;
    },
    /** Whether D1 deleted the org's row: false for another org's, a base template, or one already gone. */
    delete: async (id: string): Promise<boolean> => changedRow(repo.stage.delete(id).writes),
  });
  return {
    ...o,
    screens: {
      ...o.screens,
      ...direct<typeof schema.screens>(o.screens),
      credentials: { ...o.screens.credentials, ...direct<typeof schema.screenCredentials>(o.screens.credentials) },
    },
    screenGroups: { ...o.screenGroups, ...direct<typeof schema.screenGroups>(o.screenGroups) },
    assets: {
      ...o.assets,
      ...direct<typeof schema.assets>(o.assets),
      renditions: { ...o.assets.renditions, ...direct<typeof schema.assetRenditions>(o.assets.renditions) },
    },
    templates: {
      ...o.templates,
      ...direct<typeof schema.templates>(o.templates),
      versions: { ...o.templates.versions, ...direct<typeof schema.templateVersions>(o.templates.versions) },
    },
    spots: { ...o.spots, ...direct<typeof schema.spots>(o.spots) },
    playlists: { ...o.playlists, ...direct<typeof schema.playlists>(o.playlists) },
    scheduleEntries: { ...o.scheduleEntries, ...direct<typeof schema.scheduleEntries>(o.scheduleEntries) },
    publishes: { ...o.publishes, ...direct<typeof schema.publishes>(o.publishes) },
    dataSources: { ...o.dataSources, ...direct<typeof schema.dataSources>(o.dataSources) },
    connections: {
      ...o.connections,
      ...direct<typeof schema.connections>(o.connections),
      authorizations: { ...o.connections.authorizations, insert: insert<typeof schema.connectionAuthorizations>(o.connections.authorizations.stage.insert) },
    },
    brandKits: { ...o.brandKits, ...direct<typeof schema.brandKits>(o.brandKits) },
    feedPhotos: {
      ...o.feedPhotos,
      /** A `feed_images` row as given, made at `createdAt` (default 0) and stamped with this org: a photo set up in one line. */
      put: async (row: Omit<typeof schema.feedImages.$inferInsert, 'orgId' | 'updatedAt' | 'createdAt'> & { createdAt?: number }) => {
        await drizzle(db)
          .insert(schema.feedImages)
          .values({ createdAt: 0, ...row, orgId })
          .run();
      },
      /** Many photos stored at once, as `put` makes each: one statement, its rows as one JSON value (a test of a busy org's thousands). */
      putMany: async (rows: readonly { url: string; sourceId: string; fileSha256: string; thumbSha256: string; nextCheckAt: number; createdAt: number }[]) => {
        await drizzle(db).run(sql`INSERT INTO ${schema.feedImages} (org_id, url, source_id, file_sha256, thumb_sha256, next_check_at, created_at, updated_at)
          SELECT ${orgId}, r.value ->> 'url', r.value ->> 'sourceId', r.value ->> 'fileSha256', r.value ->> 'thumbSha256', r.value ->> 'nextCheckAt', r.value ->> 'createdAt', r.value ->> 'createdAt'
          FROM json_each(${JSON.stringify(rows)}) AS r`);
      },
      /** The org's queued blob deletes, by hash. */
      deletes: () =>
        drizzle(db).select().from(schema.feedImageDeletes).where(eq(schema.feedImageDeletes.orgId, orgId)).orderBy(asc(schema.feedImageDeletes.sha256)).all(),
    },
  };
}

export type TestScope = ReturnType<typeof testScope>;

const MANIFEST = (key: string) =>
  JSON.stringify({
    id: key,
    version: '1.0.0',
    name: key,
    fields: { title: { type: 'text', label: 'Title' } },
    duration: { defaultMs: 10_000, minMs: 5_000, maxMs: 30_000 },
    orientations: ['landscape', 'portrait'],
    uses: [],
    background: '#000',
  });

/** Ids of everything seeded for one org. */
export interface SeededOrg {
  orgId: string;
  scope: TestScope;
  screen: string;
  group: string;
  credential: string;
  asset: string;
  rendition: string;
  template: string;
  templateVersion: string;
  templateSpot: string;
  imageSpot: string;
  playlist: string;
  scheduleEntry: string;
  publish: string;
  dataSource: string;
  /** A webhook delivery that was given up on, so it can be retried. */
  alertDelivery: string;
  /** A connected account, with its sealed credentials stand-in. */
  connection: string;
  auditEntry: string;
  /** A brand kit, the org's default. Its id is the server's. */
  brandKit: string;
  /** Start of the hour the seeded play count is in. */
  hour: number;
  /** An agent grant (M4-04) by a user of its own (`grantee`, not a member), for a client the provider registered. */
  agentGrant: string;
  grantee: string;
  /** A pending request by the agent grant to publish the template spot at its version (M4-09). */
  publishRequest: string;
}

/**
 * A seeded org's row for each kind of id a tool input can name (`screenId` → `screen`), and Better Auth's rows as
 * `seedTeam` names them. Not the files (`manifest`, `bundle`, `sources`): each test that maps ids names those its way.
 */
export const ORG_ROW_IDS: Record<string, (o: SeededOrg) => string> = {
  screen: (o) => o.screen,
  group: (o) => o.group,
  credential: (o) => o.credential,
  template: (o) => o.template,
  templateVersion: (o) => o.templateVersion,
  spot: (o) => o.templateSpot,
  playlist: (o) => o.playlist,
  scheduleEntry: (o) => o.scheduleEntry,
  asset: (o) => o.asset,
  brandKit: (o) => o.brandKit,
  logoOnDarkAsset: (o) => o.asset,
  logoOnLightAsset: (o) => o.asset,
  dataSource: (o) => o.dataSource,
  alertDelivery: (o) => o.alertDelivery,
  connection: (o) => o.connection,
  publish: (o) => o.publish,
  // An agent grant (M4-07's tools): `grantId`.
  grant: (o) => o.agentGrant,
  publishRequest: (o) => o.publishRequest,
  member: (o) => `${o.orgId}-member`,
  invitation: (o) => `${o.orgId}-invitation`,
};

export interface Seeded {
  a: SeededOrg;
  b: SeededOrg;
  base: { template: string; templateVersion: string };
}

export const SEED_HOUR = Date.UTC(2026, 10, 17, 13);

/** An `organization` row, as Better Auth would write it. Tenant rows reference it. */
export async function seedOrganization(db: D1Database, orgId: string) {
  await drizzle(db)
    .insert(schema.organization)
    .values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .run();
}

/** Better Auth's rows for an org's team, as its organization endpoints write them: an owner and a pending invitation. */
export async function seedTeam(db: D1Database, orgId: string) {
  const d = drizzle(db);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const userId = `${orgId}-owner`;
  await d
    .insert(schema.user)
    .values({ id: userId, name: `${orgId} owner`, email: `${userId}@signforge.test`, emailVerified: 1, createdAt: now, updatedAt: now })
    .run();
  const member = `${orgId}-member`;
  await d.insert(schema.member).values({ id: member, organizationId: orgId, userId, role: 'owner', createdAt: now }).run();
  const invitation = `${orgId}-invitation`;
  await d
    .insert(schema.invitation)
    .values({
      id: invitation,
      organizationId: orgId,
      email: `${orgId}-invitee@signforge.test`,
      role: 'viewer',
      status: 'pending',
      expiresAt: later,
      createdAt: now,
      inviterId: userId,
    })
    .run();
  return { userId, member, invitation };
}

/**
 * A screen with an id the test chooses, such as a golden manifest's. The repositories never let a
 * caller choose a screen's id (it must be unique across orgs); a test fixture may, written around them.
 */
export async function seedScreen(
  db: D1Database,
  orgId: string,
  screen: { id: string; name: string; timezone: string; orientation: 'landscape' | 'portrait'; locale?: string; displayHours?: unknown },
) {
  const now = Date.now();
  await drizzle(db)
    .insert(schema.screens)
    .values({
      id: screen.id,
      orgId,
      name: screen.name,
      timezone: screen.timezone,
      orientation: screen.orientation,
      locale: screen.locale ?? null,
      displayHoursJson: screen.displayHours ? JSON.stringify(screen.displayHours) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return screen.id;
}

/**
 * Seed one org. Content ids (spots, playlists, schedule entries, data sources) are
 * `<orgId>-<thing>`, so a test failure names whose row leaked; the rest are the server's.
 */
export async function seedOrg(db: D1Database, orgId: string, baseTemplateVersion?: string): Promise<SeededOrg> {
  await seedOrganization(db, orgId);
  const o = testScope(db, orgId);
  const id = (thing: string) => `${orgId}-${thing}`;

  const screen = await o.screens.insert({ id: id('screen'), name: `${orgId} lobby`, timezone: 'Europe/London', orientation: 'landscape' });
  const group = await o.screenGroups.insert({ id: id('group'), name: `${orgId} group` });
  await o.screenGroups.addMember(group.id, screen.id);
  await o.commit((await o.screens.labels.stage.update([screen.id], { set: { region: orgId }, remove: [] })).writes);
  const credential = await o.screens.credentials.insert({ id: id('credential'), screenId: screen.id, secretHash: '0'.repeat(64) });

  const asset = await o.assets.insert({
    id: id('asset'),
    kind: 'image',
    name: 'logo.png',
    sha256: 'a'.repeat(64),
    type: 'image/png',
    size: 1000,
    width: 1920,
    height: 1080,
    status: 'verified',
  });
  const rendition = await o.assets.renditions.insert({
    id: id('rendition'),
    assetId: asset.id,
    orientation: 'landscape',
    sha256: 'b'.repeat(64),
    type: 'image/jpeg',
    size: 900,
    width: 1920,
    height: 1080,
  });

  const template = await o.templates.insert({ id: id('template'), key: 'menu', name: 'Menu' });
  const templateVersion = await o.templates.versions.insert({
    id: id('template-version'),
    templateId: template.id,
    version: '1.0.0',
    manifestJson: MANIFEST('menu'),
    bundleSha256: 'c'.repeat(64),
    status: 'approved',
  });

  const templateSpot = await o.spots.insert({
    id: id('spot-template'),
    name: 'Menu',
    kind: 'template',
    durationMs: 10_000,
    templateVersionId: baseTemplateVersion ?? templateVersion.id,
    dataJson: JSON.stringify({ title: 'Hello' }),
    assetMapJson: '{}',
  });
  const imageSpot = await o.spots.insert({ id: id('spot-image'), name: 'Logo', kind: 'image', durationMs: 8_000, assetId: asset.id, fit: 'cover' });

  const playlist = await o.playlists.insert({ id: id('playlist'), name: 'Main', transitionJson: JSON.stringify({ type: 'cut' }) });
  await o.playlists.setItems(playlist.id, [templateSpot.id, imageSpot.id]);
  const scheduleEntry = await o.scheduleEntries.insert({ id: id('schedule'), playlistId: playlist.id, target: 'group', groupId: group.id, priority: 1 });

  // At revision 0, the org's before any publish moves it: a publish the tests make is the org's first.
  const publish = await o.publishes.insert({ id: id('publish'), status: 'published', actorKind: 'user', actorId: id('user'), revision: 0 });
  await o.publishes.addScreens(publish.id, [{ screenId: screen.id, manifestId: 'd'.repeat(64) }]);

  const dataSource = await o.dataSources.insert({ id: id('source'), name: 'Weather', format: 'json', urlEncrypted: 'enc:xyz', refreshS: 300 });
  await o.dataSources.putSnapshot(dataSource.id, { version: 'v1', fetchedAt: SEED_HOUR, checkedAt: SEED_HOUR, dataJson: '{"t":12}' });
  const connection = await o.connections.insert({
    provider: 'fake',
    account: `facilities@${orgId}.test`,
    scopesJson: '["read"]',
    status: 'active',
    credentialsSealed: 'sealed:grant',
    createdBy: id('user'),
  });

  const delivery = o.alertDeliveries.stage.insert({
    channel: 'webhook',
    eventId: id('event'),
    eventType: 'screen.offline',
    eventJson: '{}',
    status: 'failed',
    attempts: 16,
    nextAttemptAt: SEED_HOUR,
    giveUpAt: SEED_HOUR,
    lastHttpStatus: 500,
    lastError: 'http-status',
  });
  await o.commit(delivery.writes);

  const auditEntry = await o.auditLog.append({ id: id('audit'), actorKind: 'system', actorId: 'seed', action: 'seed', at: SEED_HOUR });
  const kit = await o.brandKits.insert({
    name: `${orgId} brand`,
    colorsJson: JSON.stringify({ primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' }),
    shape: 'soft',
    displayFontId: 'base/inter',
    logoOnDarkAssetId: asset.id,
  });
  await o.commit((await o.brandKits.assignments.stage.set({ target: 'org' }, kit.id)).writes);
  await o.playCounts.add(screen.id, [{ hour: SEED_HOUR, spotId: templateSpot.id, plays: 3, ms: 30_000 }]);

  // An agent's grant, as consent writes one, and its client as the provider registers it. Its user is no
  // member here: the repository keeps grants by org, whatever the membership (agentGrantForToken checks it).
  const grantee = id('grantee');
  const at = new Date(SEED_HOUR).toISOString();
  const d = drizzle(db);
  await d
    .insert(schema.user)
    .values({ id: grantee, name: `${orgId} grantee`, email: `${grantee}@signforge.test`, emailVerified: 1, createdAt: at, updatedAt: at })
    .run();
  await d
    .insert(schema.oauthClient)
    .values({
      id: id('oauth-client'),
      clientId: id('client'),
      name: 'Seeded agent',
      redirectUris: '["http://127.0.0.1/callback"]',
      createdAt: at,
      updatedAt: at,
    })
    .run();
  const agentGrant = o.agentGrants.stage.insert({
    userId: grantee,
    clientId: id('client'),
    clientName: 'Seeded agent',
    scopesJson: '["content:read","content:draft"]',
    expiresAt: SEED_HOUR + AGENT_GRANT_IDLE_MS,
  });
  await o.commit(agentGrant.writes);
  // The seeded agent's request to publish the template spot as it is (M4-09), pending: it expires
  // a century after the seeded hour, so it is pending whenever the tests run.
  const publishRequest = o.publishRequests.stage.insert(
    {
      requestedByKind: 'agent',
      requestedBy: agentGrant.row.id,
      clientId: agentGrant.row.clientId,
      draftsJson: JSON.stringify([{ kind: 'spot', id: templateSpot.id, version: templateSpot.rowVersion }]),
      reason: 'Seeded request',
      brandState: await o.brandKits.state(),
      expiresAt: SEED_HOUR + 100 * 365 * 24 * 3_600_000,
    },
    SEED_HOUR,
    10,
  );
  await o.commit(publishRequest.writes);

  return {
    orgId,
    scope: o,
    screen: screen.id,
    group: group.id,
    credential: credential.id,
    asset: asset.id,
    rendition: rendition.id,
    template: template.id,
    templateVersion: templateVersion.id,
    templateSpot: templateSpot.id,
    imageSpot: imageSpot.id,
    playlist: playlist.id,
    scheduleEntry: scheduleEntry.id,
    publish: publish.id,
    dataSource: dataSource.id,
    alertDelivery: delivery.row.id,
    agentGrant: agentGrant.row.id,
    grantee,
    publishRequest: publishRequest.row.id,
    connection: connection.id,
    auditEntry: auditEntry.id,
    brandKit: kit.id,
    hour: SEED_HOUR,
  };
}

/** A base template (null org) every org can use, with fixed ids. Production code writes base templates through `platform(db)`. */
export async function seedBaseTemplate(db: D1Database) {
  const d = drizzle(db);
  await d.insert(schema.templates).values({ id: 'base-clock', orgId: null, key: 'clock', name: 'Clock' }).onConflictDoNothing().run();
  await d
    .insert(schema.templateVersions)
    .values({
      id: 'base-clock-1',
      orgId: null,
      templateId: 'base-clock',
      version: '1.0.0',
      manifestJson: MANIFEST('clock'),
      bundleSha256: 'e'.repeat(64),
      status: 'approved',
    })
    .onConflictDoNothing()
    .run();
  return { template: 'base-clock', templateVersion: 'base-clock-1' };
}

/** Two orgs, `org-a` and `org-b`, each with one of everything; org B's template spot uses the base template. */
export async function seedTwoOrgs(db: D1Database): Promise<Seeded> {
  const base = await seedBaseTemplate(db);
  return { a: await seedOrg(db, 'org-a'), b: await seedOrg(db, 'org-b', base.templateVersion), base };
}

/** A deleted asset's files queued in `orgId` at `at`, as `delete` of an asset queues them, for the storage sweep's tests (#235). */
export async function queueDeletedFiles(db: D1Database, orgId: string, shas: string[], at: number) {
  const org = scoped(db, orgId);
  await org.commit(org.storage.stage.queue(shas, at).writes);
}

/** The storage sweep's tombstone for an org's file: it deleted the object at `at` (#432). For a writer's test. */
export async function tombstoneFile(db: D1Database, orgId: string, sha256: string, at: number) {
  await drizzle(db)
    .insert(schema.blobDeletes)
    .values({ orgId, sha256, queuedAt: 0, deletedAt: at })
    .onConflictDoUpdate({ target: [schema.blobDeletes.orgId, schema.blobDeletes.sha256], set: { deletedAt: at } })
    .run();
}

/** Runs one SQL statement on `db` with its bound values: for fixtures no repository writes. */
export const runSql = (db: D1Database, query: string, ...binds: unknown[]) =>
  db
    .prepare(query)
    .bind(...binds)
    .run();

/** The storage sweep's claim on an org's file until `until` (0: run out), as its claim batch writes it: for a writer's test. */
export async function claimFileForSweep(db: D1Database, orgId: string, sha256: string, until: number) {
  const claim = { claimOwner: 'sweep', claimUntil: until };
  await drizzle(db)
    .insert(schema.blobDeletes)
    .values({ orgId, sha256, queuedAt: 0, ...claim })
    .onConflictDoUpdate({ target: [schema.blobDeletes.orgId, schema.blobDeletes.sha256], set: claim })
    .run();
}

/** A player release as CI registers it (#628), on `channel`, for the device release endpoints' tests. */
export async function seedPlayerRelease(db: D1Database, release: typeof schema.playerReleases.$inferInsert) {
  await drizzle(db).insert(schema.playerReleases).values(release).run();
}
