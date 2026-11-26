/**
 * Feed photos (#195, #329): the fetch, check, scale and store half of a news story's photo.
 * `packages/db/src/feed-photos.ts` owns the D1 half (read token, read-afresh rule, snapshot
 * references, holds, daily budgets, delete queue and leases, and every timing constant).
 *
 * Callers say what happened and this module decides what follows:
 *
 * - **A poll starts (`startPhotoPoll`), found stories (`attachFeedPhotos`) or got a 304
 *   (`planPhotoRecheck`), and saved (`enqueueFeedPhotos`)**: whether the feed must read whole,
 *   which stored copies the snapshot names, and which URLs to queue within the holds and daily
 *   budgets. A queue failure is logged and never blocks saving headlines.
 * - **A delivery arrives (`storeFeedImages`)**: one photo at a time, fetched
 *   through the feed guards (./fetch.ts: https only, an `http:` URL tried once as https, every
 *   redirect and resolved address checked, 8 MB), hashed to reuse existing org renditions, sniffed
 *   by bytes (JPEG, PNG, WebP or AVIF; SVG refused), passed through when a JPEG/WebP fits within
 *   1.25× SCREEN_BOX.landscape and PASS_THROUGH_MAX_BYTES or scaled via the Images binding, thumb
 *   reusing `file` when within NEWS_THUMB_BOX, written under `o/<org>/f/<sha256>` (`feedBlobKey`)
 *   through `PhotoBlobs`, and recorded with `org.feedPhotos.delivered`.
 * - **The hourly sweep (`sweepFeedPhotos`, at :30)**: expires rows unnamed for a week past their check
 *   and deletes unreferenced blobs past their grace window, bounded to 11 D1 calls and 3 R2 deletes per run.
 *
 * Ports: `PhotoBlobs` (R2 in production via `r2PhotoBlobs`) and `PhotoQueue` (FEED_IMAGES in
 * production via `cfPhotoQueue`). Every timestamp comes from the injected `now`.
 */
import { coverSize, fitsScreenBox, NEWS_THUMB_BOX, type NewsFeed, SCREEN_BOX } from '@signforge/contract';
import {
  type DataSourceRow,
  expiredFeedImages,
  DEFAULT_PHOTO_BUDGET,
  imagesMonth,
  imagesTransformsUsed,
  type OrgScope,
  PHOTOS_PER_SOURCE,
  type PhotoBudget,
  type PhotoRead,
  pendingFeedImageDeletes,
  photoRead,
  scoped,
  takeImagesTransforms,
} from '@signforge/db';
import { rendition, type ParsedNews } from '@signforge/feeds';
import { readImageInfo } from '@signforge/media/image-info';
import { workerFetch } from '../connectors';
import { FetchError, type FetchErrorCode, type FetchGuards, feedGuards, guardedImageFetch } from './fetch';

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
/**
 * What one hourly sweep run takes of what is due (rows unnamed past their check, blobs past their grace), the oldest
 * first, from up to CLEANUP_ORGS_PER_RUN orgs: 24 runs a day forget 7,200 rows and delete 14,400 blobs, so the sweep
 * keeps up with three orgs at MOST_PER_ORG_PER_DAY whatever their cap, and a cap lowered later strands nothing. A run
 * stays within 11 D1 calls and 3 R2 deletes, and each statement's list of URLs within a few hundred kB (review of #497).
 */
const FORGET_PER_RUN = 300;
const DELETE_PER_RUN = 600;
const CLEANUP_ORGS_PER_RUN = 3;
/** The most `FEED_PHOTOS_ORG_DAILY` and `FEED_PHOTOS_SOURCE_DAILY` may be: the sweep keeps up with three orgs this busy. */
const MOST_PHOTOS_PER_DAY = 1800;

/**
 * The day's photo caps the environment sets (`FEED_PHOTOS_ORG_DAILY`, `FEED_PHOTOS_SOURCE_DAILY`; the demo's real-feed
 * test lifts them), or 60 an org and 30 a source. Read once a run, before any source is claimed. A value that is not
 * written as a whole number from 1 to MOST_PHOTOS_PER_DAY (no sign, exponent, hex or spaces) fails the run, loudly,
 * rather than polling under caps nobody set.
 */
