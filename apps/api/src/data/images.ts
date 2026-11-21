/**
 * Stories' photos (#195). A feed names its photos by URL, a third party's, which no screen may
 * reach; so the server fetches each, checks it and stores its own copy in the org's storage, and
 * a snapshot names the copy by hash (the contract's `NewsImage`).
 *
 * Two halves, so a poll stays cheap whatever the photos cost:
 *
 * - **The poll** (`newsWithPhotos`, from ./poller.ts, for an `rss` source with `photos` on) looks
 *   up the first PHOTOS_PER_SOURCE stories' photo URLs in the org's `feed_images` and gives each
 *   story the copy held for it. It queues the URLs it holds nothing for, and the ones due to be
 *   asked again, to FEED_IMAGES, holding them meanwhile so the next poll does not queue them
 *   twice: one read, one write and one queue send per poll.
 * - **The queue's consumer** (`storeFeedImages`) fetches each through the feed guards (./fetch.ts:
 *   https only, every redirect and every resolved address checked, IMAGE_MAX_BYTES), an `http:`
 *   URL once as https; reads its type from its bytes (JPEG, PNG, WebP or AVIF; SVG refused) and
 *   never from a header; has the Images binding decode it and scale it to cover a landscape
 *   screen and NEWS_THUMB_BOX; makes the sample of the cover-size copy; and stores the files in
 *   R2 under the org's blob keys. A source whose photos changed is read afresh at its next poll,
 *   so its snapshot names them.
 *
 * A photo is asked for again, conditionally, a day after it was fetched (an unchanged one answers
 * 304 and is kept). A failure keeps the last good copy and is tried again in an hour if it may
 * pass (a timeout, a server's error) or in a day if it will not (an SVG, an image too large).
 */
import { coverSize, fitsScreenBox, NEWS_THUMB_BOX, type NewsFeed, type NewsImage, SCREEN_BOX } from '@signforge/contract';
import { type FeedImageRow, type OrgScope, scoped } from '@signforge/db';
import type { ParsedNews } from '@signforge/feeds';
import { readImageInfo } from '@signforge/media/image-info';
import { encodePng } from '@signforge/media/png';
import { imageSample } from '@signforge/media/sample';
import { workerFetch } from '../connectors';
import { orgBlobKey } from '../r2';
import { FetchError, type FetchErrorCode, type FetchGuards, feedGuards, guardedImageFetch } from './fetch';

/** Stories per source with a photo: the first, newest ones. No template shows more of a feed's photos. */
export const PHOTOS_PER_SOURCE = 10;
/** How long a fetched photo is kept as it is before a poll that still names it queues a conditional fetch. */
export const RECHECK_MS = 24 * 3_600_000;
/** After a failure that may pass, how long before a poll queues the URL again. */
export const RETRY_MS = 3_600_000;
/** How long a queued URL is held: past the consumer's tries, so polls meanwhile do not queue it again. */
export const HOLD_MS = 15 * 60_000;
/** Encoder quality for a copy, as `sf build` and the CMS's uploads use. */
const QUALITY = 85;

/** One photo to fetch: the URL as the feed named it, for the org and the source that named it. */
export interface FeedImageJob {
  orgId: string;
  sourceId: string;
  url: string;
}

/**
 * A news feed as a snapshot holds it: the parsed feed without its URLs, each of the first
 * PHOTOS_PER_SOURCE stories with the copy the org holds of its photo, if any. Queues the URLs that
 * have none, or are due to be asked again.
 */
export async function newsWithPhotos(
  env: Pick<Env, 'FEED_IMAGES'>,
  org: OrgScope,
  sourceId: string,
  { logo: _logo, items, ...feed }: ParsedNews,
  now: number,
): Promise<NewsFeed> {
  const shown = items.slice(0, PHOTOS_PER_SOURCE);
  const urls = [...new Set(shown.flatMap((i) => (i.image ? [i.image.url] : [])))];
  const held = new Map((await org.feedImages.get(urls)).map((r) => [r.url, r]));
  const due = urls.filter((url) => (held.get(url)?.nextCheckAt ?? now) <= now);
  if (due.length) {
    await org.feedImages.hold(due, now + HOLD_MS);
    await env.FEED_IMAGES.sendBatch(due.map((url): { body: FeedImageJob } => ({ body: { orgId: org.orgId, sourceId, url } })));
  }
  return {
    ...feed,
    items: items.map(({ image, ...item }, i) => {
      const copy = image && i < PHOTOS_PER_SOURCE ? photoOf(held.get(image.url)) : undefined;
      return copy ? { ...item, image: copy } : item;
    }),
  };
}

const photoOf = (row: FeedImageRow | undefined): NewsImage | undefined =>
  row?.fileSha256 && row.thumbSha256 ? { file: row.fileSha256, ...(row.sampleSha256 ? { sample: row.sampleSha256 } : {}), thumb: row.thumbSha256 } : undefined;

/** Why a photo was not stored: the guards' categories, and what its bytes are. */
type PhotoError = FetchErrorCode | 'svg' | 'not-an-image' | 'undecodable';

