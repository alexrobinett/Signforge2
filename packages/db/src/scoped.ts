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
import { commit, fullRow, staged, strip, updateSet, type Staged, type Write } from './writes';

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
        const id = idFor(values);
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

/** What one screen sync writes (`screens.sync`). Hours are UTC hour starts in ms. */
export interface SyncWrite {
  at: number;
  playerVersion: string;
  heartbeatJson: string;
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
  const spotRows = entity(db, orgId, s.spots, 'spt', 'content');
  const playlists = entity(db, orgId, s.playlists, 'pls', 'content');
  const scheduleEntries = entity(db, orgId, s.scheduleEntries, 'sch', 'content');
  const publishes = entity(db, orgId, s.publishes, 'pub');
  const dataSources = entity(db, orgId, s.dataSources, 'src', 'content');
  const audit = entity(db, orgId, s.auditLog, 'aud');
  const brandKitRows = entity(db, orgId, s.brandKits, 'bk');

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
       * A screen's sync (`POST /v1/device/sync`), in one atomic batch: its heartbeat and last-seen
       * time, and its play counts added to the hourly totals unless the batch's `seq` is already
       * stored in its `epoch` (a retry). The check is in the statements, so two copies of one
       * request racing still count once. Leaves `updatedAt`, the settings' change time, alone.
       * Returns the highest seq stored in the epoch, and the rows D1 wrote (the budget's unit), or
       * undefined if the org has no such screen.
       */
      sync: async (screenId: string, v: SyncWrite): Promise<{ ackSeq: number; rowsWritten: number } | undefined> => {
        const repeat = 'org_id = ? AND id = ? AND (sync_epoch IS NOT ? OR sync_ack_seq < ?)';
        const inserts = chunk([...v.counts], 7).map((part) =>
          d1
            .prepare(
              `INSERT INTO play_counts (org_id, screen_id, hour, spot_id, plays, ms)
               SELECT column1, column2, column3, column4, column5, column6 FROM (VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')})
               WHERE EXISTS (SELECT 1 FROM screens WHERE ${repeat})
               ON CONFLICT (org_id, screen_id, hour, spot_id) DO UPDATE SET plays = plays + excluded.plays, ms = ms + excluded.ms`,
            )
            .bind(...part.flatMap((c) => [orgId, screenId, c.hour, c.spotId, c.plays, c.ms]), orgId, screenId, v.epoch, v.seq),
        );
        const update = d1
          .prepare(
            `UPDATE screens SET last_seen_at = ?, player_version = ?, heartbeat_json = ?,
               sync_ack_seq = CASE WHEN sync_epoch IS ? THEN max(sync_ack_seq, ?) ELSE ? END, sync_epoch = ?
             WHERE org_id = ? AND id = ? RETURNING sync_ack_seq`,
          )
          .bind(v.at, v.playerVersion, v.heartbeatJson, v.epoch, v.seq, v.seq, v.epoch, orgId, screenId);
        const results = await d1.batch([...inserts, update]);
        const row = results.at(-1)!.results[0] as { sync_ack_seq: number } | undefined;
        if (!row) return undefined;
        return { ackSeq: row.sync_ack_seq, rowsWritten: results.reduce((n, r) => n + (r.meta.rows_written ?? 0), 0) };
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
     * by code alone, and says only whether it can be claimed now: an unknown, expired or claimed
     * code are all false, so a claim cannot tell another org's code from a wrong guess.
     */
    pairing: {
      open: async (code: string, now: number): Promise<boolean> =>
        (await db
          .select({ id: pcodes.id })
          .from(pcodes)
          .where(and(eq(pcodes.code, code), isNull(pcodes.claimedOrgId), sql`${pcodes.expiresAt} > ${now}`))
          .get()) !== undefined,
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
        update: async (current: typeof s.brandKits.$inferSelect, patch: RowPatch<typeof s.brandKits>) => {
          await checkLogos(patch);
          return brandKitRows.stage.update(current, patch);
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
      savePoll: async (dataSourceId: string, poll: { source: RowPatch<typeof s.dataSources>; snapshot?: Snapshot; checkedAt?: number }) => {
        const current = await dataSources.get(dataSourceId);
        if (!current) throw new NotInOrgError('data source', dataSourceId);
        const mineSnap = and(eq(snap.orgId, orgId), eq(snap.dataSourceId, dataSourceId));
        const writes: Write[] = [...dataSources.stage.update(current, poll.source).writes];
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

    auditLog: {
      append: (entry: NewRow<typeof s.auditLog>) => audit.insert(entry),
      /** The audit row for a change, staged to commit with it. */
      stage: (entry: NewRow<typeof s.auditLog>) => audit.stage.insert(entry),
      /** Newest first. With `target`, only what was done to that one thing (a screen's recent events). */
      list: ({ limit = 50, before, target }: { limit?: number; before?: number; target?: { kind: string; id: string } } = {}) => {
        const a = s.auditLog;
        const where: SQL[] = [eq(a.orgId, orgId)];
        if (before != null) where.push(lt(a.at, before));
        if (target) where.push(eq(a.targetKind, target.kind), eq(a.targetId, target.id));
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