export function photoBudget(env: Pick<Env, 'FEED_PHOTOS_ORG_DAILY' | 'FEED_PHOTOS_SOURCE_DAILY'>): PhotoBudget {
  const read = (name: string, value: string | undefined, unset: number) => {
    if (value === undefined) return unset;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > MOST_PHOTOS_PER_DAY)
      throw new Error(`${name} must be a whole number from 1 to ${MOST_PHOTOS_PER_DAY}, not ${JSON.stringify(value)}`);
    return Number(value);
  };
  return {
    perOrg: read('FEED_PHOTOS_ORG_DAILY', env.FEED_PHOTOS_ORG_DAILY, DEFAULT_PHOTO_BUDGET.perOrg),
    perSource: read('FEED_PHOTOS_SOURCE_DAILY', env.FEED_PHOTOS_SOURCE_DAILY, DEFAULT_PHOTO_BUDGET.perSource),
  };
}
/** Encoder quality for a copy, as `sf build` and the CMS's uploads use. */
const QUALITY = 85;

/**
 * R2 key for a feed photo blob (`o/<org>/f/<sha256>`), kept separate from `o/<org>/b/` assets,
 * template bundles and `/admin` manifest blobs so daily feed cleanup can never touch them.
 */
export const feedBlobKey = (orgId: string, sha256: string) => `o/${orgId}/f/${sha256}`;

/** One photo to fetch: the URL as the feed named it, for the org and the source that named it. */
export interface FeedImageJob {
  orgId: string;
  sourceId: string;
  url: string;
}

/** Port over feed-photo blob storage (R2 in production, in-memory in tests). */
export interface PhotoBlobs {
  put(key: string, bytes: Uint8Array, meta: { sha256: string; contentType: string }): Promise<void>;
  delete(keys: string[]): Promise<void>;
}

/** Port over the feed-photo queue (`FEED_IMAGES` in production, in-memory in tests). */
export interface PhotoQueue {
  enqueue(jobs: readonly FeedImageJob[]): Promise<void>;
}

/** Cloudflare R2 adapter for `PhotoBlobs`. */
export function r2PhotoBlobs(bucket: Pick<R2Bucket, 'put' | 'delete'>): PhotoBlobs {
  return {
    put: async (key, bytes, { sha256, contentType }) => {
      await bucket.put(key, bytes, { sha256, httpMetadata: { contentType } });
    },
    delete: async (keys) => {
      // R2 deletes at most 1,000 keys a call.
      for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    },
  };
}

/** Cloudflare Queues adapter for `PhotoQueue`. */
export function cfPhotoQueue(queue: { sendBatch(messages: Iterable<{ body: FeedImageJob }>): Promise<unknown> }): PhotoQueue {
  return {
    enqueue: async (jobs) => {
      if (jobs.length) await queue.sendBatch(jobs.map((body) => ({ body })));
    },
  };
}

/**
 * The month's Images transformations (#500): the account has 5,000 on the Free plan, past which Images fails (9422) for
 * every environment until the month resets. Each environment counts its own against its ceiling; their ceilings should
 * add up to fewer than the account's allowance.
 */
export interface TransformBudget {
  /** Whether the month's are used up: the consumer then fetches no new photo, and rechecks only those it holds (#508). */
  spent(): Promise<boolean>;
  /** Takes `n` of the month's, all or none: whether they were. */
  take(n: number): Promise<boolean>;
}

/** The environment's count in D1, against `ceiling` a UTC month: one read a batch, and one write a photo that needs Images. */
export function d1TransformBudget(db: D1Database, ceiling: number, now: number): TransformBudget {
  const month = imagesMonth(now);
  return {
    spent: async () => (await imagesTransformsUsed(db, month)) >= ceiling,
    take: (n) => takeImagesTransforms(db, month, n, ceiling),
  };
}

/** The most transformations a month the feed photos may ask for, unless `IMAGES_MONTHLY_TRANSFORMS` says: under the Free plan's 5,000. */
const DEFAULT_MONTHLY_TRANSFORMS = 4500;

/** `IMAGES_MONTHLY_TRANSFORMS`, a whole number from 1 to 1,000,000 (no sign, exponent, hex or spaces), or 4,500 when unset. */
export function monthlyTransforms(env: Pick<Env, 'IMAGES_MONTHLY_TRANSFORMS'>): number {
  const value = env.IMAGES_MONTHLY_TRANSFORMS;
  if (value === undefined) return DEFAULT_MONTHLY_TRANSFORMS;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 1_000_000)
    throw new Error(`IMAGES_MONTHLY_TRANSFORMS must be a whole number from 1 to 1000000, not ${JSON.stringify(value)}`);
  return Number(value);
}

/** What the consumer fetches, decodes and writes with. Production builds it via `photoDeps`; tests inject stubs. */
export interface PhotoDeps {
  now: number;
  blobs: PhotoBlobs;
  guards: FetchGuards;
  images: Pick<ImagesBinding, 'info' | 'input'>;
  transforms: TransformBudget;
}

