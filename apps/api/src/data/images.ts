/**
 * Stories' photos (#195). A feed names its photos by URL, a third party's, which no screen may
 * reach; so the server fetches each, checks it and stores its own copy in the org's storage, and
 * a snapshot names the copy by hash (the contract's `NewsImage`).
 *
 * Two halves, so a poll stays cheap whatever the photos cost:
 *
 * - **The poll** (`newsWithPhotos` / `planPhotos`, from ./poller.ts, for an `rss` source with
 *   `photos` on and at least one published spot whose bound template has an image property) looks
 *   up the first PHOTOS_PER_SOURCE stories' photo URLs in the org's `feed_images` in one batched
 *   query and gives each story the copy held for it. Even on an unchanged RSS `304`, `planPhotos`
 *   checks the source's last-seen photo URLs so retries, budget-deferred URLs and weekly rechecks
 *   still run. Once the snapshot is saved, `queuePhotos` queues due rechecks and new URLs within
 *   the day's budget (NEW_PER_SOURCE_PER_DAY and NEW_PER_ORG_PER_DAY) to FEED_IMAGES, holding them
 *   so the next poll does not queue them twice. A queue that refuses is logged and the snapshot
 *   stands: photos never hold up the headlines.
 * - **The queue's consumer** (`storeFeedImages`), one photo an invocation and one at a time,
 *   fetches each through the feed guards (./fetch.ts: https only, every redirect and every resolved
 *   address checked, 8 MB), an `http:` URL once as https; hashes the fetched bytes and reuses any
 *   renditions the org already holds for that content hash without transforming or storing again;
 *   reads its type from its bytes (JPEG, PNG, WebP or AVIF; SVG refused) and never from a header;
 *   stores a JPEG or WebP untouched when its dimensions fit within 1.25× SCREEN_BOX.landscape and
 *   PASS_THROUGH_MAX_BYTES, otherwise has the Images binding decode and scale it to cover a
 *   landscape screen; makes a separate thumbnail only when the photo is larger than NEWS_THUMB_BOX
 *   (otherwise reuses `file` as `thumb`); makes no contrast sample (templates use a scrim over feed
 *   photos); and stores the files in R2 under the feed-owned prefix `o/<org>/f/<sha256>`
 *   (`feedBlobKey`, isolated from assets and `/admin` manifest blobs under `o/<org>/b/`). A source
 *   whose copies changed is read afresh at its next poll, so its snapshot names them, and any
 *   replaced hashes are durably queued in `feed_image_deletes`.
 *
 * Costs, on the Free plan's limits (docs/backend-plan.md, Limits): 0 Images transformations for a
 * duplicate photo or a JPEG/WebP already fitting NEWS_THUMB_BOX; 1 for a typical web JPEG/WebP
 * fitting within 1.25× SCREEN_BOX.landscape and 1 MB (thumbnail only); 2 only for oversized or
 * PNG/AVIF photos. About three queue operations and up to 12 fetches (DNS and redirects) per photo.
 * A photo is asked for again, conditionally, a week after it was fetched. A failure keeps the last
 * good copy; one that may pass is tried again after an hour, doubling up to a day, and one that
 * will not after a day. A photo no poll has named for a week is forgotten daily (`forgetFeedImages`),
 * queueing its hashes in `feed_image_deletes` and deleting unreferenced R2 blobs after the grace
 * window (`FEED_IMAGE_DELETE_GRACE_MS`) with retry on R2 failure.
 */
import { coverSize, fitsScreenBox, NEWS_THUMB_BOX, type NewsFeed, type NewsImage, SCREEN_BOX } from '@signforge/contract';
import { expiredFeedImages, type FeedImageRow, type OrgScope, pendingFeedImageDeletes, scoped } from '@signforge/db';
import type { ParsedNews } from '@signforge/feeds';
import { readImageInfo } from '@signforge/media/image-info';
import { workerFetch } from '../connectors';
import { feedBlobKey } from '../r2';
import { FetchError, type FetchErrorCode, type FetchGuards, feedGuards, guardedImageFetch } from './fetch';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Stories per source with a photo: the first, newest ones. No template shows more of a feed's photos. */
export const PHOTOS_PER_SOURCE = 10;
/**
 * Photos new to the org that one source, and the whole org, may queue in a day. A story past them
 * plays with no photo until the next day. At most 20 a day is 600 a month: at ~1 Images
 * transformation per typical web photo, an org at its cap uses about an eighth of the 5,000 free ones.
 */
