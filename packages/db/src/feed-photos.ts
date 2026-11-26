/**
 * Feed photos (#195, #329): the D1 half of a news story's photo, from the poll that names it to
 * the delete of its blob. apps/api `src/data/feed-photos.ts` is the other half: it fetches, checks
 * and stores the bytes, and calls only what is here.
 *
 * Callers say what happened, and this decides what follows:
 *
 * - **A poll found stories, or got a 304** (`photoRead`, `plan`, and `photos` on
 *   `dataSources.savePoll`): which copies the snapshot names, whether the save stands, and (when it
 *   stands) which URLs are held within the holds and daily budgets. The read token (the source's
 *   `rowVersion` and `photoGeneration` as the poll read them) is taken here and checked here.
 * - **A source's photos setting or URL changed** (`sourceEdited`, applied by
 *   `dataSources.stage.update`): its next poll reads the feed afresh.
 * - **A delivery produced a result** (`delivered`): stored, reused, unchanged or failed; the row
 *   updated, the hashes it displaced queued for delete, and the sources that must read afresh.
 * - **Sweep** (`expire`, `deleteBlobs`, with the cross-org finders in ./retention.ts): expire
 *   rows no poll and no snapshot names, and delete their blobs past the grace window.
 *
 * "Read afresh" means: drop the source's RSS validators, so its next poll cannot take a 304 and
 * keep a snapshot that names the wrong copies. Every reason for it is written below, and nowhere else.
 */
