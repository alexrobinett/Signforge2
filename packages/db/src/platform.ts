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
import { MAX_RELEASE_MANIFEST_BYTES, parsePlayerReleaseManifest, RELEASE_SIGNATURE, type PlayerChannel } from '@signforge/contract';
import { releaseColumns, releaseOf, type ScreenRelease } from './device';
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
  const sc = s.screens;

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
      /**
       * Register a release as CI made it (#628): `releaseRow`'s row, refused as it refuses. Undefined, writing nothing,
       * when a release of that version or that tarball is registered already.
       */
      register: async (manifest: string, signature: string, channel: PlayerChannel = 'canary', now = Date.now()): Promise<PlayerRelease | undefined> =>
        db
          .insert(pr)
          .values(releaseRow(manifest, signature, channel, now))
          .onConflictDoNothing()
          .returning()
          .get(),
      /** Moves a `canary` release to `stable`, returning it; undefined, changing nothing, for any other version. */
      promote: (version: number, now = Date.now()): Promise<PlayerRelease | undefined> =>
        db
          .update(pr)
          .set({ channel: 'stable', promotedAt: now })
          .where(and(eq(pr.version, version), eq(pr.channel, 'canary')))
          .returning()
          .get(),
      /**
       * Every canary screen, in every org, by id, with what its last heartbeat said of releases (`ScreenRelease`) and when
       * it was last seen: what a person reads before promoting a release to every other screen.
       */
      canaries: async (): Promise<{ screenId: string; lastSeenAt: number | null; release: ScreenRelease }[]> =>
        (
          await db
            .select({ screenId: sc.id, lastSeenAt: sc.lastSeenAt, ...releaseColumns })
            .from(sc)
            .where(eq(sc.playerChannel, 'canary'))
            .orderBy(asc(sc.id))
            .all()
        ).map(({ screenId, lastSeenAt, ...r }) => ({ screenId, lastSeenAt, release: releaseOf(r) })),
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

/**
 * A release's row as CI made it: its manifest text exactly as signed, and the signature. `version`, `sha256` and `size`
 * come from that text, never from the caller, so the row cannot say other than what a device verifies. Refused
 * (`PlayerReleaseRefused`, with every problem) for text past `MAX_RELEASE_MANIFEST_BYTES`, a manifest the contract does
 * not read, or a signature not in `RELEASE_SIGNATURE`'s form. The signature itself is the device's to check.
 */
export function releaseRow(manifest: string, signature: string, channel: PlayerChannel, now: number): PlayerRelease {
  const problems: string[] = [];
  if (new TextEncoder().encode(manifest).byteLength > MAX_RELEASE_MANIFEST_BYTES) problems.push('the manifest text is too long');
  if (!RELEASE_SIGNATURE.test(signature)) problems.push('the signature is not an Ed25519 signature in base64');
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    problems.push('the manifest text is not JSON');
  }
  const read = problems.length ? undefined : parsePlayerReleaseManifest(parsed);
  if (read && !read.ok) problems.push(...read.problems);
  if (!read?.ok) throw new PlayerReleaseRefused(problems);
  const { version, sha256, size } = read.value;
  return { version, sha256, size, manifest, signature, channel, createdAt: now, promotedAt: null };
}

/** Why `releaseRow` refused a release: every problem, as the contract's parser and the bounds name them. */
export class PlayerReleaseRefused extends Error {
  constructor(readonly problems: string[]) {
    super(`not a player release: ${problems.join('; ')}`);
  }
}

export type PlatformScope = ReturnType<typeof platform>;