export const NEW_PER_SOURCE_PER_DAY = 10;
export const NEW_PER_ORG_PER_DAY = 20;
/** How long a fetched photo is kept as it is before a poll that still names it queues a conditional fetch. */
export const RECHECK_MS = 7 * DAY_MS;
/** After a first failure that may pass, how long before a poll queues the URL again; each failure after doubles it, up to FAIL_WAIT_MS. */
export const RETRY_MS = HOUR_MS;
/** How long before a poll queues a URL again after a failure that will not pass (4xx, blocked address, bad image) or at the top of backoff. */
export const FAIL_WAIT_MS = DAY_MS;
/** How long a queued URL is held: past the consumer's tries, so polls meanwhile do not queue it again. */
export const HOLD_MS = 15 * 60_000;
/** Lease held on `feed_image_deletes` rows while deleting from R2, so a failed R2 delete retries cleanly on the next run. */
export const DELETE_LEASE_MS = 2 * 60_000;
/**
 * Byte cap for storing a fetched JPEG or WebP untouched as `file` without calling Images: web
 * photos up to 1.25× SCREEN_BOX.landscape (2400×1350) are typically 100–600 kB, while bloated or
 * unoptimised camera files above 1 MB still go through Images to shrink for screen sync.
 */
export const PASS_THROUGH_MAX_BYTES = 1_000_000;
/** Maximum cover box (1.25× SCREEN_BOX.landscape = 2400×1350) for a JPEG/WebP to pass through without resizing. */
const PASS_THROUGH_BOX = { w: Math.round(SCREEN_BOX.landscape.w * 1.25), h: Math.round(SCREEN_BOX.landscape.h * 1.25) } as const;
/** Deliveries of one message: wrangler.jsonc's `max_retries` (2) and the first. The last records its failure. */
const ATTEMPTS = 3;
/** Rows expired and delete candidates scanned per daily run; capped per org so midnight D1 queries stay well under Free's 50-query limit. */
const FORGET_PER_RUN = 100;
const DELETE_PER_RUN = 100;
const CLEANUP_ORGS_PER_RUN = 3;
/** Encoder quality for a copy, as `sf build` and the CMS's uploads use. */
const QUALITY = 85;

/** One photo to fetch: the URL as the feed named it, for the org and the source that named it. */
export interface FeedImageJob {
  orgId: string;
  sourceId: string;
  url: string;
}

/** Look up `urls` in one batched query and split into due rechecks (`again`) and unseen URLs (`fresh`). */
export async function planPhotos(
  org: OrgScope,
  urls: readonly string[],
  now: number,
): Promise<{ held: Map<string, FeedImageRow>; again: string[]; fresh: string[] }> {
  const held = new Map((await org.feedImages.get(urls)).map((r) => [r.url, r]));
  const fresh = urls.filter((url) => !held.has(url));
  const again = urls.filter((url) => (held.get(url)?.nextCheckAt ?? Number.POSITIVE_INFINITY) <= now);
  return { held, again, fresh };
}

/**
 * A news feed as a snapshot holds it: the parsed feed without its URLs, each of the first
 * PHOTOS_PER_SOURCE stories with the copy the org holds of its photo, if any. `urls` are the
 * deduplicated top photo URLs (persisted on the source so 304 polls still schedule photo work);
 * `again` are URLs due for a recheck and `fresh` are URLs new to the org, queued once saved.
 */