import { and, eq, isNotNull, lt, lte, ne, or, type SQL, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as s from './schema';
import { commit, staged, strip, updateSet } from './writes';

type Db = DrizzleD1Database<Record<string, never>>;
type FeedImageRow = typeof s.feedImages.$inferSelect;
type DataSourceRow = typeof s.dataSources.$inferSelect;

const fi = s.feedImages;
const fid = s.feedImageDeletes;
const ds = s.dataSources;
const snap = s.dataSnapshots;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Stories per source with a photo: the first, newest ones. No template shows more of a feed's photos. */
export const PHOTOS_PER_SOURCE = 10;
/**
 * Photos new to the org that one source, and the whole org, may queue in a day (owner decision on #339).
 * A story past them plays with no photo until the next day. The org's 60 are a hard ceiling, however
 * many source ids hold photos: 1,800 a month, at ~1 Images transformation each (its thumbnail), about
 * 36% of the 5,000 free ones. They are shared fairly (#481): each source may take its share,
 * `min(NEW_PER_SOURCE_PER_DAY, NEW_PER_ORG_PER_DAY / the org's RSS sources with photos on)`, so the
 * sources that poll first never take another's, and every source an org shows gets photos every day.
 */
export const NEW_PER_SOURCE_PER_DAY = 30;
export const NEW_PER_ORG_PER_DAY = 60;
/** How long a queued URL is held: past the consumer's tries, so polls meanwhile do not queue it again. */
export const HOLD_MS = 15 * MINUTE_MS;
/** How long a fetched photo is kept as it is before a poll that still names it queues a conditional fetch. */
export const RECHECK_MS = 7 * DAY_MS;
/** After a first failure that may pass, how long before a poll queues the URL again; each failure after doubles it, up to FAIL_WAIT_MS. */
export const RETRY_MS = HOUR_MS;
/** How long before a poll queues a URL again after a failure that will not pass (4xx, blocked address, bad image) or at the top of backoff. */
export const FAIL_WAIT_MS = DAY_MS;
/** A photo no poll has named for this long after it was due is forgotten: past any screen's stale snapshot (`SNAPSHOT_STALE_MS`, a day). */
export const FEED_IMAGE_TTL_MS = 7 * DAY_MS;
/** Between queueing a blob for delete and deleting it: longer than any in-flight poll or delivery. */
export const FEED_IMAGE_DELETE_GRACE_MS = 15 * MINUTE_MS;
/** Lease on a hash while its blob is deleted, so a failed delete is retried cleanly by a later sweep. */
export const DELETE_LEASE_MS = 2 * MINUTE_MS;

/**
 * Whether a snapshot of the org names any of these copies: the one rule for a stored photo that a
 * screen may still show. Such a copy is neither expired nor deleted.
 */
const namedBySnapshot = (orgId: SQLiteColumn | string, ...copies: (SQLiteColumn | SQL)[]) =>
  sql`EXISTS (SELECT 1 FROM ${snap} WHERE ${snap.orgId} = ${orgId} AND (${sql.join(
    copies.map((copy) => sql`instr(${snap.dataJson}, ${copy}) > 0`),
    sql` OR `,
  )}))`;

/** A `feed_images` row due a check more than FEED_IMAGE_TTL_MS before `now` that no snapshot names. */
export const expiredRow = (now: number) =>
  and(lt(fi.nextCheckAt, now - FEED_IMAGE_TTL_MS), sql`NOT ${namedBySnapshot(fi.orgId, fi.fileSha256, fi.thumbSha256)}`);

/** A `feed_image_deletes` hash past its grace window and with no lease on it. */
export const deleteDue = (now: number) => and(lte(fid.queuedAt, now - FEED_IMAGE_DELETE_GRACE_MS), lte(fid.deletingUntil, now));

/**
 * What a source's next poll must reset when its photos setting or URL changes: its validators and
 * last-seen photo URLs so the next poll reads the feed afresh, and when photos switched, its poll
 * schedule and error state so the change takes effect on the next tick.
 */
export function sourceEdited(current: DataSourceRow, patch: { photos?: boolean; urlEncrypted?: string }) {
  const photosChanged = patch.photos !== undefined && patch.photos !== current.photos;
  const urlChanged = patch.urlEncrypted !== undefined;
  if (!photosChanged && !urlChanged) return {};
  return {
    etag: null,
    lastModified: null,
    photoUrlsJson: null,
    ...(photosChanged ? { failures: 0, lastError: null, nextPollAt: 0 } : {}),
  };
}

/**
 * The read token a news source's poll takes from the row it claimed, with what the row says about
 * its photos: whether the feed must be read whole (photos shown, but no read with them shown is
 * recorded, so a 304 would leave the snapshot without any, #481), and the photo URLs it last saw.
 */
export interface PhotoRead {
  rowVersion: number;
  generation: number;
  now: number;
  readWhole: boolean;
  lastSeen: string[];
}

export function photoRead(row: DataSourceRow, shown: boolean, now: number): PhotoRead {
  return {
    rowVersion: row.rowVersion,
    generation: row.photoGeneration,
    now,
    readWhole: shown && (row.photoUrlsJson === null || !readWithVersion(row.photoUrlsJson)),
    lastSeen: shown && row.photoUrlsJson ? lastSeenOf(row.photoUrlsJson) : [],
  };
}

/**
 * Whether a row's `photo_urls_json` says the snapshot version it was read from (`{ version, stories }`, #481). Every read
 * with photos shown records it, so a row without one may never have been read for photos (a feed that answered 304 since
 * photos were turned on): it is read whole once more, and its photos queued.
 */
function readWithVersion(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return !!parsed && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string';
  } catch {
    return false;
  }
}

/** The distinct URLs in `photo_urls_json`: `{ stories }` in snapshot order, or an older row's flat list. */
function lastSeenOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const urls = parsed && typeof parsed === 'object' && 'stories' in parsed ? parsed.stories : parsed;
    return Array.isArray(urls) ? [...new Set(urls.filter((u): u is string => typeof u === 'string'))] : [];
  } catch {
    return [];
  }
}

/**
 * What a news source's poll saves about photos: the token it read with, after a full read the photo
 * URL of each of the first stories in snapshot order (null: none shown; left out after a 304) and
 * the version of the snapshot they were read from, and optionally the URLs to hold within the daily
 * budgets if the save stands.
 */
export interface PollPhotos {
  read: PhotoRead;
  stories?: { version: string; urls: (string | null)[] } | null;
  hold?: { again: readonly string[]; fresh: readonly string[] };
}

/** Whether a snapshot's story at `index` names other copies than these. */
const storyCopyDiffers = (index: SQL, file: SQLiteColumn | string | null, thumb: SQLiteColumn | string | null) => sql`(
  json_extract(${snap.dataJson}, '$.items[' || ${index} || '].image.file') IS NOT ${file}
  OR json_extract(${snap.dataJson}, '$.items[' || ${index} || '].image.thumb') IS NOT ${thumb}
)`;