/** Production dependencies for `storeFeedImages`, built at the Worker boundary with an explicit `now`. */
export function photoDeps(env: Env, now: number): PhotoDeps {
  return {
    now,
    blobs: r2PhotoBlobs(env.BLOBS),
    guards: feedGuards(env, workerFetch),
    images: env.IMAGES,
    transforms: d1TransformBudget(env.DB, monthlyTransforms(env), now),
  };
}

/** Photo state for one RSS poll: whether anything shows its photos (a screen's desired manifest or a published spot), and the D1 read token. */
export interface PhotoPoll {
  shown: boolean;
  read: PhotoRead;
}

/** URLs a poll wants queued once its snapshot stands: due rechecks (`again`) and unseen URLs (`fresh`). */
export interface PhotoPlan {
  again: string[];
  fresh: string[];
}

/**
 * Start the photo half of a poll: only RSS sources take a read token. `shownBy`: whether anything shows its photos, by
 * the rule sync and the device blob route serve them by (`hasBoundListImage`, #196): a list bound to the feed whose rows
 * declare an `image` property, in a screen's desired manifest (a CMS publish's or an `sf push`'s, #481, recorded when
 * it became desired, #486) or a published spot. A source bound only by text-only templates (News 1.4.1, Info frame's
 * crawl) does no photo work.
 */
export function startPhotoPoll(row: DataSourceRow, shownBy: boolean, now: number): PhotoPoll | undefined {
  if (row.format !== 'rss') return undefined;
  const shown = row.photos && shownBy;
  return { shown, read: photoRead(row, shown, now) };
}

/** On an RSS 304, check the source's last-seen photo URLs so retries, budget-deferred URLs and weekly rechecks still run. */
export async function planPhotoRecheck(org: OrgScope, poll: PhotoPoll, now: number): Promise<PhotoPlan | undefined> {
  if (!poll.shown || !poll.read.lastSeen.length) return undefined;
  const { again, fresh } = await org.feedPhotos.plan(poll.read.lastSeen, now);
  return { again, fresh };
}

/**
 * A news feed as a snapshot holds it: the parsed feed without its URLs, each of the first
 * PHOTOS_PER_SOURCE stories with the copy the org holds of its photo, if any. The source keeps
 * `stories` in snapshot order so a recheck can find the story even when two copies match.
 */
export async function attachFeedPhotos(
  org: OrgScope,
  { logo: _logo, items, ...feed }: ParsedNews,
  now: number,
): Promise<{ data: NewsFeed; stories: (string | null)[]; toQueue: PhotoPlan }> {
  const stories = items.slice(0, PHOTOS_PER_SOURCE).map((item) => item.image?.url ?? null);
  const urls = [...new Set(stories.filter((url): url is string => url !== null))];
  const { copies, again, fresh } = await org.feedPhotos.plan(urls, now);
  const data: NewsFeed = {
    ...feed,
    items: items.map(({ image, ...item }, i) => {
      const copy = image && i < PHOTOS_PER_SOURCE ? copies.get(image.url) : undefined;
      return copy ? { ...item, image: copy } : item;
    }),
  };
  return { data, stories, toQueue: { again, fresh } };
}

/**
 * Send URLs already held by `savePoll` to `queue`. A failure is logged, not thrown: the snapshot
 * and holds stand, and the photos wait for a later poll.
 */
export async function enqueueFeedPhotos(queue: PhotoQueue, orgId: string, sourceId: string, urls: readonly string[]): Promise<void> {
  if (!urls.length) return;
  try {
    await queue.enqueue(urls.map((url) => ({ orgId, sourceId, url })));
  } catch (e) {
    console.error(`[feed images] could not queue photos of ${orgId}/${sourceId}`, e);
  }
}

/**
 * Why a photo was not stored: the guards' categories; what its bytes are; the Images binding over
 * its allowance (`images-quota`) or failing (`images-unavailable`); or, on a message's last try, an
 * error of the consumer's own (`internal`).
 */
type PhotoError = FetchErrorCode | 'svg' | 'not-an-image' | 'undecodable' | 'images-quota' | 'images-month-budget' | 'images-unavailable' | 'internal';