export async function newsWithPhotos(
  org: OrgScope,
  { logo: _logo, items, ...feed }: ParsedNews,
  now: number,
): Promise<{ data: NewsFeed; urls: string[]; again: string[]; fresh: string[] }> {
  const urls = [...new Set(items.slice(0, PHOTOS_PER_SOURCE).flatMap((i) => (i.image ? [i.image.url] : [])))];
  const { held, again, fresh } = await planPhotos(org, urls, now);
  const data = {
    ...feed,
    items: items.map(({ image, ...item }, i) => {
      const copy = image && i < PHOTOS_PER_SOURCE ? photoOf(held.get(image.url)) : undefined;
      return copy ? { ...item, image: copy } : item;
    }),
  };
  return { data, urls, again, fresh };
}

/**
 * Hold and queue `again` (due rechecks) plus `fresh` up to the source's and org's daily budgets.
 * A failure is logged, not thrown: the snapshot is saved, and the photos wait for a later poll.
 */
export async function queuePhotos(
  env: Pick<Env, 'FEED_IMAGES'>,
  org: OrgScope,
  sourceId: string,
  { again, fresh }: { again: string[]; fresh: string[] },
  now: number,
): Promise<void> {
  try {
    const urls = await org.feedImages.holdWithinBudget(sourceId, {
      again,
      fresh,
      until: now + HOLD_MS,
      now,
      since: now - DAY_MS,
      maxSource: NEW_PER_SOURCE_PER_DAY,
      maxOrg: NEW_PER_ORG_PER_DAY,
    });
    if (!urls.length) return;
    await env.FEED_IMAGES.sendBatch(urls.map((url): { body: FeedImageJob } => ({ body: { orgId: org.orgId, sourceId, url } })));
  } catch (e) {
    console.error(`[feed images] could not queue photos of ${org.orgId}/${sourceId}`, e);
  }
}

const photoOf = (row: FeedImageRow | undefined): NewsImage | undefined =>
  row?.fileSha256 && row.thumbSha256 ? { file: row.fileSha256, thumb: row.thumbSha256 } : undefined;

/**
 * Why a photo was not stored: the guards' categories; what its bytes are; the Images binding over
 * its allowance (`images-quota`) or failing (`images-unavailable`); or, on a message's last try, an
 * error of the consumer's own (`internal`).
 */
type PhotoError = FetchErrorCode | 'svg' | 'not-an-image' | 'undecodable' | 'images-quota' | 'images-unavailable' | 'internal';