/**
 * The photo half of `dataSources.savePoll`: the patch for the source row, the condition that the
 * row is still the one the poll read (its writes and hold are skipped otherwise), an optional hold
 * statement that reserves due/budgeted URLs in `feed_images` only when the save stands, and a last
 * statement that leaves a reread due when the save does not stand or a copy changed during the poll.
 */
export function pollSave(db: Db, orgId: string, dataSourceId: string, { read, stories, hold }: PollPhotos) {
  const mine = and(eq(ds.orgId, orgId), eq(ds.id, dataSourceId));
  const mineSnap = and(eq(snap.orgId, orgId), eq(snap.dataSourceId, dataSourceId));
  // The version moves on even when two edits restore the original Photos setting.
  const sameVersion = eq(ds.rowVersion, read.rowVersion);
  const current = sql`EXISTS (SELECT 1 FROM ${ds} WHERE ${mine} AND ${sameVersion})`;
  // A first-seen URL's copy can be stored before a delivery knows this source names it.
  const changedCopy = stories
    ? sql`EXISTS (
        SELECT 1 FROM json_each(${ds.photoUrlsJson}, '$.stories') AS story
        JOIN ${fi} ON ${fi.orgId} = ${orgId} AND ${fi.url} = story.value
        JOIN ${snap} ON ${mineSnap}
        WHERE ${fi.fileSha256} IS NOT NULL AND ${fi.thumbSha256} IS NOT NULL
        AND ${storyCopyDiffers(sql`story.key`, fi.fileSha256, fi.thumbSha256)}
      )`
    : undefined;
  const alreadyKnown = sql`EXISTS (SELECT 1 FROM ${fi} WHERE ${fi.orgId} = ${orgId} AND ${fi.url} = jobs.value)`;
  const holdWrite =
    hold && (hold.again.length || hold.fresh.length)
      ? db
          .insert(fi)
          .select(sql`SELECT ${orgId}, url, ${dataSourceId}, NULL, NULL, NULL, NULL, NULL, ${read.now + HOLD_MS}, NULL, 0, ${read.now}, ${read.now} FROM (
            WITH counts AS (
              SELECT count(*) AS org_n, coalesce(sum(${fi.sourceId} = ${dataSourceId}), 0) AS src_n,
                (SELECT count(*) FROM ${ds} WHERE ${ds.orgId} = ${orgId} AND ${ds.format} = 'rss' AND ${ds.photos} = 1) AS sources
              FROM ${fi}
              WHERE ${fi.orgId} = ${orgId} AND ${fi.createdAt} >= ${read.now - DAY_MS}
            )
            SELECT jobs.value AS url FROM json_each(${JSON.stringify([...hold.again, ...hold.fresh])}) AS jobs WHERE ${alreadyKnown}
            UNION ALL
            SELECT value FROM (
              SELECT jobs.value FROM json_each(${JSON.stringify(hold.fresh)}) AS jobs
              WHERE NOT ${alreadyKnown}
              ORDER BY jobs.key
              -- Its fair share of the org's day, and never past the org's ceiling (#481); a whole number, as D1 binds numbers as reals.
              LIMIT (SELECT CAST(MAX(0, MIN(MIN(${NEW_PER_SOURCE_PER_DAY}, ${NEW_PER_ORG_PER_DAY} / MAX(1, sources)) - src_n, ${NEW_PER_ORG_PER_DAY} - org_n)) AS INTEGER) FROM counts)
            )
          ) WHERE ${current}`)
          .onConflictDoUpdate({
            target: [fi.orgId, fi.url],
            set: { nextCheckAt: sql`excluded.next_check_at`, updatedAt: sql`excluded.updated_at` },
            setWhere: lte(fi.nextCheckAt, read.now),
          })
          .returning({ url: fi.url })
      : undefined;
  return {
    patch: stories === undefined ? {} : { photoUrlsJson: stories ? JSON.stringify({ version: stories.version, stories: stories.urls }) : null },
    sameVersion,
    current,
    hold: holdWrite,
    reread: db
      .update(ds)
      .set({ etag: null, lastModified: null, nextPollAt: sql`MIN(${ds.nextPollAt}, ${read.now})` })
      .where(and(mine, or(ne(ds.rowVersion, read.rowVersion), ne(ds.photoGeneration, read.generation), changedCopy))),
  };
}

