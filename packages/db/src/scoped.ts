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
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  getTableName,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { alias, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { assertId, newId } from './ids';
import * as s from './schema';
import { contentJson, published } from './drafts';
import { type AttemptResult, settleStatement } from './deliveries';
import { AGENT_GRANT_IDLE_MS } from './agent-grants';
import { feedPhotos, type PollPhotos, pollSave, sourceEdited } from './feed-photos';
import { storage } from './storage';
import { commit, fullRow, StaleVersionError, staged, staleGuard, strip, updateSet, type Staged, type Write } from './writes';

type Db = DrizzleD1Database<Record<string, never>>;
type AlertChannel = typeof s.alertChannels.$inferSelect;
type AlertChannelKind = AlertChannel['kind'];
/** What a channel's owner sets; the rest is the repository's. */
type AlertChannelValues = Omit<AlertChannel, 'orgId' | 'kind' | 'rowVersion' | 'createdAt' | 'updatedAt'>;
type AlertDelivery = typeof s.alertDeliveries.$inferSelect;
type AiProvider = typeof s.orgAiProviders.$inferSelect;
/** What an owner sets on the org's AI provider; the rest is the repository's. */
type AiProviderValues = Partial<Omit<AiProvider, 'orgId' | 'rowVersion' | 'createdAt' | 'updatedAt'>>;
/** An alert to queue: the event as a webhook receives it, the channels it goes to, and when to stop retrying it. */
export interface QueuedAlert {
  event: { id: string; type: string; json: string };
  channels: readonly AlertDelivery['channel'][];
  giveUpAt: number;
}
/** The most labels a screen has, and the most label keys an org's screens use between them. */
export const LABEL_LIMITS = { perScreen: 32, keys: 100 } as const;
type PublishRequestRow = typeof s.publishRequests.$inferSelect;
type TenantTable = SQLiteTable & { id: SQLiteColumn; orgId: SQLiteColumn };

/** Writing a row that refers to something the org cannot see. */
export class NotInOrgError extends Error {
  constructor(what: string, id: string, options?: ErrorOptions) {
    super(`${what} ${id} not found`, options);
    this.name = 'NotInOrgError';
  }
}

/**
 * Fields a caller may never set: the org is the scope's, the id is fixed at insert, a row's
 * version and the org's publish revision move on by themselves, a draft's incarnation is fixed at
 * insert, and a draft's published version is written only by `stage.publish` (./drafts.ts).
 */
type Guarded = 'orgId' | 'id' | 'createdAt' | 'rowVersion' | 'incarnation' | 'publishRevision' | 'publishedJson' | 'publishedAt' | 'publishedVersion';
export type NewRow<T extends SQLiteTable> = Omit<T['$inferInsert'], Guarded> & { id?: string };
export type RowPatch<T extends SQLiteTable> = Partial<Omit<T['$inferInsert'], Guarded>>;

/** What `auditLog.page` reads: a page after `after`, filtered (`from` inclusive, `to` exclusive, in ms). */
interface AuditPage {
  limit: number;
  after?: readonly [at: number, seq: number];
  actorKind?: (typeof s.auditLog.$inferSelect)['actorKind'];
  actorId?: string;
  action?: string;
  /**
   * With `action`: also rows of these other actions whose detail holds `detailHas` (a publish or an approval that made the
   * default, for `set_default_playlist`) and whose recorded input has, or lacks, each key of `inputHas` (a save with or
   * without its id, for the create or update it replaced), and at least one key of `inputHasAny` (a screen's update that
   * changed a setting, for the tool it replaced).
   */
  alsoAction?: { actions: readonly string[]; detailHas?: string; inputHas?: Readonly<Record<string, boolean>>; inputHasAny?: readonly string[] };
  targetKind?: string;
  targetId?: string;
  from?: number;
  to?: number;
  query?: string;
  /** Actions whose detail `query` must not read, because the caller is not shown it. */
  hideDetailOf?: readonly string[];
}

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
 * The org's brand state as `brandKits.state` reads it, from rows already read: what the compiler used
 * (`loadOrg`), so a publish guards exactly those (`brandKits.stage.unchanged`). Kits by id, then the
 * assignments by target and group or screen id, as the SQL orders them.
 */
export function brandStateOf(kits: readonly { id: string; rowVersion: number }[], assignments: readonly (typeof s.brandAssignments.$inferSelect)[]): string {
  const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const k = [...kits].sort((a, b) => by(a.id, b.id)).map((x) => `${x.id}:${x.rowVersion}`);
  const key = (a: (typeof assignments)[number]) => [a.target, a.groupId ?? '', a.screenId ?? ''] as const;
  const as = [...assignments]
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      return by(x[0], y[0]) || by(x[1], y[1]) || by(x[2], y[2]);
    })
    .map((a) => `${a.target}:${a.groupId ?? ''}:${a.screenId ?? ''}:${a.brandKitId}`);
  return `${k.join(',')}|${as.join(',')}`;
}

/**
 * A guard (`staleGuard`) that holds while the row is still `version`. A draft made again with its
 * id continues its versions (`drafts`), so the version tells the rows apart; a publish passes the
 * draft's `incarnation` too, as a second check (./schema.ts).
 * A draft deleted since it was read is stale too, at version 0, not `NotInOrgError`: a publish
 * targets the org, not the draft, so it is a conflict to load and compile again after.
 */
function versionGuard(db: Db, orgId: string, t: typeof s.screens | typeof s.spots, id: string, version: number, incarnation?: string | null): Write {
  // Only drafts have the column; the others have no way to be made again with an id.
  const sameRow = incarnation === undefined ? sql`1` : sql`${sql.identifier('incarnation')} IS ${incarnation}`;
  const holds = sql`EXISTS (SELECT 1 FROM ${t} WHERE ${t.orgId} = ${orgId} AND ${t.id} = ${id} AND ${t.rowVersion} = ${version} AND ${sameRow})`;
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
  return staleGuard(db, orgId, id, version, holds, stale);
}