/** A photo that could not be stored, for a reason it is recorded with. */
class PhotoFailure extends Error {
  constructor(
    readonly code: Extract<PhotoError, 'svg' | 'not-an-image' | 'undecodable' | 'too-large' | 'images-quota' | 'images-unavailable'>,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

/** Failures a later try may not meet. Everything else (a 4xx, a refused address, the photo itself) is tried again only after a day. */
const PASSING = new Set<PhotoError>(['dns', 'timeout', 'network', 'images-quota', 'images-unavailable', 'internal']);
const mayPass = (e: FetchError | PhotoFailure) =>
  PASSING.has(e.code) || (e instanceof FetchError && e.code === 'http-status' && (e.status === 429 || (e.status ?? 0) >= 500));

/** The Images binding's codes for bytes it cannot decode: not an image (9412) or unsupported format (9520). Ambiguous resize errors like 9523 fall through to retryable `images-unavailable`. */
const UNDECODABLE = new Set([9412, 9520]);
/** The image exceeds Cloudflare Images' maximum dimensions or area (9413). */
const IMAGES_TOO_LARGE = 9413;
/** The account's transformations are used up for the month. */
const OVER_QUOTA = 9422;

/** An Images binding error's code: `ImagesError.code`, or the one its message names (`ERROR 9412: …`). */
function imagesCode(e: unknown): number | undefined {
  if (!(e instanceof Error)) return undefined;
  if ('code' in e && typeof e.code === 'number') return e.code;
  const named = /\b(9\d{3})\b/.exec(e.message);
  return named ? Number(named[1]) : undefined;
}

/** What the consumer fetches and decodes with. The Worker passes its own; tests stub them. */
export interface PhotoDeps {
  now: number;
  guards: FetchGuards;
  images: Pick<ImagesBinding, 'info' | 'input'>;
}

/**
 * The queue's consumer: fetch, check and store each photo, one at a time, so an invocation holds
 * one photo's bytes at once; then have its source read afresh if its copy changed. A message that
 * fails for a reason of the consumer's own is retried, and on its last try recorded as `internal`
 * with a backoff, so a photo that keeps failing leaves the queue until a poll names it again later.
 */
export async function storeFeedImages(
  batch: MessageBatch<FeedImageJob>,
  env: Env,
  deps: PhotoDeps = { now: Date.now(), guards: feedGuards(env, workerFetch), images: env.IMAGES },
): Promise<void> {
  for (const message of batch.messages) {
    const { orgId, sourceId, url } = message.body;
    const org = scoped(env.DB, orgId);
    try {
      if (await storeOne(env, deps, org, sourceId, url)) await org.dataSources.readAfresh(sourceId, url);
      message.ack();
    } catch (e) {
      console.error(`[feed images] a photo of ${orgId}/${sourceId} could not be stored (try ${message.attempts} of ${ATTEMPTS})`, e);
      if (message.attempts < ATTEMPTS) {
        message.retry();
        continue;
      }
      try {
        const [row] = await org.feedImages.get([url]);
        if (row) await failed(org, row, 'internal', true, deps.now);
      } catch (again) {
        console.error('[feed images] its failure could not be recorded either', again);
      }
      message.ack();
    }
  }
}

/** Record a failure, keeping the last good copy: after an hour doubling up to a day if it may pass, else after a day. */
function failed(org: OrgScope, row: FeedImageRow, code: PhotoError, passing: boolean, now: number) {
  const failures = row.failures + 1;
  const wait = passing ? Math.min(RETRY_MS * 2 ** (failures - 1), FAIL_WAIT_MS) : FAIL_WAIT_MS;
  return org.feedImages.save(row.url, { lastError: code, failures, nextCheckAt: now + wait });
}

/** Fetch and store one photo; true when the copy it names changed. */
async function storeOne(env: Pick<Env, 'BLOBS'>, { now, guards, images }: PhotoDeps, org: OrgScope, sourceId: string, url: string): Promise<boolean> {
  const source = await org.dataSources.get(sourceId);
  const [row] = await org.feedImages.get([url]);
  // Deleted, or its photos switched off, since the poll queued it; or forgotten since (rows are made before they are queued).
  if (!source?.photos || !row) return false;
  const kept = { nextCheckAt: now + RECHECK_MS, lastError: null, failures: 0 };
  try {
    const fetched = await guardedImageFetch(httpsOf(url), row, guards);
    if (fetched.status === 'not-modified') {
      await org.feedImages.save(url, kept);
      return false;
    }
    const validators = { etag: fetched.etag, lastModified: fetched.lastModified };
    const sourceSha256 = await sha256Hex(fetched.body);
    if (sourceSha256 === row.sourceSha256 && row.fileSha256 && row.thumbSha256) {
      await org.feedImages.save(url, { ...kept, ...validators });
      return false;
    }
    // Same photo bytes already processed for another URL in this org (query string, http/https, mirror): reuse its copies with no transform or R2 write.
    const existing = await org.feedImages.bySourceSha(sourceSha256);
    if (existing?.fileSha256 && existing.thumbSha256) {
      if (!(await org.feedImages.claimForWrite([existing.fileSha256, existing.thumbSha256], now))) {
        throw new Error('feed photo blob deletion in flight; retrying');
      }
      await org.feedImages.save(
        url,
        {
          ...kept,
          ...validators,
          sourceSha256,
          fileSha256: existing.fileSha256,
          thumbSha256: existing.thumbSha256,
        },
        { now },
      );
      return existing.fileSha256 !== row.fileSha256 || existing.thumbSha256 !== row.thumbSha256;
    }
    const copy = await stored(env, images, org, fetched.body, sourceSha256, now);
    await org.feedImages.save(
      url,
      {
        ...kept,
        ...validators,
        sourceSha256,
        fileSha256: copy.file,
        thumbSha256: copy.thumb,
      },
      { now },
    );
    return copy.file !== row.fileSha256 || copy.thumb !== row.thumbSha256;
  } catch (e) {
    if (!(e instanceof FetchError || e instanceof PhotoFailure)) throw e;
    await failed(org, row, e.code, mayPass(e), now);
    return false;
  }
}

/** Many feeds still name `http:` photos: each is tried once over https, and dropped if that fails the guards. */
function httpsOf(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'https:';
  return u.href;
}

type Raster = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';

/** The type of a photo, from its bytes alone. */
function sniffed(bytes: Uint8Array): { type: Raster; width?: number; height?: number } {
  const info = readImageInfo(bytes);
  // Markup that can carry script, and no photo.
  if (info?.type === 'image/svg+xml') throw new PhotoFailure('svg');
  if (info) return info;
  // An ISO BMFF file whose `ftyp` box names an AVIF brand, major or compatible.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length >= 16 && ascii(4) === 'ftyp') {
    const end = Math.min(view.getUint32(0), bytes.length);
    for (let at = 8; at + 4 <= end; at += 4) if (at !== 12 && (ascii(at) === 'avif' || ascii(at) === 'avis')) return { type: 'image/avif' };
  }
  throw new PhotoFailure('not-an-image');
}

/**
 * The checked copies of a photo, stored in the org's feed-owned blob prefix (`o/<org>/f/<sha256>`):
 * cancels any unleased pending delete for these hashes before writing, and retries via the queue if
 * a cleanup run is actively deleting the exact same hash from R2.
 */
async function stored(
  env: Pick<Env, 'BLOBS'>,
  images: PhotoDeps['images'],
  org: OrgScope,
  bytes: Uint8Array,
  sourceSha256: string,
  now: number,
): Promise<NewsImage> {
  const { file, thumb } = await copies(images, bytes);
  const fileSha = file.bytes === bytes ? sourceSha256 : await sha256Hex(file.bytes);
  const thumbSha = thumb.bytes === file.bytes ? fileSha : await sha256Hex(thumb.bytes);
  if (!(await org.feedImages.claimForWrite([fileSha, thumbSha], now))) {
    throw new Error('feed photo blob deletion in flight; retrying');
  }
  await env.BLOBS.put(feedBlobKey(org.orgId, fileSha), file.bytes, { sha256: fileSha, httpMetadata: { contentType: file.type } });
  if (thumbSha !== fileSha) {
    await env.BLOBS.put(feedBlobKey(org.orgId, thumbSha), thumb.bytes, { sha256: thumbSha, httpMetadata: { contentType: thumb.type } });
  }
  return { file: fileSha, thumb: thumbSha };
}

/**
 * A photo's lead copy and thumbnail with their types. A JPEG or WebP already within 1.25×
 * SCREEN_BOX.landscape and PASS_THROUGH_MAX_BYTES ships untouched (no Images call); a thumbnail is
 * made only when the photo is larger than NEWS_THUMB_BOX, otherwise `file` is reused.
 */
async function copies(
  images: PhotoDeps['images'],
  bytes: Uint8Array,
): Promise<{ file: { bytes: Uint8Array; type: string }; thumb: { bytes: Uint8Array; type: string } }> {
  const source = sniffed(bytes);
  try {
    // AVIF's size is the decoder's to read; the others' as displayed, after a JPEG's EXIF orientation, as a browser draws them.
    const size = source.width && source.height ? { width: source.width, height: source.height } : await images.info(stream(bytes));
    if (!('width' in size)) throw new PhotoFailure('not-an-image');
    const cover = coverSize(size.width, size.height, SCREEN_BOX.landscape);
    if (!fitsScreenBox(cover.width, cover.height, SCREEN_BOX.landscape)) throw new PhotoFailure('too-large');
    // A JPEG stays a JPEG; anything else becomes a WebP, which keeps transparency, as uploads do.
    const type = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const passThrough =
      (source.type === 'image/jpeg' || source.type === 'image/webp') &&
      fitsScreenBox(size.width, size.height, PASS_THROUGH_BOX) &&
      bytes.length <= PASS_THROUGH_MAX_BYTES;
    const file = passThrough ? { bytes, type } : { bytes: await scaled(images, bytes, cover, type), type };
    const fileSize = passThrough ? size : cover;
    const small = coverSize(fileSize.width, fileSize.height, NEWS_THUMB_BOX);
    const thumb = small.scaled ? { bytes: await scaled(images, file.bytes, small, type), type } : file;
    return { file, thumb };
  } catch (e) {
    if (e instanceof PhotoFailure) throw e;
    const code = imagesCode(e);
    if (code === IMAGES_TOO_LARGE) throw new PhotoFailure('too-large', { cause: e });
    if (code !== undefined && UNDECODABLE.has(code)) throw new PhotoFailure('undecodable', { cause: e });
    throw new PhotoFailure(code === OVER_QUOTA ? 'images-quota' : 'images-unavailable', { cause: e });
  }
}

/** `bytes` decoded and drawn at `size`, encoded as `format`. */
async function scaled(images: PhotoDeps['images'], bytes: Uint8Array, size: { width: number; height: number }, format: 'image/jpeg' | 'image/webp') {
  const out = await images.input(stream(bytes)).transform({ width: size.width, height: size.height, fit: 'scale-down' }).output({ format, quality: QUALITY });
  return new Uint8Array(await out.response().arrayBuffer());
}

const stream = (bytes: Uint8Array) => new Blob([bytes]).stream();

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Group items by org, keeping at most `maxOrgs` orgs so a daily run stays well inside Free D1's 50-query limit. */
function groupByOrg<T>(items: readonly ({ orgId: string } & T)[], pick: (item: T) => string, maxOrgs: number): Map<string, string[]> {
  const byOrg = new Map<string, string[]>();
  for (const item of items) {
    let list = byOrg.get(item.orgId);
    if (!list) {
      if (byOrg.size >= maxOrgs) continue;
      list = [];
      byOrg.set(item.orgId, list);
    }
    list.push(pick(item));
  }
  return byOrg;
}

/**
 * The daily clean-up, bounded for Free D1's 50-query limit:
 * 1. Expire `feed_images` rows unnamed for a week past their check (`expiredFeedImages`), keeping
 *    any still named by a snapshot, and durably queue their hashes into `feed_image_deletes`.
 * 2. Drain `feed_image_deletes` rows whose grace window has elapsed (`pendingFeedImageDeletes`),
 *    re-checking references in batched SQL, leasing claimed hashes while deleting from R2 under
 *    `o/<org>/f/`, and clearing the delete records only after R2 delete succeeds so failures retry.
 * Returns how many expired rows were forgotten in phase 1 plus how many blobs were deleted in phase 2.
 */
export async function forgetFeedImages(env: Pick<Env, 'DB' | 'BLOBS'>, now: number): Promise<number> {
  const expired = await expiredFeedImages(env.DB, now, FORGET_PER_RUN);
  let forgotten = 0;
  for (const [orgId, urls] of groupByOrg(expired, (r) => r.url, CLEANUP_ORGS_PER_RUN)) {
    forgotten += await scoped(env.DB, orgId).feedImages.forget(urls, now);
  }
  const pending = await pendingFeedImageDeletes(env.DB, now, DELETE_PER_RUN);
  let deleted = 0;
  const errors: unknown[] = [];
  for (const [orgId, shas] of groupByOrg(pending, (r) => r.sha256, CLEANUP_ORGS_PER_RUN)) {
    const org = scoped(env.DB, orgId);
    const claimed = await org.feedImages.claimDeletes(shas, { now, leaseMs: DELETE_LEASE_MS });
    if (!claimed.length) continue;
    const keys = claimed.map((sha) => feedBlobKey(orgId, sha));
    try {
      // R2 deletes at most 1,000 keys a call. Keep the durable delete record until R2 delete succeeds.
      for (let i = 0; i < keys.length; i += 1000) await env.BLOBS.delete(keys.slice(i, i + 1000));
      await org.feedImages.finishDeletes(claimed);
      deleted += claimed.length;
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'feed image blob deletion failed');
  return forgotten + deleted;
}