/** Bytes that may not be stored as a photo. */
class PhotoRefused extends Error {
  constructor(
    readonly code: Extract<PhotoError, 'svg' | 'not-an-image' | 'undecodable' | 'too-large'>,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

/** Failures a later try may not meet: the URL was reached, or could not be, for a reason of its own. */
const PASSING = new Set<PhotoError>(['dns', 'timeout', 'network', 'http-status', 'blocked-address']);

/** What the consumer fetches and decodes with. The Worker passes its own; tests stub them. */
export interface PhotoDeps {
  now: number;
  guards: FetchGuards;
  images: Pick<ImagesBinding, 'info' | 'input'>;
}

/** The queue's consumer: fetch, check and store each photo, then have each source whose photos changed read afresh. */
export async function storeFeedImages(
  batch: MessageBatch<FeedImageJob>,
  env: Env,
  { now, guards, images }: PhotoDeps = { now: Date.now(), guards: feedGuards(env, workerFetch), images: env.IMAGES },
): Promise<void> {
  const changed = new Map<string, { org: OrgScope; sourceId: string }>();
  await Promise.all(
    batch.messages.map(async (message) => {
      const { orgId, sourceId, url } = message.body;
      const org = scoped(env.DB, orgId);
      try {
        if (await storeOne(env, { now, guards, images }, org, sourceId, url)) changed.set(`${orgId}/${sourceId}`, { org, sourceId });
        message.ack();
      } catch (e) {
        console.error('[feed images] a photo could not be stored', e);
        message.retry();
      }
    }),
  );
  await Promise.all([...changed.values()].map(({ org, sourceId }) => org.dataSources.readAfresh(sourceId)));
}

/** Fetch and store one photo; true when the copy it names changed. */
async function storeOne(env: Pick<Env, 'BLOBS'>, { now, guards, images }: PhotoDeps, org: OrgScope, sourceId: string, url: string): Promise<boolean> {
  const source = await org.dataSources.get(sourceId);
  const [row] = await org.feedImages.get([url]);
  // Deleted, or its photos switched off, since the poll queued it; the row is made before the URL is queued.
  if (!source?.photos || !row) return false;
  try {
    const fetched = await guardedImageFetch(httpsOf(url), row, guards);
    if (fetched.status === 'not-modified') {
      await org.feedImages.save(url, { nextCheckAt: now + RECHECK_MS, lastError: null });
      return false;
    }
    const copy = await stored(env, images, org.orgId, fetched.body);
    await org.feedImages.save(url, {
      fileSha256: copy.file,
      sampleSha256: copy.sample ?? null,
      thumbSha256: copy.thumb,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      nextCheckAt: now + RECHECK_MS,
      lastError: null,
    });
    return copy.file !== row.fileSha256 || copy.thumb !== row.thumbSha256 || (copy.sample ?? null) !== row.sampleSha256;
  } catch (e) {
    if (!(e instanceof FetchError || e instanceof PhotoRefused)) throw e;
    await org.feedImages.save(url, { lastError: e.code, nextCheckAt: now + (PASSING.has(e.code) ? RETRY_MS : RECHECK_MS) });
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
  if (info?.type === 'image/svg+xml') throw new PhotoRefused('svg');
  if (info) return info;
  // An ISO BMFF file whose `ftyp` box names an AVIF brand, major or compatible.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length >= 16 && ascii(4) === 'ftyp') {
    const end = Math.min(view.getUint32(0), bytes.length);
    for (let at = 8; at + 4 <= end; at += 4) if (at !== 12 && (ascii(at) === 'avif' || ascii(at) === 'avis')) return { type: 'image/avif' };
  }
  throw new PhotoRefused('not-an-image');
}

/** The checked copies of a photo, stored in the org's blobs: by hash, so one photo named by several stories or sources is stored once. */
async function stored(env: Pick<Env, 'BLOBS'>, images: PhotoDeps['images'], orgId: string, bytes: Uint8Array): Promise<NewsImage> {
  const [file, thumb, sample] = await Promise.all(
    (await copies(images, bytes)).map(async (f) => {
      const sha256 = await sha256Hex(f.bytes);
      await env.BLOBS.put(orgBlobKey(orgId, sha256), f.bytes, { sha256, httpMetadata: { contentType: f.type } });
      return sha256;
    }),
  );
  return { file: file!, ...(sample ? { sample } : {}), thumb: thumb! };
}

/** A photo's copy that covers a landscape screen, its thumbnail, and the copy's sample if it is opaque, with their types. */
async function copies(images: PhotoDeps['images'], bytes: Uint8Array): Promise<{ bytes: Uint8Array; type: string }[]> {
  const source = sniffed(bytes);
  try {
    // AVIF's size is the decoder's to read; the others' as displayed, after a JPEG's EXIF orientation, as the binding draws them.
    const size = source.width && source.height ? { width: source.width, height: source.height } : await images.info(stream(bytes));
    if (!('width' in size)) throw new PhotoRefused('not-an-image');
    const cover = coverSize(size.width, size.height, SCREEN_BOX.landscape);
    if (!fitsScreenBox(cover.width, cover.height, SCREEN_BOX.landscape)) throw new PhotoRefused('too-large');
    // A JPEG stays a JPEG; anything else becomes a WebP, which keeps transparency, as uploads do.
    const type = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const file = await scaled(images, bytes, cover, type);
    // The sample is of the pixels a screen draws: the copy's, decoded again.
    const drawn = readImageInfo(file);
    const pixels = new Uint8Array(await (await images.input(stream(file)).output({ format: 'rgba' })).response().arrayBuffer());
    if (!drawn?.width || pixels.length !== drawn.width * drawn.height * 4) throw new PhotoRefused('undecodable');
    const thumb = await scaled(images, file, coverSize(drawn.width, drawn.height, NEWS_THUMB_BOX), type);
    const sample = imageSample(pixels, drawn.width, drawn.height);
    return [
      { bytes: file, type },
      { bytes: thumb, type },
      ...(sample ? [{ bytes: await encodePng(sample.data, sample.width, sample.height), type: 'image/png' }] : []),
    ];
  } catch (e) {
    if (e instanceof PhotoRefused) throw e;
    // The binding could not decode it: damaged, or not what its first bytes said.
    throw new PhotoRefused('undecodable', { cause: e });
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