/** What a delivery of one photo produced, with the clock it ran on. */
export type Delivery =
  /** The URL answered 304, or the same bytes as the copy held: kept, checked again in a week. */
  | { result: 'unchanged'; now: number; sourceId: string; checked: FeedImageRow; validators?: Validators }
  /** New copies: `write` stores their blobs once their hashes are safe from a delete. */
  | { result: 'stored'; now: number; sourceId: string; sourceSha256: string; copy: Copy; validators: Validators; write: () => Promise<void> }
  /** The org already holds copies of these bytes (`copyOf`): named again, nothing written. */
  | { result: 'reused'; now: number; sourceId: string; sourceSha256: string; copy: Copy; validators: Validators }
  /** Not stored, for `error`: the last good copy kept, tried again later. */
  | { result: 'failed'; now: number; checked: FeedImageRow; error: string; passing: boolean };

type Validators = { etag: string | null; lastModified: string | null };
type Copy = { file: string; thumb: string };

/** A delivery found a delete of one of its hashes under way: it is tried again later. */
export class DeleteInFlightError extends Error {
  constructor() {
    super('a feed photo blob is being deleted; try again');
    this.name = 'DeleteInFlightError';
  }
}

/** The org's feed photos: what `OrgScope.feedPhotos` is. */
export function feedPhotos(db: Db, orgId: string) {
  const urlIn = (urls: readonly string[]) => sql`${fi.url} IN (SELECT value FROM json_each(${JSON.stringify(urls)}))`;
  const shaIn = (shas: readonly string[]) => sql`${fid.sha256} IN (SELECT value FROM json_each(${JSON.stringify(shas)}))`;

  const rows = (urls: readonly string[]) =>
    urls.length
      ? db
          .select()
          .from(fi)
          .where(and(eq(fi.orgId, orgId), urlIn(urls)))
          .all()
      : Promise.resolve([]);

  /** Cancel unleased deletes of `shas` before their blobs are written or named again; false while a sweep is deleting one. */
  const claimForWrite = async (shas: readonly string[], now: number): Promise<boolean> => {
    const unique = [...new Set(shas)];
    const [, active] = await db.batch([
      db.delete(fid).where(and(eq(fid.orgId, orgId), shaIn(unique), lte(fid.deletingUntil, now))),
      db
        .select({ sha256: fid.sha256 })
        .from(fid)
        .where(and(eq(fid.orgId, orgId), shaIn(unique))),
    ]);
    return active.length === 0;
  };

  /**
   * Write what a delivery found over the row: conditional on `checked` (the row as the delivery
   * read it) when it stored no new copy. With `sourceId`, any news source naming this URL whose
   * snapshot does not name the row's copies reads afresh; with new copies, the hashes they
   * displace are queued for delete. All in one batch.
   */
  const save = async (
    url: string,
    found: Partial<FeedImageRow> & { nextCheckAt: number },
    { now, sourceId, checked }: { now: number; sourceId?: string; checked?: FeedImageRow },
  ) => {
    const mine = and(
      eq(fi.orgId, orgId),
      eq(fi.url, url),
      checked && sql`${fi.sourceSha256} IS ${checked.sourceSha256}`,
      checked && sql`${fi.etag} IS ${checked.etag} AND ${fi.lastModified} IS ${checked.lastModified}`,
      checked && eq(fi.nextCheckAt, checked.nextCheckAt),
    );
    const updateRow = db
      .update(fi)
      .set(updateSet(fi, strip(found)))
      .where(mine);
    const replacesHashes = found.fileSha256 !== undefined || found.thumbSha256 !== undefined;
    if (!sourceId && !replacesHashes) {
      await updateRow.run();
      return;
    }
    const file = found.fileSha256 === undefined ? fi.fileSha256 : found.fileSha256;
    const thumb = found.thumbSha256 === undefined ? fi.thumbSha256 : found.thumbSha256;
    const changed = sql`${fi.fileSha256} IS NOT ${file} OR ${fi.thumbSha256} IS NOT ${thumb}`;
    const namesPhoto = sql`instr(coalesce(${ds.photoUrlsJson}, ''), ${JSON.stringify(url)}) > 0`;
    // A flat URL list can't identify the story. One full read upgrades it to snapshot order.
    const missingCopy = or(
      and(sql`json_type(${ds.photoUrlsJson}) = 'array'`, namesPhoto),
      sql`EXISTS (
        SELECT 1 FROM json_each(${ds.photoUrlsJson}, '$.stories') AS story
        LEFT JOIN ${snap} ON ${snap.orgId} = ${orgId} AND ${snap.dataSourceId} = ${ds.id}
        WHERE story.value = ${url} AND ${storyCopyDiffers(sql`story.key`, file, thumb)}
      )`,
    );
    const readAfresh = sourceId
      ? db
          .update(ds)
          .set(updateSet(ds, { etag: null, lastModified: null, photoGeneration: sql`${ds.photoGeneration} + 1` }))
          .where(
            and(
              eq(ds.orgId, orgId),
              eq(ds.format, 'rss'),
              eq(ds.photos, true),
              or(eq(ds.id, sourceId), namesPhoto),
              sql`EXISTS (SELECT 1 FROM ${fi} WHERE ${mine} AND ${file} IS NOT NULL AND ${thumb} IS NOT NULL
              AND ((${changed}) OR ((${ds.etag} IS NOT NULL OR ${ds.lastModified} IS NOT NULL) AND ${missingCopy})))`,
            ),
          )
      : undefined;
    const queueDisplaced = replacesHashes
      ? db
          .insert(fid)
          .select(sql`SELECT DISTINCT ${orgId}, old.value, ${now}, 0
            FROM ${fi}, json_each(json_array(${fi.fileSha256}, ${fi.thumbSha256})) AS old
            WHERE ${mine} AND old.value IS NOT NULL AND old.value IS NOT ${file} AND old.value IS NOT ${thumb}`)
          .onConflictDoUpdate({ target: [fid.orgId, fid.sha256], set: { queuedAt: sql`MAX(${fid.queuedAt}, excluded.queued_at)` } })
      : undefined;
    const clearActive = replacesHashes
      ? db.delete(fid).where(
          and(
            eq(fid.orgId, orgId),
            lte(fid.deletingUntil, now),
            sql`EXISTS (SELECT 1 FROM ${fi} WHERE ${fi.orgId} = ${orgId} AND ${fi.url} = ${url}
            AND (${fid.sha256} = ${fi.fileSha256} OR ${fid.sha256} = ${fi.thumbSha256}))`,
          ),
        )
      : undefined;
    // The hashes in D1 just before the update count: another delivery may have stored a copy during this fetch.
    const statements = [readAfresh, queueDisplaced, updateRow, clearActive].filter((q) => q !== undefined);
    await commit(db, staged(undefined, ...statements).writes);
  };

  /** A new copy is named: its hashes claimed from any delete first, then its blobs written, then the row. */
  const named = async (url: string, d: Extract<Delivery, { result: 'stored' | 'reused' }>) => {
    if (!(await claimForWrite([d.copy.file, d.copy.thumb], d.now))) throw new DeleteInFlightError();
    if (d.result === 'stored') await d.write();
    await save(
      url,
      {
        ...kept(d.now),
        ...d.validators,
        sourceSha256: d.sourceSha256,
        fileSha256: d.copy.file,
        thumbSha256: d.copy.thumb,
      },
      { now: d.now, sourceId: d.sourceId },
    );
  };

  return {
    /** The org's rows for these photo URLs, in one query. */
    get: rows,

    /**
     * A poll found these photo URLs: the copies the org holds of each, the ones due a recheck
     * (`again`), and the ones it has never seen (`fresh`). One query.
     */
    plan: async (urls: readonly string[], now: number) => {
      const held = new Map((await rows(urls)).map((r) => [r.url, r]));
      const copies = new Map<string, Copy>();
      for (const [url, r] of held) if (r.fileSha256 && r.thumbSha256) copies.set(url, { file: r.fileSha256, thumb: r.thumbSha256 });
      return {
        copies,
        again: urls.filter((url) => (held.get(url)?.nextCheckAt ?? Number.POSITIVE_INFINITY) <= now),
        fresh: urls.filter((url) => !held.has(url)),
      };
    },

    /** Copies the org already stored for these exact fetched bytes, under any URL. */
    copyOf: async (sourceSha256: string): Promise<Copy | undefined> => {
      const r = await db
        .select({ file: fi.fileSha256, thumb: fi.thumbSha256 })
        .from(fi)
        .where(and(eq(fi.orgId, orgId), eq(fi.sourceSha256, sourceSha256), isNotNull(fi.fileSha256), isNotNull(fi.thumbSha256)))
        .limit(1)
        .get();
      return r?.file && r.thumb ? { file: r.file, thumb: r.thumb } : undefined;
    },

    /**
     * A delivery of `url` produced `d`. A new copy's hashes are claimed from any pending delete
     * before its blobs are written (`DeleteInFlightError` while a sweep is deleting one); a failure
     * waits RETRY_MS doubling up to FAIL_WAIT_MS if it may pass, else FAIL_WAIT_MS.
     */
    delivered: async (url: string, d: Delivery): Promise<void> => {
      switch (d.result) {
        case 'stored':
        case 'reused':
          return named(url, d);
        case 'unchanged':
          return save(url, { ...kept(d.now), ...d.validators }, { now: d.now, sourceId: d.sourceId, checked: d.checked });
        case 'failed': {
          const failures = d.checked.failures + 1;
          const wait = d.passing ? Math.min(RETRY_MS * 2 ** (failures - 1), FAIL_WAIT_MS) : FAIL_WAIT_MS;
          return save(url, { lastError: d.error, failures, nextCheckAt: d.now + wait }, { now: d.now, checked: d.checked });
        }
      }
    },

    /**
     * Sweep: expire these rows if they still are (`expiredRow`: the scan that found them may
     * predate a hold, a replacement or a snapshot), queueing their hashes for delete in the same
     * batch. Returns how many went.
     */
    expire: async (urls: readonly string[], now: number): Promise<number> => {
      if (!urls.length) return 0;
      const expired = and(eq(fi.orgId, orgId), urlIn(urls), expiredRow(now));
      const [, gone] = await db.batch([
        db
          .insert(fid)
          .select(sql`SELECT DISTINCT ${orgId}, copy.value, ${now}, 0
            FROM ${fi}, json_each(json_array(${fi.fileSha256}, ${fi.thumbSha256})) AS copy
            WHERE ${expired} AND copy.value IS NOT NULL`)
          .onConflictDoUpdate({ target: [fid.orgId, fid.sha256], set: { queuedAt: sql`MAX(${fid.queuedAt}, excluded.queued_at)` } }),
        db.delete(fi).where(expired).returning({ url: fi.url }),
      ]);
      return gone.length;
    },

    /**
     * Sweep: delete these queued blobs with `remove`, if they still may go. In one batch, a hash a
     * row names again leaves the queue; one a snapshot names waits again from `now`; the rest past
     * their grace are leased for DELETE_LEASE_MS. Only the leased go to `remove`, and leave the
     * queue once it succeeds; a failure throws, and the lease runs out for a later sweep.
     * Returns how many were deleted.
     */
    deleteBlobs: async (shas: readonly string[], now: number, remove: (shas: string[]) => Promise<void>): Promise<number> => {
      const unique = [...new Set(shas)];
      if (!unique.length) return 0;
      const due = and(eq(fid.orgId, orgId), shaIn(unique), deleteDue(now));
      const rowNames = sql`EXISTS (SELECT 1 FROM ${fi} WHERE ${fi.orgId} = ${orgId} AND (${fi.fileSha256} = ${fid.sha256} OR ${fi.thumbSha256} = ${fid.sha256}))`;
      const shown = namedBySnapshot(orgId, fid.sha256);
      const [leased] = await db.batch([
        db
          .update(fid)
          .set({ deletingUntil: now + DELETE_LEASE_MS })
          .where(and(due, sql`NOT ${rowNames}`, sql`NOT ${shown}`))
          .returning({ sha256: fid.sha256 }),
        db.delete(fid).where(and(due, rowNames)),
        db.update(fid).set({ queuedAt: now, deletingUntil: 0 }).where(and(due, shown)),
      ]);
      const claimed = leased.map((r) => r.sha256);
      if (!claimed.length) return 0;
      await remove(claimed);
      await db
        .delete(fid)
        .where(and(eq(fid.orgId, orgId), shaIn(claimed)))
        .run();
      return claimed.length;
    },
  };
}

/** A delivery that kept or stored a copy: checked again in RECHECK_MS, its failures cleared. */
const kept = (now: number) => ({ nextCheckAt: now + RECHECK_MS, lastError: null, failures: 0 });
