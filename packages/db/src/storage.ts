/**
 * Storage clean-up (#235): what an org stores in R2 that nothing needs any more, decided here from what the org keeps, and
 * deleted by the API's daily sweep (apps/api/src/storage.ts), which builds every key under the org's own prefixes.
 * Owner decisions (2026-11-24): a 90-day grace period (`STORAGE_GRACE_MS`); the current publish and every publish of
 * the last 90 days keep their files, and a roll back reaches no further; only deleted assets' files and unfinished
 * uploads go, never an asset in the library.
 *
 * **What the org keeps** is explicit, never inferred from when something was published (review of #429):
 * - Manifests (`keptManifests`): each screen's desired, previous and reported manifest, and the ones its last heartbeat
 *   names (`active`, `fallbackFrom`, `lastGood`, which the device API lets it fetch files for); and every manifest
 *   effective on a screen at any publish of the last 90 days, one it inherited from an older publish included.
 * - Files: every file a kept manifest names (`stored_manifests`, the index written in the batch of the publish that stores
 *   a manifest, and by the sweep for one stored before it), and every file an asset, a rendition, a rendition's sample or
 *   a template version of the org names, a pending upload's included.
 *
 * **A deleted asset's file** (`blob_deletes`, queued by `delete_asset`) is deleted once queued for the grace period,
 * outside all of that, and only while every kept manifest is indexed: an unindexed one could name it.
 * **An unfinished upload**: an asset still `pending` for the grace period, its `up/` objects and its row; the hashes it
 * named are queued again, so a stored copy it was reusing is not left unqueued.
 *
 * **Writers and the sweep exclude each other.** The sweep leases the org (`storage_sweeps`, with an owner token) and claims
 * the files it deletes with that owner; a writer that could reuse a claimed file's bytes (an upload made or verified, a
 * template registered) is refused while the claim holds (`stage.unclaimed`), and a publish whose manifests name a deleted
 * asset's file is refused at its commit (`stage.filesLive`). The sweep deletes objects only while its lease holds, and its
 * last batch, guarded by that lease, forgets only its own claims. A run that fails part-way is taken up by the next.
 */
