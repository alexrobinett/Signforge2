/**
 * `scoped(db, orgId)`: the only way code outside this package reaches tenant tables.
 *
 * Every query a repository runs is filtered by the org it was made for, and every row it writes
 * is stamped with that org, whatever the caller passes. A call made for org B with org A's ids
 * finds nothing: reads return `undefined` or `[]`, updates and deletes change nothing.
 *
 * D1 has no row-level security and may not enforce foreign keys everywhere, so this filter is
 * the isolation boundary. The schema's composite `(org_id, id)` foreign keys are a second line.
 */
import type { ScreenKind } from '@signforge/contract';
import { and, asc, desc, eq, getTableColumns, getTableName, gt, inArray, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { assertId, newId } from './ids';
import * as s from './schema';
import { contentJson } from './drafts';
import { type AttemptResult, settleStatement } from './deliveries';
import { commit, fullRow, guard, StaleVersionError, staged, strip, updateSet, type Staged, type Write } from './writes';

type Db = DrizzleD1Database<Record<string, never>>;
type AlertChannel = typeof s.alertChannels.$inferSelect;
type AlertChannelKind = AlertChannel['kind'];
/** What a channel's owner sets; the rest is the repository's. */
type AlertChannelValues = Omit<AlertChannel, 'orgId' | 'kind' | 'rowVersion' | 'createdAt' | 'updatedAt'>;
type AlertDelivery = typeof s.alertDeliveries.$inferSelect;
/** An alert to queue: the event as a webhook receives it, the channels it goes to, and when to stop retrying it. */
export interface QueuedAlert {
  event: { id: string; type: string; json: string };
  channels: readonly AlertDelivery['channel'][];
  giveUpAt: number;
}
type TenantTable = SQLiteTable & { id: SQLiteColumn; orgId: SQLiteColumn };

/** Writing a row that refers to something the org cannot see. */
export class NotInOrgError extends Error {
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`);
    this.name = 'NotInOrgError';
  }
}

/**
 * Fields a caller may never set: the org is the scope's, the id is fixed at insert, a row's
 * version and the org's publish revision move on by themselves, a draft's incarnation is fixed at
 * insert, and a draft's published version is written only by `stage.publish` (./drafts.ts).
 */
type Guarded = 'orgId' | 'id' | 'createdAt' | 'rowVersion' | 'incarnation' | 'publishRevision' | 'publishedJson' | 'publishedAt';
export type NewRow<T extends SQLiteTable> = Omit<T['$inferInsert'], Guarded> & { id?: string };
export type RowPatch<T extends SQLiteTable> = Partial<Omit<T['$inferInsert'], Guarded>>;

/** D1 binds at most 100 parameters per statement; leave one for the org. */
function chunk<T>(rows: T[], columns: number): T[][] {
  const size = Math.max(1, Math.floor(99 / columns));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Who names a row. `content`: spots, playlists, schedule entries and data sources, whose ids
 * content and manifests name; a caller may choose one, and the table is keyed `(org_id, id)` so
 * two orgs can choose the same. `server`: everything else, made by a tool; the id is always
 * `newId(prefix)` and a caller's is ignored, so ids are unique across orgs (a screen's must be:
 * its credential and its Durable Object name it by id alone).
 */
type Ids = 'content' | 'server';

/**
 * A first statement for a batch that fails it unless the row is still `version` when it runs, so
 * a change made from an old read writes nothing (`commit` throws `StaleVersionError`). A draft
 * made again with its id continues its versions (`drafts`), so the version tells the rows apart;
 * a publish passes the draft's `incarnation` too, as a second check (./schema.ts).
 * A draft deleted since it was read is stale too, at version 0, not `NotInOrgError`: a publish
 * targets the org, not the draft, so it is a conflict to load and compile again after.
 */
function versionGuard(db: Db, orgId: string, t: typeof s.screens | typeof s.spots, id: string, version: number, incarnation?: string | null): Write {
  // Only drafts have the column; the others have no way to be made again with an id.
  const sameRow = incarnation === undefined ? sql`1` : sql`${sql.identifier('incarnation')} IS ${incarnation}`;
  const check = db
    .select({
      // json() of text that is not JSON raises an error, which aborts the batch.
      ok: sql`json(CASE WHEN EXISTS (SELECT 1 FROM ${t} WHERE ${t.orgId} = ${orgId} AND ${t.id} = ${id} AND ${t.rowVersion} = ${version} AND ${sameRow}) THEN '1' ELSE 'stale version' END)`,
    })
    .from(s.organization)
    .where(eq(s.organization.id, orgId));
  const stale = async () => {
    const r = await db
      .select({ version: t.rowVersion, same: sql<number>`${sameRow}` })
      .from(t)
      .where(and(eq(t.orgId, orgId), eq(t.id, id)))
      .get();
    if (!r) {
      if (incarnation !== undefined) return 0;
      throw new NotInOrgError('row', id);
    }
    return r.version === version && r.same ? undefined : r.version;
  };
  return guard(check, { id, version, stale });
}

/** get / list / insert / update / delete over a table with an org and an id. */
function entity<T extends TenantTable>(db: Db, orgId: string, table: T, prefix: string, ids: Ids = 'server') {
  const idFor = (values: { id?: string }) => {
    const id = ids === 'content' ? (values.id ?? newId(prefix)) : newId(prefix);
    assertId(id);
    return id;
  };
  type Row = T['$inferSelect'];
  // Drizzle's builders do not type-check over a generic table; the public signatures carry the types.
  const t = table as unknown as typeof s.screens;
  const mine = (id: string) => and(eq(t.orgId, orgId), eq(t.id, id));
  // A table with a `row_version` (screens, groups, brand kits): every change moves it on.
  const versioned = 'rowVersion' in table;
  const bump = (set: Record<string, unknown>) => (versioned ? { ...set, rowVersion: sql`${t.rowVersion} + 1` } : set);
  /**
   * The statements of a change to `current`, the row as read, whose version moves on by one.
   * With `ifVersion`, the change is refused (`StaleVersionError`) unless the row is still that
   * version: now, if `current` is already another, and again inside the batch, by a first
   * statement that fails it if another change landed between the read and the commit.
   */
  const change = (current: Row, set: Record<string, unknown>, ifVersion: number | undefined): Staged<Row> => {
    const { id, rowVersion: version } = current as { id: string; rowVersion?: number };
    if (ifVersion !== undefined) {
      if (version === undefined) throw new Error(`${prefix} rows have no version to check`);
      if (version !== ifVersion) throw new StaleVersionError(id, version);
    }
    if (!Object.keys(set).length) return { row: current, writes: [] };
    const row = (version === undefined ? { ...current, ...set } : { ...current, ...set, rowVersion: version + 1 }) as Row;
    const update = staged(
      row,
      db
        .update(t)
        .set(bump(set) as never)
        .where(mine(id)),
    );
    if (ifVersion === undefined) return update;
    return { row, writes: [versionGuard(db, orgId, t, id, ifVersion), ...update.writes] };
  };
  return {
    get: async (id: string): Promise<Row | undefined> => (await db.select().from(t).where(mine(id)).get()) as Row | undefined,
    getMany: async (ids: readonly string[]): Promise<Row[]> =>
      (
        await Promise.all(
          chunk([...ids], 1).map((part) =>
            db
              .select()
              .from(t)
              .where(and(eq(t.orgId, orgId), inArray(t.id, part)))
              .all(),
          ),
        )
      ).flat() as Row[],
    list: async (): Promise<Row[]> => (await db.select().from(t).where(eq(t.orgId, orgId)).orderBy(asc(t.id)).all()) as Row[],
    insert: async (values: NewRow<T>): Promise<Row> => {
      const id = idFor(values);
      return (await db
        .insert(t)
        .values({ ...strip(values as object), id, orgId } as never)
        .returning()
        .get()) as Row;
    },
    /** Returns the updated row, or undefined if the org has no such row. An empty patch changes nothing. */
    update: async (id: string, patch: RowPatch<T>): Promise<Row | undefined> => {
      const set = strip(patch as Record<string, unknown>);
      if (!Object.values(set).some((v) => v !== undefined)) return (await db.select().from(t).where(mine(id)).get()) as Row | undefined;
      return (await db
        .update(t)
        .set(bump(set) as never)
        .where(mine(id))
        .returning()
        .get()) as Row | undefined;
    },
    delete: async (id: string): Promise<boolean> => (await db.delete(t).where(mine(id)).returning({ id: t.id }).all()).length > 0,
    /** The same changes, staged for the scope's `commit` (./writes.ts). */
    stage: {
      insert: (values: NewRow<T>): Staged<Row> => {
        const id = idFor(values);
        const row = fullRow(t, { ...strip(values as object), id, orgId });
        return staged(row as Row, db.insert(t).values(row as never));
      },
      /**
       * `current` is the row as read; the staged row is it with the patch applied (and its version
       * moved on). An empty patch stages nothing. Pass `ifVersion`, the version the caller read,
       * to refuse the change with `StaleVersionError` if the row has changed since.
       */
      update: (current: Row, patch: RowPatch<T>, ifVersion?: number): Staged<Row> =>
        change(current, updateSet(t, strip(patch as Record<string, unknown>)), ifVersion),
      /**
       * Move a versioned row's version and `updatedAt` on without changing its fields: for a
       * change to what belongs to it (a group's members). Guarded by `ifVersion` as `update` is.
       */
      touch: (current: Row, ifVersion?: number): Staged<Row> => change(current, { updatedAt: Date.now() }, ifVersion),
      delete: (id: string): Staged => staged(undefined, db.delete(t).where(mine(id))),
    },
  };
}

/** Templates and their versions: the org's own plus base ones (null org), which it may read but not change. */
function shared<T extends SQLiteTable & { id: SQLiteColumn; orgId: SQLiteColumn }>(db: Db, orgId: string, table: T, prefix: string) {
  type Row = T['$inferSelect'];
  const own = entity(db, orgId, table, prefix, 'server');
  const t = table as unknown as typeof s.templates;
  const visible = or(eq(t.orgId, orgId), isNull(t.orgId))!;
  return {
    ...own,
    /** The org's own or a base row. */
    get: async (id: string): Promise<Row | undefined> =>
      (await db
        .select()
        .from(t)
        .where(and(visible, eq(t.id, id)))
        .get()) as Row | undefined,
    getMany: async (ids: readonly string[]): Promise<Row[]> =>
      (
        await Promise.all(
          chunk([...ids], 1).map((part) =>
            db
              .select()
              .from(t)
              .where(and(visible, inArray(t.id, part)))
              .all(),
          ),
        )
      ).flat() as Row[],
    /** The org's own and base rows. */
    list: async (): Promise<Row[]> => (await db.select().from(t).where(visible).orderBy(asc(t.id)).all()) as Row[],
  };
}

type DraftTable = typeof s.spots | typeof s.playlists | typeof s.scheduleEntries;

/**
 * A draft table's rows: `entity`, except that a row made with the id of a deleted one continues
 * its versions from the last (`draft_tombstones`, kept by delete triggers), so an edit or publish
 * made from the old row is refused on the new one. `stage.insert` reads that version to give the
 * exact row, so it is async.
 */
function drafts<T extends DraftTable>(db: Db, orgId: string, table: T, prefix: string) {
  type Row = T['$inferSelect'];
  const rows = entity(db, orgId, table, prefix, 'content');
  // Drizzle's builders do not type-check over a generic table; the public signatures carry the types.
  const t = table as unknown as typeof s.spots;
  const dt = s.draftTombstones;
  const tableName = getTableName(t) as (typeof dt.$inferSelect)['draftTable'];
  const deleted = (id: string) =>
    db
      .select({ version: dt.rowVersion })
      .from(dt)
      .where(and(eq(dt.orgId, orgId), eq(dt.draftTable, tableName), eq(dt.draftId, id)));
  const firstVersion = (id: string) => sql`coalesce((${deleted(id)}), 0) + 1`;
  const idFor = (values: { id?: string }) => {
    const id = values.id ?? newId(prefix);
    assertId(id);
    return id;
  };
  return {
    ...rows,
    insert: async (values: NewRow<T>): Promise<Row> => {
      const id = idFor(values);
      return (await db
        .insert(t)
        .values({ ...strip(values as object), id, orgId, rowVersion: firstVersion(id) } as never)
        .returning()
        .get()) as Row;
    },
    stage: {
      ...rows.stage,
      insert: async (values: NewRow<T>): Promise<Staged<Row>> => {
        const id = idFor(values);
        const rowVersion = ((await deleted(id).get())?.version ?? 0) + 1;
        const row = fullRow(t, { ...strip(values as object), id, orgId, rowVersion });
        // Read again when it runs, so a delete committed in between, or staged earlier in the same batch, still counts. The row then says a lower version than stored, which refuses an edit made from it: never one let through.
        return staged(row as Row, db.insert(t).values({ ...row, rowVersion: firstVersion(id) } as never));
      },
      publish: publisher(db, orgId, table),
    },
  };
}

/**
 * Stage making a draft row's content (as read, plus a playlist's items) its published version.
 * Refused, writing nothing, if the draft was edited since it was read (its version moved on: a
 * playlist's moves with its items too), so a publish never promotes content older than the draft.
 * Not an edit: the version stays, and `updated_at` keeps the draft's last edit as stored.
 */
function publisher<T extends DraftTable>(db: Db, orgId: string, table: T) {
  const t = table as unknown as typeof s.spots;
  return (row: T['$inferSelect'], items?: readonly string[]): Staged<T['$inferSelect']> => {
    const set = { publishedJson: contentJson(row, items), publishedAt: Date.now() };
    const promoted = staged(
      { ...row, ...set },
      db
        .update(t)
        // Set to itself, or Drizzle's `$onUpdateFn` would stamp it now.
        .set({ ...set, updatedAt: sql`${t.updatedAt}` })
        .where(and(eq(t.orgId, orgId), eq(t.id, row.id))),
    );
    return { row: promoted.row, writes: [versionGuard(db, orgId, t, row.id, row.rowVersion, row.incarnation), ...promoted.writes] };
  };
}

/**
 * Whether a screen's report of the manifest on screen replaces the one stored (gh-44), as SQL over
 * `screens`, and the time stored with it. One observed on a trusted clock replaces only a report
 * observed earlier, so a sync built before a socket's `applied` cannot undo it when it arrives
 * after; of two at one time the first stays. A time after the report arrived counts as its
 * arrival, so a clock ahead cannot hold the column. Without a time (a player before gh-44, or an
 * untrusted clock) a report is ordered by arrival, as before: it replaces, and counts as observed then.
 */
function manifestReport(observedAt: number | undefined, arrivedAt: number) {
  const at = Math.min(observedAt ?? arrivedAt, arrivedAt);
  return { at, takes: '(? OR reported_manifest_at IS NULL OR ? > reported_manifest_at)', takesArgs: [observedAt === undefined ? 1 : 0, at] };
}

/** What one screen sync writes (`screens.sync`). Hours are UTC hour starts in ms. */
export interface SyncWrite {
  at: number;
  playerVersion: string;
  heartbeatJson: string;
  /** The manifest the heartbeat says is playing, if any. */
  active?: string;
  /** When the screen observed `active`, on the server's clock; absent if its clock is untrusted. */
  observedAt?: number;
  epoch: string;
  seq: number;
  counts: readonly { hour: number; spotId: string; plays: number; ms: number }[];
}

type Snapshot = Omit<typeof s.dataSnapshots.$inferInsert, 'orgId' | 'dataSourceId'>;

export function scoped(d1: D1Database, orgId: string) {
  assertId(orgId, 'orgId');
  const db: Db = drizzle(d1);

  const screens = entity(db, orgId, s.screens, 'scr');
  const screenGroups = entity(db, orgId, s.screenGroups, 'grp');
  const screenCredentials = entity(db, orgId, s.screenCredentials, 'crd');
  const assets = entity(db, orgId, s.assets, 'ast');
  const assetRenditions = entity(db, orgId, s.assetRenditions, 'rnd');
  const templates = shared(db, orgId, s.templates, 'tpl');
  const templateVersions = shared(db, orgId, s.templateVersions, 'tpv');
  const spotRows = drafts(db, orgId, s.spots, 'spt');
  const playlists = drafts(db, orgId, s.playlists, 'pls');
  const scheduleEntries = drafts(db, orgId, s.scheduleEntries, 'sch');
  const publishes = entity(db, orgId, s.publishes, 'pub');
  const dataSources = entity(db, orgId, s.dataSources, 'src', 'content');
  const connectionRows = entity(db, orgId, s.connections, 'con');
  const authorizations = entity(db, orgId, s.connectionAuthorizations, 'oas');
  const audit = entity(db, orgId, s.auditLog, 'aud');
  const brandKitRows = entity(db, orgId, s.brandKits, 'bk');

  /** A spot may use the org's own template versions or base ones; the foreign key cannot say so. */
  const checkTemplateVersion = async (id: string | null | undefined) => {
    if (id != null && !(await templateVersions.get(id))) throw new NotInOrgError('template version', id);
  };
  /** A template spot's image fields name assets in JSON, which no foreign key covers: each must be the org's. */
  const checkAssetMap = async (json: string | null | undefined) => {
    if (json == null) return;
    const ids = [...new Set(Object.values(JSON.parse(json) as Record<string, string>))];
    const found = new Set((await assets.getMany(ids)).map((a) => a.id));
    for (const id of ids) if (!found.has(id)) throw new NotInOrgError('asset', id);
  };
  type SpotPatch = { templateVersionId?: string | null; assetMapJson?: string | null; assetId?: string | null };
  const checkSpot = async (v: SpotPatch) => {
    await checkTemplateVersion(v.templateVersionId);
    await checkAssetMap(v.assetMapJson);
    if (v.assetId != null && !(await assets.get(v.assetId))) throw new NotInOrgError('asset', v.assetId);
  };

  /** A provider source's connection, or a reconnect's, must be the org's: the column has no foreign key (./schema.ts). */
  const checkConnection = async (id: string | null | undefined) => {
    if (id != null && !(await connectionRows.get(id))) throw new NotInOrgError('connection', id);
  };
  const cn = s.connections;
  const cna = s.connectionAuthorizations;
  /** A poll's change to a connection, made only while it still holds the grant the poll read (`from`). Whether it wrote. */
  const changeGrant = async (id: string, from: string, set: RowPatch<typeof s.connections>) =>
    (
      await db
        .update(cn)
        .set(updateSet(cn, set))
        .where(and(eq(cn.orgId, orgId), eq(cn.id, id), eq(cn.credentialsSealed, from)))
        .returning({ id: cn.id })
        .all()
    ).length > 0;

  const m = s.screenGroupMembers;
  const os = s.orgSettings;
  const inc = s.screenIncidents;
  const ac = s.alertChannels;
  const ad = s.alertDeliveries;
  const alertDeliveries = entity(db, orgId, ad, 'dlv');
  /**
   * The statements that queue `alert` for each of its channels when `when` holds as they run; an
   * event already queued for a channel is left as it is. INSERT ... SELECT, so the condition is
   * read in the same batch as the rest.
   */
  const queueAlert = ({ event, channels, giveUpAt }: QueuedAlert, now: number, when: SQL) =>
    channels.map((channel) => {
      const row = fullRow(ad, {
        id: newId('dlv'),
        orgId,
        channel,
        eventId: event.id,
        eventType: event.type,
        eventJson: event.json,
        nextAttemptAt: now,
        giveUpAt,
        createdAt: now,
        updatedAt: now,
      });
      // Every column, in the table's order, as INSERT ... SELECT takes them.
      const values = Object.keys(getTableColumns(ad)).map((key) => sql`${row[key]}`);
      return db
        .insert(ad)
        .select(sql`SELECT ${sql.join(values, sql`, `)} WHERE ${when}`)
        .onConflictDoNothing();
    });

  type Group = typeof s.screenGroups.$inferSelect;
  /** The screens, once each. Throws `NotInOrgError` if any is not the org's. */
  const orgScreens = async (screenIds: readonly string[]) => {
    const unique = [...new Set(screenIds)];
    const found = new Set((await screens.getMany(unique)).map((r) => r.id));
    for (const id of unique) if (!found.has(id)) throw new NotInOrgError('screen', id);
    return unique;
  };
  const inserts = (groupId: string, screenIds: string[]) =>
    chunk(
      screenIds.map((screenId) => ({ orgId, groupId, screenId })),
      3,
    ).map((part) => db.insert(m).values(part).onConflictDoNothing());
  /**
   * A change to a group's members, after the group's own statements (`touch`: its version moves
   * on, guarded by `ifVersion`), so a guard that fails stops the membership change too.
   */
  const withTouch = (group: Group, ifVersion: number | undefined, ...queries: unknown[]): Staged<Group> => {
    const touched = screenGroups.stage.touch(group, ifVersion);
    return { row: touched.row, writes: [...touched.writes, ...staged(undefined, ...queries).writes] };
  };
  /**
   * A group's members replaced, as read in `group`. A group staged in the same batch (`newGroup`)
   * is not stored yet: its version stays as staged. Throws `NotInOrgError` if the group or any
   * screen is not the org's.
   */
  const stageMembers = async (
    group: Group,
    screenIds: readonly string[],
    { newGroup = false, ifVersion }: { newGroup?: boolean; ifVersion?: number } = {},
  ): Promise<Staged<Group>> => {
    if (!newGroup && !(await screenGroups.get(group.id))) throw new NotInOrgError('group', group.id);
    const unique = await orgScreens(screenIds);
    const queries = [db.delete(m).where(and(eq(m.orgId, orgId), eq(m.groupId, group.id))), ...inserts(group.id, unique)];
    return newGroup ? staged(group, ...queries) : withTouch(group, ifVersion, ...queries);
  };
  /** A kit's logos must be the org's own assets. */
  const checkLogos = async (v: { logoOnDarkAssetId?: string | null; logoOnLightAssetId?: string | null }) => {
    for (const id of [v.logoOnDarkAssetId, v.logoOnLightAssetId]) if (id != null && !(await assets.get(id))) throw new NotInOrgError('asset', id);
  };
  const ba = s.brandAssignments;
  type BrandTarget = { target: 'org' } | { target: 'group'; groupId: string } | { target: 'screen'; screenId: string };
  const whereTarget = (t: BrandTarget) =>
    t.target === 'org'
      ? and(eq(ba.orgId, orgId), eq(ba.target, 'org'))
      : t.target === 'group'
        ? and(eq(ba.orgId, orgId), eq(ba.groupId, t.groupId))
        : and(eq(ba.orgId, orgId), eq(ba.screenId, t.screenId));
  const pi = s.playlistItems;
  /** Throws `NotInOrgError` unless every spot is the org's. */
  const checkSpots = async (spotIds: readonly string[]) => {
    const found = new Set((await spotRows.getMany([...new Set(spotIds)])).map((r) => r.id));
    for (const id of spotIds) if (!found.has(id)) throw new NotInOrgError('spot', id);
  };
  const itemRows = (playlistId: string, spotIds: readonly string[]) =>
    chunk(
      spotIds.map((spotId, position) => ({ orgId, playlistId, position, spotId })),
      4,
    ).map((part) => db.insert(pi).values(part));
  const ps = s.publishScreens;
  const snap = s.dataSnapshots;
  const pc = s.playCounts;
  const pcodes = s.pairingCodes;

  return {
    orgId,
    /** Run staged writes (from any `stage` of this scope) in one atomic batch: all of them take effect, or none. */
    commit: (writes: readonly Write[]) => commit(db, writes),
    screens: {
      ...screens,
      credentials: {
        ...screenCredentials,
        forScreen: (screenId: string) =>
          db
            .select()
            .from(s.screenCredentials)
            .where(and(eq(s.screenCredentials.orgId, orgId), eq(s.screenCredentials.screenId, screenId)))
            .orderBy(asc(s.screenCredentials.createdAt))
            .all(),
        /**
         * Record a credential's first use (device auth calls this once per credential, when
         * `findDeviceScreen` says it is unused). A used credential is never replaced by a repeat
         * pairing poll.
         */
        markUsed: async (credentialId: string, now: number) => {
          await db
            .update(s.screenCredentials)
            .set({ lastUsedAt: now })
            .where(and(eq(s.screenCredentials.orgId, orgId), eq(s.screenCredentials.id, credentialId), isNull(s.screenCredentials.lastUsedAt)))
            .run();
        },
      },
      /**
       * Up to `limit` screens after `afterId`, by id, with only what their state is worked out
       * from: for the fleet poll, which must not read the org's whole list. One statement over the
       * `(org_id, id)` index; `credentialsRevoked` is whether the screen had credentials and every
       * one is revoked, read through `(org_id, screen_id)`.
       */
      statusPage: ({ afterId, limit }: { afterId?: string; limit: number }) => {
        const sc = s.screens;
        const c = s.screenCredentials;
        const credentials = (more: SQL = sql`1`) => sql`SELECT 1 FROM ${c} WHERE ${c.orgId} = ${sc.orgId} AND ${c.screenId} = ${sc.id} AND ${more}`;
        return db
          .select({
            id: sc.id,
            status: sc.status,
            timezone: sc.timezone,
            displayHoursJson: sc.displayHoursJson,
            desiredManifestId: sc.desiredManifestId,
            reportedManifestId: sc.reportedManifestId,
            lastSeenAt: sc.lastSeenAt,
            heartbeatJson: sc.heartbeatJson,
            credentialsRevoked: sql<boolean>`EXISTS (${credentials()}) AND NOT EXISTS (${credentials(isNull(c.revokedAt))})`.mapWith(Boolean),
          })
          .from(sc)
          .where(and(eq(sc.orgId, orgId), afterId === undefined ? undefined : gt(sc.id, afterId)))
          .orderBy(asc(sc.id))
          .limit(limit)
          .all();
      },
      /**
       * Make `manifestId` the screen's desired manifest. The one it replaces becomes the previous
       * manifest, whose files a screen still mid-download may fetch. Setting the current one again
       * changes nothing. Returns false if the org has no such screen.
       */
      setDesiredManifest: async (screenId: string, manifestId: string) => {
        const sc = s.screens;
        const row = await db
          .update(sc)
          .set({
            previousManifestId: sql`CASE WHEN ${sc.desiredManifestId} IS ${manifestId} THEN ${sc.previousManifestId} ELSE ${sc.desiredManifestId} END`,
            desiredManifestId: manifestId,
          })
          .where(and(eq(sc.orgId, orgId), eq(sc.id, screenId)))
          .returning({ id: sc.id })
          .get();
        return row !== undefined;
      },
      stage: {
        ...screens.stage,
        /** As `setDesiredManifest`, staged. Stages nothing for a screen the org does not have. */
        setDesiredManifest: (screenId: string, manifestId: string): Staged => {
          const sc = s.screens;
          return staged(
            undefined,
            db
              .update(sc)
              .set({
                previousManifestId: sql`CASE WHEN ${sc.desiredManifestId} IS ${manifestId} THEN ${sc.previousManifestId} ELSE ${sc.desiredManifestId} END`,
                desiredManifestId: manifestId,
              })
              .where(and(eq(sc.orgId, orgId), eq(sc.id, screenId))),
          );
        },
      },
      /**
       * The manifest a screen says is on screen, from its socket's `applied`. A sync's heartbeat
       * writes the same column (`sync`), so it holds the latest observed over either transport
       * (`manifestReport`). Telemetry, not a setting: the row's version and `updatedAt` stay, so an
       * editor open on the screen does not conflict with its own rollout. A repeat without a time
       * writes no row; a newer timed repeat moves the time on, so a sync observed before it cannot win.
       */
      reportManifest: async (screenId: string, manifestId: string, when: { observedAt?: number; arrivedAt: number }) => {
        const r = manifestReport(when.observedAt, when.arrivedAt);
        await d1
          .prepare(
            `UPDATE screens SET reported_manifest_id = ?, reported_manifest_at = ?
             WHERE org_id = ? AND id = ? AND (reported_manifest_id IS NOT ? OR ? = 0) AND ${r.takes}`,
          )
          .bind(manifestId, r.at, orgId, screenId, manifestId, when.observedAt === undefined ? 1 : 0, ...r.takesArgs)
          .run();
      },
      /**
       * A screen's sync (`POST /v1/device/sync`), in one atomic batch: its heartbeat, last-seen
       * time and the manifest it reports playing (`reportManifest`), and its play counts added to
       * the hourly totals if the batch's `seq` is above the highest stored in its `epoch`
       * (`sync_epochs`; seq 0 is no batch). Each epoch keeps its own mark, so retries from before
       * and after a re-image count once in any order. The check is in the statements, so two
       * copies of one request racing still count once. Leaves `updatedAt`, the settings' change
       * time, alone. Returns the highest seq stored in the epoch, and the rows D1 wrote (the
       * budget's unit), or undefined if the org has no such screen.
       */
      sync: async (screenId: string, v: SyncWrite): Promise<{ ackSeq: number; rowsWritten: number } | undefined> => {
        const mark = 'coalesce((SELECT ack_seq FROM sync_epochs WHERE org_id = ? AND screen_id = ? AND epoch = ?), 0)';
        const markArgs = [orgId, screenId, v.epoch];
        const inserts = chunk([...v.counts], 7).map((part) =>
          d1
            .prepare(
              `INSERT INTO play_counts (org_id, screen_id, hour, spot_id, plays, ms)
               SELECT column1, column2, column3, column4, column5, column6 FROM (VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')})
               WHERE EXISTS (SELECT 1 FROM screens WHERE org_id = ? AND id = ?) AND ? > ${mark}
               ON CONFLICT (org_id, screen_id, hour, spot_id) DO UPDATE SET plays = plays + excluded.plays, ms = ms + excluded.ms`,
            )
            .bind(...part.flatMap((c) => [orgId, screenId, c.hour, c.spotId, c.plays, c.ms]), orgId, screenId, v.seq, ...markArgs),
        );
        // A repeat or an older seq leaves the mark, and writes nothing.
        const advance = d1
          .prepare(
            `INSERT INTO sync_epochs (org_id, screen_id, epoch, ack_seq)
             SELECT org_id, id, ?, ? FROM screens WHERE org_id = ? AND id = ? AND ? > 0
             ON CONFLICT (org_id, screen_id, epoch) DO UPDATE SET ack_seq = excluded.ack_seq WHERE excluded.ack_seq > sync_epochs.ack_seq`,
          )
          .bind(v.epoch, v.seq, orgId, screenId, v.seq);
        // The manifest it reports replaces the stored one only if observed later (`manifestReport`).
        const r = manifestReport(v.observedAt, v.at);
        const report =
          v.active === undefined
            ? { sql: '', args: [] }
            : {
                sql: `, reported_manifest_id = CASE WHEN ${r.takes} THEN ? ELSE reported_manifest_id END,
                   reported_manifest_at = CASE WHEN ${r.takes} THEN ? ELSE reported_manifest_at END`,
                args: [...r.takesArgs, v.active, ...r.takesArgs, r.at],
              };
        const update = d1
          .prepare(
            `UPDATE screens SET last_seen_at = ?, player_version = ?, heartbeat_json = ?${report.sql}
             WHERE org_id = ? AND id = ? RETURNING ${mark} AS ack_seq`,
          )
          .bind(v.at, v.playerVersion, v.heartbeatJson, ...report.args, orgId, screenId, ...markArgs);
        const results = await d1.batch([...inserts, advance, update]);
        const row = results.at(-1)!.results[0] as { ack_seq: number } | undefined;
        if (!row) return undefined;
        return { ackSeq: row.ack_seq, rowsWritten: results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0) };
      },
      /** Ids of the groups a screen belongs to. */
      groupsOf: async (screenId: string) =>
        (
          await db
            .select({ id: m.groupId })
            .from(m)
            .where(and(eq(m.orgId, orgId), eq(m.screenId, screenId)))
            .all()
        ).map((r) => r.id),
    },

    /**
     * Claiming a pairing code (M3-08). A code belongs to no org until claimed, so `open` reads it
     * by code alone, and says only whether it can be claimed now, with the kind of screen showing
     * it: an unknown, expired or claimed code are all undefined, so a claim cannot tell another
     * org's code from a wrong guess.
     */
    pairing: {
      open: async (code: string, now: number): Promise<ScreenKind | undefined> =>
        (
          await db
            .select({ kind: pcodes.kind })
            .from(pcodes)
            .where(and(eq(pcodes.code, code), isNull(pcodes.claimedOrgId), sql`${pcodes.expiresAt} > ${now}`))
            .get()
        )?.kind,
      stage: {
        /**
         * Bind an open code to `screenId`, staged after the screen's insert (the code references
         * it). The batch fails, writing nothing, if the code was not open when it ran: expired, or
         * claimed by someone else first. The second statement is that check.
         */
        claim: (code: string, screenId: string, now: number): Staged =>
          staged(
            undefined,
            db
              .update(pcodes)
              .set({ claimedOrgId: orgId, claimedScreenId: screenId, claimedAt: now })
              .where(and(eq(pcodes.code, code), isNull(pcodes.claimedOrgId), sql`${pcodes.expiresAt} > ${now}`)),
            // json() of text that is not JSON raises an error, which aborts the batch.
            db
              .select({
                open: sql`json(CASE WHEN EXISTS (SELECT 1 FROM ${pcodes} WHERE ${pcodes.code} = ${code} AND ${pcodes.claimedOrgId} = ${orgId} AND ${pcodes.claimedScreenId} = ${screenId}) THEN '1' ELSE 'pairing code is not open' END)`,
              })
              .from(s.organization)
              .where(eq(s.organization.id, orgId)),
          ),
      },
      /**
       * A screen collecting the credential for a code this org claimed (`collectPairing`,
       * ./pairing.ts, which finds the code by poll token and makes this scope from the org the
       * claim stored). Stores `secretHash` as the screen's credential `credentialId`, replacing
       * `previous` (the credential an earlier collect of this code stored) if that one is still
       * unused. One batch, every step guarded on the code still naming `previous`, so of two
       * racing collects one writes and the other changes nothing. Returns whether it wrote.
       */
      collect: async (v: { codeId: string; screenId: string; previous: string | null; credentialId: string; secretHash: string; now: number }) => {
        assertId(v.credentialId);
        const code = 'SELECT 1 FROM pairing_codes WHERE id = ? AND claimed_org_id = ? AND claimed_screen_id = ? AND collected_credential_id IS ?';
        const codeArgs = [v.codeId, orgId, v.screenId, v.previous];
        const [, inserted] = await d1.batch([
          d1
            .prepare(`DELETE FROM screen_credentials WHERE org_id = ? AND id = ? AND last_used_at IS NULL AND revoked_at IS NULL AND EXISTS (${code})`)
            .bind(orgId, v.previous, ...codeArgs),
          d1
            .prepare(
              `INSERT INTO screen_credentials (id, org_id, screen_id, secret_hash, created_at)
               SELECT ?, ?, ?, ?, ? WHERE EXISTS (${code}) AND NOT EXISTS (SELECT 1 FROM screen_credentials WHERE org_id = ? AND id IS ?)`,
            )
            .bind(v.credentialId, orgId, v.screenId, v.secretHash, v.now, ...codeArgs, orgId, v.previous),
          d1
            .prepare(
              `UPDATE pairing_codes SET collected_credential_id = ?, collected_at = coalesce(collected_at, ?)
               WHERE id = ? AND claimed_org_id = ? AND claimed_screen_id = ? AND collected_credential_id IS ?
                 AND EXISTS (SELECT 1 FROM screen_credentials WHERE org_id = ? AND id = ?)`,
            )
            .bind(v.credentialId, v.now, ...codeArgs, orgId, v.credentialId),
        ]);
        return inserted?.meta.changes === 1;
      },
    },

    screenGroups: {
      ...screenGroups,
      /** Every membership in the org, by group then screen. */
      allMembers: () =>
        db.select({ groupId: m.groupId, screenId: m.screenId }).from(m).where(eq(m.orgId, orgId)).orderBy(asc(m.groupId), asc(m.screenId)).all(),
      /** Ids of the screens in a group. */
      members: async (groupId: string) =>
        (
          await db
            .select({ id: m.screenId })
            .from(m)
            .where(and(eq(m.orgId, orgId), eq(m.groupId, groupId)))
            .all()
        ).map((r) => r.id),
      addMember: async (groupId: string, screenId: string) => {
        if (!(await screenGroups.get(groupId))) throw new NotInOrgError('group', groupId);
        if (!(await screens.get(screenId))) throw new NotInOrgError('screen', screenId);
        await db.insert(m).values({ orgId, groupId, screenId }).onConflictDoNothing().run();
      },
      removeMember: async (groupId: string, screenId: string) =>
        (
          await db
            .delete(m)
            .where(and(eq(m.orgId, orgId), eq(m.groupId, groupId), eq(m.screenId, screenId)))
            .returning()
            .all()
        ).length > 0,
      /** Replace a group's members. Throws `NotInOrgError`, changing nothing, if the group or any screen is not the org's. */
      setMembers: async (groupId: string, screenIds: readonly string[]) => {
        const group = await screenGroups.get(groupId);
        if (!group) throw new NotInOrgError('group', groupId);
        await commit(db, (await stageMembers(group, screenIds)).writes);
      },
      /**
       * Group membership, staged. Each takes the group as read and returns it as it will be: its
       * version moves on, and `ifVersion` refuses the change (`StaleVersionError`) if it moved
       * since. Each throws `NotInOrgError` if the group or a screen is not the org's.
       */
      stage: {
        ...screenGroups.stage,
        /** Replace the members. Pass `newGroup` for a group staged in the same batch, which is not stored yet. */
        setMembers: stageMembers,
        /** Add screens; ones already in the group stay as they are. */
        addMembers: async (group: Group, screenIds: readonly string[], ifVersion?: number): Promise<Staged<Group>> => {
          if (!(await screenGroups.get(group.id))) throw new NotInOrgError('group', group.id);
          return withTouch(group, ifVersion, ...inserts(group.id, await orgScreens(screenIds)));
        },
        /** Remove screens; ones not in the group are ignored. */
        removeMembers: async (group: Group, screenIds: readonly string[], ifVersion?: number): Promise<Staged<Group>> => {
          if (!(await screenGroups.get(group.id))) throw new NotInOrgError('group', group.id);
          const ids = [...new Set(screenIds)];
          return withTouch(
            group,
            ifVersion,
            ...chunk(ids, 1).map((part) => db.delete(m).where(and(eq(m.orgId, orgId), eq(m.groupId, group.id), inArray(m.screenId, part)))),
          );
        },
      },
    },

    assets: {
      ...assets,
      /**
       * The spots that use each asset: an image or video spot's `asset_id`, or a template spot's
       * asset map. Assets no spot uses are absent. Pass ids to look at those assets only.
       */
      usage: async (assetIds?: readonly string[]): Promise<Map<string, string[]>> => {
        const sp = s.spots;
        // The draft's assets and the published version's: a screen may be playing the latter.
        const rows = await db
          .select({ id: sp.id, assetId: sp.assetId, assetMapJson: sp.assetMapJson, publishedJson: sp.publishedJson })
          .from(sp)
          .where(
            and(
              eq(sp.orgId, orgId),
              or(sql`${sp.assetId} IS NOT NULL`, sql`${sp.assetMapJson} IS NOT NULL AND ${sp.assetMapJson} <> '{}'`, sql`${sp.publishedJson} IS NOT NULL`),
            ),
          )
          .orderBy(asc(sp.id))
          .all();
        const wanted = assetIds ? new Set(assetIds) : undefined;
        const out = new Map<string, string[]>();
        const add = (assetId: unknown, spotId: string) => {
          if (typeof assetId !== 'string' || (wanted && !wanted.has(assetId))) return;
          const list = out.get(assetId) ?? [];
          if (list.at(-1) !== spotId) list.push(spotId);
          out.set(assetId, list);
        };
        const parse = (json: unknown): unknown => {
          try {
            return typeof json === 'string' ? JSON.parse(json) : undefined;
          } catch {
            return undefined;
          }
        };
        const addAll = (spotId: string, assetId: unknown, assetMapJson: unknown) => {
          add(assetId, spotId);
          // Field name to asset id; a list field may hold several.
          const map = parse(assetMapJson);
          if (map && typeof map === 'object') for (const v of Object.values(map)) for (const a of Array.isArray(v) ? v : [v]) add(a, spotId);
        };
        for (const r of rows) {
          addAll(r.id, r.assetId, r.assetMapJson);
          const pub = parse(r.publishedJson) as { assetId?: unknown; assetMapJson?: unknown } | undefined;
          if (pub) addAll(r.id, pub.assetId, pub.assetMapJson);
        }
        return out;
      },
      renditions: {
        ...assetRenditions,
        forAsset: (assetId: string) =>
          db
            .select()
            .from(s.assetRenditions)
            .where(and(eq(s.assetRenditions.orgId, orgId), eq(s.assetRenditions.assetId, assetId)))
            .all(),
      },
    },

    templates: {
      ...templates,
      /** The org's own template whose `template.json` id is `key`. Never a base one. */
      ownByKey: (key: string) =>
        db
          .select()
          .from(s.templates)
          .where(and(eq(s.templates.orgId, orgId), eq(s.templates.key, key)))
          .get(),
      versions: {
        ...templateVersions,
        /** The org's own version of one of its templates. Never a base one. */
        ownVersion: (templateId: string, version: string) => {
          const tv = s.templateVersions;
          return db
            .select()
            .from(tv)
            .where(and(eq(tv.orgId, orgId), eq(tv.templateId, templateId), eq(tv.version, version)))
            .get();
        },
        /** A base version whose bundle is this hash: base bundles live in R2's shared prefix, which every org may read. */
        baseBundle: (bundleSha256: string) => {
          const tv = s.templateVersions;
          return db
            .select()
            .from(tv)
            .where(and(isNull(tv.orgId), eq(tv.bundleSha256, bundleSha256)))
            .get();
        },
        /** Versions of one template, if the org can see it. */
        forTemplate: async (templateId: string) => {
          const tv = s.templateVersions;
          return db
            .select()
            .from(tv)
            .where(and(or(eq(tv.orgId, orgId), isNull(tv.orgId)), eq(tv.templateId, templateId)))
            .orderBy(asc(tv.createdAt))
            .all();
        },
      },
    },

    spots: {
      ...spotRows,
      insert: async (values: NewRow<typeof s.spots>) => {
        await checkSpot(values);
        return spotRows.insert(values);
      },
      update: async (id: string, patch: RowPatch<typeof s.spots>) => {
        await checkSpot(patch);
        return spotRows.update(id, patch);
      },
      stage: {
        ...spotRows.stage,
        insert: async (values: NewRow<typeof s.spots>) => {
          await checkSpot(values);
          return spotRows.stage.insert(values);
        },
        /** With `ifVersion`, refused (`StaleVersionError`) unless the draft is still that version, as for every versioned row. */
        update: async (current: typeof s.spots.$inferSelect, patch: RowPatch<typeof s.spots>, ifVersion?: number) => {
          await checkSpot(patch);
          return spotRows.stage.update(current, patch, ifVersion);
        },
      },
    },

    playlists: {
      ...playlists,
      /** Every playlist's draft items: playlist id to spot ids in play order. Playlists with none are absent. */
      allItems: async () => {
        const rows = await db
          .select({ playlistId: pi.playlistId, spotId: pi.spotId })
          .from(pi)
          .where(eq(pi.orgId, orgId))
          .orderBy(asc(pi.playlistId), asc(pi.position))
          .all();
        const out = new Map<string, string[]>();
        for (const r of rows) out.set(r.playlistId, [...(out.get(r.playlistId) ?? []), r.spotId]);
        return out;
      },
      /** Spot ids in play order. */
      items: async (playlistId: string) =>
        (
          await db
            .select({ spotId: pi.spotId })
            .from(pi)
            .where(and(eq(pi.orgId, orgId), eq(pi.playlistId, playlistId)))
            .orderBy(asc(pi.position))
            .all()
        ).map((r) => r.spotId),
      /** Replace a playlist's items: an edit of its draft, so its version moves on. */
      setItems: async (playlistId: string, spotIds: readonly string[]) => {
        if (!(await playlists.get(playlistId))) throw new NotInOrgError('playlist', playlistId);
        await checkSpots(spotIds);
        const pl = s.playlists;
        await db.batch([
          db
            .update(pl)
            .set({ rowVersion: sql`${pl.rowVersion} + 1` })
            .where(and(eq(pl.orgId, orgId), eq(pl.id, playlistId))),
          db.delete(pi).where(and(eq(pi.orgId, orgId), eq(pi.playlistId, playlistId))),
          ...itemRows(playlistId, spotIds),
        ]);
      },
      stage: {
        ...playlists.stage,
        /** A new playlist with its spots in play order. Throws `NotInOrgError` for a spot the org does not have. */
        insert: async (values: NewRow<typeof s.playlists>, items: readonly string[] = []): Promise<Staged<typeof s.playlists.$inferSelect>> => {
          await checkSpots(items);
          const made = await playlists.stage.insert(values);
          return { row: made.row, writes: [...made.writes, ...staged(undefined, ...itemRows(made.row.id, items)).writes] };
        },
        /**
         * A change to `current`, the draft as read: its fields, and with `items` its spots in play
         * order, replaced whole. The version moves on once, guarded by `ifVersion` as every
         * versioned row's `stage.update` is, so an order made from an old read is refused rather
         * than dropping someone else's change. Throws `NotInOrgError` for a spot the org does not have.
         */
        update: async (
          current: typeof s.playlists.$inferSelect,
          patch: RowPatch<typeof s.playlists>,
          ifVersion?: number,
          items?: readonly string[],
        ): Promise<Staged<typeof s.playlists.$inferSelect>> => {
          if (!items) return playlists.stage.update(current, patch, ifVersion);
          await checkSpots(items);
          // An empty patch stages nothing, so the items alone move the version on with `touch`.
          const row = Object.values(patch).some((v) => v !== undefined)
            ? playlists.stage.update(current, patch, ifVersion)
            : playlists.stage.touch(current, ifVersion);
          const replace = staged(undefined, db.delete(pi).where(and(eq(pi.orgId, orgId), eq(pi.playlistId, current.id))), ...itemRows(current.id, items));
          return { row: row.row, writes: [...row.writes, ...replace.writes] };
        },
      },
    },

    scheduleEntries,

    /** Org-wide settings: one row, absent until first set. */
    settings: {
      get: () => db.select().from(os).where(eq(os.orgId, orgId)).get(),
      stage: {
        /**
         * Set the fields given, leaving the rest as they are (null clears one), and move the
         * version on. Throws `NotInOrgError` for a default playlist the org does not have. With
         * `ifVersion`, refused (`StaleVersionError`) unless the settings are still that version,
         * checked now and again in the batch, as `stage.update` is; an org with no row is at 1.
         */
        set: async (values: RowPatch<typeof os>, ifVersion?: number): Promise<Staged<typeof os.$inferSelect>> => {
          const patch = strip(values);
          const id = patch.defaultPlaylistId;
          if (id != null && !(await playlists.get(id))) throw new NotInOrgError('playlist', id);
          const current = await db.select().from(os).where(eq(os.orgId, orgId)).get();
          const version = current?.rowVersion ?? 1;
          if (ifVersion !== undefined && version !== ifVersion) throw new StaleVersionError('settings', version);
          const updatedAt = Date.now();
          const row: typeof os.$inferSelect = {
            orgId,
            defaultPlaylistId: null,
            timezone: null,
            locale: null,
            displayHoursJson: null,
            updateWindowJson: null,
            unreachableAfterMs: null,
            alertsJson: null,
            publishRevision: 0,
            editorsPublish: true,
            auditRetentionDays: null,
            ...current,
            ...patch,
            rowVersion: version + 1,
            updatedAt,
          };
          const upsert = staged(
            row,
            db
              .insert(os)
              .values(row)
              .onConflictDoUpdate({ target: os.orgId, set: { ...patch, rowVersion: sql`${os.rowVersion} + 1`, updatedAt } }),
          );
          if (ifVersion === undefined) return upsert;
          const stale = async () => {
            const now = (await db.select({ v: os.rowVersion }).from(os).where(eq(os.orgId, orgId)).get())?.v ?? 1;
            return now === ifVersion ? undefined : now;
          };
          const check = db
            .select({
              // json() of text that is not JSON raises an error, which aborts the batch.
              ok: sql`json(CASE WHEN COALESCE((SELECT ${os.rowVersion} FROM ${os} WHERE ${os.orgId} = ${orgId}), 1) = ${ifVersion} THEN '1' ELSE 'stale version' END)`,
            })
            .from(s.organization)
            .where(eq(s.organization.id, orgId));
          return { row, writes: [guard(check, { id: 'settings', version: ifVersion, stale }), ...upsert.writes] };
        },
      },
    },

    /**
     * A screen's incidents (M3-42), written by the alert check, not by tools. Each write says
     * whether it was the one that made the change, so two overlapping checks alert once.
     */
    incidents: {
      /**
       * Open an offline incident and queue its alert (`alert`, given the incident's id), in one
       * batch: both are written or neither, and the deliveries only by the call that opened the
       * incident, so two overlapping checks queue it once. The incident's id, or undefined if the
       * screen already had one open. Without `alert`, the incident alone: for when the queue cannot
       * be written, so the email still goes once.
       */
      open: async (screenId: string, lastSeenAt: number, now: number, alert?: (incidentId: string) => QueuedAlert): Promise<string | undefined> => {
        const id = newId('inc');
        const ours = sql`EXISTS (SELECT 1 FROM ${inc} WHERE ${inc.orgId} = ${orgId} AND ${inc.id} = ${id})`;
        const [opened] = await db.batch([
          db.insert(inc).values({ id, orgId, screenId, kind: 'offline', lastSeenAt, openedAt: now }).onConflictDoNothing().returning({ id: inc.id }),
          ...(alert ? queueAlert(alert(id), now, ours) : []),
        ]);
        return opened.length ? id : undefined;
      },
      /**
       * Close an open incident and queue its alert, in one batch; false if it was closed already
       * (by a check that queued the same event, which is queued once). Without `alert`, as `open`.
       */
      clear: async (incidentId: string, now: number, alert?: QueuedAlert): Promise<boolean> => {
        const [cleared] = await db.batch([
          db
            .update(inc)
            .set({ clearedAt: now })
            .where(and(eq(inc.orgId, orgId), eq(inc.id, incidentId), isNull(inc.clearedAt)))
            .returning({ id: inc.id }),
          ...(alert ? queueAlert(alert, now, sql`1`) : []),
        ]);
        return cleared.length === 1;
      },
    },

    /** The org's name, as alerts name it. */
    name: async (): Promise<string> => {
      const org = await db.select({ name: s.organization.name }).from(s.organization).where(eq(s.organization.id, orgId)).get();
      if (!org) throw new Error(`organization ${orgId} does not exist`);
      return org.name;
    },

    /** Where alerts go besides email (#88): one Slack webhook and one outgoing webhook at most. */
    alertChannels: {
      get: (kind: AlertChannelKind) =>
        db
          .select()
          .from(ac)
          .where(and(eq(ac.orgId, orgId), eq(ac.kind, kind)))
          .get(),
      list: () => db.select().from(ac).where(eq(ac.orgId, orgId)).orderBy(asc(ac.kind)).all(),
      stage: {
        /**
         * Put the channel's fields, making it if absent, and move its version on (an absent
         * channel is at 0). With `ifVersion`, refused (`StaleVersionError`) unless it is still
         * that version, checked now and again in the batch, as `stage.update` is.
         */
        put: async (kind: AlertChannelKind, values: AlertChannelValues, ifVersion?: number): Promise<Staged<AlertChannel>> => {
          const mine = and(eq(ac.orgId, orgId), eq(ac.kind, kind));
          const current = await db.select().from(ac).where(mine).get();
          const version = current?.rowVersion ?? 0;
          if (ifVersion !== undefined && version !== ifVersion) throw new StaleVersionError(`${kind} channel`, version);
          const at = Date.now();
          const row: AlertChannel = { ...values, orgId, kind, rowVersion: version + 1, createdAt: current?.createdAt ?? at, updatedAt: at };
          const upsert = staged(
            row,
            db
              .insert(ac)
              .values(row)
              .onConflictDoUpdate({ target: [ac.orgId, ac.kind], set: { ...values, rowVersion: sql`${ac.rowVersion} + 1`, updatedAt: at } }),
          );
          if (ifVersion === undefined) return upsert;
          const now = sql`COALESCE((SELECT ${ac.rowVersion} FROM ${ac} WHERE ${mine}), 0)`;
          const stale = async () => {
            const v = (await db.select({ v: ac.rowVersion }).from(ac).where(mine).get())?.v ?? 0;
            return v === ifVersion ? undefined : v;
          };
          // json() of text that is not JSON raises an error, which aborts the batch.
          const check = db
            .select({ ok: sql`json(CASE WHEN ${now} = ${ifVersion} THEN '1' ELSE 'stale version' END)` })
            .from(s.organization)
            .where(eq(s.organization.id, orgId));
          return { row, writes: [guard(check, { id: `${kind} channel`, version: ifVersion, stale }), ...upsert.writes] };
        },
        remove: (kind: AlertChannelKind): Staged => staged(undefined, db.delete(ac).where(and(eq(ac.orgId, orgId), eq(ac.kind, kind)))),
      },
    },

    /**
     * The alert delivery log and queue (#88). The alert check queues through `incidents` and the delivery
     * run claims and settles, writing directly; a tool stages (a test send, a retry).
     */
    alertDeliveries: {
      get: alertDeliveries.get,
      /** Newest first, `after` the key `[createdAt, id]` of the last row of the page before. */
      list: ({ after, take }: { after?: readonly (string | number)[]; take: number }) => {
        const [at, id] = after ?? [];
        const where: SQL[] = [eq(ad.orgId, orgId)];
        if (typeof at === 'number' && typeof id === 'string') where.push(or(lt(ad.createdAt, at), and(eq(ad.createdAt, at), lt(ad.id, id)))!);
        return db
          .select()
          .from(ad)
          .where(and(...where))
          .orderBy(desc(ad.createdAt), desc(ad.id))
          .limit(take)
          .all();
      },
      /**
       * Take one pending delivery that is due for an attempt now, as `claimDueAlertDeliveries`
       * (./deliveries.ts) does across orgs; undefined if it is not pending and due.
       */
      claim: (id: string, now: number, leaseMs: number) =>
        db
          .update(ad)
          .set({ attempts: sql`${ad.attempts} + 1`, lastAttemptAt: now, nextAttemptAt: now + leaseMs, leasedUntil: now + leaseMs, updatedAt: now })
          .where(and(eq(ad.orgId, orgId), eq(ad.id, id), eq(ad.status, 'pending'), lte(ad.nextAttemptAt, now)))
          .returning()
          .get(),
      /** What attempt `attempt` came to, as `settleAlertDeliveries` (./deliveries.ts) records a run's. */
      settle: async (id: string, attempt: number, now: number, result: AttemptResult) => {
        await settleStatement(db, orgId, id, attempt, now, result).run();
      },
      stage: {
        insert: alertDeliveries.stage.insert,
        /**
         * Make a delivery due now; one that was given up on gets at least this one more attempt.
         * Changes nothing if an attempt holds it, or it was delivered, by the time it runs (check
         * `leasedUntil` and `status` first, to say so).
         */
        retry: (current: AlertDelivery, now: number): Staged<AlertDelivery> => {
          const set = { status: 'pending' as const, nextAttemptAt: now, giveUpAt: Math.max(current.giveUpAt, now), updatedAt: now };
          return staged(
            { ...current, ...set },
            db
              .update(ad)
              .set(set)
              .where(and(eq(ad.orgId, orgId), eq(ad.id, current.id), ne(ad.status, 'delivered'), or(isNull(ad.leasedUntil), lte(ad.leasedUntil, now))!)),
          );
        },
      },
    },

    /**
     * Brand kits. Ids are always the server's (`bk_...`): an `id` a caller passes is ignored, so
     * no org can pick an id another org holds.
     */
    brandKits: {
      ...brandKitRows,
      insert: async (values: NewRow<typeof s.brandKits>) => {
        await checkLogos(values);
        return brandKitRows.insert(values);
      },
      update: async (id: string, patch: RowPatch<typeof s.brandKits>) => {
        await checkLogos(patch);
        return brandKitRows.update(id, patch);
      },
      stage: {
        ...brandKitRows.stage,
        insert: async (values: NewRow<typeof s.brandKits>) => {
          await checkLogos(values);
          return brandKitRows.stage.insert(values);
        },
        update: async (current: typeof s.brandKits.$inferSelect, patch: RowPatch<typeof s.brandKits>, ifVersion?: number) => {
          await checkLogos(patch);
          return brandKitRows.stage.update(current, patch, ifVersion);
        },
      },
      /** Which kit applies where (`brand_assignments`): the org default, groups, screens. */
      assignments: {
        /** Every assignment in the org, by target then group or screen id. */
        list: () => db.select().from(ba).where(eq(ba.orgId, orgId)).orderBy(asc(ba.target), asc(ba.groupId), asc(ba.screenId)).all(),
        stage: {
          /**
           * Make `brandKitId` the kit of the org (its default), a group or a screen; null removes
           * the choice. Throws `NotInOrgError` for a kit, group or screen the org does not have.
           * Pass `newKit` for a kit staged earlier in the same batch, which is not stored yet.
           */
          set: async (target: BrandTarget, brandKitId: string | null, { newKit = false } = {}): Promise<Staged> => {
            if (brandKitId !== null && !newKit && !(await brandKitRows.get(brandKitId))) throw new NotInOrgError('brand kit', brandKitId);
            if (target.target === 'group' && !(await screenGroups.get(target.groupId))) throw new NotInOrgError('group', target.groupId);
            if (target.target === 'screen' && !(await screens.get(target.screenId))) throw new NotInOrgError('screen', target.screenId);
            const clear = db.delete(ba).where(whereTarget(target));
            if (brandKitId === null) return staged(undefined, clear);
            const row = {
              orgId,
              target: target.target,
              groupId: target.target === 'group' ? target.groupId : null,
              screenId: target.target === 'screen' ? target.screenId : null,
              brandKitId,
              updatedAt: Date.now(),
            };
            return staged(undefined, clear, db.insert(ba).values(row));
          },
        },
      },
    },

    publishes: {
      ...publishes,
      stage: {
        ...publishes.stage,
        /**
         * As `addScreens`, staged, so a publish's rollout rows commit in one batch with its row
         * (`stage.insert`, staged before them), its order (`advance`) and its screens' switches.
         * Throws `NotInOrgError` for a screen the org does not have. The publish may not be stored
         * yet, so it is not read: the `(org_id, publish_id)` foreign key refuses another org's.
         */
        addScreens: async (publishId: string, rows: readonly { screenId: string; manifestId: string }[]): Promise<Staged> => {
          await orgScreens(rows.map((r) => r.screenId));
          const values = rows.map((r) => ({ orgId, publishId, screenId: r.screenId, manifestId: r.manifestId }));
          return staged(undefined, ...chunk(values, 4).map((part) => db.insert(ps).values(part)));
        },
        /**
         * Put a publish in order: stage moving the org's publish revision on from `revision`, the
         * one read with the content it compiled (`org_settings.publish_revision`; 0 with no row).
         * If another publish committed since, the batch fails (`StaleVersionError`, id
         * `publish revision`) and writes nothing, so an older publish cannot switch screens back
         * after a newer one. Commit the screens' switches in the same batch. An org with no
         * settings row gets one, every setting at its default and at version 1, as with no row.
         */
        advance: (revision: number): Staged => {
          const read = sql`COALESCE((SELECT ${os.publishRevision} FROM ${os} WHERE ${os.orgId} = ${orgId}), 0)`;
          const check = db
            .select({
              // json() of text that is not JSON raises an error, which aborts the batch.
              ok: sql`json(CASE WHEN ${read} = ${revision} THEN '1' ELSE 'stale version' END)`,
            })
            .from(s.organization)
            .where(eq(s.organization.id, orgId));
          const stale = async () => {
            const now = (await db.select({ v: os.publishRevision }).from(os).where(eq(os.orgId, orgId)).get())?.v ?? 0;
            return now === revision ? undefined : now;
          };
          // Not a setting: the version and `updatedAt` stay, so an open settings form does not conflict.
          const move = db
            .insert(os)
            .values({ orgId, publishRevision: 1 })
            .onConflictDoUpdate({ target: os.orgId, set: { publishRevision: sql`${os.publishRevision} + 1`, updatedAt: sql`${os.updatedAt}` } });
          return { row: undefined, writes: [guard(check, { id: 'publish revision', version: revision, stale }), ...staged(undefined, move).writes] };
        },
      },
      screens: (publishId: string) =>
        db
          .select({ screenId: ps.screenId, manifestId: ps.manifestId })
          .from(ps)
          .where(and(eq(ps.orgId, orgId), eq(ps.publishId, publishId)))
          .orderBy(asc(ps.screenId))
          .all(),
      addScreens: async (publishId: string, rows: readonly { screenId: string; manifestId: string }[]) => {
        if (!(await publishes.get(publishId))) throw new NotInOrgError('publish', publishId);
        const found = new Set((await screens.getMany([...new Set(rows.map((r) => r.screenId))])).map((r) => r.id));
        for (const r of rows) if (!found.has(r.screenId)) throw new NotInOrgError('screen', r.screenId);
        const values = rows.map((r) => ({ orgId, publishId, screenId: r.screenId, manifestId: r.manifestId }));
        if (values.length) await db.batch(chunk(values, 4).map((part) => db.insert(ps).values(part)) as [never, ...never[]]);
      },
    },

    dataSources: {
      ...dataSources,
      insert: async (values: NewRow<typeof s.dataSources>) => {
        await checkConnection(values.connectionId);
        return dataSources.insert(values);
      },
      update: async (id: string, patch: RowPatch<typeof s.dataSources>) => {
        await checkConnection(patch.connectionId);
        return dataSources.update(id, patch);
      },
      stage: {
        ...dataSources.stage,
        insert: async (values: NewRow<typeof s.dataSources>) => {
          await checkConnection(values.connectionId);
          return dataSources.stage.insert(values);
        },
        update: async (current: typeof s.dataSources.$inferSelect, patch: RowPatch<typeof s.dataSources>, ifVersion?: number) => {
          await checkConnection(patch.connectionId);
          return dataSources.stage.update(current, patch, ifVersion);
        },
        /**
         * The sources reading through `connectionId` polled again at once, their failures and backoff
         * gone: for a connection reconnected. Their versions stay, as with a poll.
         */
        pollAgain: (connectionId: string): Staged =>
          staged(
            undefined,
            db
              .update(s.dataSources)
              .set(updateSet(s.dataSources, { nextPollAt: 0, failures: 0, lastError: null }))
              .where(and(eq(s.dataSources.orgId, orgId), eq(s.dataSources.connectionId, connectionId))),
          ),
      },
      /** The sources that read through `connectionId`. */
      usingConnection: (connectionId: string) =>
        db
          .select()
          .from(s.dataSources)
          .where(and(eq(s.dataSources.orgId, orgId), eq(s.dataSources.connectionId, connectionId)))
          .orderBy(asc(s.dataSources.id))
          .all(),
      snapshot: async (dataSourceId: string) =>
        db
          .select()
          .from(snap)
          .where(and(eq(snap.orgId, orgId), eq(snap.dataSourceId, dataSourceId)))
          .get(),
      /** Latest snapshots of several sources. */
      snapshots: async (dataSourceIds: readonly string[]) =>
        dataSourceIds.length
          ? db
              .select({ dataSourceId: snap.dataSourceId, version: snap.version, fetchedAt: snap.fetchedAt, checkedAt: snap.checkedAt, dataJson: snap.dataJson })
              .from(snap)
              .where(and(eq(snap.orgId, orgId), inArray(snap.dataSourceId, [...dataSourceIds])))
              .all()
          : [],
      putSnapshot: async (dataSourceId: string, v: Snapshot) => {
        if (!(await dataSources.get(dataSourceId))) throw new NotInOrgError('data source', dataSourceId);
        await db
          .insert(snap)
          .values({ orgId, dataSourceId, ...v })
          .onConflictDoUpdate({ target: [snap.orgId, snap.dataSourceId], set: { ...v } })
          .run();
      },
      /**
       * What one poll found, in one batch: the source's patch (next poll, failures, validators),
       * and either a changed `snapshot` or, when the feed still says the same, its new `checkedAt`.
       */
      savePoll: async (
        dataSourceId: string,
        poll: { source: RowPatch<typeof s.dataSources> & { nextPollAt: number }; snapshot?: Snapshot; checkedAt?: number },
      ) => {
        if (!(await dataSources.get(dataSourceId))) throw new NotInOrgError('data source', dataSourceId);
        const ds = s.dataSources;
        const mineSnap = and(eq(snap.orgId, orgId), eq(snap.dataSourceId, dataSourceId));
        // Not `stage.update`: a poll leaves the row's version alone, so it never makes a person's edit stale.
        const writes: Write[] = [
          ...staged(
            undefined,
            db
              .update(ds)
              .set(updateSet(ds, strip(poll.source)))
              .where(and(eq(ds.orgId, orgId), eq(ds.id, dataSourceId))),
          ).writes,
        ];
        if (poll.snapshot)
          writes.push(
            ...staged(
              undefined,
              db
                .insert(snap)
                .values({ orgId, dataSourceId, ...poll.snapshot })
                .onConflictDoUpdate({ target: [snap.orgId, snap.dataSourceId], set: { ...poll.snapshot } }),
            ).writes,
          );
        else if (poll.checkedAt !== undefined) writes.push(...staged(undefined, db.update(snap).set({ checkedAt: poll.checkedAt }).where(mineSnap)).writes);
        await commit(db, writes);
      },
    },

    connections: {
      ...connectionRows,
      /**
       * The poller refreshed the grant: stored only over the one it refreshed (another run may have
       * refreshed it first, or a person reconnected), and active again, since a racing run whose
       * rotated-out token was refused may have marked it `needs_reconnect` first. A disconnected
       * connection has no grant to match, so this never revives one.
       */
      saveGrant: (id: string, from: string, grant: { credentialsSealed: string; expiresAt: number | null }) =>
        changeGrant(id, from, { ...grant, status: 'active', lastError: null }),
      /** The provider refused the grant the poller read: a person must connect it again. */
      markNeedsReconnect: (id: string, from: string, lastError: string) => changeGrant(id, from, { status: 'needs_reconnect', lastError }),
      authorizations: {
        ...authorizations,
        insert: async (values: NewRow<typeof s.connectionAuthorizations>) => {
          await checkConnection(values.connectionId);
          return authorizations.insert(values);
        },
        /** The live authorization whose state hashes to `stateHash`, in this org. */
        byState: (stateHash: string, now: number) =>
          db
            .select()
            .from(cna)
            .where(and(eq(cna.orgId, orgId), eq(cna.stateHash, stateHash), gt(cna.expiresAt, now)))
            .get(),
        stage: {
          insert: async (values: NewRow<typeof s.connectionAuthorizations>) => {
            await checkConnection(values.connectionId);
            return authorizations.stage.insert(values);
          },
          /**
           * Use it up: deleted, and the batch fails, writing nothing, unless this delete is the
           * one that removed it. Of two finishes of one state, one commits.
           */
          consume: (id: string): Staged =>
            staged(
              undefined,
              db.delete(cna).where(and(eq(cna.orgId, orgId), eq(cna.id, id))),
              // json() of text that is not JSON raises an error, which aborts the batch.
              db
                .select({ ok: sql`json(CASE WHEN changes() = 1 THEN '1' ELSE 'authorization is not pending' END)` })
                .from(s.organization)
                .where(eq(s.organization.id, orgId)),
            ),
          /** The org's authorizations that ran out unfinished. */
          deleteExpired: (now: number): Staged => staged(undefined, db.delete(cna).where(and(eq(cna.orgId, orgId), lte(cna.expiresAt, now)))),
        },
      },
    },

    auditLog: {
      append: (entry: NewRow<typeof s.auditLog>) => audit.insert(entry),
      /** The audit row for a change, staged to commit with it. */
      stage: (entry: NewRow<typeof s.auditLog>) => audit.stage.insert(entry),
      /**
       * An audit row written at most once for `key` in this org (an agent grant's refusals in one
       * window, which several calls may race to record): another call with the key writes nothing.
       * Its id is made from the org and the key, so no other org's row can stand in for it.
       */
      appendOnce: async (key: string, entry: Omit<NewRow<typeof s.auditLog>, 'id'>): Promise<void> => {
        await db
          .insert(s.auditLog)
          .values({ ...strip(entry), id: `aud_once_${orgId}_${key}`, orgId })
          .onConflictDoNothing()
          .run();
      },
      /**
       * Newest first; rows of the same millisecond by insertion order (`rowid`), as ids are random.
       * With `target`, only what was done to that one thing (a screen's recent events).
       */
      list: ({ limit = 50, before, target }: { limit?: number; before?: number; target?: { kind: string; id: string } } = {}) => {
        const a = s.auditLog;
        const where: SQL[] = [eq(a.orgId, orgId)];
        if (before != null) where.push(lt(a.at, before));
        if (target) where.push(eq(a.targetKind, target.kind), eq(a.targetId, target.id));
        return db
          .select()
          .from(a)
          .where(and(...where))
          .orderBy(desc(a.at), desc(sql`rowid`))
          .limit(limit)
          .all();
      },
    },

    idempotency: {
      /** The record of an earlier call made with `key`, if any. */
      get: (key: string) =>
        db
          .select()
          .from(s.idempotencyKeys)
          .where(and(eq(s.idempotencyKeys.orgId, orgId), eq(s.idempotencyKeys.key, key)))
          .get(),
      /** The record of this call, staged to commit with its change. A second record of the same key fails the batch. */
      stage: (entry: Omit<typeof s.idempotencyKeys.$inferInsert, 'orgId' | 'createdAt'>): Staged<typeof s.idempotencyKeys.$inferSelect> => {
        const row = fullRow(s.idempotencyKeys, { ...entry, orgId });
        return staged(row as typeof s.idempotencyKeys.$inferSelect, db.insert(s.idempotencyKeys).values(row as never));
      },
    },

    playCounts: {
      /** Add plays to the hourly totals. */
      add: async (screenId: string, counts: readonly { hour: number; spotId: string; plays: number; ms: number }[]) => {
        if (!(await screens.get(screenId))) throw new NotInOrgError('screen', screenId);
        const rows = counts.map((c) => ({ orgId, screenId, ...c }));
        if (!rows.length) return;
        await db.batch(
          chunk(rows, 6).map((part) =>
            db
              .insert(pc)
              .values(part)
              .onConflictDoUpdate({
                target: [pc.orgId, pc.screenId, pc.hour, pc.spotId],
                set: { plays: sql`${pc.plays} + excluded.plays`, ms: sql`${pc.ms} + excluded.ms` },
              }),
          ) as [never, ...never[]],
        );
      },
      /** Hours in `[from, to)`, in milliseconds. */
      list: ({ from, to, screenId }: { from: number; to: number; screenId?: string }) => {
        const where: SQL[] = [eq(pc.orgId, orgId), sql`${pc.hour} >= ${from}`, lt(pc.hour, to)];
        if (screenId) where.push(eq(pc.screenId, screenId));
        return db
          .select()
          .from(pc)
          .where(and(...where))
          .orderBy(asc(pc.hour), asc(pc.screenId), asc(pc.spotId))
          .all();
      },
    },
  };
}

export type OrgScope = ReturnType<typeof scoped>;
