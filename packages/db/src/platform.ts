/**
 * `platform(db)`: what the platform changes outside any org. Today that is base templates (rows of
 * `templates` and `template_versions` with a null org, which every org may read and none may
 * change), the platform audit log that records each change, and the player releases a device may install (#628).
 *
 * Only the deploy-secret tree (`/admin` in apps/api) writes through it, by the tool dispatcher; the device tree
 * reads the player release a screen's channel is offered. Its
 * `templates` has the same shape as `scoped(db, orgId).templates`, so one tool serves both: on
 * an org scope it writes the org's templates, on this one base templates. It never reads or
 * writes an org's rows.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { PlayerChannel } from '@signforge/contract';
import { newId } from './ids';
import type { NewRow, RowPatch } from './scoped';
import * as s from './schema';
import { commit, fullRow, staged, strip, updateSet, type Staged, type Write } from './writes';

type Db = DrizzleD1Database<Record<string, never>>;
type Template = typeof s.templates.$inferSelect;
type TemplateVersion = typeof s.templateVersions.$inferSelect;
type PlayerRelease = typeof s.playerReleases.$inferSelect;

export function platform(d1: D1Database) {
  const db: Db = drizzle(d1);
  const t = s.templates;
  const tv = s.templateVersions;
  const pa = s.platformAuditLog;
  const pr = s.playerReleases;

  /** Staged writes of base rows (null org), as `scoped`'s `stage`. */
  const stager = <T extends typeof t | typeof tv>(table: T, prefix: string) => ({
    insert: (values: NewRow<T>): Staged<T['$inferSelect']> => {
      // The server's id, never a caller's, as for an org's templates (./scoped.ts).
      const row = fullRow(table, { ...strip(values), id: newId(prefix), orgId: null });
      return staged(row as T['$inferSelect'], db.insert(table).values(row as never));
    },
    update: (current: T['$inferSelect'], patch: RowPatch<T>): Staged<T['$inferSelect']> => {
      const set = updateSet(table, strip(patch));
      if (!Object.keys(set).length) return { row: current, writes: [] };
      const x = table as typeof t;
      return staged(
        { ...current, ...set } as T['$inferSelect'],
        db
          .update(x)
          .set(set as never)
          .where(and(isNull(x.orgId), eq(x.id, current.id))),
      );
    },
  });

  return {
    /** Null: there is no org. Tools use it to tell base templates from an org's. */
    orgId: null,
    /** Run staged writes in one atomic batch, as `scoped(...).commit`. */
    commit: (writes: readonly Write[]) => commit(db, writes),
    templates: {
      get: async (id: string): Promise<Template | undefined> =>
        db
          .select()
          .from(t)
          .where(and(isNull(t.orgId), eq(t.id, id)))
          .get(),
      list: async (): Promise<Template[]> => db.select().from(t).where(isNull(t.orgId)).orderBy(asc(t.id)).all(),
      ownByKey: async (key: string): Promise<Template | undefined> =>
        db
          .select()
          .from(t)
          .where(and(isNull(t.orgId), eq(t.key, key)))
          .get(),
      insert: async (values: NewRow<typeof s.templates>): Promise<Template> => {
        return db
          .insert(t)
          .values({ ...(strip(values) as typeof values), id: newId('tpl'), orgId: null })
          .returning()
          .get();
      },
      update: async (id: string, patch: RowPatch<typeof s.templates>): Promise<Template | undefined> =>
        db
          .update(t)
          .set(strip(patch))
          .where(and(isNull(t.orgId), eq(t.id, id)))
          .returning()
          .get(),
      stage: stager(t, 'tpl'),
      versions: {
        get: async (id: string): Promise<TemplateVersion | undefined> =>
          db
            .select()
            .from(tv)
            .where(and(isNull(tv.orgId), eq(tv.id, id)))
            .get(),
        forTemplate: async (templateId: string): Promise<TemplateVersion[]> =>
          db
            .select()
            .from(tv)
            .where(and(isNull(tv.orgId), eq(tv.templateId, templateId)))
            .orderBy(asc(tv.createdAt))
            .all(),
        ownVersion: async (templateId: string, version: string): Promise<TemplateVersion | undefined> =>
          db
            .select()
            .from(tv)
            .where(and(isNull(tv.orgId), eq(tv.templateId, templateId), eq(tv.version, version)))
            .get(),
        insert: async (values: NewRow<typeof s.templateVersions>): Promise<TemplateVersion> => {
          return db
            .insert(tv)
            .values({ ...(strip(values) as typeof values), id: newId('tpv'), orgId: null })
            .returning()
            .get();
        },
        update: async (id: string, patch: RowPatch<typeof s.templateVersions>): Promise<TemplateVersion | undefined> =>
          db
            .update(tv)
            .set(strip(patch))
            .where(and(isNull(tv.orgId), eq(tv.id, id)))
            .returning()
            .get(),
        stage: stager(tv, 'tpv'),
      },
    },
    auditLog: {
      append: (entry: NewRow<typeof s.platformAuditLog>) => {
        const id = entry.id ?? newId('pau');
        return db
          .insert(pa)
          .values({ ...(strip(entry) as typeof entry), id })
          .returning()
          .get();
      },
      /** The audit row for a change, staged to commit with it. */
      stage: (entry: NewRow<typeof s.platformAuditLog>): Staged<typeof pa.$inferSelect> => {
        const row = fullRow(pa, { ...strip(entry), id: entry.id ?? newId('pau') });
        return staged(row as typeof pa.$inferSelect, db.insert(pa).values(row as never));
      },
      /** Newest first; rows of the same millisecond by insertion order (`rowid`), as ids are random. */
      list: ({ limit = 50 }: { limit?: number } = {}) => db.select().from(pa).orderBy(desc(pa.at), desc(sql`rowid`)).limit(limit).all(),
    },
    /**
     * Player releases (#628), as a screen's channel sees them: a `canary` screen every release, a `stable` one only
     * the promoted ones. The channel is the screen's own, read with its credential (`findDeviceScreen`), never one a
     * request names.
     */
    playerReleases: {
      /** The newest release the channel is offered, or undefined. */
      offered: (channel: PlayerChannel): Promise<PlayerRelease | undefined> =>
        db
          .select()
          .from(pr)
          .where(channel === 'canary' ? undefined : eq(pr.channel, 'stable'))
          .orderBy(desc(pr.version))
          .limit(1)
          .get(),
      /**
       * Whether the channel is offered the release of this build number: a screen's report of one it rolled back counts
       * only for a release it could have installed.
       */
      offers: async (channel: PlayerChannel, version: number): Promise<boolean> =>
        (await db
          .select({ version: pr.version })
          .from(pr)
          .where(and(eq(pr.version, version), channel === 'canary' ? undefined : eq(pr.channel, 'stable')))
          .get()) !== undefined,
      /** The release whose tarball has this hash, if the channel is offered it: a stable screen never fetches a canary build. */
      bySha256: (channel: PlayerChannel, sha256: string): Promise<PlayerRelease | undefined> =>
        db
          .select()
          .from(pr)
          .where(and(eq(pr.sha256, sha256), channel === 'canary' ? undefined : eq(pr.channel, 'stable')))
          .get(),
    },
  };
}

export type PlatformScope = ReturnType<typeof platform>;