import { and, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { newId } from './ids';
import * as s from './schema';
import { staged, staleGuard, type Staged, type Write } from './writes';

type Db = DrizzleD1Database<Record<string, never>>;

const DAY_MS = 24 * 60 * 60_000;

/** How long after a file or an upload stops being needed it is kept, and how far back a roll back reaches (owner decision on #235). */
export const STORAGE_GRACE_MS = 90 * DAY_MS;
/** An org's sweep lease: longer than one org's sweep takes; its claims expire with it. */
export const STORAGE_LEASE_MS = 10 * 60_000;
/** D1 binds at most 100 values a statement: lists go in chunks under it. */
const CHUNK = 90;
/** A manifest index written in a publish's batch: its JSON in parts of at most this many characters, each one statement. */
const INDEX_CHARS = 90_000;

const chunks = <T>(list: readonly T[], size = CHUNK): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

const bd = s.blobDeletes;
const a = s.assets;
const r = s.assetRenditions;
const sm = s.storedManifests;
const sw = s.storageSweeps;

/**
 * The org's kept manifests (`keptManifests` above), as `(screen_id, manifest_id)` rows: a screen's own pointers, and the
 * publishes' rows effective at any publish made since `cutoff`, those of the publishes since and each screen's newest
 * from before.
 */
const keptManifests = (orgId: string, cutoff: number) =>
  // Two terms: D1 allows few in a compound SELECT.
  sql`SELECT sc.id AS screen_id, j.value AS manifest_id FROM screens sc, json_each(json_array(
      sc.desired_manifest_id, sc.previous_manifest_id, sc.reported_manifest_id,
      json_extract(sc.heartbeat_json, '$.manifest.active'), json_extract(sc.heartbeat_json, '$.manifest.fallbackFrom'),
      json_extract(sc.heartbeat_json, '$.manifest.lastGood'))) j
    WHERE sc.org_id = ${orgId} AND j.value IS NOT NULL
    UNION SELECT ps.screen_id, ps.manifest_id FROM publish_screens ps JOIN publishes p ON p.org_id = ps.org_id AND p.id = ps.publish_id
    WHERE ps.org_id = ${orgId} AND (p.created_at >= ${cutoff} OR p.revision = (
      SELECT max(p2.revision) FROM publish_screens ps2 JOIN publishes p2 ON p2.org_id = ps2.org_id AND p2.id = ps2.publish_id
      WHERE ps2.org_id = ps.org_id AND ps2.screen_id = ps.screen_id AND p2.created_at < ${cutoff}))`;

/** A queued file whose bytes an asset, a rendition, a sample or a template version of its org names. */
const named = sql`(
  EXISTS (SELECT 1 FROM ${a} WHERE ${a.orgId} = ${bd.orgId} AND ${a.sha256} = ${bd.sha256})
  OR EXISTS (SELECT 1 FROM ${r} WHERE ${r.orgId} = ${bd.orgId} AND (${r.sha256} = ${bd.sha256} OR ${r.sampleSha256} = ${bd.sha256}))
  OR EXISTS (SELECT 1 FROM template_versions tv WHERE tv.org_id = ${bd.orgId} AND (tv.bundle_sha256 = ${bd.sha256} OR instr(tv.check_report_json, ${bd.sha256}) > 0))
)`;

/**
 * A queued file a kept manifest names, by the index. By manifest id: its id is its content's hash, so a manifest names
 * the same files for every screen it is stored for, and a row whose files are known for one screen holds for them all.
 */
const inKept = (orgId: string, cutoff: number) =>
  sql`EXISTS (SELECT 1 FROM stored_manifests m, json_each(m.files_json) f WHERE m.org_id = ${orgId} AND f.value = ${bd.sha256}
    AND m.manifest_id IN (SELECT manifest_id FROM (${keptManifests(orgId, cutoff)})))`;

/** A manifest id whose files the index knows (a row for any screen with `files_json`). */
const known = (orgId: string, manifestId: SQL) =>
  sql`EXISTS (SELECT 1 FROM stored_manifests m WHERE m.org_id = ${orgId} AND m.manifest_id = ${manifestId} AND m.files_json IS NOT NULL)`;

/**
 * Every kept manifest's files are known when the batch runs (review of #429, round 2): read in the claim's own statement,
 * so a screen reporting, or a push naming, a manifest not indexed yet while a sweep runs holds every file back. One found
 * in no R2 object is unknown, and holds them back for as long as it is kept.
 */
const allKnown = (orgId: string, cutoff: number) =>
  sql`NOT EXISTS (SELECT 1 FROM (${keptManifests(orgId, cutoff)}) k WHERE NOT ${known(orgId, sql`k.manifest_id`)})`;

/** A list of hashes as one bound value: `IN (SELECT value FROM json_each(?))`. */
const anyOf = (shas: readonly string[]) => sql`(SELECT value FROM json_each(${JSON.stringify([...new Set(shas)])}))`;

/** A manifest as the index holds it: the screen it is stored for, its id, and the files it names (null: unknown). */
interface IndexedManifest {
  screenId: string;
  id: string;
  files: readonly string[] | null;
}

/** What one sweep of an org deletes: its claimed files, and unfinished uploads with their files. */
export interface StorageDue {
  files: string[];
  uploads: { assetId: string; files: string[] }[];
}

/**
 * Up to `limit` orgs with a queued file or an unfinished upload past the grace period at `now`, the least recently swept
 * first, so an org whose files stay pinned, or whose sweep fails, never holds the others back. One statement.
 */
export async function orgsWithStorageDue(d1: D1Database, now: number, limit: number): Promise<string[]> {
  const cutoff = now - STORAGE_GRACE_MS;
  const rows = await drizzle(d1).all<{ orgId: string }>(sql`
    SELECT d.org_id AS orgId FROM (
      SELECT org_id FROM blob_deletes WHERE queued_at <= ${cutoff} AND claim_until <= ${now}
      UNION SELECT org_id FROM assets WHERE status = 'pending' AND created_at <= ${cutoff}
    ) d LEFT JOIN storage_sweeps w ON w.org_id = d.org_id
    WHERE coalesce(w.lease_until, 0) <= ${now}
    ORDER BY coalesce(w.swept_at, 0), d.org_id LIMIT ${limit}`);
  return rows.map((row) => row.orgId);
}

/** The org's storage: what `OrgScope.storage` is. */
export function storage(db: Db, orgId: string) {
  /** The lease `owner` holds on the org at the time the batch runs. */
  const leased = (owner: string, at: number) =>
    sql`EXISTS (SELECT 1 FROM ${sw} WHERE ${sw.orgId} = ${orgId} AND ${sw.owner} = ${owner} AND ${sw.leaseUntil} > ${at})`;
  return {
    /**
     * Takes the org's sweep lease for `owner` until `now + STORAGE_LEASE_MS`, unless another holds it, and marks the org
     * swept now: one whose sweep then fails goes behind the others next time (review of #429, round 2). Whether it did.
     */
    lease: async (owner: string, now: number): Promise<boolean> => {
      const taken = await db
        .insert(sw)
        .values({ orgId, owner, leaseUntil: now + STORAGE_LEASE_MS, sweptAt: now })
        .onConflictDoUpdate({ target: sw.orgId, set: { owner, leaseUntil: now + STORAGE_LEASE_MS, sweptAt: now }, setWhere: lte(sw.leaseUntil, now) })
        .returning({ owner: sw.owner })
        .all();
      return taken[0]?.owner === owner;
    },
    /**
     * Up to `limit` kept manifests whose files the index does not know, by a screen they are kept for that the sweep has not
     * looked for yet: what it reads from R2. One it found no object for is not looked for again: a real write replaces it.
     */
    unindexed: (now: number, limit: number) =>
      db.all<{ screenId: string; manifestId: string }>(sql`
        SELECT k.screen_id AS screenId, k.manifest_id AS manifestId FROM (${keptManifests(orgId, now - STORAGE_GRACE_MS)}) k
        WHERE NOT ${known(orgId, sql`k.manifest_id`)}
        AND NOT EXISTS (SELECT 1 FROM stored_manifests m WHERE m.org_id = ${orgId} AND m.screen_id = k.screen_id AND m.manifest_id = k.manifest_id)
        ORDER BY k.manifest_id, k.screen_id LIMIT ${limit}`),
    /**
     * Claims for `owner`, which holds the org's lease, up to `limit` files due at `now` and up to `limit` unfinished uploads.
     * Files only while every kept manifest's files are known (`allKnown`, checked as the claim runs). A queued file the org
     * names again is forgotten there: it is not a deleted asset's alone any more. Nothing is deleted here.
     */
    claim: async (owner: string, now: number, limit: number): Promise<StorageDue> => {
      const cutoff = now - STORAGE_GRACE_MS;
      const mine = eq(bd.orgId, orgId);
      const due = db
        .select({ sha256: bd.sha256 })
        .from(bd)
        .where(and(mine, lte(bd.queuedAt, cutoff), lte(bd.claimUntil, now), sql`NOT ${named}`, sql`NOT ${inKept(orgId, cutoff)}`))
        .orderBy(bd.queuedAt, bd.sha256)
        .limit(limit);
      const [claimed] = await db.batch([
        db
          .update(bd)
          .set({ claimOwner: owner, claimUntil: now + STORAGE_LEASE_MS })
          .where(and(mine, inArray(bd.sha256, due), leased(owner, now), allKnown(orgId, cutoff)))
          .returning({ sha256: bd.sha256 }),
        db.delete(bd).where(and(mine, sql`${named}`)),
      ]);
      const pending = await db
        .select({ id: a.id, kind: a.kind, sha256: a.sha256 })
        .from(a)
        .where(and(eq(a.orgId, orgId), eq(a.status, 'pending'), lte(a.createdAt, cutoff)))
        .orderBy(a.createdAt, a.id)
        .limit(limit)
        .all();
      const renditions = (
        await Promise.all(
          chunks(pending.filter((p) => p.kind === 'image').map((p) => p.id)).map((ids) =>
            db
              .select({ assetId: r.assetId, sha256: r.sha256, sampleSha256: r.sampleSha256 })
              .from(r)
              .where(and(eq(r.orgId, orgId), inArray(r.assetId, ids)))
              .all(),
          ),
        )
      ).flat();
      return {
        files: claimed.map((row) => row.sha256),
        // A video's one file is the asset's own; an image's, its renditions' and their samples'.
        uploads: pending.map((p) => ({
          assetId: p.id,
          files: [
            ...new Set(
              p.kind === 'video'
                ? [p.sha256]
                : renditions.filter((x) => x.assetId === p.id).flatMap((x) => [x.sha256, ...(x.sampleSha256 ? [x.sampleSha256] : [])]),
            ),
          ],
        })),
      };
    },
    /** Whether any of these hashes is claimed by a sweep at `now`: a writer about to reuse them says so before it starts. */
    claimed: async (shas: readonly string[], now: number) =>
      shas.length > 0 &&
      (await db
        .select({ sha256: bd.sha256 })
        .from(bd)
        .where(and(eq(bd.orgId, orgId), sql`${bd.sha256} IN ${anyOf(shas)}`, sql`${bd.claimUntil} > ${now}`))
        .limit(1)
        .get()) !== undefined,
    stage: {
      /** A deleted asset's files, queued at `now` (`delete_asset`): one already queued keeps the later of its times. */
      queue: (shas: readonly string[], now: number): Staged => ({
        row: undefined,
        // Five bound values a row (every column, defaults too): 18 rows a statement.
        writes: chunks([...new Set(shas)], 18).flatMap(
          (part) =>
            staged(
              undefined,
              db
                .insert(bd)
                .values(part.map((sha256) => ({ orgId, sha256, queuedAt: now })))
                .onConflictDoUpdate({ target: [bd.orgId, bd.sha256], set: { queuedAt: sql`max(${bd.queuedAt}, excluded.queued_at)` } }),
            ).writes,
        ),
      }),
      /**
       * Refuses the batch while a sweep claims any of these hashes at `now`: a writer that could reuse their bytes (an upload
       * made or verified, a template registered) never adopts an object the sweep is deleting.
       */
      unclaimed: (shas: readonly string[], now: number): Write[] =>
        shas.length
          ? [
              staleGuard(
                db,
                orgId,
                'storage clean-up',
                0,
                sql`NOT EXISTS (SELECT 1 FROM ${bd} WHERE ${bd.orgId} = ${orgId} AND ${bd.sha256} IN ${anyOf(shas)} AND ${bd.claimUntil} > ${now})`,
                async () => 0,
              ),
            ]
          : [],
      /**
       * Refuses a publish whose manifests name a deleted asset's file that nothing of the org names (review of #429): the
       * asset was deleted while it compiled. It runs again from a fresh read.
       */
      filesLive: (shas: readonly string[]): Write[] =>
        shas.length
          ? [
              staleGuard(
                db,
                orgId,
                'deleted asset',
                0,
                sql`NOT EXISTS (SELECT 1 FROM ${bd} WHERE ${bd.orgId} = ${orgId} AND ${bd.sha256} IN ${anyOf(shas)} AND NOT ${named})`,
                async () => 0,
              ),
            ]
          : [],
      /**
       * The files each manifest names, indexed for the screen it is stored for at `now`: `files` null for one the sweep
       * found no object for, unknown. In parts under D1's limits.
       */
      index: (manifests: readonly IndexedManifest[], now: number): Staged => {
        const parts: { screenId: string; id: string; files: string | null }[][] = [[]];
        let size = 0;
        for (const m of manifests) {
          const entry = { screenId: m.screenId, id: m.id, files: m.files && JSON.stringify([...m.files].sort()) };
          const length = entry.screenId.length + entry.id.length + (entry.files?.length ?? 4) + 40;
          if (size + length > INDEX_CHARS && parts.at(-1)!.length) {
            parts.push([]);
            size = 0;
          }
          parts.at(-1)!.push(entry);
          size += length;
        }
        return staged(
          undefined,
          ...parts
            .filter((part) => part.length)
            .map((part) =>
              db
                .insert(sm)
                .select(
                  // `WHERE true`: SQLite reads `ON CONFLICT` after a bare `SELECT ... FROM` as the select's own join.
                  sql`SELECT ${orgId}, json_extract(value, '$.screenId'), json_extract(value, '$.id'), json_extract(value, '$.files'), ${now}
                    FROM json_each(${JSON.stringify(part)}) WHERE true`,
                )
                // Files known replace files unknown, never the other way round.
                .onConflictDoUpdate({ target: [sm.orgId, sm.screenId, sm.manifestId], set: { filesJson: sql`coalesce(excluded.files_json, ${sm.filesJson})` } }),
            ),
        );
      },
      /**
       * Once the claimed objects are deleted, in a batch refused unless `owner` still holds the org's lease at `now`: its
       * own claims forgotten, the uploads' assets deleted while still pending (one finished meanwhile stays) with the hashes
       * they named queued again, one audit row as the system, and the lease released with the org marked swept.
       */
      forget: (due: StorageDue, owner: string, now: number): Staged => {
        const uploads = due.uploads.map((u) => u.assetId);
        const requeued = [...new Set(due.uploads.flatMap((u) => u.files))];
        const writes: Write[] = [
          staleGuard(db, orgId, 'storage sweep', 0, leased(owner, now), async () => 0),
          ...staged(undefined, db.delete(bd).where(and(eq(bd.orgId, orgId), eq(bd.claimOwner, owner)))).writes,
          ...chunks(uploads).flatMap(
            (ids) => staged(undefined, db.delete(a).where(and(eq(a.orgId, orgId), inArray(a.id, ids), eq(a.status, 'pending')))).writes,
          ),
          ...storage(db, orgId).stage.queue(requeued, now).writes,
          ...staged(
            undefined,
            db.insert(s.auditLog).values({
              id: newId('aud'),
              orgId,
              at: now,
              actorKind: 'system',
              actorId: 'storage-sweep',
              clientId: null,
              action: 'sweep_storage',
              targetKind: null,
              targetId: null,
              detailJson: JSON.stringify({ files: due.files.length, uploads }),
            }),
          ).writes,
          ...storage(db, orgId).stage.release(owner, now).writes,
        ];
        return { row: undefined, writes };
      },
      /** The org's lease let go by `owner`, and the org marked swept at `now`. */
      release: (owner: string, now: number): Staged =>
        staged(
          undefined,
          db
            .update(sw)
            .set({ owner: null, leaseUntil: 0, sweptAt: now })
            .where(and(eq(sw.orgId, orgId), eq(sw.owner, owner))),
        ),
    },
  };
}

/** Whether a claim found nothing to delete. */
export const nothingDue = (due: StorageDue) => !due.files.length && !due.uploads.length;

/** The rule a roll back is held to (owner decision on #235): a publish made before `now - STORAGE_GRACE_MS` may have lost its files. */
export const rollbackOpen = (createdAt: number, now: number) => createdAt >= now - STORAGE_GRACE_MS;