/**
 * get / list over a table with an org and an id, and its writes, staged. Tests write directly
 * through `testScope` (./testing.ts), which commits these.
 */
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
    /** Changes, staged for the scope's `commit` (./writes.ts). */
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
    /**
     * How many of the org's drafts have changes screens do not have, in one SQL count (#361): never
     * published, or edited since, by version, not by time (an edit in the publish's millisecond
     * counts). An edit put back as it was still counts, which `draftChanged` would not, so it is for
     * a count shown, never for what to publish.
     */
    countUnpublished: async (): Promise<number> => {
      const found = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(t)
        .where(and(eq(t.orgId, orgId), or(isNull(t.publishedVersion), gt(t.rowVersion, t.publishedVersion))))
        .get();
      return found?.n ?? 0;
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
      /**
       * Nothing written: the batch is refused, as `publish` is, if the draft was edited since it was
       * read. For a draft a publish pins at its version but need not promote, as it is live as it is.
       */
      unchanged: (row: Row): Staged => ({ row: undefined, writes: [versionGuard(db, orgId, t, row.id, row.rowVersion, row.incarnation)] }),
      /** Delete the row, draft and published version, refused like `publish` if it was edited since it was read. */
      remove: (row: Row): Staged => {
        const deleted = rows.stage.delete(row.id);
        return { row: undefined, writes: [versionGuard(db, orgId, t, row.id, row.rowVersion, row.incarnation), ...deleted.writes] };
      },
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
    const set = { publishedJson: contentJson(row, items), publishedAt: Date.now(), publishedVersion: row.rowVersion };
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
 * untrusted clock) a report is ordered by arrival, as before: it counts as observed then, and
 * replaces one stored at that time or before. So a write that started before a later report's and
 * landed after it (a socket report whose D1 write hung past its limit, #519) does not replace it.
 */
function manifestReport(observedAt: number | undefined, arrivedAt: number) {
  const at = Math.min(observedAt ?? arrivedAt, arrivedAt);
  // One fixed operator or the other, never input: by arrival, a report at the same time replaces.
  const op = observedAt === undefined ? '>=' : '>';
  return { at, takes: `(reported_manifest_at IS NULL OR ? ${op} reported_manifest_at)`, takesArgs: [at] };
}

/** What one screen sync writes (`screens.sync`). Hours are UTC hour starts in ms. */
export interface SyncWrite {
  at: number;
  playerVersion: string;
  heartbeatJson: string;
  /** The manifest the heartbeat says it fell back from, if any: `fallback_since` moves only when this changes. */
  fallbackFrom: string | null;
  /** The manifest the heartbeat says is playing, if any. */
  active?: string;
  /** When the screen observed `active`, on the server's clock; absent if its clock is untrusted. */
  observedAt?: number;
  epoch: string;
  seq: number;
  counts: readonly { hour: number; spotId: string; plays: number; ms: number }[];
}

type Snapshot = Omit<typeof s.dataSnapshots.$inferInsert, 'orgId' | 'dataSourceId'>;
/** A snapshot's fields without its key, which is the scope's org and the source it is put on, whatever the caller passes. */
const snapshotFields = (v: Snapshot): Snapshot => {
  const { orgId: _o, dataSourceId: _d, ...rest } = v as typeof s.dataSnapshots.$inferInsert;
  return rest;
};

const statusCredentials = (more: SQL = sql`1`) =>
  sql`SELECT 1 FROM ${s.screenCredentials} WHERE ${s.screenCredentials.orgId} = ${s.screens.orgId} AND ${s.screenCredentials.screenId} = ${s.screens.id} AND ${more}`;

/**
 * What a screen's state is worked out from, and nothing else: for the fleet poll and a publish's
 * rollout. `credentialsRevoked` is whether the screen had credentials and every one is revoked.
 */
const statusColumns = {
  id: s.screens.id,
  status: s.screens.status,
  timezone: s.screens.timezone,
  displayHoursJson: s.screens.displayHoursJson,
  desiredManifestId: s.screens.desiredManifestId,
  reportedManifestId: s.screens.reportedManifestId,
  lastSeenAt: s.screens.lastSeenAt,
  heartbeatJson: s.screens.heartbeatJson,
  credentialsRevoked: sql<boolean>`EXISTS (${statusCredentials()}) AND NOT EXISTS (${statusCredentials(isNull(s.screenCredentials.revokedAt))})`.mapWith(
    Boolean,
  ),
};

/**
 * The facts a screen's place in a publish's rollout is decided from, for a `publish_screens` row
 * joined to its screen: whether it reports the manifest the publish gave it, whether that is still
 * its desired one, and whether it is revoked (as its state reads it: revoked, or every credential
 * it had is). The decision is `@signforge/tools`'s rollout.ts, and only there.
 */
const rolloutFacts = {
  reports: sql<boolean>`${s.screens.reportedManifestId} IS ${s.publishScreens.manifestId}`.mapWith(Boolean),
  current: sql<boolean>`${s.screens.desiredManifestId} IS ${s.publishScreens.manifestId}`.mapWith(Boolean),
  revoked: sql<boolean>`(${s.screens.status} = 'revoked' OR (${statusColumns.credentialsRevoked}))`.mapWith(Boolean),
};

/** How many of a publish's screens have one combination of `rolloutFacts`. */
export interface RolloutCount {
  reports: boolean;
  current: boolean;
  revoked: boolean;
  screens: number;
}

/** For each publish `where` picks, how many of its screens have each combination of `rolloutFacts`, by publish id. */
export async function rolloutCounts(db: Db, where: SQL | undefined): Promise<Map<string, RolloutCount[]>> {
  const p = s.publishes;
  const ps = s.publishScreens;
  const rows = await db
    .select({ publishId: p.id, ...rolloutFacts, screens: sql<number>`count(*)`.mapWith(Number) })
    .from(p)
    .innerJoin(ps, and(eq(ps.orgId, p.orgId), eq(ps.publishId, p.id)))
    .innerJoin(s.screens, and(eq(s.screens.orgId, ps.orgId), eq(s.screens.id, ps.screenId)))
    .where(where)
    .groupBy(p.id, rolloutFacts.reports, rolloutFacts.current, rolloutFacts.revoked)
    .all();
  const out = new Map<string, RolloutCount[]>();
  for (const { publishId, ...count } of rows) out.set(publishId, [...(out.get(publishId) ?? []), count]);
  return out;
}

/** A draft whose kept draft (#116) is written: the version and incarnation it was read at. */
interface KeptDraft {
  id: string;
  rowVersion: number;
  incarnation: string | null;
}
/** What is kept of a draft: its content as `contentJson` holds it, and a spot's sample-text marks. */
interface KeptContent {
  contentJson: string;
  sampleFieldsJson: string | null;
}

export function scoped(d1: D1Database, orgId: string) {
  assertId(orgId, 'orgId');
  const db: Db = drizzle(d1);
  /**
   * Deletes, for the grants `ours` selects, the provider's access and refresh tokens, consents and unexchanged
   * authorization codes: verification rows whose JSON value names one (the provider's `{ type: 'authorization_code',
   * referenceId, ... }`). Other rows (sign-in codes) hold no JSON, so the value is read only where it is valid.
   */
  const grantTokenDeletes = (ours: SQLWrapper): Staged =>
    staged(
      undefined,
      db.delete(s.oauthAccessToken).where(inArray(s.oauthAccessToken.referenceId, ours)),
      db.delete(s.oauthRefreshToken).where(inArray(s.oauthRefreshToken.referenceId, ours)),
      db.delete(s.oauthConsent).where(inArray(s.oauthConsent.referenceId, ours)),
      db
        .delete(s.verification)
        .where(inArray(sql`CASE WHEN json_valid(${s.verification.value}) THEN json_extract(${s.verification.value}, '$.referenceId') END`, ours)),
    );

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
  const ds = s.draftSnapshots;
  /** A spot's or a playlist's kept draft (#116), by the draft's kind and id. */
  const keptFor = (kind: 'spot' | 'playlist', id: string) => and(eq(ds.orgId, orgId), kind === 'spot' ? eq(ds.spotId, id) : eq(ds.playlistId, id));
  const clearKept = (kind: 'spot' | 'playlist', id: string): Staged => staged(undefined, db.delete(ds).where(keptFor(kind, id)));
  /** A kept draft's row: its content fields alone, then the org and the draft it is kept for, which nothing given can override. */
  const keptRow = (kind: 'spot' | 'playlist', id: string, holds: 'person' | 'agent', kept: KeptContent) => {
    const content = { holds, contentJson: kept.contentJson, sampleFieldsJson: kept.sampleFieldsJson, createdAt: Date.now() };
    return { content, row: { ...content, orgId, spotId: kind === 'spot' ? id : null, playlistId: kind === 'playlist' ? id : null } };
  };
  /** The guard that the draft is still the version read: a kept draft is never written without it in the same batch. */
  const draftAt = (kind: 'spot' | 'playlist', draft: KeptDraft): Write =>
    versionGuard(db, orgId, (kind === 'spot' ? s.spots : s.playlists) as typeof s.spots, draft.id, draft.rowVersion, draft.incarnation);
  const publishes = entity(db, orgId, s.publishes, 'pub');
  const pr = s.publishRequests;
  const publishRequests = entity(db, orgId, pr, 'prq');
  const dataSources = entity(db, orgId, s.dataSources, 'src', 'content');
  const connectionRows = entity(db, orgId, s.connections, 'con');
  const authorizations = entity(db, orgId, s.connectionAuthorizations, 'oas');
  const grants = entity(db, orgId, s.agentGrants, 'agt');
  const ag = s.agentGrants;
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
  const checkBindings = async (json: string | null | undefined) => {
    if (json == null) return;
    const ids = [...new Set(Object.values(JSON.parse(json) as Record<string, { source: string }>).map((b) => b.source))];
    const found = new Set((await dataSources.getMany(ids)).map((d) => d.id));
    for (const id of ids) if (!found.has(id)) throw new NotInOrgError('data source', id);
  };
  type SpotPatch = { templateVersionId?: string | null; assetMapJson?: string | null; assetId?: string | null; bindingsJson?: string | null };
  const checkSpot = async (v: SpotPatch) => {
    await checkTemplateVersion(v.templateVersionId);
    await checkAssetMap(v.assetMapJson);
    await checkBindings(v.bindingsJson);
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
        .set(updateSet(cn, strip(set)))
        .where(and(eq(cn.orgId, orgId), eq(cn.id, id), eq(cn.credentialsSealed, from)))
        .returning({ id: cn.id })
        .all()
    ).length > 0;

  const m = s.screenGroupMembers;
  const sl = s.screenLabels;
  const os = s.orgSettings;
  const ac = s.alertChannels;
  const ai = s.orgAiProviders;
  /**
   * Stage setting `values` on a single-row versioned record (the org's settings, an alert channel, its AI provider),
   * the row its `key` names (the scope's org, and a channel's kind): made from `fresh` if absent,
   * and its version moved on; a record with no row is at version `absent`. The key comes from
   * `key` alone: `values` never sets it, nor any field `strip` guards, so no write moves the row to
   * another org or key, whatever the caller passes. With `ifVersion`, refused (`StaleVersionError`,
   * id `id`) unless it is still that version: now, if it is already another, and again by a guard
   * inside the batch.
   */
  const upsertVersioned = async <T extends typeof os | typeof ac | typeof ai>(
    table: T,
    r: {
      id: string;
      key: { orgId: string } & Partial<T['$inferSelect']>;
      absent: number;
      fresh: (at: number) => Partial<T['$inferSelect']>;
    },
    values: Omit<RowPatch<T>, 'kind' | 'updatedAt'>,
    ifVersion: number | undefined,
  ): Promise<Staged<T['$inferSelect']>> => {
    // Drizzle's builders do not type-check over a union of tables; the signature carries the types.
    const t = table as unknown as typeof os;
    const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
    const keyColumns = Object.keys(r.key).map((k) => columns[k]!);
    const where = and(...Object.entries(r.key).map(([k, v]) => eq(columns[k]!, v)))!;
    const set = Object.fromEntries(Object.entries(strip(values)).filter(([k]) => !(k in r.key) && k !== 'updatedAt'));
    const current = (await db.select().from(t).where(where).get()) as T['$inferSelect'] | undefined;
    const version = current?.rowVersion ?? r.absent;
    if (ifVersion !== undefined && version !== ifVersion) throw new StaleVersionError(r.id, version);
    const at = Date.now();
    const row = { ...r.fresh(at), ...current, ...set, ...r.key, rowVersion: version + 1, updatedAt: at } as T['$inferSelect'];
    const upsert = staged(
      row,
      db
        .insert(t)
        .values(row as never)
        .onConflictDoUpdate({ target: keyColumns, set: { ...set, rowVersion: sql`${t.rowVersion} + 1`, updatedAt: at } }),
    );
    if (ifVersion === undefined) return upsert;
    const now = sql`COALESCE((SELECT ${t.rowVersion} FROM ${t} WHERE ${where}), ${r.absent})`;
    const stale = async () => {
      const v = (await db.select({ v: t.rowVersion }).from(t).where(where).get())?.v ?? r.absent;
      return v === ifVersion ? undefined : v;
    };
    return { row, writes: [staleGuard(db, orgId, r.id, ifVersion, sql`${now} = ${ifVersion}`, stale), ...upsert.writes] };
  };
  const inc = s.screenIncidents;
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
  const bk = s.brandKits;
  /** The org's brand state (`brandKits.state`): every kit and its version, then every assignment, each in a fixed order. */
  const brandState = sql<string>`COALESCE((SELECT group_concat(${bk.id} || ':' || ${bk.rowVersion}, ',' ORDER BY ${bk.id}) FROM ${bk} WHERE ${bk.orgId} = ${orgId}), '')
    || '|' || COALESCE((SELECT group_concat(${ba.target} || ':' || COALESCE(${ba.groupId}, '') || ':' || COALESCE(${ba.screenId}, '') || ':' || ${ba.brandKitId}, ',' ORDER BY ${ba.target}, ${ba.groupId}, ${ba.screenId}) FROM ${ba} WHERE ${ba.orgId} = ${orgId}), '')`;
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
  /** The org's member rows with their user's name and address, narrowed by `where`. */
  const memberRows = (where?: SQL) =>
    db
      .select({ id: s.member.id, userId: s.member.userId, name: s.user.name, email: s.user.email, role: s.member.role, createdAt: s.member.createdAt })
      .from(s.member)
      .innerJoin(s.user, eq(s.user.id, s.member.userId))
      .where(and(eq(s.member.organizationId, orgId), where));

  return {
    orgId,
    /** Run staged writes (from any `stage` of this scope) in one atomic batch: all of them take effect, or none. */
    commit: async (writes: readonly Write[]) => {
      await commit(db, writes);
    },
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
      /** The locales the org's screens are set to, each once; null for a screen set to none (the player's default). */
      locales: async () => (await db.selectDistinct({ locale: s.screens.locale }).from(s.screens).where(eq(s.screens.orgId, orgId)).all()).map((r) => r.locale),
      /**
       * Up to `limit` screens after `afterId`, by id, with only what their state is worked out
       * from: for the fleet poll, which must not read the org's whole list. One statement over the
       * `(org_id, id)` index; `credentialsRevoked` is whether the screen had credentials and every
       * one is revoked, read through `(org_id, screen_id)`.
       */
      statusPage: ({ afterId, limit }: { afterId?: string; limit: number }) =>
        db
          .select(statusColumns)
          .from(s.screens)
          .where(and(eq(s.screens.orgId, orgId), afterId === undefined ? undefined : gt(s.screens.id, afterId)))
          .orderBy(asc(s.screens.id))
          .limit(limit)
          .all(),
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
        /** Nothing written: the batch is refused (`StaleVersionError`, id `screens`) unless the org's screens are still exactly `ids`. */
        are: (ids: readonly string[]): Staged => {
          const sc = s.screens;
          const want = [...ids].sort().join(',');
          const now = sql`COALESCE((SELECT group_concat(id, ',') FROM (SELECT ${sc.id} AS id FROM ${sc} WHERE ${sc.orgId} = ${orgId} ORDER BY ${sc.id})), '')`;
          const stale = async () =>
            (await screens.list())
              .map((x) => x.id)
              .sort()
              .join(',') === want
              ? undefined
              : 0;
          return { row: undefined, writes: [staleGuard(db, orgId, 'screens', 0, sql`${now} = ${want}`, stale)] };
        },
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
            // The SET's right sides read the row as it was: the stored heartbeat is the last sync's.
            // A screen that said the same at the last sync had fallen back by then: a row from before
            // migration 0046 has no `fallback_since`, and takes that heartbeat's time, not this one's (#474).
            `UPDATE screens SET last_seen_at = ?, player_version = ?, heartbeat_json = ?,
               fallback_since = CASE WHEN ? IS NULL THEN NULL
                 WHEN json_extract(heartbeat_json, '$.manifest.fallbackFrom') IS ? THEN coalesce(fallback_since, json_extract(heartbeat_json, '$.at'), ?) ELSE ? END${report.sql}
             WHERE org_id = ? AND id = ? RETURNING ${mark} AS ack_seq`,
          )
          .bind(v.at, v.playerVersion, v.heartbeatJson, v.fallbackFrom, v.fallbackFrom, v.at, v.at, ...report.args, orgId, screenId, ...markArgs);
        const results = await d1.batch([...inserts, advance, update]);
        const row = results.at(-1)!.results[0] as { ack_seq: number } | undefined;
        if (!row) return undefined;
        return { ackSeq: row.ack_seq, rowsWritten: results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0) };
      },
      /** Screens' `key=value` labels (`screen_labels`). The only code that touches the table. */
      labels: {
        /** The org's labels, or one screen's, by screen then key. */
        list: (screenId?: string) =>
          db
            .select({ screenId: sl.screenId, key: sl.key, value: sl.value })
            .from(sl)
            .where(and(eq(sl.orgId, orgId), screenId === undefined ? undefined : eq(sl.screenId, screenId)))
            .orderBy(asc(sl.screenId), asc(sl.key))
            .all(),
        stage: {
          /**
           * A merge into each screen's labels: a key in `set` takes that value, a key in `remove`
           * goes, the rest stay. Pass `newScreen` for a screen staged in the same batch (a claim),
           * not stored yet. The batch fails, writing nothing, if a screen then has more labels or
           * the org more keys than `LABEL_LIMITS`, so two changes made at once cannot pass a limit
           * each was checked against alone. Throws `NotInOrgError` if a screen is not the org's.
           * 1,000 screens are one statement each way: the ids go as one JSON value.
           */
          update: async (
            screenIds: readonly string[],
            change: { set: Readonly<Record<string, string>>; remove: readonly string[] },
            { newScreen = false } = {},
          ): Promise<Staged> => {
            const ids = newScreen ? [...new Set(screenIds)] : await orgScreens(screenIds);
            const idsJson = JSON.stringify(ids);
            const sc = s.screens;
            const now = Date.now();
            const queries: unknown[] = [];
            if (change.remove.length)
              queries.push(
                db
                  .delete(sl)
                  .where(
                    and(
                      eq(sl.orgId, orgId),
                      sql`${sl.screenId} IN (SELECT value FROM json_each(${idsJson}))`,
                      sql`${sl.key} IN (SELECT value FROM json_each(${JSON.stringify(change.remove)}))`,
                    ),
                  ),
              );
            if (Object.keys(change.set).length)
              queries.push(
                db
                  .insert(sl)
                  // The table's columns in order: org, screen, key, value, created_at. Only the org's screens are joined.
                  .select(
                    sql`SELECT ${sc.orgId}, ${sc.id}, k.key, k.value, ${now} FROM ${sc}, json_each(${JSON.stringify(change.set)}) AS k
                        WHERE ${sc.orgId} = ${orgId} AND ${sc.id} IN (SELECT value FROM json_each(${idsJson}))`,
                  )
                  .onConflictDoUpdate({ target: [sl.orgId, sl.screenId, sl.key], set: { value: sql`excluded.value` } }),
              );
            const crowded = sql`EXISTS (SELECT 1 FROM ${sl} WHERE ${sl.orgId} = ${orgId} AND ${sl.screenId} IN (SELECT value FROM json_each(${idsJson})) GROUP BY ${sl.screenId} HAVING count(*) > ${LABEL_LIMITS.perScreen})`;
            const keys = sql`(SELECT count(DISTINCT ${sl.key}) FROM ${sl} WHERE ${sl.orgId} = ${orgId})`;
            // json() of text that is not JSON raises an error, which aborts the batch.
            queries.push(
              db
                .select({ ok: sql`json(CASE WHEN ${crowded} OR ${keys} > ${LABEL_LIMITS.keys} THEN 'over a label limit' ELSE '1' END)` })
                .from(s.organization)
                .where(eq(s.organization.id, orgId)),
            );
            return staged(undefined, ...queries);
          },
        },
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
      stage: {
        ...assets.stage,
        /**
         * Nothing written: the batch is refused (`StaleVersionError`, id `asset in use`) if, as it runs, a spot's draft or
         * published version, or a brand kit's logo, names the asset: an asset `delete`'s rule held to its commit (review of #429).
         * A spot's asset map and published version are matched as text, which can only err towards in use.
         */
        unused: (assetId: string): Write => {
          const sp = s.spots;
          const bk = s.brandKits;
          const holds = sql`NOT EXISTS (SELECT 1 FROM ${sp} WHERE ${sp.orgId} = ${orgId} AND (${sp.assetId} = ${assetId}
            OR instr(coalesce(${sp.assetMapJson}, ''), ${assetId}) > 0 OR instr(coalesce(${sp.publishedJson}, ''), ${assetId}) > 0))
            AND NOT EXISTS (SELECT 1 FROM ${bk} WHERE ${bk.orgId} = ${orgId} AND (${bk.logoOnDarkAssetId} = ${assetId} OR ${bk.logoOnLightAssetId} = ${assetId}))`;
          return staleGuard(db, orgId, 'asset in use', 0, holds, async () => 0);
        },
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
      /**
       * The org's playlists that play the spot (#242): in their draft (`playlist_items`) or in their
       * published version, which screens may have. A spot is deleted only when none does.
       */
      usedBy: async (spotId: string) => {
        const drafted = await db
          .select({ playlistId: pi.playlistId })
          .from(pi)
          .where(and(eq(pi.orgId, orgId), eq(pi.spotId, spotId)))
          .all();
        const inDraft = new Set(drafted.map((r) => r.playlistId));
        const playlists = await db.select().from(s.playlists).where(eq(s.playlists.orgId, orgId)).orderBy(asc(s.playlists.id)).all();
        return playlists.filter((p) => inDraft.has(p.id) || (published(p)?.items ?? []).includes(spotId));
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

    /**
     * The draft kept beside a spot's or playlist's while an agent's draft is on it (#116,
     * `draft_snapshots`): the person's draft it was written over, or the agent's a Reject set aside.
     * One per draft. A publish clears it (`stage.publish`), and it goes with its draft (the foreign
     * keys cascade).
     */
    draftSnapshots: {
      get: (kind: 'spot' | 'playlist', id: string) => db.select().from(ds).where(keptFor(kind, id)).get(),
      /** Every draft with one kept beside it, by kind and id: what a publish may have to clear. */
      kept: async () =>
        (await db.select({ spotId: ds.spotId, playlistId: ds.playlistId }).from(ds).where(eq(ds.orgId, orgId)).all()).flatMap(
          (r): { kind: 'spot' | 'playlist'; id: string }[] =>
            r.spotId ? [{ kind: 'spot', id: r.spotId }] : r.playlistId ? [{ kind: 'playlist', id: r.playlistId }] : [],
        ),
      stage: {
        /**
         * Keep `kept` beside `draft`, replacing whatever was kept: refused (`StaleVersionError`) unless the
         * draft is still the version read, as every write of a kept draft is (review of #410).
         */
        keep: (kind: 'spot' | 'playlist', draft: KeptDraft, holds: 'person' | 'agent', kept: KeptContent): Staged => {
          const { content, row } = keptRow(kind, draft.id, holds, kept);
          const target = kind === 'spot' ? [ds.orgId, ds.spotId] : [ds.orgId, ds.playlistId];
          return {
            row: undefined,
            writes: [draftAt(kind, draft), ...staged(undefined, db.insert(ds).values(row).onConflictDoUpdate({ target, set: content })).writes],
          };
        },
        /**
         * Keep `kept` as the person's draft an agent writes over `draft` with, unless one is kept already:
         * no read first. What a Reject set aside (the agent's) is replaced; a person's stays. Held to the
         * draft's version as read, as `keep` is.
         */
        propose: (kind: 'spot' | 'playlist', draft: KeptDraft, kept: KeptContent): Staged => {
          const { content, row } = keptRow(kind, draft.id, 'person', kept);
          const target = kind === 'spot' ? [ds.orgId, ds.spotId] : [ds.orgId, ds.playlistId];
          const insert = db
            .insert(ds)
            .values(row)
            .onConflictDoUpdate({ target, set: content, setWhere: eq(ds.holds, 'agent') });
          return { row: undefined, writes: [draftAt(kind, draft), ...staged(undefined, insert).writes] };
        },
        /**
         * Nothing written: the batch is refused (`StaleVersionError`, id `draft_snapshot`) unless, as it runs,
         * what is kept beside the draft still holds `holds`. A Reject or Keep decided from a read loses to a
         * Keep, Reject or publish that committed first (review of #410).
         */
        holding: (kind: 'spot' | 'playlist', id: string, holds: 'person' | 'agent'): Staged => {
          const still = sql`EXISTS (SELECT 1 FROM ${ds} WHERE ${keptFor(kind, id)} AND ${ds.holds} = ${holds})`;
          const stale = async () => ((await db.select().from(ds).where(keptFor(kind, id)).get())?.holds === holds ? undefined : 0);
          return { row: undefined, writes: [staleGuard(db, orgId, 'draft_snapshot', 0, still, stale)] };
        },
        clear: clearKept,
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
          const id = values.defaultPlaylistId;
          if (id != null && !(await playlists.get(id))) throw new NotInOrgError('playlist', id);
          const fresh = () => ({
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
          });
          return upsertVersioned(os, { id: 'settings', key: { orgId }, absent: 1, fresh }, values, ifVersion);
        },
        /**
         * Nothing written: the batch is refused (`StaleVersionError`, id `default_playlist`) unless, as it
         * runs, the org's default playlist is `playlistId` (null: it has none). A default chosen or changed
         * by someone else between a read and the batch fails it.
         */
        defaultIs: (playlistId: string | null): Staged => {
          const holds = sql`COALESCE((SELECT ${os.defaultPlaylistId} FROM ${os} WHERE ${os.orgId} = ${orgId}), '') = ${playlistId ?? ''}`;
          const stale = async () => {
            const row = await db.select({ id: os.defaultPlaylistId, version: os.rowVersion }).from(os).where(eq(os.orgId, orgId)).get();
            return (row?.id ?? null) === playlistId ? undefined : (row?.version ?? 1);
          };
          return { row: undefined, writes: [staleGuard(db, orgId, 'default_playlist', 0, holds, stale)] };
        },
        /**
         * Nothing written: the batch is refused (`StaleVersionError`, id `settings`) unless editors
         * still publish when it runs. For an editor's publish, whose right to it is this setting, read
         * before the batch: one turned off meanwhile fails it.
         */
        editorsPublish: (): Staged => {
          const holds = sql`COALESCE((SELECT ${os.editorsPublish} FROM ${os} WHERE ${os.orgId} = ${orgId}), 1) = 1`;
          const stale = async () => {
            const row = await db.select({ version: os.rowVersion, editorsPublish: os.editorsPublish }).from(os).where(eq(os.orgId, orgId)).get();
            return row && !row.editorsPublish ? row.version : undefined;
          };
          return { row: undefined, writes: [staleGuard(db, orgId, 'settings', 0, holds, stale)] };
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
        put: (kind: AlertChannelKind, values: AlertChannelValues, ifVersion?: number): Promise<Staged<AlertChannel>> =>
          upsertVersioned(ac, { id: `${kind} channel`, key: { orgId, kind }, absent: 0, fresh: (at) => ({ createdAt: at }) }, values, ifVersion),
        remove: (kind: AlertChannelKind): Staged => staged(undefined, db.delete(ac).where(and(eq(ac.orgId, orgId), eq(ac.kind, kind)))),
      },
    },

    /**
     * The model the org's agent uses with its own key (#261): one row, absent while it uses the
     * demo model. The key arrives sealed; nothing here opens it.
     */
    aiProvider: {
      get: () => db.select().from(ai).where(eq(ai.orgId, orgId)).get(),
      stage: {
        /**
         * Set the fields given, making the row if absent (a new one needs the provider and its key), and
         * move its version on; an absent row is at 0. With `ifVersion`, refused (`StaleVersionError`)
         * unless it is still that version, checked now and again in the batch, as `stage.update` is.
         * With `ifSealed`, refused the same way unless it still holds that sealed key: a row removed
         * and saved again starts at version 1 again, so a version alone can name another key.
         */
        put: async (values: AiProviderValues, ifVersion?: number, ifSealed?: string): Promise<Staged<AiProvider>> => {
          const upsert = await upsertVersioned(
            ai,
            {
              id: 'AI provider',
              key: { orgId },
              absent: 0,
              fresh: (at) => ({
                baseUrl: null,
                acceptsImages: false,
                jsonSchemaOutput: false,
                verifiedAt: null,
                fastModel: null,
                capableModel: null,
                dailyTurnCeiling: null,
                createdAt: at,
              }),
            },
            values,
            ifVersion,
          );
          if (ifSealed === undefined) return upsert;
          const holding = async () => {
            const now = await db.select({ keySealed: ai.keySealed, rowVersion: ai.rowVersion }).from(ai).where(eq(ai.orgId, orgId)).get();
            return now?.keySealed === ifSealed ? undefined : (now?.rowVersion ?? 0);
          };
          const moved = await holding();
          if (moved !== undefined) throw new StaleVersionError('AI provider', moved);
          const holds = sql`(SELECT ${ai.keySealed} FROM ${ai} WHERE ${ai.orgId} = ${orgId}) = ${ifSealed}`;
          return { row: upsert.row, writes: [staleGuard(db, orgId, 'AI provider', upsert.row.rowVersion - 1, holds, holding), ...upsert.writes] };
        },
        /** Delete the row, and the sealed key with it. */
        remove: (): Staged => staged(undefined, db.delete(ai).where(eq(ai.orgId, orgId))),
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
      /**
       * One email delivery of `event` per member in `userIds`, each its own row to send and retry (a
       * delivery addressed to approvers, fanned out when it is sent, M4-09): its event id names the
       * member, as one delivery per event and channel is kept, so a member already queued is left as it is.
       * The first `claim` are claimed for the caller to send now, leased for `leaseMs` as a run's claim is
       * (#396); the rest are due now. Returns the claimed rows it made, as they are.
       */
      queueEmails: async (
        event: QueuedAlert['event'],
        userIds: readonly string[],
        now: number,
        giveUpAt: number,
        { claim, leaseMs }: { claim: number; leaseMs: number },
      ): Promise<AlertDelivery[]> => {
        const [first, ...rest] = userIds.map((toUserId, i) =>
          db
            .insert(ad)
            .values(
              fullRow(ad, {
                id: newId('dlv'),
                orgId,
                channel: 'email',
                eventId: `${event.id}:${toUserId}`,
                eventType: event.type,
                eventJson: event.json,
                toUserId,
                giveUpAt,
                createdAt: now,
                updatedAt: now,
                ...(i < claim ? { attempts: 1, lastAttemptAt: now, nextAttemptAt: now + leaseMs, leasedUntil: now + leaseMs } : { nextAttemptAt: now }),
              }) as never,
            )
            .onConflictDoNothing()
            .returning(),
        );
        if (!first) return [];
        const made: AlertDelivery[][] = await db.batch([first, ...rest]);
        return made.flat().filter((d) => d.leasedUntil !== null);
      },
      /** Queues `alert` for each of its channels now, on its own (an agent's refusals, M4-08); an event already queued for a channel is left as it is. */
      queue: async (alert: QueuedAlert, now: number): Promise<void> => {
        const [first, ...rest] = queueAlert(alert, now, sql`1`);
        if (first) await db.batch([first, ...rest]);
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
      /**
       * What the org's screens would be branded with at the next publish, as one text: each kit's id
       * and version, and each assignment, the default included. Kits have no draft, so a publish
       * takes them as they are: a publish request records this, and its approval publishes only while
       * it is the same (`stage.unchanged`).
       */
      state: async (): Promise<string> => (await db.select({ state: brandState }).from(s.organization).where(eq(s.organization.id, orgId)).get())?.state ?? '',
      stage: {
        ...brandKitRows.stage,
        /** Nothing written: the batch is refused (`StaleVersionError`, id `brand`) unless the org's brand state is still `state`. */
        unchanged: (state: string): Staged => {
          const stale = async () =>
            (await db.select({ state: brandState }).from(s.organization).where(eq(s.organization.id, orgId)).get())?.state === state ? undefined : 0;
          return { row: undefined, writes: [staleGuard(db, orgId, 'brand', 0, sql`(${brandState}) = ${state}`, stale)] };
        },
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

    /** Requests to publish chosen drafts (M4-09), made and decided through the publish request tools. */
    publishRequests: {
      get: publishRequests.get,
      /**
       * Newest first, `after` the key `[createdAt, id]` of the last row of the page before; with
       * `pendingAt`, only those still waiting then: not decided, and not past `expires_at`.
       */
      list: ({ after, take, pendingAt }: { after?: readonly (string | number)[]; take: number; pendingAt?: number }) => {
        const [at, id] = after ?? [];
        const where: SQL[] = [eq(pr.orgId, orgId)];
        if (pendingAt !== undefined) where.push(eq(pr.status, 'pending'), gt(pr.expiresAt, pendingAt));
        if (typeof at === 'number' && typeof id === 'string') where.push(or(lt(pr.createdAt, at), and(eq(pr.createdAt, at), lt(pr.id, id)))!);
        return db
          .select()
          .from(pr)
          .where(and(...where))
          .orderBy(desc(pr.createdAt), desc(pr.id))
          .limit(take)
          .all();
      },
      /** `requestedBy`'s requests still waiting at `now`: not decided, and not past `expires_at`. */
      pendingBy: (requestedBy: string, now: number) =>
        db
          .select()
          .from(pr)
          .where(and(eq(pr.orgId, orgId), eq(pr.requestedBy, requestedBy), eq(pr.status, 'pending'), gt(pr.expiresAt, now)))
          .all(),
      stage: {
        /**
         * A new request, made at `now`: its `created_at`, which its expiry is counted from. The batch is
         * refused (`StaleVersionError`, id `publish_request`) if, as it runs, the asker already has one
         * waiting with the same pins, or `maxPending` waiting: two asked at once cannot both get past.
         */
        insert: (values: NewRow<typeof pr>, now: number, maxPending: number): Staged<PublishRequestRow> => {
          const row = fullRow(pr, { ...strip(values), id: newId('prq'), orgId, createdAt: now }) as PublishRequestRow;
          const waiting = sql`FROM ${pr} WHERE ${pr.orgId} = ${orgId} AND ${pr.requestedBy} = ${row.requestedBy} AND ${pr.status} = 'pending' AND ${pr.expiresAt} > ${now}`;
          const holds = sql`NOT EXISTS (SELECT 1 ${waiting} AND ${pr.draftsJson} = ${row.draftsJson}) AND (SELECT COUNT(*) ${waiting}) < ${maxPending}`;
          return { row, writes: [staleGuard(db, orgId, 'publish_request', 0, holds, async () => 0), ...staged(row, db.insert(pr).values(row)).writes] };
        },
        /**
         * Decided: approved (with the publish it made, if any) or declined, by `by` at `now`. The batch
         * is refused (`StaleVersionError`) unless the request is still the version read and not expired
         * at `now`, so of two decisions from one read one commits, and one that took past the expiry
         * commits nothing.
         */
        decide: (
          current: PublishRequestRow,
          decision: { status: 'approved' | 'declined'; by: string; now: number; publishId?: string | null },
        ): Staged<PublishRequestRow> => {
          const changed = publishRequests.stage.update(current, {
            status: decision.status,
            decidedBy: decision.by,
            decidedAt: decision.now,
            publishId: decision.publishId ?? null,
          });
          // Not expired at its decision's time, nor by the database's own clock as the batch runs: a
          // decision whose batch runs late (a publish that took long) commits nothing past the expiry.
          const holds = sql`EXISTS (SELECT 1 FROM ${pr} WHERE ${pr.orgId} = ${orgId} AND ${pr.id} = ${current.id} AND ${pr.rowVersion} = ${current.rowVersion} AND ${pr.expiresAt} > ${decision.now} AND ${pr.expiresAt} > CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
          // Changed since, or past its expiry by either clock: either way not the request that was read. Asked only once the
          // guard failed, so never "holds again" by the Worker's clock, which may be behind the database's (#396).
          const stale = async () => (await publishRequests.get(current.id))?.rowVersion ?? 0;
          return { row: changed.row, writes: [staleGuard(db, orgId, current.id, current.rowVersion, holds, stale), ...changed.writes] };
        },
        /**
         * A declined request put back to pending, undecided, at `now` (#115's Undo). The batch is refused
         * (`StaleVersionError`) unless, as it runs, it is still the declined version read and not expired at
         * `now` nor by the database's clock: one reopened or decided since, or past its expiry, commits nothing.
         * And, as `insert` holds it, its asker has no other request waiting with the same pins, and fewer than
         * `maxPending` waiting: a request asked again since the decline is the one that waits.
         */
        reopen: (current: PublishRequestRow, now: number, maxPending: number): Staged<PublishRequestRow> => {
          const changed = publishRequests.stage.update(current, { status: 'pending', decidedBy: null, decidedAt: null, publishId: null });
          const waiting = sql`FROM ${pr} WHERE ${pr.orgId} = ${orgId} AND ${pr.requestedBy} = ${current.requestedBy} AND ${pr.status} = 'pending' AND ${pr.expiresAt} > ${now}`;
          const holds = sql`EXISTS (SELECT 1 FROM ${pr} WHERE ${pr.orgId} = ${orgId} AND ${pr.id} = ${current.id} AND ${pr.rowVersion} = ${current.rowVersion} AND ${pr.status} = 'declined' AND ${pr.expiresAt} > ${now} AND ${pr.expiresAt} > CAST(unixepoch('subsec') * 1000 AS INTEGER)) AND NOT EXISTS (SELECT 1 ${waiting} AND ${pr.draftsJson} = ${current.draftsJson}) AND (SELECT COUNT(*) ${waiting}) < ${maxPending}`;
          // As `decide`'s: not the request that was read, by the database's clock too (#396).
          const stale = async () => (await publishRequests.get(current.id))?.rowVersion ?? 0;
          return { row: changed.row, writes: [staleGuard(db, orgId, current.id, current.rowVersion, holds, stale), ...changed.writes] };
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
         * The batch fails as a stale read (`StaleVersionError`, id `screens`, version 0) unless
         * every screen is the org's when it commits: one deleted since the publish read it, or
         * another org's, which would otherwise fail on the rows' foreign key. A publish retries
         * that from a fresh read. Nothing is read here: 1,000 screens are one statement's check.
         * The publish may not be stored yet: the `(org_id, publish_id)` foreign key refuses another org's.
         */
        addScreens: (publishId: string, rows: readonly { screenId: string; manifestId: string }[]): Staged => {
          const ids = [...new Set(rows.map((r) => r.screenId))];
          const values = rows.map((r) => ({ orgId, publishId, screenId: r.screenId, manifestId: r.manifestId }));
          const inserts = staged(undefined, ...chunk(values, 4).map((part) => db.insert(ps).values(part)));
          if (!ids.length) return inserts;
          // The ids go as one JSON value, past the 100-parameter limit.
          const sc = s.screens;
          const found = sql`(SELECT count(*) FROM ${sc} WHERE ${sc.orgId} = ${orgId} AND ${sc.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)})))`;
          const stale = async () => ((await screens.getMany(ids)).length === ids.length ? undefined : 0);
          return { row: undefined, writes: [staleGuard(db, orgId, 'screens', ids.length, sql`${found} = ${ids.length}`, stale), ...inserts.writes] };
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
          const stale = async () => {
            const now = (await db.select({ v: os.publishRevision }).from(os).where(eq(os.orgId, orgId)).get())?.v ?? 0;
            return now === revision ? undefined : now;
          };
          // Not a setting: the version and `updatedAt` stay, so an open settings form does not conflict.
          const move = db
            .insert(os)
            .values({ orgId, publishRevision: 1 })
            .onConflictDoUpdate({ target: os.orgId, set: { publishRevision: sql`${os.publishRevision} + 1`, updatedAt: sql`${os.updatedAt}` } });
          return {
            row: undefined,
            writes: [staleGuard(db, orgId, 'publish revision', revision, sql`${read} = ${revision}`, stale), ...staged(undefined, move).writes],
          };
        },
      },
      /**
       * Mark a publish's rollout finished at `now`, with how many of its screens were playing it
       * (`reached`), and queue its alert, in one batch; false if it was marked already (by a check
       * that queued the same event, which is queued once). Without `alert`, the mark alone.
       */
      finish: async (publishId: string, now: number, reached: number, alert?: QueuedAlert): Promise<boolean> => {
        const p = s.publishes;
        const [marked] = await db.batch([
          db
            .update(p)
            .set({ finishedAt: now, reached })
            .where(and(eq(p.orgId, orgId), eq(p.id, publishId), isNull(p.finishedAt)))
            .returning({ id: p.id }),
          ...(alert ? queueAlert(alert, now, sql`1`) : []),
        ]);
        return marked.length === 1;
      },
      /**
       * Publishes newest first, `limit` of them from below `beforeRevision`, each with who made it
       * (a member's name, else their address before the @: every member reads this list, so never
       * the whole address, #253), for a roll back the revision it went back to, and its rollout's
       * `rolloutCounts`, read after the page: a publish's screens commit with it.
       */
      history: async ({ beforeRevision, limit }: { beforeRevision?: number; limit: number }) => {
        const p = s.publishes;
        const restored = alias(s.publishes, 'restored');
        const page = await db
          .select({
            ...getTableColumns(p),
            actorName: sql<string | null>`coalesce(nullif(${s.user.name}, ''), substr(${s.user.email}, 1, instr(${s.user.email}, '@') - 1))`,
            restoresRevision: restored.revision,
          })
          .from(p)
          .leftJoin(s.user, and(eq(p.actorKind, 'user'), eq(s.user.id, p.actorId)))
          .leftJoin(restored, and(eq(restored.orgId, p.orgId), eq(restored.id, p.restoresId)))
          .where(and(eq(p.orgId, orgId), beforeRevision === undefined ? undefined : lt(p.revision, beforeRevision)))
          .orderBy(desc(p.revision))
          .limit(limit)
          .all();
        const [newest, oldest] = [page[0], page.at(-1)];
        if (!newest || !oldest) return [];
        // The page is every publish between its revisions: a range, past the 100-parameter limit.
        const counts = await rolloutCounts(db, and(eq(p.orgId, orgId), gte(p.revision, oldest.revision), lte(p.revision, newest.revision)));
        return page.map((h) => ({ ...h, rollout: counts.get(h.id) ?? [] }));
      },
      /**
       * The latest publish at or before `atOrBefore` that gave `screenId` the manifest `manifestId` (#367): the one a
       * screen fell back from, made before it said so (a roll back that sent the same manifest later is not it). For
       * its page to link to; undefined when none did.
       */
      ofManifest: (screenId: string, manifestId: string, atOrBefore: number) => {
        const p = s.publishes;
        return db
          .select({ id: p.id, revision: p.revision })
          .from(ps)
          .innerJoin(p, and(eq(p.orgId, ps.orgId), eq(p.id, ps.publishId)))
          .where(and(eq(ps.orgId, orgId), eq(ps.screenId, screenId), eq(ps.manifestId, manifestId), lte(p.createdAt, atOrBefore)))
          .orderBy(desc(p.revision))
          .limit(1)
          .get();
      },
      /** A publish's screens, by name, with the manifest each got and what its state is worked out from now. */
      rollout: (publishId: string) =>
        db
          .select({ ...statusColumns, ...rolloutFacts, name: s.screens.name, manifestId: ps.manifestId })
          .from(ps)
          .innerJoin(s.screens, and(eq(s.screens.orgId, ps.orgId), eq(s.screens.id, ps.screenId)))
          .where(and(eq(ps.orgId, orgId), eq(ps.publishId, publishId)))
          .orderBy(asc(s.screens.name), asc(s.screens.id))
          .all(),
      /**
       * The manifest each screen had right after the publish at `revision`: the one from the last
       * publish up to it that switched the screen. A screen no such publish switched is absent.
       */
      asOf: (revision: number) => {
        const p = s.publishes;
        const p2 = alias(s.publishes, 'p2');
        const ps2 = alias(ps, 'ps2');
        const last = db
          .select({ r: sql`max(${p2.revision})` })
          .from(ps2)
          .innerJoin(p2, and(eq(p2.orgId, ps2.orgId), eq(p2.id, ps2.publishId)))
          .where(and(eq(ps2.orgId, ps.orgId), eq(ps2.screenId, ps.screenId), lte(p2.revision, revision)));
        return db
          .select({ screenId: ps.screenId, manifestId: ps.manifestId })
          .from(ps)
          .innerJoin(p, and(eq(p.orgId, ps.orgId), eq(p.id, ps.publishId)))
          .where(and(eq(ps.orgId, orgId), eq(p.revision, sql`(${last})`)))
          .orderBy(asc(ps.screenId))
          .all();
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
      stage: {
        ...dataSources.stage,
        insert: async (values: NewRow<typeof s.dataSources>) => {
          await checkConnection(values.connectionId);
          return dataSources.stage.insert(values);
        },
        update: async (current: typeof s.dataSources.$inferSelect, patch: RowPatch<typeof s.dataSources>, ifVersion?: number) => {
          await checkConnection(patch.connectionId);
          const clean = strip(patch);
          return dataSources.stage.update(current, { ...sourceEdited(current, clean), ...clean }, ifVersion);
        },
        /**
         * Delete each of these sources, with its snapshot, made before `madeBefore`, that no spot
         * binds when the batch runs: in its draft or its published version. The check is in the
         * statement, so a spot bound to one since the caller looked keeps it, and staged after a
         * publish's promotions it sees them.
         */
        deleteUnbound: (ids: readonly string[], madeBefore: number): Staged => {
          if (!ids.length) return { row: undefined, writes: [] };
          const ds = s.dataSources;
          const sp = s.spots;
          const binds = (bindings: SQL) =>
            sql`EXISTS (SELECT 1 FROM ${sp}, json_each(COALESCE(${bindings}, '{}')) AS b WHERE ${sp.orgId} = ${ds.orgId} AND json_extract(b.value, '$.source') = ${ds.id})`;
          return staged(
            undefined,
            db
              .delete(ds)
              .where(
                and(
                  eq(ds.orgId, orgId),
                  lt(ds.createdAt, madeBefore),
                  sql`${ds.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
                  sql`NOT ${binds(sql`${sp.bindingsJson}`)}`,
                  sql`NOT ${binds(sql`json_extract(${sp.publishedJson}, '$.bindingsJson')`)}`,
                ),
              ),
          );
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
      /**
       * Everything the poller needs once per org: the claimed sources with their latest snapshot
       * versions, plus published spots (with template manifests), the screens' desired manifests (an
       * `sf push`'s as well as a publish's, #481) and screen/org locales for bound field checks — all
       * in one D1 batch.
       */
      pollInit: async (ids: readonly string[]) => {
        if (!ids.length) return { rows: [], spots: [], manifests: [], locales: [null as string | null] };
        const ds = s.dataSources;
        const sp = s.spots;
        const tv = s.templateVersions;
        const [rows, spots, manifests, screenLocales, settings] = await db.batch([
          db
            .select({ source: ds, snapshotVersion: snap.version })
            .from(ds)
            .leftJoin(snap, and(eq(snap.orgId, ds.orgId), eq(snap.dataSourceId, ds.id)))
            .where(and(eq(ds.orgId, orgId), sql`${ds.id} IN (SELECT value FROM json_each(${JSON.stringify([...ids])}))`)),
          db
            .select({ id: sp.id, publishedJson: sp.publishedJson, manifestJson: tv.manifestJson })
            .from(sp)
            .leftJoin(tv, sql`${tv.id} = json_extract(${sp.publishedJson}, '$.templateVersionId') AND (${tv.orgId} IS NULL OR ${tv.orgId} = ${sp.orgId})`)
            .where(and(eq(sp.orgId, orgId), isNotNull(sp.publishedJson))),
          db
            .select({ screenId: s.screens.id, manifestId: s.screens.desiredManifestId })
            .from(s.screens)
            .where(and(eq(s.screens.orgId, orgId), isNotNull(s.screens.desiredManifestId))),
          db.selectDistinct({ locale: s.screens.locale }).from(s.screens).where(eq(s.screens.orgId, orgId)),
          db.select({ locale: s.orgSettings.locale }).from(s.orgSettings).where(eq(s.orgSettings.orgId, orgId)).limit(1),
        ]);
        return {
          rows: rows.map((r) => ({ source: r.source, snapshotVersion: r.snapshotVersion ?? null })),
          spots: spots.filter((r): r is { id: string; publishedJson: string; manifestJson: string | null } => r.publishedJson !== null),
          manifests: manifests.flatMap((r) => (r.manifestId === null ? [] : [{ screenId: r.screenId, manifestId: r.manifestId }])),
          locales: screenLocales.length ? screenLocales.map((r) => r.locale) : [settings[0]?.locale ?? null],
        };
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
      /** When each source's latest snapshot was last confirmed, without its data (up to 64 kB each). */
      checkedTimes: async (dataSourceIds: readonly string[]) =>
        dataSourceIds.length
          ? db
              .select({ dataSourceId: snap.dataSourceId, checkedAt: snap.checkedAt })
              .from(snap)
              .where(and(eq(snap.orgId, orgId), inArray(snap.dataSourceId, [...dataSourceIds])))
              .all()
          : [],
      putSnapshot: async (dataSourceId: string, v: Snapshot) => {
        if (!(await dataSources.get(dataSourceId))) throw new NotInOrgError('data source', dataSourceId);
        const fields = snapshotFields(v);
        await db
          .insert(snap)
          .values({ ...fields, orgId, dataSourceId })
          .onConflictDoUpdate({ target: [snap.orgId, snap.dataSourceId], set: fields })
          .run();
      },
      /**
       * What one poll found, in one batch: the source's patch (next poll, failures, validators),
       * and either a changed `snapshot` or, when the feed still says the same, its new `checkedAt`.
       * A news source's poll also passes `photos` (./feed-photos.ts): its writes and optional photo
       * holds then stand only if the source is still the row the poll read, and a reread is left due
       * if not. Returns whether the poll's writes stood and the photo URLs held for queueing. Throws
       * `NotInOrgError` if the source does not belong to this org without an extra read.
       */
      savePoll: async (
        dataSourceId: string,
        poll: { source: RowPatch<typeof s.dataSources> & { nextPollAt: number }; snapshot?: Snapshot; checkedAt?: number; photos?: PollPhotos },
      ): Promise<{ stood: boolean; held: string[] }> => {
        const ds = s.dataSources;
        const mine = and(eq(ds.orgId, orgId), eq(ds.id, dataSourceId));
        const mineSnap = and(eq(snap.orgId, orgId), eq(snap.dataSourceId, dataSourceId));
        const photos = poll.photos && pollSave(db, orgId, dataSourceId, poll.photos);
        const check = db
          .select({
            ok: sql`json(CASE WHEN EXISTS (SELECT 1 FROM ${ds} WHERE ${ds.orgId} = ${orgId} AND ${ds.id} = ${dataSourceId}) THEN '1' ELSE 'not in org' END)`,
          })
          .from(sql`(SELECT 1)`);
        // Not `stage.update`: a poll leaves the row's version alone, so it never makes a person's edit stale.
        const sourceWrite = db
          .update(ds)
          .set(updateSet(ds, strip({ ...poll.source, ...photos?.patch })))
          .where(and(mine, photos?.sameVersion));
        type BatchQuery = Parameters<Db['batch']>[0][number];
        const queries: BatchQuery[] = [check, sourceWrite];
        if (poll.snapshot) {
          const { version, fetchedAt, checkedAt, dataJson } = poll.snapshot;
          const fields = { version, fetchedAt, checkedAt, dataJson };
          queries.push(
            db
              .insert(snap)
              .select(sql`SELECT ${orgId}, ${dataSourceId}, ${version}, ${fetchedAt}, ${checkedAt}, ${dataJson} WHERE ${photos?.current ?? sql`1`}`)
              .onConflictDoUpdate({ target: [snap.orgId, snap.dataSourceId], set: fields }),
          );
        } else if (poll.checkedAt !== undefined) {
          queries.push(db.update(snap).set({ checkedAt: poll.checkedAt }).where(and(mineSnap, photos?.current)));
        }
        const holdAt = photos?.hold ? queries.push(photos.hold) - 1 : undefined;
        if (photos) queries.push(photos.reread);
        try {
          const [first, ...rest] = queries;
          const results = await db.batch([first!, ...rest]);
          const stood = ((results[1] as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
          const held = holdAt !== undefined ? (results[holdAt] as { url: string }[]).map((r) => r.url) : [];
          return { stood, held };
        } catch (err) {
          // biome-ignore lint/style/useErrorCause: the cause is passed in the options argument.
          if (!(await dataSources.get(dataSourceId))) throw new NotInOrgError('data source', dataSourceId, { cause: err });
          throw err;
        }
      },
    },

    /** The photos the org's news sources name (./feed-photos.ts). Written by the poller and the photos queue, not by tools. */
    feedPhotos: feedPhotos(db, orgId),
    /** What it stores that nothing needs any more (#235, ./storage.ts). */
    storage: storage(db, orgId),

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

    /**
     * The org's agent grants (M4-04): what an agent's OAuth client may do here, as one member. The
     * provider's tokens carry a grant's id as their reference id (`agentGrantForToken`).
     */
    agentGrants: {
      ...grants,
      /** The user's grants here not yet revoked, expired ones included: their tokens are still stored. */
      unrevokedFor: (userId: string) =>
        db
          .select()
          .from(ag)
          .where(and(eq(ag.orgId, orgId), eq(ag.userId, userId), isNull(ag.revokedAt)))
          .orderBy(asc(ag.id))
          .all(),
      /**
       * The grants not revoked, newest first, each with its client's registered redirect URIs (the
       * provider's `oauthClient`, reached only through a grant here): what Settings › Connected agents (MCP)
       * lists (M4-07). `userId` keeps one member's; `grantId` one grant.
       */
      connected: (filter: { userId?: string; grantId?: string } = {}) =>
        db
          .select({ grant: ag, redirectUrisJson: s.oauthClient.redirectUris })
          .from(ag)
          .innerJoin(s.oauthClient, eq(s.oauthClient.clientId, ag.clientId))
          .where(
            and(
              eq(ag.orgId, orgId),
              isNull(ag.revokedAt),
              filter.userId === undefined ? undefined : eq(ag.userId, filter.userId),
              filter.grantId === undefined ? undefined : eq(ag.id, filter.grantId),
            ),
          )
          .orderBy(desc(ag.createdAt), asc(ag.id))
          .all(),
      /** Used now: its 90 days unused start again. Bookkeeping, not audited; a revoked grant stays revoked. */
      touch: (grantId: string, now: number) =>
        db
          .update(ag)
          .set({ lastUsedAt: now, expiresAt: now + AGENT_GRANT_IDLE_MS })
          .where(and(eq(ag.orgId, orgId), eq(ag.id, grantId), isNull(ag.revokedAt)))
          .run(),
      stage: {
        ...grants.stage,
        /**
         * Revoked by `by` at `now`, and in the same batch the provider's access and refresh tokens,
         * consents and unexchanged authorization codes for it deleted, so its client's next refresh is refused too (M4-01's RESULTS,
         * limitation 3). Only this org's grant's: the deletes find it here first. Already revoked: nothing.
         */
        revoke: (grant: typeof ag.$inferSelect, by: string, now: number): Staged<typeof ag.$inferSelect> => {
          if (grant.revokedAt !== null) return { row: grant, writes: [] };
          // Guarded by the version read: of two revokes from one read, the second commits nothing.
          const revoked = grants.stage.update(grant, { revokedAt: now, revokedBy: by }, grant.rowVersion);
          const ours = db
            .select({ id: ag.id })
            .from(ag)
            .where(and(eq(ag.orgId, orgId), eq(ag.id, grant.id)));
          return { row: revoked.row, writes: [...revoked.writes, ...grantTokenDeletes(ours).writes] };
        },
        /**
         * Every grant `userId` holds here still connected, revoked by `by` at `now` as their membership ends (#328): one
         * audit row each (`detailJson`, as `clientId`), their tokens, consents and codes deleted, and each marked, in six
         * statements however many grants. No version is held: a scope change meanwhile does not keep a grant connected
         * once its member has gone, and one revoked meanwhile is left as it is, with no second audit row (review of #422).
         */
        revokeAllOf: (userId: string, by: string, clientId: string, now: number, detailJson: string): Staged => {
          const theirs = and(eq(ag.orgId, orgId), eq(ag.userId, userId));
          const live = and(theirs, isNull(ag.revokedAt));
          const a = s.auditLog;
          // Before the grants are marked, so it names exactly those still connected. Its id is the grant's: a grant is revoked once.
          const audit = db.insert(a).select(
            db
              .select({
                id: sql<string>`'aud_end_' || ${ag.id}`.as('id'),
                orgId: ag.orgId,
                at: sql<number>`${now}`.as('at'),
                actorKind: sql<'user'>`'user'`.as('actor_kind'),
                actorId: sql<string>`${by}`.as('actor_id'),
                clientId: sql<string>`${clientId}`.as('client_id'),
                action: sql<string>`'revoke_agent_grant'`.as('action'),
                targetKind: sql<string>`'agent_grant'`.as('target_kind'),
                targetId: ag.id,
                detailJson: sql<string>`${detailJson}`.as('detail_json'),
              })
              .from(ag)
              .where(live),
          );
          const mark = db
            .update(ag)
            .set({ revokedAt: now, revokedBy: by, rowVersion: sql`${ag.rowVersion} + 1` })
            .where(live);
          return {
            row: undefined,
            writes: [
              ...staged(undefined, audit).writes,
              ...grantTokenDeletes(db.select({ id: ag.id }).from(ag).where(theirs)).writes,
              ...staged(undefined, mark).writes,
            ],
          };
        },
      },
    },

    /**
     * The org's members (Better Auth's `member` rows), with each one's name and address. Read only:
     * members change through Better Auth's organization endpoints, which keep its rules (one of our
     * roles each) and write the audit row (`membershipAudit` in apps/api). Migration 0036's triggers
     * refuse a write that would leave the org without an owner (#292).
     */
    members: {
      list: () => memberRows().orderBy(s.member.createdAt, s.member.id).all(),
      get: (memberId: string) => memberRows(eq(s.member.id, memberId)).get(),
      /** The user's role here now, or undefined if they are no longer a member. */
      roleOf: async (userId: string) => (await memberRows(eq(s.member.userId, userId)).get())?.role,
      stage: {
        /**
         * Nothing written: the batch is refused (`StaleVersionError`, id `member`) unless, as it runs,
         * `userId` is still a member in one of `roles`, and, when `editorsOnlyWhilePublishing`, an editor
         * only while the org lets editors publish. The right a change was checked for, held to its commit.
         */
        stillMay: (userId: string, roles: readonly string[], editorsOnlyWhilePublishing: boolean): Staged => {
          const m = s.member;
          const setting = sql`COALESCE((SELECT ${os.editorsPublish} FROM ${os} WHERE ${os.orgId} = ${orgId}), 1) = 1`;
          const holds = sql`EXISTS (SELECT 1 FROM ${m} WHERE ${m.organizationId} = ${orgId} AND ${m.userId} = ${userId} AND ${inArray(m.role, [...roles])}${
            editorsOnlyWhilePublishing ? sql` AND (${m.role} <> 'editor' OR ${setting})` : sql``
          })`;
          return { row: undefined, writes: [staleGuard(db, orgId, 'member', 0, holds, async () => 0)] };
        },
      },
    },
    /** The org's invitations (Better Auth's `invitation` rows): read, and cancelled (`stage.cancel`); Better Auth makes them. */
    invitations: {
      /** Those still pending, oldest first. One whose `expiresAt` has passed can no longer be accepted. */
      pending: () =>
        db
          .select()
          .from(s.invitation)
          .where(and(eq(s.invitation.organizationId, orgId), eq(s.invitation.status, 'pending')))
          .orderBy(s.invitation.createdAt, s.invitation.id)
          .all(),
      get: (invitationId: string) =>
        db
          .select()
          .from(s.invitation)
          .where(and(eq(s.invitation.organizationId, orgId), eq(s.invitation.id, invitationId)))
          .get(),
      stage: {
        /**
         * Cancel a pending invitation of this org, as Better Auth's cancel does (`canceled`), for a caller with
         * no session (an agent over /mcp, #321). The batch is refused (`StaleVersionError`, id the invitation's)
         * unless, as it runs, the invitation is this org's and still pending: one accepted, rejected or
         * cancelled meanwhile is left as it is. Only this one write to Better Auth's table: inviting stays its.
         */
        cancel: (invitationId: string): Staged => {
          const iv = s.invitation;
          // Better Auth's table: its primary key is the id alone, with no org in it, so this predicate is the only thing
          // keeping the guard and the update to this org's row. Both use it, unchanged.
          const mine = and(eq(iv.organizationId, orgId), eq(iv.id, invitationId), eq(iv.status, 'pending'));
          const holds = sql`EXISTS (SELECT 1 FROM ${iv} WHERE ${mine})`;
          const stale = async () => ((await db.select({ id: iv.id }).from(iv).where(mine).get()) ? undefined : 0);
          return {
            row: undefined,
            writes: [staleGuard(db, orgId, invitationId, 0, holds, stale), ...staged(undefined, db.update(iv).set({ status: 'canceled' }).where(mine)).writes],
          };
        },
      },
    },

    auditLog: {
      /** One statement, not a batch: for a change made outside ours (Better Auth's), which no batch of ours records. */
      append: async (entry: NewRow<typeof s.auditLog>) =>
        db
          .insert(s.auditLog)
          .values({ ...strip(entry), id: newId('aud'), orgId })
          .returning()
          .get(),
      /** The audit row for a change, staged to commit with it. */
      stage: (entry: NewRow<typeof s.auditLog>) => audit.stage.insert(entry),
      /**
       * An audit row written at most once for `key` in this org (an agent grant's refusals in one
       * window, which several calls may race to record): another call with the key writes nothing.
       * Its id is a hash of the org and the key, so no other org's row can stand in for it, and of
       * fixed length (49 characters) under the contract's `ID_PATTERN` however long the key is.
       */
      appendOnce: async (key: string, entry: Omit<NewRow<typeof s.auditLog>, 'id'>): Promise<void> => {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${orgId}\n${key}`)));
        const hash = [...digest.subarray(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('');
        await db
          .insert(s.auditLog)
          .values({ ...strip(entry), id: `aud_once_${hash}`, orgId })
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
      /**
       * One page of the log, newest first, in `list`'s order, read in SQL: up to `limit` rows after
       * `after` (the `[at, seq]` of the last row of the page before), each with its `seq` (its
       * `rowid`, which breaks ties within a millisecond; audit_log_org_at_idx holds it, so the
       * order needs no sort). Every filter is optional; `query` matches the action, the actor's
       * and the target's ids and the detail (but not that of `hideDetailOf`'s actions), as text,
       * ignoring ASCII case.
       */
      page: (p: AuditPage) => {
        const a = s.auditLog;
        const seq = sql<number>`rowid`;
        const where: SQL[] = [eq(a.orgId, orgId)];
        if (p.after) {
          const [at, rowid] = p.after;
          where.push(or(lt(a.at, at), and(eq(a.at, at), sql`rowid < ${rowid}`))!);
        }
        if (p.actorKind) where.push(eq(a.actorKind, p.actorKind));
        if (p.actorId) where.push(eq(a.actorId, p.actorId));
        if (p.action) {
          const also = p.alsoAction;
          const alsoWhere = also && [
            inArray(a.action, [...also.actions]),
            ...(also.detailHas === undefined ? [] : [sql`instr(${a.detailJson}, ${also.detailHas}) > 0`]),
            ...Object.entries(also.inputHas ?? {}).map(([key, has]) => {
              const value = sql`json_extract(${a.detailJson}, ${`$.input.${key}`})`;
              return has ? sql`${value} is not null` : sql`${value} is null`;
            }),
            // json_type, not json_extract: a key given as null (hours cleared) is there, and json_extract reads it as absent (#545).
            ...(also.inputHasAny?.length ? [or(...also.inputHasAny.map((key) => sql`json_type(${a.detailJson}, ${`$.input.${key}`}) is not null`))!] : []),
          ];
          where.push(alsoWhere ? or(eq(a.action, p.action), and(...alsoWhere))! : eq(a.action, p.action));
        }
        if (p.targetKind) where.push(eq(a.targetKind, p.targetKind));
        if (p.targetId) where.push(eq(a.targetId, p.targetId));
        if (p.from != null) where.push(sql`${a.at} >= ${p.from}`);
        if (p.to != null) where.push(lt(a.at, p.to));
        if (p.query) {
          // instr, not LIKE: D1 refuses a LIKE pattern over 50 bytes, and instr has no wildcards to escape.
          const has = (c: SQLiteColumn) => sql`instr(lower(${c}), lower(${p.query})) > 0`;
          const detail = p.hideDetailOf?.length ? and(has(a.detailJson), notInArray(a.action, [...p.hideDetailOf]))! : has(a.detailJson);
          where.push(or(has(a.action), has(a.actorId), has(a.targetId), detail)!);
        }
        return db
          .select({ ...getTableColumns(a), seq })
          .from(a)
          .where(and(...where))
          .orderBy(desc(a.at), desc(seq))
          .limit(p.limit)
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
        const rows = counts.map((c) => ({ hour: c.hour, spotId: c.spotId, plays: c.plays, ms: c.ms, orgId, screenId }));
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