/** A photo that could not be stored, for a reason it is recorded with. */
class PhotoFailure extends Error {
  constructor(
    readonly code: Extract<PhotoError, 'svg' | 'not-an-image' | 'undecodable' | 'too-large' | 'images-quota' | 'images-month-budget' | 'images-unavailable'>,
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

/**
 * The queue's consumer: fetch, check and store each photo, one at a time, so an invocation holds
 * one photo's bytes at once; then have its source read afresh if its copy changed. A message that
 * fails for a reason of the consumer's own is retried, and on its last try recorded as `internal`
 * with a backoff, so a photo that keeps failing leaves the queue until a poll names it again later.
 */
export async function storeFeedImages(batch: MessageBatch<FeedImageJob>, db: D1Database, deps: PhotoDeps): Promise<void> {
  // The month's transformations used up: no new photo is fetched, each recorded as waiting for the next month (#500).
  // A D1 error here fails the batch, which the queue retries whole: nothing was fetched or written yet (#508).
  const spent = await deps.transforms.spent();
  for (const message of batch.messages) {
    const job = message.body;
    try {
      await deliverFeedPhoto(db, job, deps, spent);
      message.ack();
    } catch (e) {
      console.error(`[feed images] a photo of ${job.orgId}/${job.sourceId} could not be stored (try ${message.attempts} of ${ATTEMPTS})`, e);
      if (message.attempts < ATTEMPTS) {
        message.retry();
        continue;
      }
      try {
        const org = scoped(db, job.orgId);
        const [row] = await org.feedPhotos.get([job.url]);
        if (row) await org.feedPhotos.delivered(job.url, { result: 'failed', now: deps.now, checked: row, error: 'internal', passing: true });
      } catch (again) {
        console.error('[feed images] its failure could not be recorded either', again);
      }
      message.ack();
    }
  }
}

/** Fetch, check and store one queued photo, reporting its result to `org.feedPhotos.delivered`. */
async function deliverFeedPhoto(
  db: D1Database,
  { orgId, sourceId, url }: FeedImageJob,
  { now, blobs, guards, images, transforms }: PhotoDeps,
  spent: boolean,
): Promise<void> {
  const org = scoped(db, orgId);
  const source = await org.dataSources.get(sourceId);
  const [row] = await org.feedPhotos.get([url]);
  // Deleted, or its photos switched off, since the poll queued it; or forgotten since (rows are made before they are queued).
  if (!source?.photos || !row) return;
  /** Fetch, check and store the photo from `from`, under the feed's URL whichever it is. */
  const storeFrom = async (from: string) => {
    // Only to the URL they came from: BBC and Le Monde answer each size of a photo with one ETag, so the feed's small
    // photo's would get a 304 from the CDN's copy and keep the small one (#518).
    const sent = (row.validatedFrom ?? httpsOf(url)) === from ? row : { etag: null, lastModified: null };
    const fetched = await guardedImageFetch(from, sent, guards);
    if (fetched.status === 'not-modified') {
      await org.feedPhotos.delivered(url, { result: 'unchanged', now, sourceId, checked: row });
      return;
    }
    const validators = { etag: fetched.etag, lastModified: fetched.lastModified, validatedFrom: from };
    const sourceSha256 = await sha256Hex(fetched.body);
    if (sourceSha256 === row.sourceSha256 && row.fileSha256 && row.thumbSha256) {
      await org.feedPhotos.delivered(url, { result: 'unchanged', now, sourceId, checked: row, validators });
      return;
    }
    // Same photo bytes already processed for another URL in this org (query string, http/https, mirror): reuse its copies with no transform or blob write.
    const existing = await org.feedPhotos.copyOf(sourceSha256);
    if (existing) {
      await org.feedPhotos.delivered(url, { result: 'reused', now, sourceId, sourceSha256, copy: existing, validators });
      return;
    }
    const { file, thumb } = await copies(images, transforms, fetched.body);
    const fileSha = file.bytes === fetched.body ? sourceSha256 : await sha256Hex(file.bytes);
    const thumbSha = thumb.bytes === file.bytes ? fileSha : await sha256Hex(thumb.bytes);
    await org.feedPhotos.delivered(url, {
      result: 'stored',
      now,
      sourceId,
      sourceSha256,
      copy: { file: fileSha, thumb: thumbSha },
      validators,
      write: async () => {
        await blobs.put(feedBlobKey(org.orgId, fileSha), file.bytes, { sha256: fileSha, contentType: file.type });
        if (thumbSha !== fileSha) {
          await blobs.put(feedBlobKey(org.orgId, thumbSha), thumb.bytes, { sha256: thumbSha, contentType: thumb.type });
        }
      },
    });
  };
  // A CDN's copy at the size the screen needs first (#488); the feed's own when the CDN refuses that size or sends what
  // does not decode, so a CDN that changes its sizes costs no photo. Not over a copy already held from it: a refusal at
  // its recheck keeps that copy, as any failure does, rather than the feed's smaller photo.
  const larger = rendition(url);
  const holdsCopy = !!row.fileSha256 && row.validatedFrom === larger;
  try {
    // A held copy is still rechecked: unchanged bytes cost none, and a changed one is refused by `take` and kept (#508).
    if (spent && !row.fileSha256) throw new PhotoFailure('images-month-budget');
    if (!larger) await storeFrom(httpsOf(url));
    else
      await storeFrom(larger).catch((e: unknown) => {
        if (holdsCopy || !refusedCopy(e)) throw e;
        console.warn(`[feed images] ${larger} was refused (${e.code}); fetching the feed's ${url}`);
        return storeFrom(httpsOf(url));
      });
  } catch (e) {
    if (!(e instanceof FetchError || e instanceof PhotoFailure)) throw e;
    await org.feedPhotos.delivered(url, { result: 'failed', now, checked: row, error: e.code, passing: mayPass(e) });
  }
}

/**
 * Whether a CDN's rewritten copy was refused as that copy: a 4xx other than 429 (which, like a 5xx, waits and asks for
 * the copy again, #518), over the size a photo may be, or bytes that are not a photo it can decode.
 */
const refusedCopy = (e: unknown): e is FetchError | PhotoFailure =>
  (e instanceof FetchError &&
    ((e.code === 'http-status' && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) || e.code === 'too-large')) ||
  (e instanceof PhotoFailure && (e.code === 'not-an-image' || e.code === 'undecodable' || e.code === 'too-large'));

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
 * A photo's lead copy and thumbnail with their types. A JPEG or WebP already within 1.25×
 * SCREEN_BOX.landscape and PASS_THROUGH_MAX_BYTES ships untouched (no Images call); a thumbnail is
 * made only when the photo is larger than NEWS_THUMB_BOX, otherwise `file` is reused.
 */
async function copies(
  images: PhotoDeps['images'],
  transforms: TransformBudget,
  bytes: Uint8Array,
): Promise<{ file: { bytes: Uint8Array; type: string }; thumb: { bytes: Uint8Array; type: string } }> {
  const source = sniffed(bytes);
  // An AVIF never passes through: its first transformation is taken before Images reads its size, so a spent month
  // asks Images nothing (review of #548). One Images then refuses keeps that one taken, which errs on the safe side.
  const paid = source.type === 'image/avif' ? 1 : 0;
  try {
    if (paid && !(await transforms.take(paid))) throw new PhotoFailure('images-month-budget');
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
    const fileSize = passThrough ? size : cover;
    const small = coverSize(fileSize.width, fileSize.height, NEWS_THUMB_BOX);
    // What Images is asked for, taken from the month's before it is: none for a small photo that passes through.
    const needed = (passThrough ? 0 : 1) + (small.scaled ? 1 : 0) - paid;
    if (needed && !(await transforms.take(needed))) throw new PhotoFailure('images-month-budget');
    const file = passThrough ? { bytes, type } : { bytes: await scaled(images, bytes, cover, type), type };
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

/** Group items by org, keeping at most `maxOrgs` orgs so a run stays well inside Free D1's 50-query limit. */
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
 * The hourly sweep, bounded to 11 D1 calls and 3 R2 deletes for Free D1's 50-query limit:
 * 1. Expire `feed_images` rows unnamed for a week past their check (`expiredFeedImages`), keeping
 *    any still named by a snapshot, and durably queue their hashes into `feed_image_deletes`.
 * 2. Drain `feed_image_deletes` rows whose grace window has elapsed (`pendingFeedImageDeletes`),
 *    re-checking references in batched SQL, leasing claimed hashes while deleting from `blobs`
 *    under `o/<org>/f/`, and clearing the delete records only after blob delete succeeds.
 * Returns how many expired rows were forgotten plus how many blobs were deleted.
 */
export async function sweepFeedPhotos(db: D1Database, blobs: PhotoBlobs, now: number): Promise<number> {
  const expired = await expiredFeedImages(db, now, FORGET_PER_RUN);
  let forgotten = 0;
  for (const [orgId, urls] of groupByOrg(expired, (r) => r.url, CLEANUP_ORGS_PER_RUN)) {
    forgotten += await scoped(db, orgId).feedPhotos.expire(urls, now);
  }
  const pending = await pendingFeedImageDeletes(db, now, DELETE_PER_RUN);
  let deleted = 0;
  const errors: unknown[] = [];
  for (const [orgId, shas] of groupByOrg(pending, (r) => r.sha256, CLEANUP_ORGS_PER_RUN)) {
    try {
      deleted += await scoped(db, orgId).feedPhotos.deleteBlobs(shas, now, (leased) => blobs.delete(leased.map((sha) => feedBlobKey(orgId, sha))));
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'feed image blob deletion failed');
  return forgotten + deleted;
}
