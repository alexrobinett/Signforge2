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
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { assertId, newId } from './ids';
import * as s from './schema';
import { contentJson } from './drafts';
import { commit, fullRow, staged, updateSet, type Staged, type Write } from './writes';

type Db = DrizzleD1Database<Record<string, never>>;
type TenantTable = SQLiteTable & { id: SQLiteColumn; orgId: SQLiteColumn };

/** Writing a row that refers to something the org cannot see. */
export class NotInOrgError extends Error {
  constructor(what: string, id: string) {
    super(`${what} ${id} not found`);
    this.name = 'NotInOrgError';
  }
}

/**
 * Fields a caller may never set: the org is the scope's, the id is fixed at insert, and a draft's
 * published version is written only by `stage.publish` (./drafts.ts).
 */
type Guarded = 'orgId' | 'id' | 'createdAt' | 'publishedJson' | 'publishedAt';
export type NewRow<T extends SQLiteTable> = Omit<T['$inferInsert'], Guarded> & { id?: string };
export type RowPatch<T extends SQLiteTable> = Partial<Omit<T['$inferInsert'], Guarded>>;

function strip<T extends object>(v: T): T {
  const { orgId: _o, id: _i, createdAt: _c, publishedJson: _pj, publishedAt: _pa, ...rest } = v as Record<string, unknown>;
  return rest as T;
}

/** D1 binds at most 100 parameters per statement; leave one for the org. */
function chunk<T>(rows: T[], columns: number): T[][] {
  const size = Math.max(1, Math.floor(99 / columns));
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** get / list / insert / update / delete over a table keyed by `(org_id, id)`. */
function entity<T extends TenantTable>(db: Db, orgId: string, table: T, prefix: string) {
  type Row = T['$inferSelect'];
  // Drizzle's builders do not type-check over a generic table; the public signatures carry the types.
  const t = table as unknown as typeof s.screens;
  const mine = (id: string) => and(eq(t.orgId, orgId), eq(t.id, id));
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
      const id = values.id ?? newId(prefix);
      assertId(id);
      return (await db
        .insert(t)
        .values({ ...strip(values as object), id, orgId } as never)
        .returning()
        .get()) as Row;
    },
    /** Returns the updated row, or undefined if the org has no such row. An empty patch changes nothing. */
    update: async (id: string, patch: RowPatch<T>): Promise<Row | undefined> => {
      const set = strip(patch as object);
      if (!Object.values(set).some((v) => v !== undefined)) return (await db.select().from(t).where(mine(id)).get()) as Row | undefined;
      return (await db
        .update(t)
        .set(set as never)
        .where(mine(id))
        .returning()
        .get()) as Row | undefined;
    },
    delete: async (id: string): Promise<boolean> => (await db.delete(t).where(mine(id)).returning({ id: t.id }).all()).length > 0,
    /** The same changes, staged for the scope's `commit` (./writes.ts). */
    stage: {
      insert: (values: NewRow<T>): Staged<Row> => {
        const id = values.id ?? newId(prefix);
        assertId(id);
        const row = fullRow(t, { ...strip(values as object), id, orgId });
        return staged(row as Row, db.insert(t).values(row as never));
      },
      /** `current` is the row as read; the staged row is it with the patch applied. An empty patch stages nothing. */
      update: (current: Row, patch: RowPatch<T>): Staged<Row> => {
        const set = updateSet(t, strip(patch as Record<string, unknown>));
        if (!Object.keys(set).length) return { row: current, writes: [] };
        return staged(
          { ...current, ...set } as Row,
          db
            .update(t)
            .set(set as never)
            .where(mine((current as { id: string }).id)),
        );
      },
      delete: (id: string): Staged => staged(undefined, db.delete(t).where(mine(id))),
    },
  };
}

