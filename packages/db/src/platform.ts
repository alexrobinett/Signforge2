/**
 * `platform(db)`: what the platform changes outside any org. Today that is base templates (rows of
 * `templates` and `template_versions` with a null org, which every org may read and none may
 * change) and the platform audit log that records each change.
 *
 * Only the deploy-secret tree (`/admin` in apps/api) uses it, through the tool dispatcher. Its
 * `templates` has the same shape as `scoped(db, orgId).templates`, so one tool serves both: on
 * an org scope it writes the org's templates, on this one base templates. It never reads or
 * writes an org's rows.
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { assertId, newId } from './ids';
import type { NewRow, RowPatch } from './scoped';
import * as s from './schema';

type Db = DrizzleD1Database<Record<string, never>>;
type Template = typeof s.templates.$inferSelect;
type TemplateVersion = typeof s.templateVersions.$inferSelect;

/** Fields a caller may never set, as in `scoped`. */
function strip<T extends object>(v: T) {
  const { orgId: _o, id: _i, createdAt: _c, ...rest } = v as Record<string, unknown>;
  return rest;
}

export function platform(d1: D1Database) {
  const db: Db = drizzle(d1);
  const t = s.templates;
  const tv = s.templateVersions;
  const pa = s.platformAuditLog;

  return {
    /** Null: there is no org. Tools use it to tell base templates from an org's. */
    orgId: null,
    templates: {
      get: async (id: string): Promise<Template | undefined> => db.select().from(t).where(and(isNull(t.orgId), eq(t.id, id))).get(),
      list: async (): Promise<Template[]> => db.select().from(t).where(isNull(t.orgId)).orderBy(asc(t.id)).all(),
      ownByKey: async (key: string): Promise<Template | undefined> => db.select().from(t).where(and(isNull(t.orgId), eq(t.key, key))).get(),
      insert: async (values: NewRow<typeof s.templates>): Promise<Template> => {
        const id = values.id ?? newId('tpl');
        assertId(id);
        return db.insert(t).values({ ...(strip(values) as typeof values), id, orgId: null }).returning().get();
      },
      update: async (id: string, patch: RowPatch<typeof s.templates>): Promise<Template | undefined> =>
        db.update(t).set(strip(patch)).where(and(isNull(t.orgId), eq(t.id, id))).returning().get(),
      versions: {
        get: async (id: string): Promise<TemplateVersion | undefined> => db.select().from(tv).where(and(isNull(tv.orgId), eq(tv.id, id))).get(),
        forTemplate: async (templateId: string): Promise<TemplateVersion[]> =>
          db.select().from(tv).where(and(isNull(tv.orgId), eq(tv.templateId, templateId))).orderBy(asc(tv.createdAt)).all(),
        ownVersion: async (templateId: string, version: string): Promise<TemplateVersion | undefined> =>
          db.select().from(tv).where(and(isNull(tv.orgId), eq(tv.templateId, templateId), eq(tv.version, version))).get(),
        insert: async (values: NewRow<typeof s.templateVersions>): Promise<TemplateVersion> => {
          const id = values.id ?? newId('tpv');
          assertId(id);
          return db.insert(tv).values({ ...(strip(values) as typeof values), id, orgId: null }).returning().get();
        },
        update: async (id: string, patch: RowPatch<typeof s.templateVersions>): Promise<TemplateVersion | undefined> =>
          db.update(tv).set(strip(patch)).where(and(isNull(tv.orgId), eq(tv.id, id))).returning().get(),
      },
    },
    auditLog: {
      append: (entry: NewRow<typeof s.platformAuditLog>) => {
        const id = entry.id ?? newId('pau');
        return db.insert(pa).values({ ...(strip(entry) as typeof entry), id }).returning().get();
      },
      /** Newest first. */
      list: ({ limit = 50 }: { limit?: number } = {}) => db.select().from(pa).orderBy(desc(pa.at), desc(pa.id)).limit(limit).all(),
    },
  };
}

export type PlatformScope = ReturnType<typeof platform>;