/** Templates and their versions: the org's own plus base ones (null org), which it may read but not change. */
function shared<T extends SQLiteTable & { id: SQLiteColumn; orgId: SQLiteColumn }>(db: Db, orgId: string, table: T, prefix: string) {
  type Row = T['$inferSelect'];
  const own = entity(db, orgId, table, prefix);
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

/**
 * Stage making a draft row's content (as read, plus a playlist's items) its published version.
 * Not an edit: `updated_at` keeps the draft's last edit.
 */
function publisher<T extends typeof s.spots | typeof s.playlists | typeof s.scheduleEntries>(db: Db, orgId: string, table: T) {
  const t = table as unknown as typeof s.spots;
  return (row: T['$inferSelect'], items?: readonly string[]): Staged<T['$inferSelect']> => {
    const set = { publishedJson: contentJson(row, items), publishedAt: Date.now(), updatedAt: row.updatedAt };
    return staged(
      { ...row, ...set },
      db
        .update(t)
        .set(set)
        .where(and(eq(t.orgId, orgId), eq(t.id, row.id))),
    );
  };
}

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
  const spotRows = entity(db, orgId, s.spots, 'spt');
  const playlists = entity(db, orgId, s.playlists, 'pls');
  const scheduleEntries = entity(db, orgId, s.scheduleEntries, 'sch');
  const publishes = entity(db, orgId, s.publishes, 'pub');
  const dataSources = entity(db, orgId, s.dataSources, 'src');
  const audit = entity(db, orgId, s.auditLog, 'aud');

  /** A spot may use the org's own template versions or base ones; the foreign key cannot say so. */
  const checkTemplateVersion = async (id: string | null | undefined) => {
    if (id != null && !(await templateVersions.get(id))) throw new NotInOrgError('template version', id);
  };

  const m = s.screenGroupMembers;
  const os = s.orgSettings;

  /**
   * A group's members replaced. The group may be one staged in the same batch (`knownGroup`).
   * Throws `NotInOrgError` if the group or any screen is not the org's.
   */
  const stageMembers = async (groupId: string, screenIds: readonly string[], knownGroup = false): Promise<Staged> => {
    if (!knownGroup && !(await screenGroups.get(groupId))) throw new NotInOrgError('group', groupId);
    const unique = [...new Set(screenIds)];
    const found = new Set((await screens.getMany(unique)).map((r) => r.id));
    for (const id of unique) if (!found.has(id)) throw new NotInOrgError('screen', id);
    const rows = unique.map((screenId) => ({ orgId, groupId, screenId }));
    return staged(undefined, db.delete(m).where(and(eq(m.orgId, orgId), eq(m.groupId, groupId))), ...chunk(rows, 3).map((part) => db.insert(m).values(part)));
  };
  const pi = s.playlistItems;
  const ps = s.publishScreens;
  const snap = s.dataSnapshots;
  const pc = s.playCounts;

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
        await commit(db, (await stageMembers(groupId, screenIds)).writes);
      },
      stage: {
        ...screenGroups.stage,
        /** As `setMembers`, staged. Pass `newGroup` for a group staged in the same batch, which is not stored yet. */
        setMembers: (groupId: string, screenIds: readonly string[], { newGroup = false } = {}) => stageMembers(groupId, screenIds, newGroup),
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
        await checkTemplateVersion(values.templateVersionId);
        return spotRows.insert(values);
      },
      update: async (id: string, patch: RowPatch<typeof s.spots>) => {
        await checkTemplateVersion(patch.templateVersionId);
        return spotRows.update(id, patch);
      },
      stage: {
        ...spotRows.stage,
        insert: async (values: NewRow<typeof s.spots>) => {
          await checkTemplateVersion(values.templateVersionId);
          return spotRows.stage.insert(values);
        },
        update: async (current: typeof s.spots.$inferSelect, patch: RowPatch<typeof s.spots>) => {
          await checkTemplateVersion(patch.templateVersionId);
          return spotRows.stage.update(current, patch);
        },
        publish: publisher(db, orgId, s.spots),
      },
    },

    playlists: {
      ...playlists,
      stage: { ...playlists.stage, publish: publisher(db, orgId, s.playlists) },
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
      /** Replace a playlist's items. */
      setItems: async (playlistId: string, spotIds: readonly string[]) => {
        if (!(await playlists.get(playlistId))) throw new NotInOrgError('playlist', playlistId);
        const found = new Set((await spotRows.getMany([...new Set(spotIds)])).map((r) => r.id));
        for (const id of spotIds) if (!found.has(id)) throw new NotInOrgError('spot', id);
        const rows = spotIds.map((spotId, position) => ({ orgId, playlistId, position, spotId }));
        await db.batch([
          db.delete(pi).where(and(eq(pi.orgId, orgId), eq(pi.playlistId, playlistId))),
          ...chunk(rows, 4).map((part) => db.insert(pi).values(part)),
        ]);
      },
    },

    scheduleEntries: { ...scheduleEntries, stage: { ...scheduleEntries.stage, publish: publisher(db, orgId, s.scheduleEntries) } },

    /** Org-wide settings: one row, absent until first set. */
    settings: {
      get: () => db.select().from(os).where(eq(os.orgId, orgId)).get(),
      stage: {
        /** Set the default playlist (null for none). Throws `NotInOrgError` for a playlist the org does not have. */
        set: async (values: { defaultPlaylistId: string | null }): Promise<Staged<typeof os.$inferSelect>> => {
          const id = values.defaultPlaylistId;
          if (id !== null && !(await playlists.get(id))) throw new NotInOrgError('playlist', id);
          const row = { orgId, defaultPlaylistId: id, updatedAt: Date.now() };
          return staged(
            row,
            db
              .insert(os)
              .values(row)
              .onConflictDoUpdate({ target: os.orgId, set: { defaultPlaylistId: id, updatedAt: row.updatedAt } }),
          );
        },
      },
    },

    publishes: {
      ...publishes,
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
              .select()
              .from(snap)
              .where(and(eq(snap.orgId, orgId), inArray(snap.dataSourceId, [...dataSourceIds])))
              .all()
          : [],
      putSnapshot: async (dataSourceId: string, v: { version: string; fetchedAt: number; dataJson: string }) => {
        if (!(await dataSources.get(dataSourceId))) throw new NotInOrgError('data source', dataSourceId);
        await db
          .insert(snap)
          .values({ orgId, dataSourceId, ...v })
          .onConflictDoUpdate({ target: [snap.orgId, snap.dataSourceId], set: { ...v } })
          .run();
      },
    },

    auditLog: {
      append: (entry: NewRow<typeof s.auditLog>) => audit.insert(entry),
      /** The audit row for a change, staged to commit with it. */
      stage: (entry: NewRow<typeof s.auditLog>) => audit.stage.insert(entry),
      /** Newest first. */
      list: ({ limit = 50, before }: { limit?: number; before?: number } = {}) => {
        const a = s.auditLog;
        const where: SQL[] = [eq(a.orgId, orgId)];
        if (before != null) where.push(lt(a.at, before));
        return db
          .select()
          .from(a)
          .where(and(...where))
          .orderBy(desc(a.at), desc(a.id))
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
