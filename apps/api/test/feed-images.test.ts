// Feed photos (#195, #329): the poll looks up and queues them, the queue's consumer fetches, checks
// and stores them, and the sweep expires and deletes them. No network and no image service: fetch,
// DNS and the Images binding are stubs, R2 and the queue use in-memory adapters over real D1, and
// every clock time is injected.
import { MAX_SNAPSHOT_BYTES, type NewsFeed } from '@signforge/contract';
import {
  DELETE_LEASE_MS,
  FAIL_WAIT_MS,
  FEED_IMAGE_DELETE_GRACE_MS,
  FEED_IMAGE_TTL_MS,
  HOLD_MS,
  DEFAULT_PHOTO_BUDGET,
  imagesMonth,
  imagesTransformsUsed,
  NEW_PER_ORG_PER_DAY,
  NEW_PER_SOURCE_PER_DAY,
  PHOTOS_PER_SOURCE,
  RECHECK_MS,
  RETRY_MS,
} from '@signforge/db';
import { seedOrg, seedOrganization, type SeededOrg, testScope } from '@signforge/db/testing';
import { dispatch, registry } from '@signforge/tools';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../src/connectors/adapter';
import { sealGrant } from '../src/connectors/vault';
import { feedUrlSealer } from '../src/data/cipher';
import type { FetchGuards } from '../src/data/fetch';
import {
  cfPhotoQueue,
  d1TransformBudget,
  feedBlobKey,
  type FeedImageJob,
  PASS_THROUGH_MAX_BYTES,
  type PhotoBlobs,
  photoBudget,
  type PhotoDeps,
  type PhotoQueue,
  monthlyTransforms,
  r2PhotoBlobs,
  sha256Hex,
  storeFeedImages,
  sweepFeedPhotos,
} from '../src/data/feed-photos';
import { pollDataSources } from '../src/data/poller';
import worker from '../src/index';
import { screenNotifier } from '../src/device/screens';
import { manifestKey, orgBlobKey } from '../src/r2';
import { fakeProvider } from './fake-provider';

const DAY_MS = 24 * 3_600_000;
/** The caps demo's Worker vars set (wrangler.jsonc `env.demo`). */
const LIFTED = { perOrg: 1800, perSource: 300 };
const MIN = 60_000;
let NOW = Date.UTC(2026, 10, 21, 9);

// ------------------------------------------------------------------ images

/** The first bytes of a w x h baseline JPEG: as far as its frame header, which is all a header reader needs. */
function jpeg(w: number, h: number, tail = '', padBytes = 0): Uint8Array {
  const extra = new TextEncoder().encode(tail);
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, ...Array<number>(9).fill(0)];
  const out = new Uint8Array(Math.max(head.length + extra.length, padBytes));
  out.set(head, 0);
  out.set(extra, head.length);
  return out;
}
/** A w x h WebP's header (VP8X). */
function webp(w: number, h: number, tail = ''): Uint8Array {
  const extra = new TextEncoder().encode(tail);
  const b = new Uint8Array(30 + extra.length);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  b[16] = 10;
  b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16], 24);
  b.set(extra, 30);
  return b;
}
/** A w x h PNG's signature and header. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  b.set(new TextEncoder().encode('IHDR'), 12);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  b.set([8, 6], 24);
  return b;
}
/** An AVIF's `ftyp` box: brand `mif1`, compatible with `avif`. */
const avif = () => new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypmif1'), 0, 0, 0, 0, ...new TextEncoder().encode('mif1avif')]);
const text = (s: string) => new TextEncoder().encode(s);

/**
 * A stand-in for the Images binding: it "decodes" the headers above (bytes holding `BROKEN` fail
 * with 9412 as damaged files do; `failWith` simulates quota/service failures), draws to the size
 * asked as a header of the type asked, and records each draw as `type@WxH`.
 */
function imagesStub({ failWith, avifSize = { w: 2400, h: 1600 } }: { failWith?: () => Error; avifSize?: { w: number; h: number } } = {}) {
  const draws: string[] = [];
  const read = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());
  const decoded = (b: Uint8Array) => {
    if (failWith) throw failWith();
    if (new TextDecoder().decode(b).includes('BROKEN')) throw new Error('ERROR 9412: Input image could not be decoded');
    if (new TextDecoder().decode(b).includes('HUGE')) throw new Error('ERROR 9413: Input image is too large');
    const v = new DataView(b.buffer, b.byteOffset);
    if (b[0] === 0xff) return { w: v.getUint16(9), h: v.getUint16(7) };
    if (b[0] === 0x89) return { w: v.getUint32(16), h: v.getUint32(20) };
    if (b[0] === 0x52) return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    return avifSize;
  };
  const images: PhotoDeps['images'] = {
    info: async (s) => {
      const { w, h } = decoded(await read(s));
      return { format: 'image/avif', fileSize: 1, width: w, height: h };
    },
    input: (s) => {
      let size: { width?: number; height?: number } = {};
      const t = {
        transform: (x: { width?: number; height?: number }) => {
          size = x;
          return t;
        },
        draw: () => t,
        output: async ({ format }: { format: string }) => {
          const { w, h } = decoded(await read(s));
          const width = size.width ?? w;
          const height = size.height ?? h;
          draws.push(`${format}@${width}x${height}`);
          return {
            response: () => new Response(format === 'image/jpeg' ? jpeg(width, height) : webp(width, height)),
            contentType: () => format,
            image: () => s,
          };
        },
      };
      return t as unknown as ImageTransformer;
    },
  };
  return { images, draws };
}

// ------------------------------------------------------------------- fetch

type Answer = { status?: number; body?: Uint8Array | string | ReadableStream<Uint8Array>; headers?: Record<string, string> };

/** Guards whose fetch answers by URL and records each request; a host resolves to a public address unless `addresses` says otherwise. */
function web(answers: Record<string, Answer | ((req: Request) => Answer)>, addresses: Record<string, string[]> = {}) {
  const requests: Request[] = [];
  const guards: FetchGuards = {
    fetch: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      const a = answers[req.url];
      if (!a) return new Response('nope', { status: 404 });
      const { status = 200, body = null, headers } = typeof a === 'function' ? a(req) : a;
      return new Response(body, { status, headers });
    },
    resolve: async (host) => addresses[host] ?? ['93.184.216.34'],
  };
  return { guards, requests };
}

/** Count D1 calls (`prepare().first/all/run/raw` and `batch()`) executed through a wrapped D1Database. */
function countingDb(db: D1Database) {
  let apiCalls = 0;
  let statements = 0;
  const prepared = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') return (...args: unknown[]) => wrapStmt(target.bind(...args));
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
          return async (...args: unknown[]) => {
            apiCalls++;
            statements++;
            return (target[prop] as (...a: unknown[]) => unknown)(...args);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    prepared.set(proxy, stmt);
    return proxy;
  };
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (query: string) => wrapStmt(target.prepare(query));
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          apiCalls++;
          statements += stmts.length;
          return target.batch(stmts.map((s) => prepared.get(s) ?? s));
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
  return {
    db: wrapped,
    counts: () => ({ apiCalls, statements }),
    reset: () => {
      apiCalls = 0;
      statements = 0;
    },
  };
}

// ------------------------------------------------------------------ adapters

/** In-memory adapter for `PhotoBlobs`: keyed by R2 key, never touching real R2. */
function memoryPhotoBlobs() {
  const stored = new Map<string, { bytes: Uint8Array; sha256: string; contentType: string }>();
  const blobs: PhotoBlobs & {
    has: (key: string) => boolean;
    seed: (key: string, bytes: Uint8Array, sha256: string, contentType?: string) => void;
  } = {
    put: async (key, bytes, { sha256, contentType }) => {
      stored.set(key, { bytes, sha256, contentType });
    },
    delete: async (keys) => {
      for (const key of keys) stored.delete(key);
    },
    has: (key) => stored.has(key),
    seed: (key, bytes, sha256, contentType = 'image/jpeg') => void stored.set(key, { bytes, sha256, contentType }),
  };
  return blobs;
}

/** In-memory adapter for `PhotoQueue`: captures queued jobs for tests to drain. */
function memoryPhotoQueue() {
  const queued: FeedImageJob[] = [];
  const queue: PhotoQueue & { take: () => FeedImageJob[] } = {
    enqueue: async (jobs) => void queued.push(...jobs),
    take: () => queued.splice(0),
  };
  return queue;
}

// ------------------------------------------------------------------- setup

let o: SeededOrg;
let n = 0;
const photoVersions = new Map<string, string>();
const createdSpots: { orgId: string; id: string }[] = [];
const extraPollOrgs = new Set<string>();
const photoQueue = memoryPhotoQueue();
const photoBlobs = memoryPhotoBlobs();

const PHOTO_NEWS_FIELDS = {
  language: { type: 'text', label: 'Language', default: '' },
  items: {
    type: 'list',
    label: 'Headlines',
    item: {
      title: { type: 'text', label: 'Headline' },
      image: { type: 'image', label: 'Photo' },
    },
  },
};

/** A template version in `org` with the given `fields`. */
async function templateVersion(org: SeededOrg, version: string, fields: Record<string, unknown>): Promise<string> {
  const tv = await org.scope.templates.versions.insert({
    templateId: org.template,
    version,
    manifestJson: JSON.stringify({
      id: 'news-test',
      version,
      name: 'News',
      fields,
      duration: { defaultMs: 10_000, minMs: 5_000, maxMs: 30_000 },
      orientations: ['landscape', 'portrait'],
      uses: [],
      background: '#000',
    }),
    bundleSha256: '0'.repeat(64),
    status: 'approved',
  });
  return tv.id;
}

/** The cached photo-capable template version for `org`. */
async function photoTemplateFor(org: SeededOrg): Promise<string> {
  let tvId = photoVersions.get(org.orgId);
  if (!tvId) {
    tvId = await templateVersion(org, `2.0.${++n}`, PHOTO_NEWS_FIELDS);
    photoVersions.set(org.orgId, tvId);
  }
  return tvId;
}

/** Bind a template spot to `sourceId`, published by default so the poller counts it. */
async function bindSpot(
  org: SeededOrg,
  sourceId: string,
  {
    tvId,
    bindings = { items: { source: sourceId, path: 'items' }, language: { source: sourceId, path: 'language' } },
    publish = true,
  }: { tvId?: string; bindings?: Record<string, { source: string; path: string }>; publish?: boolean } = {},
) {
  const id = `spot-${++n}`;
  const spot = await org.scope.spots.insert({
    id,
    name: id,
    kind: 'template',
    durationMs: 10_000,
    templateVersionId: tvId ?? (await photoTemplateFor(org)),
    dataJson: '{}',
    bindingsJson: JSON.stringify(bindings),
  });
  if (publish) await org.scope.commit(org.scope.spots.stage.publish(spot).writes);
  createdSpots.push({ orgId: org.orgId, id });
  return id;
}

/** A news source due at `at`, its URL sealed as the tools seal it, bound by a published photo-capable spot unless `bind: false`. */
async function news(url: string, { org = o, photos = true, at = NOW, bind = true } = {}) {
  const id = `news-${++n}`;
  await org.scope.dataSources.insert({
    id,
    name: id,
    format: 'rss',
    urlEncrypted: await feedUrlSealer(env).seal({ orgId: org.orgId, id }, url),
    refreshS: 300,
    photos,
    nextPollAt: at,
  });
  if (bind) await bindSpot(org, id);
  return id;
}

/** An RSS feed whose stories each name a photo, by `photo(i)`. */
function feedOf(stories: number, photo: (i: number) => string | undefined) {
  const items = Array.from({ length: stories }, (_, i) => {
    const url = photo(i);
    const hour = String(23 - (i % 24)).padStart(2, '0');
    return `<item><title>Story ${i}</title><pubDate>Fri, 20 Nov 2026 ${hour}:00:00 GMT</pubDate>${url ? `<media:content url="${url}" medium="image"/>` : ''}</item>`;
  });
  return `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Daily</title>${items.join('')}</channel></rss>`;
}

/** Take what the polls queued so far. */
const take = () => photoQueue.take();

/** Run the poller with the in-memory `photoQueue` by default. */
const poll = (opts: Parameters<typeof pollDataSources>[1], customEnv = env) => pollDataSources(customEnv, { photoQueue, ...opts });

/** Run the consumer on these jobs at `at`; the messages it acked and retried. */
async function consume(
  jobs: FeedImageJob[],
  deps: Omit<PhotoDeps, 'now' | 'blobs' | 'transforms'> & { blobs?: PhotoBlobs; transforms?: PhotoDeps['transforms'] },
  at = NOW,
  { attempts = 1, db = env.DB }: { attempts?: number; db?: D1Database } = {},
) {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages = jobs.map((body) => ({
    id: body.url,
    timestamp: new Date(at),
    attempts,
    body,
    ack: () => acked.push(body.url),
    retry: () => retried.push(body.url),
  }));
  const batch = { queue: 'signforge-feed-images', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<FeedImageJob>;
  // Unless a test counts them, the month's Images transformations never run out.
  await storeFeedImages(batch, db, { blobs: photoBlobs, transforms: { spent: async () => false, take: async () => true }, ...deps, now: at });
  return { acked, retried };
}

const snapshot = async (id: string, org = o): Promise<NewsFeed> => JSON.parse((await org.scope.dataSources.snapshots([id]))[0]!.dataJson);
const row = async (url: string, org = o) => (await org.scope.feedPhotos.get([url]))[0];

beforeAll(async () => {
  o = await seedOrg(env.DB, 'photos-org');
  await o.scope.dataSources.update(o.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
});

// Move the clock forward 30 days before each test so daily budgets and holds from earlier tests never interfere.
beforeEach(() => {
  NOW += 30 * DAY_MS;
  take();
});

// Only a test's own sources and spots are active in it: the rest are not due, and hold no share of an org's photo day.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const org of [o.orgId, 'photos-other', ...extraPollOrgs])
    for (const d of await testScope(env.DB, org).dataSources.list())
      await testScope(env.DB, org).dataSources.update(d.id, { nextPollAt: Number.MAX_SAFE_INTEGER, photos: false });
  extraPollOrgs.clear();
  for (const s of createdSpots.splice(0)) await testScope(env.DB, s.orgId).spots.delete(s.id);
});

// ------------------------------------------------------------------- tests

describe('a news source with photos', () => {
  it('queues the first stories’ photos, stores them, and names the copies in its next snapshot', async () => {
    // Small photos keep this cap/hold/snapshot test fast; scaling of large photos is tested on one photo below.
    const id = await news('https://daily.test/rss');
    const photo = (i: number) => `https://cdn.daily.test/${i}.jpg`;
    const body = feedOf(12, photo);
    const feed = web({ 'https://daily.test/rss': { body, headers: { etag: '"f1"' } } });
    await poll({ now: NOW, guards: feed.guards });
    // At most PHOTOS_PER_SOURCE per source: a screen shows no more.
    expect(take().map((j) => j.url)).toEqual(Array.from({ length: PHOTOS_PER_SOURCE }, (_, i) => photo(i)));
    expect((await snapshot(id)).items.some((i) => i.image)).toBe(false);
    expect(await row(photo(0))).toMatchObject({ fileSha256: null, nextCheckAt: NOW + HOLD_MS });

    // Polled again before they are stored: held, so not queued twice.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN, etag: null });
    await poll({ now: NOW + 5 * MIN, guards: feed.guards });
    expect(take()).toEqual([]);

    const { images, draws } = imagesStub();
    const photos = web(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [photo(i), { body: jpeg(320, 180, `p${i}`), headers: { etag: `"p${i}"` } }])));
    const jobs = Array.from({ length: PHOTOS_PER_SOURCE }, (_, i) => ({ orgId: o.orgId, sourceId: id, url: photo(i) }));
    expect(await consume(jobs, { guards: photos.guards, images }, NOW + 6 * MIN)).toEqual({ acked: jobs.map((j) => j.url), retried: [] });
    // Small JPEGs already fit NEWS_THUMB_BOX: 0 Images calls, `thumb` reuses `file`.
    expect(draws).toEqual([]);
    const stored = (await row(photo(0)))!;
    expect(stored).toMatchObject({ etag: '"p0"', lastError: null, failures: 0, nextCheckAt: NOW + 6 * MIN + RECHECK_MS });
    expect(stored.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.thumbSha256).toBe(stored.fileSha256);
    // Stored under the literal feed-owned prefix `o/<org>/f/<sha256>`.
    expect(photoBlobs.has(`o/${o.orgId}/f/${stored.fileSha256!}`)).toBe(true);
    // Read afresh next time, so a 304 cannot leave the snapshot without them.
    expect(await o.scope.dataSources.get(id)).toMatchObject({ etag: null });

    await o.scope.dataSources.update(id, { nextPollAt: NOW + 10 * MIN });
    await poll({ now: NOW + 10 * MIN, guards: feed.guards });
    expect(take()).toEqual([]);
    const data = await snapshot(id);
    expect(data.items[0]?.image).toEqual({ file: stored.fileSha256, thumb: stored.thumbSha256 });
    expect(data.items.filter((i) => i.image)).toHaveLength(PHOTOS_PER_SOURCE);
    expect(data.items.slice(PHOTOS_PER_SOURCE).some((i) => i.image)).toBe(false);
    expect(JSON.stringify(data)).not.toContain('cdn.daily.test');
  });

  it('scales oversized photos to cover 1920x1080 and 480x270, passes fitting JPEG/WebP through with no Images call for file, and reuses file as thumb when small', async () => {
    const runOne = async (url: string, body: Uint8Array) => {
      const feedUrl = `https://scale-${++n}.test/rss`;
      await news(feedUrl);
      await poll({ now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => url) } }).guards });
      const stub = imagesStub();
      await consume(take(), { guards: web({ [url]: { body } }).guards, images: stub.images });
      return { r: (await row(url))!, draws: stub.draws };
    };

    // 1. Oversized 4K JPEG: scaled to 1920x1080 + 480x270 (2 Images calls).
    const big = await runOne('https://scale.test/4k.jpg', jpeg(3840, 2160));
    expect(big.draws).toEqual(['image/jpeg@1920x1080', 'image/jpeg@480x270']);
    expect(big.r.fileSha256).not.toBe(big.r.thumbSha256);

    // 2. Web JPEG within 1.25× SCREEN_BOX (2400x1350) and <= 1 MB: file passes through untouched (original sha256), only thumb scaled (1 Images call).
    const fitBytes = jpeg(2048, 1366, 'fit');
    const fit = await runOne('https://scale.test/fit.jpg', fitBytes);
    expect(fit.draws).toEqual(['image/jpeg@480x320']);
    expect(fit.r.fileSha256).toBe(await sha256Hex(fitBytes));
    expect(fit.r.thumbSha256).not.toBe(fit.r.fileSha256);

    // 3. WebP fitting within 1.25× box and <= 1 MB: passes through untouched, only thumb scaled.
    const fitWebpBytes = webp(1600, 900, 'w');
    const fitWebp = await runOne('https://scale.test/fit.webp', fitWebpBytes);
    expect(fitWebp.draws).toEqual(['image/webp@480x270']);
    expect(fitWebp.r.fileSha256).toBe(await sha256Hex(fitWebpBytes));

    // 4. Small JPEG fitting NEWS_THUMB_BOX (480x270): 0 Images calls, thumb === file.
    const tinyBytes = jpeg(480, 270, 'tiny');
    const tiny = await runOne('https://scale.test/tiny.jpg', tinyBytes);
    expect(tiny.draws).toEqual([]);
    expect(tiny.r.fileSha256).toBe(await sha256Hex(tinyBytes));
    expect(tiny.r.thumbSha256).toBe(tiny.r.fileSha256);

    // 5. Fitting dimensions (1600x900) but over PASS_THROUGH_MAX_BYTES (1 MB): re-encoded by Images.
    const bloated = await runOne('https://scale.test/bloated.jpg', jpeg(1600, 900, 'bloat', PASS_THROUGH_MAX_BYTES + 1));
    expect(bloated.draws).toEqual(['image/jpeg@1600x900', 'image/jpeg@480x270']);

    // 6. Small PNG (320x180): converted to WebP (1 Images call), thumb reuses file (no second call).
    const smallPng = await runOne('https://scale.test/small.png', png(320, 180));
    expect(smallPng.draws).toEqual(['image/webp@320x180']);
    expect(smallPng.r.thumbSha256).toBe(smallPng.r.fileSha256);
  });

  it('still fits a snapshot with a photo on every story it shows', async () => {
    // The longest titles a feed can give, and the most stories.
    const id = await news('https://long.test/rss');
    const title = 'T'.repeat(2000);
    const items = Array.from(
      { length: 20 },
      (_, i) =>
        `<item><title>${title}</title><pubDate>Fri, 20 Nov 2026 0${i % 10}:00:00 GMT</pubDate><media:content url="https://cdn.long.test/${i}.jpg" medium="image"/></item>`,
    );
    const body = `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Long</title>${items.join('')}</channel></rss>`;
    await poll({ now: NOW, guards: web({ 'https://long.test/rss': { body } }).guards });
    const jobs = take();
    const { images } = imagesStub();
    await consume(jobs, { guards: web(Object.fromEntries(jobs.map((j, i) => [j.url, { body: jpeg(320, 180, `l${i}`) }]))).guards, images });
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    await poll({ now: NOW + 5 * MIN, guards: web({ 'https://long.test/rss': { body } }).guards });
    const json = (await o.scope.dataSources.snapshots([id]))[0]!.dataJson;
    expect(JSON.parse(json).items.filter((i: { image?: unknown }) => i.image)).toHaveLength(PHOTOS_PER_SOURCE);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it('asks again a week later with its validators even when RSS returns 304, and keeps the copy when unchanged', async () => {
    const id = await news('https://etag.test/rss');
    const url = 'https://cdn.etag.test/a.png';
    const body = feedOf(1, () => url);
    const rss = web({
      'https://etag.test/rss': (req) => (req.headers.get('if-none-match') === '"rss-v1"' ? { status: 304 } : { body, headers: { etag: '"rss-v1"' } }),
    });
    await poll({ now: NOW, guards: rss.guards });
    const { images, draws } = imagesStub();
    let answer: Answer = { body: png(800, 600), headers: { etag: '"img1"', 'last-modified': 'Thu, 19 Nov 2026 08:00:00 GMT' } };
    const photos = web({ [url]: () => answer });
    await consume(take(), { guards: photos.guards, images });
    const first = (await row(url))!;
    // A PNG becomes a WebP; one larger than NEWS_THUMB_BOX also makes a thumbnail.
    expect(draws).toEqual(['image/webp@800x600', 'image/webp@480x360']);

    // Poll once to populate snapshot and restore RSS ETag '"rss-v1"'.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    await poll({ now: NOW + 5 * MIN, guards: rss.guards });
    expect((await o.scope.dataSources.get(id))?.etag).toBe('"rss-v1"');

    // Not due within the week: RSS returns 304 and poll queues nothing.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + DAY_MS });
    await poll({ now: NOW + DAY_MS, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"rss-v1"');
    expect(take()).toEqual([]);

    // A week later, RSS STILL returns 304 (etag never manually cleared!), yet photo revalidation is queued.
    const later = NOW + RECHECK_MS;
    await o.scope.dataSources.update(id, { nextPollAt: later });
    await poll({ now: later, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"rss-v1"');
    const jobs = take();
    expect(jobs.map((j) => j.url)).toEqual([url]);
    answer = { status: 304 };
    await consume(jobs, { guards: photos.guards, images }, later);
    expect(photos.requests.at(-1)?.headers.get('if-none-match')).toBe('"img1"');
    expect(photos.requests.at(-1)?.headers.get('if-modified-since')).toBe('Thu, 19 Nov 2026 08:00:00 GMT');
    // Nothing drawn again, the copy kept, and the source's RSS ETag kept intact.
    expect(draws).toHaveLength(2);
    expect(await row(url)).toMatchObject({ fileSha256: first.fileSha256, nextCheckAt: later + RECHECK_MS, lastError: null });
    expect((await o.scope.dataSources.get(id))?.etag).toBe('"rss-v1"');
  });

  it('retries failed enqueues and failed photo fetches when due even when RSS keeps returning 304', async () => {
    const id = await news('https://retry304.test/rss');
    const url = 'https://cdn.retry304.test/a.jpg';
    const body = feedOf(1, () => url);
    const rss = web({
      'https://retry304.test/rss': (req) => (req.headers.get('if-none-match') === '"r304"' ? { status: 304 } : { body, headers: { etag: '"r304"' } }),
    });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    // 1. Initial 200 poll saves snapshot + ETag + photoUrlsJson, but queue enqueue fails.
    await poll({ now: NOW, guards: rss.guards, photoQueue: { enqueue: async () => Promise.reject(new Error('queue down')) } });
    expect((await o.scope.dataSources.get(id))?.etag).toBe('"r304"');
    expect(consoleErr).toHaveBeenCalled();

    // 2. Once the hold expires, RSS returns 304 and the poller still retries enqueueing the photo.
    const t1 = NOW + HOLD_MS;
    await o.scope.dataSources.update(id, { nextPollAt: t1 });
    await poll({ now: t1, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"r304"');
    const retryJobs = take();
    expect(retryJobs.map((j) => j.url)).toEqual([url]);

    // 3. Consumer gets 503 -> backs off RETRY_MS (1h). Before 1h, 304 poll queues nothing.
    const { images } = imagesStub();
    await consume(retryJobs, { guards: web({ [url]: { status: 503 } }).guards, images }, t1);
    await o.scope.dataSources.update(id, { nextPollAt: t1 + 10 * MIN });
    await poll({ now: t1 + 10 * MIN, guards: rss.guards });
    expect(take()).toEqual([]);

    // 4. At 1h backoff, RSS STILL returns 304 and the poller queues the retry; consumer succeeds and marks source readAfresh.
    const t2 = t1 + RETRY_MS;
    await o.scope.dataSources.update(id, { nextPollAt: t2 });
    await poll({ now: t2, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"r304"');
    const secondTry = take();
    expect(secondTry.map((j) => j.url)).toEqual([url]);
    await consume(secondTry, { guards: web({ [url]: { body: jpeg(320, 180, 'recovered') } }).guards, images }, t2);
    expect((await o.scope.dataSources.get(id))?.etag).toBeNull();

    // 5. Next poll fetches 200 and writes the recovered photo into the snapshot.
    await o.scope.dataSources.update(id, { nextPollAt: t2 + 5 * MIN });
    await poll({ now: t2 + 5 * MIN, guards: rss.guards });
    expect((await snapshot(id)).items[0]?.image?.file).toBe((await row(url))!.fileSha256);
  });

  it('repairs a snapshot missing an already-stored photo when its weekly recheck returns 304', async () => {
    const feed = 'https://repair-304.test/rss';
    const url = 'https://repair-304.test/photo.jpg';
    const id = await news(feed);
    const body = feedOf(1, () => url);
    const rss = web({ [feed]: (req) => (req.headers.has('if-none-match') ? { status: 304 } : { body, headers: { etag: '"rss"' } }) });
    await poll({ now: NOW, guards: rss.guards });
    const bytes = jpeg(320, 180, 'repair');
    await consume(take(), { guards: web({ [url]: { body: bytes, headers: { etag: '"photo"' } } }).guards, images: imagesStub().images });
    // An older poller could leave an RSS validator on a snapshot that never got the stored copy.
    const at = NOW + RECHECK_MS;
    await o.scope.dataSources.update(id, { etag: '"rss"', nextPollAt: at, photoUrlsJson: JSON.stringify([url]) });
    expect((await snapshot(id)).items[0]?.image).toBeUndefined();
    await poll({ now: at, guards: rss.guards });
    const photo = web({ [url]: { status: 304 } });
    const jobs = take();
    expect(jobs.map((job) => job.url)).toEqual([url]);
    await consume(jobs, { guards: photo.guards, images: imagesStub().images }, at);
    expect(photo.requests[0]?.headers.get('if-none-match')).toBe('"photo"');
    await poll({ now: at + 5 * MIN, guards: rss.guards });
    const sha = await sha256Hex(bytes);
    expect((await snapshot(id)).items[0]?.image).toEqual({ file: sha, thumb: sha });
  });

  it('repairs the story missing its photo even when another story already has the same copy', async () => {
    const feed = 'https://identical-304.test/rss';
    const urls = ['https://identical-304.test/a.jpg', 'https://identical-304.test/b.jpg'];
    const id = await news(feed);
    const body = feedOf(2, (i) => urls[i]);
    const rss = web({ [feed]: (req) => (req.headers.has('if-none-match') ? { status: 304 } : { body, headers: { etag: '"rss"' } }) });
    const bytes = jpeg(320, 180, 'same bytes, different stories');
    const sha = await sha256Hex(bytes);
    const copy = { file: sha, thumb: sha };
    const { images } = imagesStub();
    await poll({ now: NOW, guards: rss.guards });
    const photos = web(
      Object.fromEntries(
        urls.map((url) => [
          url,
          (req: Request): Answer => (req.headers.get('if-none-match') === '"photo"' ? { status: 304 } : { body: bytes, headers: { etag: '"photo"' } }),
        ]),
      ),
    );
    await consume(take(), { guards: photos.guards, images }, NOW);
    const fullAt = NOW + 5 * MIN;
    await poll({ now: fullAt, guards: rss.guards });
    const stale = await snapshot(id);
    expect(stale.items.map((item) => item.image)).toEqual([copy, copy]);
    delete stale.items[1]?.image;
    await o.scope.dataSources.putSnapshot(id, { version: 'stale', fetchedAt: fullAt, checkedAt: fullAt, dataJson: JSON.stringify(stale) });

    const at = NOW + RECHECK_MS;
    await poll({ now: at, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"rss"');
    const jobs = take();
    expect(jobs.map((job) => job.url).sort()).toEqual(urls);
    await consume(jobs, { guards: photos.guards, images }, at);
    expect(photos.requests.slice(-2).map((req) => req.headers.get('if-none-match'))).toEqual(['"photo"', '"photo"']);
    await poll({ now: at + 5 * MIN, guards: rss.guards });
    expect((await snapshot(id)).items.map((item) => item.image)).toEqual([copy, copy]);
  });

  it('dedupes by content hash across URLs in the same org with no transform or new blob', async () => {
    const id = await news('https://dedupe.test/rss');
    const url1 = 'https://cdn.dedupe.test/a.jpg?v=1';
    const url2 = 'https://cdn.dedupe.test/a.jpg?v=2';
    const bytes = jpeg(3000, 2000, 'same-photo');
    await poll({ now: NOW, guards: web({ 'https://dedupe.test/rss': { body: feedOf(1, () => url1) } }).guards });
    const stub1 = imagesStub();
    await consume(take(), { guards: web({ [url1]: { body: bytes } }).guards, images: stub1.images });
    expect(stub1.draws).toEqual(['image/jpeg@1920x1280', 'image/jpeg@480x320']);
    const first = (await row(url1))!;

    // Another URL in the same org serves the exact same bytes: 0 Images calls, 0 blob puts, same hashes, source read afresh.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN, etag: '"kept"' });
    await poll({ now: NOW + 5 * MIN, guards: web({ 'https://dedupe.test/rss': { body: feedOf(1, () => url2) } }).guards });
    const stub2 = imagesStub();
    const putSpy = vi.spyOn(photoBlobs, 'put');
    await consume(take(), { guards: web({ [url2]: { body: bytes } }).guards, images: stub2.images }, NOW + 6 * MIN);
    expect(stub2.draws).toEqual([]);
    expect(putSpy).not.toHaveBeenCalled();
    expect(await row(url2)).toMatchObject({
      sourceSha256: first.sourceSha256,
      fileSha256: first.fileSha256,
      thumbSha256: first.thumbSha256,
      lastError: null,
    });
    expect(await o.scope.dataSources.get(id)).toMatchObject({ etag: null });
  });

  it('reads an AVIF by its brand, and its size from the decoder', async () => {
    await news('https://avif.test/rss');
    const url = 'https://cdn.avif.test/a.avif';
    await poll({ now: NOW, guards: web({ 'https://avif.test/rss': { body: feedOf(1, () => url) } }).guards });
    const { images, draws } = imagesStub();
    await consume(take(), { guards: web({ [url]: { body: avif() } }).guards, images });
    expect(draws).toEqual(['image/webp@1920x1280', 'image/webp@480x320']);
  });

  it("asks Images nothing for an AVIF the month's transformations cannot pay for, not even its size (review of #548)", async () => {
    await news('https://avif-spent.test/rss');
    const url = 'https://cdn.avif-spent.test/a.avif';
    await poll({ now: NOW, guards: web({ 'https://avif-spent.test/rss': { body: feedOf(1, () => url) } }).guards });
    const { images, draws } = imagesStub();
    const info = vi.spyOn(images, 'info');
    // Bytes no other test's AVIF has, so no copy of them is reused before Images would be asked.
    await consume(take(), {
      guards: web({ [url]: { body: new Uint8Array([...avif(), 7]) } }).guards,
      images,
      transforms: { spent: async () => false, take: async () => false },
    });
    expect(info).not.toHaveBeenCalled();
    expect(draws).toEqual([]);
    expect(await row(url)).toMatchObject({ fileSha256: null, lastError: 'images-month-budget' });
  });
});

describe('only fetching for sources something will show', () => {
  it('skips photo work for an unbound source, a draft-only spot, and a text-only template, and recovers from a 304 feed when newly bound', async () => {
    const photo = 'https://cdn.bound.test/hero.jpg';
    const body = feedOf(1, () => photo);
    const rss = web({
      'https://unbound.test/rss': (req) => (req.headers.get('if-none-match') === '"b1"' ? { status: 304 } : { body, headers: { etag: '"b1"' } }),
    });

    // 1. Unbound source (photos: true, no published spot): stores ETag '"b1"', no image rows, nothing queued.
    const unboundId = await news('https://unbound.test/rss', { bind: false });
    await poll({ now: NOW, guards: rss.guards });
    expect((await o.scope.dataSources.get(unboundId))?.etag).toBe('"b1"');
    expect(take()).toEqual([]);
    expect(await row(photo)).toBeUndefined();

    // 2. Draft spot binding a photo template, not published: RSS returns 304, still skipped.
    const draftSpotId = await bindSpot(o, unboundId, { publish: false });
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 5 * MIN });
    await poll({ now: NOW + 5 * MIN, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"b1"');
    expect(take()).toEqual([]);

    // 3. Published template with a static image field (like Info frame) whose RSS binding is text-only: skipped.
    const textOnlyTv = await templateVersion(o, `1.0.${++n}`, {
      photo: { type: 'image', label: 'Static photo' },
      items: { type: 'list', label: 'Crawl', item: { title: { type: 'text', label: 'Headline' } } },
    });
    const textOnlySpotId = await bindSpot(o, unboundId, {
      tvId: textOnlyTv,
      bindings: { items: { source: unboundId, path: 'items' } },
      publish: true,
    });
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 10 * MIN });
    await poll({ now: NOW + 10 * MIN, guards: rss.guards });
    expect(take()).toEqual([]);

    // 4. Publishing the photo-capable spot without clearing the RSS ETag: poller omits validators once (photoUrlsJson is null) and queues the photo.
    const draftSpot = (await o.scope.spots.get(draftSpotId))!;
    await o.scope.commit(o.scope.spots.stage.publish(draftSpot).writes);
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 15 * MIN });
    await poll({ now: NOW + 15 * MIN, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBeNull();
    expect(take().map((j) => j.url)).toEqual([photo]);

    // 5. Removing the photo spot (leaving only the text-only spot) stops photo work again at the next poll.
    await o.scope.spots.delete(draftSpotId);
    const photo2 = 'https://cdn.bound.test/next.jpg';
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 20 * MIN, etag: null });
    await poll({ now: NOW + 20 * MIN, guards: web({ 'https://unbound.test/rss': { body: feedOf(1, () => photo2) } }).guards });
    expect(take()).toEqual([]);
    expect(await row(photo2)).toBeUndefined();
    await o.scope.spots.delete(textOnlySpotId);
  });
});

describe('photos for what screens play, and a feed unchanged since photos were turned on (#481)', () => {
  /**
   * A manifest as `sf push` uploads one for `org`'s screen: a News spot binding `sourceIds`' stories, with no published
   * spot behind it. The screen is told to play it by a plain update, which records no photo sources (#486): the poller
   * reads the manifest, as for a screen made desired before migration 0050.
   */
  async function pushed(org: SeededOrg, sourceIds: string[]) {
    const manifestId = await uploaded(org, sourceIds);
    await org.scope.screens.update(org.screen, { desiredManifestId: manifestId });
  }

  /** As `sf push` does it: uploaded, then `publish_manifest_to_screen`, which records its photo sources with it (#486). */
  async function pushedBySf(org: SeededOrg, sourceIds: string[]) {
    const manifestId = await uploaded(org, sourceIds);
    const r = await dispatch(
      registry,
      'publish_manifest_to_screen',
      { screenId: org.screen, manifestId },
      { org: org.scope, role: 'owner', actor: { kind: 'user', id: 'feed-test' }, blobs: env.BLOBS, services: { notify: screenNotifier(env) } },
    );
    expect(r.ok).toBe(true);
  }

  /** The R2 bucket, counting the reads of `org`'s manifests. */
  function countingManifestReads(org: SeededOrg) {
    let reads = 0;
    const bucket = new Proxy(env.BLOBS, {
      get(target, prop) {
        if (prop === 'get')
          return (key: string) => {
            if (key.startsWith(`o/${org.orgId}/`) && key.includes('/m/')) reads++;
            return target.get(key);
          };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { bucket, reads: () => reads };
  }

  async function uploaded(org: SeededOrg, sourceIds: string[]) {
    const manifestId = (++n).toString(16).padStart(64, 'f');
    const template = 'org/news-test@2.0.0';
    const manifest = {
      schema: 2,
      screen: { locale: 'en-GB' },
      templates: { [template]: { html: 'a'.repeat(64), manifest: { fields: PHOTO_NEWS_FIELDS, protocol: 1 } } },
      spots: Object.fromEntries(
        sourceIds.map((id) => [`pushed-${id}`, { kind: 'template', id: `pushed-${id}`, template, bindings: { items: { source: id, path: 'items' } } }]),
      ),
      files: {},
      dataSources: Object.fromEntries(sourceIds.map((id) => [id, {}])),
    };
    await env.BLOBS.put(manifestKey(org.orgId, org.screen, manifestId), JSON.stringify(manifest));
    return manifestId;
  }

  it('names the photos stored since its last poll in the next snapshot, though the feed answers 304 to a conditional request', async () => {
    const org = await seedOrg(env.DB, `push-481-probe-${++n}`);
    extraPollOrgs.add(org.orgId);
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const feed = 'https://probe.test/rss';
    const id = await news(feed, { org, bind: false });
    await pushed(org, [id]);
    const photo = (i: number) => `https://cdn.probe.test/${i}.jpg`;
    const rss = web({ [feed]: (req) => (req.headers.has('if-none-match') ? { status: 304 } : { body: feedOf(2, photo), headers: { etag: '"rss"' } }) });
    await poll({ now: NOW, guards: rss.guards });
    const jobs = take().filter((j) => j.sourceId === id);
    const { images } = imagesStub();
    const bytes = jpeg(320, 180, 'probe');
    await consume(jobs, { guards: web(Object.fromEntries(jobs.map((j) => [j.url, { body: bytes }]))).guards, images }, NOW + MIN);
    // A stored copy its snapshot does not name clears the source's validators: the next poll reads the feed whole.
    expect(await org.scope.dataSources.get(id)).toMatchObject({ etag: null, lastModified: null });
    await org.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    await poll({ now: NOW + 5 * MIN, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.has('if-none-match')).toBe(false);
    expect((await snapshot(id, org)).items.map((item) => item.image)).toEqual([
      expect.objectContaining({ file: expect.any(String) }),
      expect.objectContaining({ file: expect.any(String) }),
    ]);
  });

  it("queues photos for a source only a screen's pushed manifest shows: no published spot binds it", async () => {
    const org = await seedOrg(env.DB, `push-481-${++n}`);
    extraPollOrgs.add(org.orgId);
    const feed = 'https://pushed.test/rss';
    const id = await news(feed, { org, bind: false });
    await pushed(org, [id]);
    const photo = (i: number) => `https://cdn.pushed.test/${i}.jpg`;
    await poll({ now: NOW, guards: web({ [feed]: { body: feedOf(2, photo) } }).guards });
    expect(
      take()
        .filter((job) => job.sourceId === id)
        .map((job) => job.url),
    ).toEqual([photo(0), photo(1)]);
  });

  it('reads a feed whole once when photos are shown but were never read from it, though it answers 304, then takes 304s again', async () => {
    const feed = 'https://unchanged.test/rss';
    const id = await news(feed);
    const photo = (i: number) => `https://cdn.unchanged.test/${i}.jpg`;
    // As demo's NYT had it: a snapshot read with no photo recorded, and validators that make every request a 304.
    await o.scope.dataSources.putSnapshot(id, {
      version: 'text-only',
      fetchedAt: NOW - DAY_MS,
      checkedAt: NOW - DAY_MS,
      dataJson: JSON.stringify({ items: [{ title: 'Story 0' }] }),
    });
    await o.scope.dataSources.update(id, { etag: '"rss"', photoUrlsJson: JSON.stringify({ stories: [null] }) });
    const rss = web({ [feed]: (req) => (req.headers.has('if-none-match') ? { status: 304 } : { body: feedOf(2, photo), headers: { etag: '"rss"' } }) });
    await poll({ now: NOW, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.has('if-none-match')).toBe(false);
    expect(
      take()
        .filter((job) => job.sourceId === id)
        .map((job) => job.url),
    ).toEqual([photo(0), photo(1)]);
    // Read with photos now: the next poll asks for changes only.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    await poll({ now: NOW + 5 * MIN, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"rss"');
  });

  it("queues photos for a source an `sf push`'d manifest shows, from what the push recorded, reading no manifest (#486)", async () => {
    const org = await seedOrg(env.DB, `push-486-${++n}`);
    extraPollOrgs.add(org.orgId);
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const feed = 'https://pushed-486.test/rss';
    const id = await news(feed, { org, bind: false });
    await pushedBySf(org, [id]);
    const r2 = countingManifestReads(org);
    const photo = (i: number) => `https://cdn.pushed-486.test/${i}.jpg`;
    await poll({ now: NOW, guards: web({ [feed]: { body: feedOf(2, photo) } }).guards }, { ...env, BLOBS: r2.bucket });
    expect(
      take()
        .filter((job) => job.sourceId === id)
        .map((job) => job.url),
    ).toEqual([photo(0), photo(1)]);
    expect(r2.reads()).toBe(0);
  });

  it('reads the manifest when what was recorded is for another one: the screen was pointed at it by a path that records none (#486)', async () => {
    const org = await seedOrg(env.DB, `push-486-other-${++n}`);
    extraPollOrgs.add(org.orgId);
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const feed = 'https://pushed-486-other.test/rss';
    const id = await news(feed, { org, bind: false });
    // Recorded for a manifest that shows nothing; the one now desired shows the source.
    await pushedBySf(org, []);
    await pushed(org, [id]);
    const r2 = countingManifestReads(org);
    const photo = (i: number) => `https://cdn.pushed-486-other.test/${i}.jpg`;
    await poll({ now: NOW, guards: web({ [feed]: { body: feedOf(1, photo) } }).guards }, { ...env, BLOBS: r2.bucket });
    expect(take().filter((job) => job.sourceId === id)).toHaveLength(1);
    expect(r2.reads()).toBe(1);
  });

  it('takes a desired manifest that cannot be read as showing no photos, and polls the source as it is (#486)', async () => {
    const org = await seedOrg(env.DB, `push-486-gone-${++n}`);
    extraPollOrgs.add(org.orgId);
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const feed = 'https://pushed-486-gone.test/rss';
    const id = await news(feed, { org, bind: false });
    // Pointed at a manifest R2 does not hold, with nothing recorded for it.
    await org.scope.screens.update(org.screen, { desiredManifestId: 'e'.repeat(64) });
    await poll({ now: NOW, guards: web({ [feed]: { body: feedOf(1, (i) => `https://cdn.pushed-486-gone.test/${i}.jpg`) } }).guards });
    expect(take().filter((job) => job.sourceId === id)).toEqual([]);
    expect(await org.scope.dataSources.snapshot(id)).toBeDefined();
  });

  it("decides fit by published spots alone, whatever else the run claims: a pushed manifest's fields are for photos only", async () => {
    const org = await seedOrg(env.DB, `push-481-fit-${++n}`);
    extraPollOrgs.add(org.orgId);
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const feed = 'https://pushed-fit.test/rss';
    const rss = await news(feed, { org, bind: false });
    const jsonUrl = 'https://pushed-fit.test/data.json';
    const json = `json-${++n}`;
    await org.scope.dataSources.insert({
      id: json,
      name: json,
      format: 'json',
      urlEncrypted: await feedUrlSealer(env).seal({ orgId: org.orgId, id: json }, jsonUrl),
      refreshS: 300,
      nextPollAt: NOW,
    });
    // Both bound by the pushed manifest's stories; the JSON has none, which no published spot asks of it.
    await pushed(org, [rss, json]);
    await poll({ now: NOW, guards: web({ [feed]: { body: feedOf(1, () => undefined) }, [jsonUrl]: { body: '{"other":1}' } }).guards });
    expect(await org.scope.dataSources.get(json)).toMatchObject({ lastError: null, failures: 0 });
    expect(await org.scope.dataSources.snapshot(json)).toMatchObject({ dataJson: '{"other":1}' });
  });

  it("skips only the org whose manifests cannot be read, never another org's sources, and saves none as if photos were off", async () => {
    const broken = await seedOrg(env.DB, `push-481-r2-${++n}`);
    extraPollOrgs.add(broken.orgId);
    await broken.scope.dataSources.update(broken.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const brokenFeed = 'https://pushed-r2.test/rss';
    const theirs = await news(brokenFeed, { org: broken, bind: false });
    await pushed(broken, [theirs]);
    const fine = 'https://unbroken-r2.test/rss';
    const ours = await news(fine);
    const blobs = new Proxy(env.BLOBS, {
      get(target, prop) {
        if (prop === 'get') return (key: string) => (key.startsWith(`o/${broken.orgId}/`) ? Promise.reject(new Error('R2 is down')) : target.get(key));
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const feeds = web({
      [brokenFeed]: { body: feedOf(1, () => 'https://cdn.pushed-r2.test/0.jpg') },
      [fine]: { body: feedOf(1, () => 'https://cdn.unbroken-r2.test/0.jpg') },
    });
    await poll({ now: NOW, guards: feeds.guards }, { ...env, BLOBS: blobs });
    logged.mockRestore();
    expect(feeds.requests.map((r) => new URL(r.url).host)).toEqual(['unbroken-r2.test']);
    expect(await o.scope.dataSources.snapshot(ours)).toBeDefined();
    expect(await broken.scope.dataSources.snapshot(theirs)).toBeUndefined();
  });

  it("keeps a poll of 5 sources an `sf push`'d manifest shows under the Free plan's D1 limits, reading no manifest from R2 (#486)", async () => {
    const org = await seedOrg(env.DB, `push-481-budget-${++n}`);
    extraPollOrgs.add(org.orgId);
    // Only the five: the seeded org's own source is not due.
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const answers: Record<string, Answer> = {};
    const ids: string[] = [];
    for (let s = 0; s < 5; s++) {
      const feedUrl = `https://push-budget-${s}.test/rss`;
      ids.push(await news(feedUrl, { org, bind: false }));
      answers[feedUrl] = { body: feedOf(10, (i) => `https://cdn.push-budget-${s}.test/${i}.jpg`) };
    }
    await pushedBySf(org, ids);
    const counter = countingDb(env.DB);
    const r2 = countingManifestReads(org);
    await poll({ now: NOW, guards: web(answers).guards }, { ...env, DB: counter.db, BLOBS: r2.bucket });
    // Measured: pollInit is one batch, the screens' desired manifests and their recorded photo sources a statement in it
    // (#486), as before it, when the manifests themselves were R2 reads. 12 calls is what D1 counts against an invocation's 50.
    expect(counter.counts()).toEqual({ apiCalls: 12, statements: 36 });
    expect(r2.reads()).toBe(0);
    // Ten each, within each source's share of the org's day (60 / 5).
    expect(take().filter((job) => ids.includes(job.sourceId))).toHaveLength(50);
  });
});

describe('budgets, resilience and cleanup', () => {
  it("gives each of an org's photo sources its fair share of the day, whichever polls first, as demo's NYT needed (#481)", async () => {
    const org = await seedOrg(env.DB, `fair-share-${++n}`);
    extraPollOrgs.add(org.orgId);
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const feeds = ['guardian', 'verge', 'nyt'];
    const ids = new Map<string, string>();
    for (const f of feeds) ids.set(f, await news(`https://share-${f}.test/rss`, { org }));
    // Three busy feeds, ten unseen photos each poll, an hour apart: the share is 60 / 3 = 20 each, never another's.
    let serial = 0;
    for (let hour = 0; hour < 4; hour++) {
      const at = NOW + hour * 60 * MIN;
      for (const id of ids.values()) await org.scope.dataSources.update(id, { nextPollAt: at, etag: null });
      await poll({
        now: at,
        guards: web(
          Object.fromEntries(feeds.map((f) => [`https://share-${f}.test/rss`, { body: feedOf(10, () => `https://cdn.share-${f}.test/${serial++}.jpg`) }])),
        ).guards,
      });
    }
    const jobs = take();
    for (const [f, id] of ids)
      expect(jobs.filter((j) => j.sourceId === id).length, f).toBe(Math.min(NEW_PER_SOURCE_PER_DAY, NEW_PER_ORG_PER_DAY / feeds.length));
    expect(jobs).toHaveLength(NEW_PER_ORG_PER_DAY);
  });

  it("queues every story's photo where the environment lifts the caps, as the demo's does, and refuses a cap that is no number", async () => {
    const org = await seedOrg(env.DB, `lifted-${++n}`);
    extraPollOrgs.add(org.orgId);
    await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const feeds = ['guardian', 'verge', 'nyt'];
    const ids = new Map<string, string>();
    for (const f of feeds) ids.set(f, await news(`https://lifted-${f}.test/rss`, { org }));
    const lifted = { ...env, FEED_PHOTOS_ORG_DAILY: String(LIFTED.perOrg), FEED_PHOTOS_SOURCE_DAILY: String(LIFTED.perSource) };
    let serial = 0;
    for (let hour = 0; hour < 4; hour++) {
      const at = NOW + hour * 60 * MIN;
      for (const id of ids.values()) await org.scope.dataSources.update(id, { nextPollAt: at, etag: null });
      await poll(
        {
          now: at,
          guards: web(
            Object.fromEntries(feeds.map((f) => [`https://lifted-${f}.test/rss`, { body: feedOf(10, () => `https://cdn.lifted-${f}.test/${serial++}.jpg`) }])),
          ).guards,
        },
        lifted,
      );
    }
    const jobs = take();
    // Ten new stories a poll, four polls: all forty of each feed, where 60 an org would stop at 20 each.
    for (const [f, id] of ids) expect(jobs.filter((j) => j.sourceId === id).length, f).toBe(40);
    for (const value of ['', 'lots', '0', '2.5', '1e3', '0x10', ' 60', '060', '1801'])
      expect(() => photoBudget({ FEED_PHOTOS_ORG_DAILY: value }), value).toThrow(/FEED_PHOTOS_ORG_DAILY must be a whole number from 1 to 1800/);
    expect(photoBudget({ FEED_PHOTOS_SOURCE_DAILY: '1800' })).toEqual({ ...DEFAULT_PHOTO_BUDGET, perSource: 1800 });
    expect(photoBudget({})).toEqual(DEFAULT_PHOTO_BUDGET);
  });

  it("asks Images for no more than the month's ceiling: a photo past it, and every photo once it is spent, waits with images-month-budget unfetched (#500)", async () => {
    const id = await news('https://month.test/rss');
    // Sizes no other test's photos have: the Images stub draws by size, and a shared thumbnail would be another's too.
    const [big, mid, small, later] = ['big', 'mid', 'small', 'later'].map((n) => `https://cdn.month.test/${n}.jpg`);
    const photos = web({
      [big!]: { body: jpeg(3010, 2000, 'big') },
      [mid!]: { body: jpeg(812, 600, 'mid') },
      [small!]: { body: jpeg(322, 180, 'small') },
      [later!]: { body: jpeg(814, 600, 'later') },
    });
    const { images } = imagesStub();
    // A ceiling of 2, in a month of its own: the big photo takes both (its copy and its thumbnail).
    const at = Date.UTC(2031, 0, 10);
    const transforms = d1TransformBudget(env.DB, 2, at);
    await poll({ now: at, guards: web({ 'https://month.test/rss': { body: feedOf(3, (i) => [big, mid, small][i]!) } }).guards });
    await consume(take(), { guards: photos.guards, images, transforms }, at);
    expect((await row(big!))?.fileSha256).toEqual(expect.any(String));
    // The next needs one, past the ceiling; a small one that passes through needs none.
    expect(await row(mid!)).toMatchObject({ fileSha256: null, lastError: 'images-month-budget' });
    expect((await row(small!))?.fileSha256).toEqual(expect.any(String));
    expect(await imagesTransformsUsed(env.DB, imagesMonth(at))).toBe(2);
    // Spent: the next batch fetches nothing at all.
    await o.scope.dataSources.update(id, { nextPollAt: at + 5 * MIN, etag: null });
    await poll({ now: at + 5 * MIN, guards: web({ 'https://month.test/rss': { body: feedOf(1, () => later!) } }).guards });
    const fetched = photos.requests.length;
    await consume(take(), { guards: photos.guards, images, transforms: d1TransformBudget(env.DB, 2, at + 5 * MIN) }, at + 5 * MIN);
    expect(photos.requests).toHaveLength(fetched);
    expect(await row(later!)).toMatchObject({ fileSha256: null, lastError: 'images-month-budget' });
    // Spent, a held photo is still rechecked: its unchanged bytes cost none, and it keeps its copy (#508).
    const held = (await row(big!))!;
    const recheck = at + RECHECK_MS + 10 * MIN;
    await o.scope.dataSources.update(id, { nextPollAt: recheck, etag: null });
    await poll({ now: recheck, guards: web({ 'https://month.test/rss': { body: feedOf(1, () => big!) } }).guards });
    const beforeRecheck = photos.requests.length;
    await consume(take(), { guards: photos.guards, images, transforms: d1TransformBudget(env.DB, 2, recheck) }, recheck);
    expect(photos.requests.length).toBeGreaterThan(beforeRecheck);
    expect(await row(big!)).toMatchObject({ fileSha256: held.fileSha256, lastError: null });
    expect((await row(big!))!.nextCheckAt).toBeGreaterThan(held.nextCheckAt);
    // Its bytes changed: a new copy would need Images, so it keeps the one it has and is fetched again a day later (review of #548).
    const changedAt = (await row(big!))!.nextCheckAt;
    await o.scope.dataSources.update(id, { nextPollAt: changedAt, etag: null });
    await poll({ now: changedAt, guards: web({ 'https://month.test/rss': { body: feedOf(1, () => big!) } }).guards });
    const changed = web({ [big!]: { body: jpeg(3010, 2000, 'big, changed') } });
    await consume(take(), { guards: changed.guards, images, transforms: d1TransformBudget(env.DB, 2, changedAt) }, changedAt);
    expect(changed.requests).toHaveLength(1);
    expect(await row(big!)).toMatchObject({ fileSha256: held.fileSha256, lastError: 'images-month-budget', nextCheckAt: changedAt + DAY_MS });
    expect(await imagesTransformsUsed(env.DB, imagesMonth(at))).toBe(2);
    // A new month starts again.
    const next = Date.UTC(2031, 1, 1);
    await o.scope.dataSources.update(id, { nextPollAt: next, etag: null });
    await poll({ now: next + RETRY_MS * 48, guards: web({ 'https://month.test/rss': { body: feedOf(1, () => later!) } }).guards });
    await consume(take(), { guards: photos.guards, images, transforms: d1TransformBudget(env.DB, 2, next) }, next + RETRY_MS * 48);
    expect((await row(later!))?.fileSha256).toEqual(expect.any(String));
  });

  it('counts the month in one D1 read a batch and one write a photo that needs Images, and reads its ceiling as a whole number', async () => {
    const [a, b] = ['a', 'b'].map((n) => `https://cdn.month-cost.test/${n}.jpg`);
    await news('https://month-cost.test/rss');
    const at = Date.UTC(2031, 5, 10);
    await poll({ now: at, guards: web({ 'https://month-cost.test/rss': { body: feedOf(2, (i) => [a, b][i]!) } }).guards });
    const jobs = take();
    // Sizes no other test's photos have: the Images stub draws by size, and a shared thumbnail would be another's too.
    const guards = web({ [a!]: { body: jpeg(816, 600, 'cost-a') }, [b!]: { body: jpeg(818, 600, 'cost-b') } }).guards;
    /** The D1 calls of storing one of the photos, each needing one transformation (its thumbnail). */
    const calls = async (job: FeedImageJob, transforms?: (db: D1Database) => PhotoDeps['transforms']) => {
      const counter = countingDb(env.DB);
      await consume([job], { guards, images: imagesStub().images, ...(transforms && { transforms: transforms(counter.db) }) }, at, { db: counter.db });
      return counter.counts().apiCalls;
    };
    const uncounted = await calls(jobs.find((j) => j.url === a)!);
    const counted = await calls(jobs.find((j) => j.url === b)!, (db) => d1TransformBudget(db, 100, at));
    expect(counted - uncounted).toBe(2);
    expect(await imagesTransformsUsed(env.DB, imagesMonth(at))).toBe(1);
    for (const value of ['', '0', '4.5e3', '0x10', ' 4500', '1000001'])
      expect(() => monthlyTransforms({ IMAGES_MONTHLY_TRANSFORMS: value }), value).toThrow(
        /IMAGES_MONTHLY_TRANSFORMS must be a whole number from 1 to 1000000/,
      );
    expect(monthlyTransforms({})).toBe(4500);
    expect(monthlyTransforms({ IMAGES_MONTHLY_TRANSFORMS: '2000' })).toBe(2000);
  });

  it("reads every environment's photo caps and month's ceiling as the Worker does, so a malformed one fails here (#508)", () => {
    const vars: Record<string, Record<string, string | undefined>> = JSON.parse(env.DEPLOYED_VARS);
    // Read from wrangler.jsonc's env: these at least, and any added since.
    expect(Object.keys(vars)).toEqual(expect.arrayContaining(['dev', 'demo', 'prod']));
    for (const [name, v] of Object.entries(vars)) {
      expect(() => photoBudget(v), name).not.toThrow();
      expect(() => monthlyTransforms(v), name).not.toThrow();
    }
    expect(monthlyTransforms(vars.demo!) + monthlyTransforms(vars.prod!)).toBeLessThan(5000);
  });

  it('resumes a day later: the 24 hours since a photo was held are what count', async () => {
    const s1 = await news('https://b1.test/rss');
    const photos = (tag: string) => feedOf(10, (i) => `https://cdn.b1.test/${tag}-${i}.jpg`);
    // Alone with photos on, the source's share is its own cap.
    for (let k = 0; k < 4; k++) {
      await o.scope.dataSources.update(s1, { nextPollAt: NOW + k * 5 * MIN, etag: null });
      await poll({ now: NOW + k * 5 * MIN, guards: web({ 'https://b1.test/rss': { body: photos(`day1-${k}`) } }).guards });
    }
    expect(take()).toHaveLength(NEW_PER_SOURCE_PER_DAY);
    await o.scope.dataSources.update(s1, { nextPollAt: NOW + DAY_MS + 1, etag: null });
    await poll({ now: NOW + DAY_MS + 1, guards: web({ 'https://b1.test/rss': { body: photos('day2') } }).guards });
    expect(take()).toHaveLength(10);
  });

  it('saves headlines even when the photos queue rejects enqueue', async () => {
    const id = await news('https://queue-down.test/rss');
    const url = 'https://cdn.queue-down.test/a.jpg';
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await poll({
      now: NOW,
      guards: web({ 'https://queue-down.test/rss': { body: feedOf(1, () => url) } }).guards,
      photoQueue: { enqueue: async () => Promise.reject(new Error('queue quota exceeded')) },
    });
    expect((await snapshot(id)).items[0]?.title).toBe('Story 0');
    expect(await o.scope.dataSources.get(id)).toMatchObject({ failures: 0, lastError: null });
    expect(consoleErr).toHaveBeenCalled();
  });

  it('does not queue photos when the snapshot is refused as too-large or unfit', async () => {
    // Too large: 20 stories with huge titles push JSON past MAX_SNAPSHOT_BYTES.
    const bigId = await news('https://too-big.test/rss');
    const hugeItems = Array.from(
      { length: 20 },
      (_, i) =>
        `<item><title>${'X'.repeat(4000)}</title><pubDate>Fri, 20 Nov 2026 0${i % 10}:00:00 GMT</pubDate><media:content url="https://cdn.too-big.test/${i}.jpg" medium="image"/></item>`,
    ).join('');
    const bigFeed = `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Big</title>${hugeItems}</channel></rss>`;
    await poll({ now: NOW, guards: web({ 'https://too-big.test/rss': { body: bigFeed } }).guards });
    expect(await o.scope.dataSources.get(bigId)).toMatchObject({ failures: 1, lastError: 'too-large' });
    expect(take()).toEqual([]);
    expect(await row('https://cdn.too-big.test/0.jpg')).toBeUndefined();

    // Unfit: spot expects a number at `title` (and binds an image-capable list that also cannot fit).
    const unfitTv = await templateVersion(o, `3.0.${++n}`, {
      count: { type: 'number', label: 'Count' },
      items: { type: 'list', label: 'Items', item: { image: { type: 'image', label: 'Photo' } } },
    });
    const unfitId = await news('https://unfit.test/rss', { bind: false });
    await bindSpot(o, unfitId, {
      tvId: unfitTv,
      bindings: { count: { source: unfitId, path: 'title' }, items: { source: unfitId, path: 'title' } },
      publish: true,
    });
    await poll({ now: NOW, guards: web({ 'https://unfit.test/rss': { body: feedOf(1, () => 'https://cdn.unfit.test/0.jpg') } }).guards });
    expect(await o.scope.dataSources.get(unfitId)).toMatchObject({ failures: 1, lastError: 'unfit' });
    expect(take()).toEqual([]);
    expect(await row('https://cdn.unfit.test/0.jpg')).toBeUndefined();
  });

  it('grows backoff for passing failures up to 24h, puts 4xx and blocked-address in the 24h group, and classifies Images errors', async () => {
    const queueOne = async (url: string) => {
      const feedUrl = `https://err-${++n}.test/rss`;
      await news(feedUrl);
      await poll({ now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => url) } }).guards });
      return take();
    };

    // 503 backs off 1h, 2h, 4h, 8h, 16h, 24h, 24h.
    const flaky = 'https://err.test/flaky.jpg';
    const flakyJobs = await queueOne(flaky);
    const { images } = imagesStub();
    const waits: number[] = [];
    let at = NOW;
    for (let i = 0; i < 7; i++) {
      await consume(flakyJobs, { guards: web({ [flaky]: { status: 503 } }).guards, images }, at);
      const r = (await row(flaky))!;
      waits.push((r.nextCheckAt - at) / 3_600_000);
      at = r.nextCheckAt;
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 24, 24]);

    // 404 and Cloudflare blocked-address (403 error code 1003) wait 24h immediately.
    const gone = 'https://err.test/gone.jpg';
    const blocked = 'https://err.test/blocked.jpg';
    await consume(await queueOne(gone), { guards: web({ [gone]: { status: 404 } }).guards, images }, NOW);
    await consume(await queueOne(blocked), { guards: web({ [blocked]: { status: 403, body: 'error code: 1003' } }).guards, images }, NOW);
    expect(await row(gone)).toMatchObject({ lastError: 'http-status', failures: 1, nextCheckAt: NOW + FAIL_WAIT_MS });
    expect(await row(blocked)).toMatchObject({ lastError: 'blocked-address', failures: 1, nextCheckAt: NOW + FAIL_WAIT_MS });

    // Images 9422 -> images-quota (1h backoff); transient & ambiguous 9523 -> images-unavailable (1h backoff); 9413 -> too-large (24h); 9412 -> undecodable (24h).
    const quota = 'https://err.test/quota.jpg';
    const unavail = 'https://err.test/unavail.jpg';
    const resizeAmbiguous = 'https://err.test/9523.jpg';
    const tooLargeImg = 'https://err.test/9413.jpg';
    const decodeErr = 'https://err.test/decode.jpg';
    const bigJpeg = jpeg(3000, 2000);
    await consume(
      await queueOne(quota),
      { guards: web({ [quota]: { body: bigJpeg } }).guards, images: imagesStub({ failWith: () => new Error('ERROR 9422: over quota') }).images },
      NOW,
    );
    await consume(
      await queueOne(unavail),
      { guards: web({ [unavail]: { body: bigJpeg } }).guards, images: imagesStub({ failWith: () => new Error('upstream timeout') }).images },
      NOW,
    );
    await consume(
      await queueOne(resizeAmbiguous),
      {
        guards: web({ [resizeAmbiguous]: { body: bigJpeg } }).guards,
        images: imagesStub({ failWith: () => new Error('ERROR 9523: could not resize') }).images,
      },
      NOW,
    );
    await consume(
      await queueOne(tooLargeImg),
      { guards: web({ [tooLargeImg]: { body: bigJpeg } }).guards, images: imagesStub({ failWith: () => new Error('ERROR 9413: too large') }).images },
      NOW,
    );
    await consume(
      await queueOne(decodeErr),
      { guards: web({ [decodeErr]: { body: bigJpeg } }).guards, images: imagesStub({ failWith: () => new Error('ERROR 9412: corrupt') }).images },
      NOW,
    );
    expect(await row(quota)).toMatchObject({ lastError: 'images-quota', nextCheckAt: NOW + RETRY_MS });
    expect(await row(unavail)).toMatchObject({ lastError: 'images-unavailable', nextCheckAt: NOW + RETRY_MS });
    expect(await row(resizeAmbiguous)).toMatchObject({ lastError: 'images-unavailable', nextCheckAt: NOW + RETRY_MS });
    expect(await row(tooLargeImg)).toMatchObject({ lastError: 'too-large', nextCheckAt: NOW + FAIL_WAIT_MS });
    expect(await row(decodeErr)).toMatchObject({ lastError: 'undecodable', nextCheckAt: NOW + FAIL_WAIT_MS });
  });

  it('retries unexpected consumer errors, then records internal failure with backoff on the last attempt', async () => {
    const url = 'https://internal.test/a.jpg';
    await news('https://internal.test/rss');
    await poll({ now: NOW, guards: web({ 'https://internal.test/rss': { body: feedOf(1, () => url) } }).guards });
    const jobs = take();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenBlobs: PhotoBlobs = { ...photoBlobs, put: async () => Promise.reject(new Error('R2 down')) };
    const deps = { guards: web({ [url]: { body: jpeg(320, 180, 'r2fail') } }).guards, images: imagesStub().images, blobs: brokenBlobs };

    expect(await consume(jobs, deps, NOW, { attempts: 1 })).toEqual({ acked: [], retried: [url] });
    expect(await consume(jobs, deps, NOW, { attempts: 2 })).toEqual({ acked: [], retried: [url] });
    expect(await row(url)).toMatchObject({ lastError: null, failures: 0 });
    expect(await consume(jobs, deps, NOW, { attempts: 3 })).toEqual({ acked: [url], retried: [] });
    expect(await row(url)).toMatchObject({ lastError: 'internal', failures: 1, nextCheckAt: NOW + RETRY_MS });
    expect(consoleErr).toHaveBeenCalled();
  });

  it('forgets expired unreferenced rows, deletes feed blobs after the grace window, and never touches an /admin manifest blob with the same hash', async () => {
    // A year before the rest of the file: when its rows are due, no other test's are, so one sweep run reaches them.
    const T = NOW - 365 * DAY_MS;
    const id = await news('https://gc.test/rss', { at: T });
    const dropUrl = 'https://cdn.gc.test/drop.jpg';
    const keepUrl = 'https://cdn.gc.test/keep.jpg';
    const dropBytes = jpeg(320, 180, 'drop-shared-with-manifest');
    await poll({
      now: T,
      guards: web({ 'https://gc.test/rss': { body: feedOf(2, (i) => (i === 0 ? dropUrl : keepUrl)) } }).guards,
    });
    const jobs = take();
    const { images } = imagesStub();
    await consume(jobs, { guards: web({ [dropUrl]: { body: dropBytes }, [keepUrl]: { body: jpeg(320, 180, 'keep') } }).guards, images }, T);
    const dropSha = (await row(dropUrl))!.fileSha256!;
    const keepSha = (await row(keepUrl))!.fileSha256!;
    // Simulate a published /admin manifest holding the exact same content hash at orgBlobKey (no assets row).
    photoBlobs.seed(orgBlobKey(o.orgId, dropSha), dropBytes, dropSha);

    // Next poll writes a snapshot naming only keepUrl (dropUrl has dropped off the feed).
    await o.scope.dataSources.update(id, { nextPollAt: T + 5 * MIN, etag: null });
    await poll({ now: T + 5 * MIN, guards: web({ 'https://gc.test/rss': { body: feedOf(1, () => keepUrl) } }).guards });
    expect((await snapshot(id)).items[0]?.image?.file).toBe(keepSha);

    // Phase 1 at cleanupAt: forgets dropUrl and queues dropSha durably in feed_image_deletes (kept during grace window).
    const cleanupAt = T + RECHECK_MS + FEED_IMAGE_TTL_MS + 1;
    expect(await sweepFeedPhotos(env.DB, photoBlobs, cleanupAt)).toBeGreaterThanOrEqual(1);
    expect(await row(dropUrl)).toBeUndefined();
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).toContain(dropSha);
    expect(photoBlobs.has(feedBlobKey(o.orgId, dropSha))).toBe(true);

    // Phase 2 after FEED_IMAGE_DELETE_GRACE_MS: deletes feed blob o/<org>/f/<dropSha>, keeps snapshot-referenced keepSha AND keeps /admin manifest blob o/<org>/b/<dropSha>.
    const drainAt = cleanupAt + FEED_IMAGE_DELETE_GRACE_MS;
    await sweepFeedPhotos(env.DB, photoBlobs, drainAt);
    expect(photoBlobs.has(feedBlobKey(o.orgId, dropSha))).toBe(false);
    expect(photoBlobs.has(orgBlobKey(o.orgId, dropSha))).toBe(true);
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).not.toContain(dropSha);
    expect(await row(keepUrl)).toBeDefined();
    expect(photoBlobs.has(feedBlobKey(o.orgId, keepSha))).toBe(true);
  });

  it('queues replaced blobs for cleanup when a recheck replaces a photo at the same URL, and retries failed blob deletes cleanly', async () => {
    const id = await news('https://replace.test/rss');
    const url = 'https://cdn.replace.test/hero.jpg';
    const body = feedOf(1, () => url);
    let photoBody = jpeg(800, 600, 'version-1');
    const photos = web({ [url]: () => ({ body: photoBody }) });
    const { images } = imagesStub();

    // 1. Fetch and store version 1 (800x600 -> distinct file and thumb blobs).
    await poll({ now: NOW, guards: web({ 'https://replace.test/rss': { body } }).guards });
    await consume(take(), { guards: photos.guards, images }, NOW);
    const v1 = (await row(url))!;
    expect(v1.fileSha256).not.toBe(v1.thumbSha256);
    expect(photoBlobs.has(feedBlobKey(o.orgId, v1.fileSha256!))).toBe(true);
    expect(photoBlobs.has(feedBlobKey(o.orgId, v1.thumbSha256!))).toBe(true);

    // 2. Recheck a week later serves version 2 (different aspect ratio so both file and thumb hashes change): old file & thumb are queued durably in feed_image_deletes.
    const later = NOW + RECHECK_MS;
    photoBody = jpeg(900, 500, 'version-2');
    await o.scope.dataSources.update(id, { nextPollAt: later });
    await poll({ now: later, guards: web({ 'https://replace.test/rss': { body } }).guards });
    await consume(take(), { guards: photos.guards, images }, later);
    const v2 = (await row(url))!;
    expect(v2.fileSha256).not.toBe(v1.fileSha256);
    expect(v2.thumbSha256).not.toBe(v1.thumbSha256);
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).toEqual(expect.arrayContaining([v1.fileSha256!, v1.thumbSha256!]));

    // While the snapshot still references v1 (before the next poll refreshes it to v2), cleanup keeps both v1 blobs AND keeps them durably queued.
    const beforeRefreshAt = later + FEED_IMAGE_DELETE_GRACE_MS;
    await sweepFeedPhotos(env.DB, photoBlobs, beforeRefreshAt);
    expect(photoBlobs.has(feedBlobKey(o.orgId, v1.fileSha256!))).toBe(true);
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).toEqual(expect.arrayContaining([v1.fileSha256!, v1.thumbSha256!]));

    // Next poll updates the snapshot to v2, dropping v1 from snapshots.
    await o.scope.dataSources.update(id, { nextPollAt: beforeRefreshAt + 5 * MIN });
    await poll({ now: beforeRefreshAt + 5 * MIN, guards: web({ 'https://replace.test/rss': { body } }).guards });
    expect((await snapshot(id)).items[0]?.image?.file).toBe(v2.fileSha256);

    // 3. Failing blob delete keeps the durable delete record intact, and after DELETE_LEASE_MS the next sweep retries and succeeds.
    const drainAt = beforeRefreshAt + FEED_IMAGE_DELETE_GRACE_MS;
    const failingBlobs: PhotoBlobs = { ...photoBlobs, delete: async () => Promise.reject(new Error('R2 delete failed')) };
    await expect(sweepFeedPhotos(env.DB, failingBlobs, drainAt)).rejects.toThrow('R2 delete failed');
    // Old blobs and their durable delete records survive the failed delete.
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).toEqual(expect.arrayContaining([v1.fileSha256!, v1.thumbSha256!]));
    expect(photoBlobs.has(feedBlobKey(o.orgId, v1.fileSha256!))).toBe(true);

    // While leased, a consumer writing the same hash retries rather than racing blob delete.
    const racingUrl = 'https://cdn.replace.test/racing.jpg';
    await o.scope.feedPhotos.put({ url: racingUrl, sourceId: id, nextCheckAt: drainAt + HOLD_MS, createdAt: drainAt });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const race = await consume(
      [{ orgId: o.orgId, sourceId: id, url: racingUrl }],
      { guards: web({ [racingUrl]: { body: jpeg(800, 600, 'version-1') } }).guards, images },
      drainAt + 1_000,
    );
    expect(race).toEqual({ acked: [], retried: [racingUrl] });
    expect(consoleErr).toHaveBeenCalled();

    // Once DELETE_LEASE_MS passes, cleanup retries blob delete cleanly and removes old blobs + durable records while keeping v2.
    await sweepFeedPhotos(env.DB, photoBlobs, drainAt + DELETE_LEASE_MS);
    expect(photoBlobs.has(feedBlobKey(o.orgId, v1.fileSha256!))).toBe(false);
    expect(photoBlobs.has(feedBlobKey(o.orgId, v1.thumbSha256!))).toBe(false);
    expect(photoBlobs.has(feedBlobKey(o.orgId, v2.fileSha256!))).toBe(true);
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).not.toContain(v1.fileSha256);
  });

  it('queues the copy displaced by overlapping deliveries and keeps duplicate deliveries idempotent', async () => {
    const id = await news('https://overlap.test/rss', { bind: false });
    const url = 'https://overlap.test/photo.jpg';
    const jobs = [{ orgId: o.orgId, sourceId: id, url }];
    await o.scope.feedPhotos.put({ url, sourceId: id, nextCheckAt: NOW + HOLD_MS, createdAt: NOW });
    const a = jpeg(320, 180, 'overlap-a');
    const b = jpeg(320, 180, 'overlap-b');
    const c = jpeg(320, 180, 'overlap-c');
    const { images } = imagesStub();
    await consume(jobs, { guards: web({ [url]: { body: a } }).guards, images });

    const fetchingC = Promise.withResolvers<void>();
    const canStoreC = Promise.withResolvers<void>();
    const guards = web({ [url]: { body: c } }).guards;
    const deliveryC = consume(
      jobs,
      {
        images,
        guards: {
          ...guards,
          fetch: async (...args) => {
            fetchingC.resolve();
            await canStoreC.promise;
            return guards.fetch(...args);
          },
        },
      },
      NOW + RECHECK_MS,
    );
    try {
      await fetchingC.promise;
      expect(await consume(jobs, { guards: web({ [url]: { body: b } }).guards, images }, NOW + RECHECK_MS)).toEqual({ acked: [url], retried: [] });
      expect((await row(url))?.fileSha256).toBe(await sha256Hex(b));
    } finally {
      canStoreC.resolve();
      await deliveryC;
    }
    expect(await deliveryC).toEqual({ acked: [url], retried: [] });
    const shas = await Promise.all([a, b, c].map(sha256Hex));
    expect((await row(url))?.fileSha256).toBe(shas[2]);
    const pending = () => o.scope.feedPhotos.deletes();
    const deletions = await pending();
    expect(deletions.map((d) => d.sha256)).toEqual(expect.arrayContaining(shas.slice(0, 2)));
    expect(deletions.map((d) => d.sha256)).not.toContain(shas[2]);
    expect(await consume(jobs, { guards: web({ [url]: { body: c } }).guards, images }, NOW + RECHECK_MS + 1)).toEqual({ acked: [url], retried: [] });
    expect(await pending()).toEqual(deletions);
    await sweepFeedPhotos(env.DB, photoBlobs, NOW + RECHECK_MS + FEED_IMAGE_DELETE_GRACE_MS);
    expect(photoBlobs.has(feedBlobKey(o.orgId, shas[1]!))).toBe(false);
    expect(photoBlobs.has(feedBlobKey(o.orgId, shas[2]!))).toBe(true);
  });

  it('expires an eligible photo in another org when protected rows would fill the scan', async () => {
    const protectedSha = '1'.repeat(64);
    for (let i = 0; i < 10; i++) {
      const orgId = `expiry-protected-${i}`;
      await seedOrganization(env.DB, orgId);
      const scope = testScope(env.DB, orgId);
      const sourceId = 'news';
      await scope.dataSources.insert({
        id: sourceId,
        name: sourceId,
        format: 'rss',
        urlEncrypted: 'unused',
        refreshS: 300,
        nextPollAt: Number.MAX_SAFE_INTEGER,
      });
      for (let j = 0; j < 11; j++) {
        await scope.feedPhotos.put({
          url: `https://expiry-protected.test/${i}/${j}.jpg`,
          sourceId,
          fileSha256: protectedSha,
          thumbSha256: protectedSha,
          nextCheckAt: 0,
        });
      }
      await scope.dataSources.putSnapshot(sourceId, {
        version: 'expiry-protected',
        checkedAt: NOW,
        fetchedAt: NOW,
        dataJson: JSON.stringify({ items: [{ image: { file: protectedSha, thumb: protectedSha } }] }),
      });
    }

    const url = 'https://expiry-eligible.test/photo.jpg';
    const sha = '2'.repeat(64);
    const scope = o.scope.feedPhotos;
    await scope.put({ url, sourceId: 'eligible', fileSha256: sha, thumbSha256: sha, nextCheckAt: 1, createdAt: 1 });

    await sweepFeedPhotos(env.DB, photoBlobs, NOW);

    expect(await scope.get([url])).toEqual([]);
    expect(await scope.deletes()).toContainEqual(expect.objectContaining({ sha256: sha, queuedAt: NOW }));
    expect(await testScope(env.DB, 'expiry-protected-0').feedPhotos.get(['https://expiry-protected.test/0/0.jpg'])).toHaveLength(1);
  });

  it('keeps both polling (5 sources × 10 photos) and cleanup (25 expired rows × 2 hashes) well under Free D1 50-query limits', async () => {
    // 1. Poll 5 RSS sources in one org, each with 10 distinct photo URLs (50 URLs total).
    const answers: Record<string, Answer> = {};
    for (let s = 0; s < 5; s++) {
      const feedUrl = `https://d1-budget-${s}.test/rss`;
      await news(feedUrl);
      answers[feedUrl] = { body: feedOf(10, (i) => `https://cdn.d1-budget-${s}.test/${i}.jpg`) };
    }
    const counter = countingDb(env.DB);
    await poll({ now: NOW, guards: web(answers).guards }, { ...env, DB: counter.db });
    const pollCounts = counter.counts();
    expect(pollCounts.apiCalls).toBeLessThan(25);
    expect(pollCounts.statements).toBeLessThan(40);
    // All 5 sources saved their snapshots and queued their ten, each within its share of the org's day (60 / 5).
    expect(take()).toHaveLength(50);

    // 2. Cleanup of 25 expired rows with 2 distinct hashes each (50 hashes) stays well under 50 D1 queries.
    for (let i = 0; i < 25; i++) {
      const f = `${String(i).padStart(2, '0')}f`.padEnd(64, 'a');
      const t = `${String(i).padStart(2, '0')}t`.padEnd(64, 'b');
      await o.scope.feedPhotos.put({ url: `https://gc-bulk.test/${i}.jpg`, sourceId: 'bulk', fileSha256: f, thumbSha256: t, nextCheckAt: NOW, createdAt: NOW });
    }
    counter.reset();
    const expireAt = NOW + FEED_IMAGE_TTL_MS + 1;
    await sweepFeedPhotos(counter.db, photoBlobs, expireAt);
    expect(counter.counts().apiCalls).toBeLessThan(15);
    expect(counter.counts().statements).toBeLessThan(20);

    counter.reset();
    await sweepFeedPhotos(counter.db, photoBlobs, expireAt + FEED_IMAGE_DELETE_GRACE_MS);
    expect(counter.counts().apiCalls).toBeLessThan(15);
    expect(counter.counts().statements).toBeLessThan(20);
  });

  // Twelve orgs seeded and polled: 8.2 s on CI (run 45070332774), against 0.4 s on a laptop.
  it('keeps a full mixed-source poll within the D1 budget when provider refreshes fail', { timeout: 30_000 }, async () => {
    const fake = fakeProvider();
    const refresh = vi.fn(async () => {
      throw new ProviderError('invalid_grant', 'The provider refused the grant');
    });
    const providers = [];
    for (let i = 0; i < 2; i++) {
      const org = await seedOrg(env.DB, `budget-provider-${i}`);
      extraPollOrgs.add(org.orgId);
      const expiresAt = NOW - 1;
      const credentialsSealed = await sealGrant(
        env,
        { orgId: org.orgId, id: org.connection },
        {
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt,
        },
      );
      await org.scope.connections.update(org.connection, { credentialsSealed, expiresAt });
      await org.scope.dataSources.update(org.dataSource, {
        format: 'provider',
        connectionId: org.connection,
        urlEncrypted: await feedUrlSealer(env).seal({ orgId: org.orgId, id: org.dataSource }, 'rooms'),
        nextPollAt: NOW - 1,
      });
      providers.push(org);
    }

    const answers: Record<string, Answer> = {};
    for (let i = 0; i < 10; i++) {
      const org = await seedOrg(env.DB, `budget-rss-${i}`);
      extraPollOrgs.add(org.orgId);
      await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
      const feed = `https://d1-mixed-${i}.test/rss`;
      await news(feed, { org });
      answers[feed] = { body: feedOf(1, () => `https://d1-mixed-${i}.test/photo.jpg`) };
    }
    const counter = countingDb(env.DB);
    await poll(
      {
        now: NOW,
        guards: web(answers).guards,
        connectors: { adapters: [{ ...fake.adapter, refresh }], fetch: fake.fetch },
      },
      { ...env, DB: counter.db },
    );
    expect(counter.counts().apiCalls).toBeLessThan(50);
    expect(refresh).toHaveBeenCalledTimes(2);
    for (const org of providers) expect(await org.scope.dataSources.get(org.dataSource)).toMatchObject({ failures: 1, lastError: 'needs-reconnect' });
    expect(take()).toHaveLength(4);
  });

  // Twelve orgs and 18,000 old rows, then two crons: 9.1 s on CI (run 45070332774), against 0.5 s on a laptop.
  it('keeps the full midnight cron and the separate feed cleanup within the D1 budget under load', { timeout: 30_000 }, async () => {
    const midnight = Math.ceil(NOW / DAY_MS) * DAY_MS;
    vi.spyOn(Date, 'now').mockReturnValue(midnight);
    const orgs = [];
    const expiredAt = 0;
    for (let i = 0; i < 12; i++) {
      const org = await seedOrg(env.DB, `budget-midnight-${i}`);
      extraPollOrgs.add(org.orgId);
      orgs.push(org);
      await org.scope.dataSources.update(org.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
      await org.scope.screens.update(org.screen, { lastSeenAt: midnight - 60 * MIN, reportedManifestId: 'd'.repeat(64) });
      const event = {
        id: `test-${i}`,
        type: 'test',
        occurredAt: new Date(midnight).toISOString(),
        org: { id: org.orgId, name: org.orgId },
        data: { message: 'test' },
      };
      await org.scope.commit(
        org.scope.alertDeliveries.stage.insert({
          channel: 'email',
          eventId: event.id,
          eventType: event.type,
          eventJson: JSON.stringify(event),
          nextAttemptAt: midnight - 1,
          giveUpAt: midnight,
        }).writes,
      );
      if (i < 3) {
        const url = `https://midnight-gc.test/${i}.jpg`;
        const pending = `https://midnight-gc.test/pending-${i}.jpg`;
        const gc = org.scope.feedPhotos;
        await gc.put({ url, sourceId: org.dataSource, fileSha256: 'a'.repeat(64), thumbSha256: 'a'.repeat(64), nextCheckAt: expiredAt });
        await gc.put({ url: pending, sourceId: org.dataSource, fileSha256: 'b'.repeat(64), thumbSha256: 'b'.repeat(64), nextCheckAt: expiredAt });
        await gc.expire([pending], expiredAt + FEED_IMAGE_TTL_MS + 1);
      }
    }
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9000)
        INSERT INTO audit_log (id, org_id, at, actor_kind, actor_id, action) SELECT 'old-audit-'||x, ?, ?, 'system', 'test', 'test' FROM n`).bind(
        o.orgId,
        midnight - 366 * DAY_MS,
      ),
      env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9000)
        INSERT INTO alert_deliveries (id, org_id, channel, event_id, event_type, event_json, status, next_attempt_at, give_up_at, created_at, updated_at)
        SELECT 'old-delivery-'||x, ?, 'email', 'old-event-'||x, 'test', '{}', 'delivered', 0, 0, ?, 0 FROM n`).bind(o.orgId, midnight - 8 * DAY_MS),
    ]);

    const counter = countingDb(env.DB);
    const runCron = async (cron: string, scheduledTime: number) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime, cron }), { ...env, DB: counter.db }, ctx);
      await waitOnExecutionContext(ctx);
    };
    await runCron('*/5 * * * *', midnight);
    expect(counter.counts().apiCalls).toBeLessThan(50);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE id LIKE 'old-audit-%'").first('n')).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM alert_deliveries WHERE id LIKE 'old-delivery-%'").first('n')).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM alert_deliveries WHERE event_id LIKE 'test-%' AND attempts = 1").first('n')).toBe(12);
    expect((await Promise.all(orgs.map((org) => org.scope.publishes.get(org.publish)))).filter((p) => p?.finishedAt === midnight)).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM screen_incidents WHERE opened_at = ?').bind(midnight).first('n')).toBe(1);
    expect(await orgs[0]!.scope.feedPhotos.get(['https://midnight-gc.test/0.jpg'])).toHaveLength(1);

    counter.reset();
    // The feed photos' sweep runs at half past every hour.
    await runCron('* * * * *', midnight + 30 * MIN);
    expect(counter.counts().apiCalls).toBe(11);
    for (const [i, org] of orgs.slice(0, 3).entries()) {
      expect(await org.scope.feedPhotos.get([`https://midnight-gc.test/${i}.jpg`])).toHaveLength(0);
      expect((await org.scope.feedPhotos.deletes()).map((row) => row.sha256)).toEqual(['a'.repeat(64)]);
    }
  });
});

describe('a photo that may not be stored', () => {
  /** One story naming `url`, polled and its photo queued; the jobs. */
  async function queued(url: string) {
    const feedUrl = `https://refused-${++n}.test/rss`;
    await news(feedUrl);
    await poll({ now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => url) } }).guards });
    return take();
  }

  it('is refused when a redirect, or the host itself, leads to a private address', async () => {
    const hop = 'https://cdn.hop.test/a.jpg';
    const direct = 'https://inside.hop.test/b.jpg';
    const photos = web(
      { [hop]: { status: 302, headers: { location: 'https://router.hop.test/admin.jpg' } }, 'https://router.hop.test/admin.jpg': { body: jpeg(10, 10) } },
      { 'router.hop.test': ['192.168.1.1'], 'inside.hop.test': ['10.1.2.3'] },
    );
    const { images, draws } = imagesStub();
    await consume([...(await queued(hop)), ...(await queued(direct))], { guards: photos.guards, images });
    expect(await row(hop)).toMatchObject({ fileSha256: null, lastError: 'private-address', nextCheckAt: NOW + FAIL_WAIT_MS });
    expect(await row(direct)).toMatchObject({ fileSha256: null, lastError: 'private-address' });
    // The private address was never asked.
    expect(photos.requests.map((r) => r.url)).toEqual([hop]);
    expect(draws).toEqual([]);
  });

  it('tries an http photo once over https, and drops it when that fails', async () => {
    const url = 'http://old.test/a.jpg';
    const photos = web({ 'https://old.test/a.jpg': { status: 503 } });
    const { images } = imagesStub();
    await consume(await queued(url), { guards: photos.guards, images });
    expect(photos.requests.map((r) => r.url)).toEqual(['https://old.test/a.jpg']);
    // A server's error may pass: tried again within the hour, not the day.
    expect(await row(url)).toMatchObject({ fileSha256: null, lastError: 'http-status', nextCheckAt: NOW + RETRY_MS });
    const ok = 'http://old.test/b.jpg';
    await consume(await queued(ok), { guards: web({ 'https://old.test/b.jpg': { body: jpeg(100, 100) } }).guards, images });
    expect(await row(ok)).toMatchObject({ fileSha256: expect.any(String), lastError: null });
  });

  it('is refused unread when it says it is over the limit, and as it is read past the limit when it does not say', async () => {
    const said = 'https://big.test/said.jpg';
    const unsaid = 'https://big.test/unsaid.jpg';
    let pulled = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1_000_000));
        },
      });
    const photos = web({
      [said]: () => ({ body: endless(), headers: { 'content-length': '9000000' } }),
      [unsaid]: () => ({ body: endless() }),
    });
    const { images } = imagesStub();
    await consume(await queued(said), { guards: photos.guards, images });
    expect(pulled).toBeLessThanOrEqual(1);
    await consume(await queued(unsaid), { guards: photos.guards, images });
    expect(pulled).toBeLessThan(12);
    for (const url of [said, unsaid]) expect(await row(url)).toMatchObject({ fileSha256: null, lastError: 'too-large', nextCheckAt: NOW + FAIL_WAIT_MS });
  });

  it('is refused by its bytes whatever its content type says, and an SVG always', async () => {
    const lying = 'https://types.test/a.jpg';
    const svg = 'https://types.test/b.svg';
    const photos = web({
      [lying]: { body: text('<html><script>alert(1)</script></html>'), headers: { 'content-type': 'image/jpeg' } },
      [svg]: { body: text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), headers: { 'content-type': 'image/jpeg' } },
    });
    const { images, draws } = imagesStub();
    await consume([...(await queued(lying)), ...(await queued(svg))], { guards: photos.guards, images });
    expect(await row(lying)).toMatchObject({ fileSha256: null, lastError: 'not-an-image' });
    expect(await row(svg)).toMatchObject({ fileSha256: null, lastError: 'svg' });
    expect(draws).toEqual([]);
  });

  it('is refused when it cannot be decoded, and a failure keeps the last good copy', async () => {
    const url = 'https://decode.test/a.jpg';
    const jobs = await queued(url);
    let body = jpeg(640, 480);
    const photos = web({ [url]: () => ({ body }) });
    const { images } = imagesStub();
    await consume(jobs, { guards: photos.guards, images });
    const good = (await row(url))!;
    expect(good.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    // Changed into something its header passes for and the decoder refuses (640x480 > NEWS_THUMB_BOX, so thumbnail goes through Images).
    body = jpeg(640, 480, 'BROKEN');
    await consume(jobs, { guards: photos.guards, images }, NOW + RECHECK_MS);
    expect(await row(url)).toMatchObject({
      fileSha256: good.fileSha256,
      thumbSha256: good.thumbSha256,
      lastError: 'undecodable',
      nextCheckAt: NOW + RECHECK_MS + FAIL_WAIT_MS,
    });
    // A first fetch that cannot be decoded gives the story no photo.
    const broken = 'https://decode.test/b.jpg';
    await consume(await queued(broken), { guards: web({ [broken]: { body: jpeg(640, 480, 'BROKEN') } }).guards, images });
    expect(await row(broken)).toMatchObject({ fileSha256: null, lastError: 'undecodable' });
  });

  it('is refused when its shape would cost a screen more pixels than it may decode', async () => {
    const url = 'https://strip.test/a.png';
    const { images, draws } = imagesStub();
    await consume(await queued(url), { guards: web({ [url]: { body: png(1000, 20_000) } }).guards, images });
    expect(await row(url)).toMatchObject({ fileSha256: null, lastError: 'too-large' });
    expect(draws).toEqual([]);
  });
});

// #488: a CDN's copy at the screen's size is fetched first, and the feed's own when that copy is refused.
describe("a CDN's copy at the size the screen needs", () => {
  /** A BBC photo of its own, as the feed names it and as its 1920 copy. */
  const bbc = () => {
    const name = `cpsprodpb/cdd4/live/${++n}.jpg`;
    return { feedPhoto: `https://ichef.bbci.co.uk/ace/standard/240/${name}`, copy: `https://ichef.bbci.co.uk/ace/standard/1920/${name}` };
  };

  /** One story naming `feedPhoto`, polled and queued; then the queue drained against `answers`. */
  async function delivered({ feedPhoto }: { feedPhoto: string }, answers: Parameters<typeof web>[0]) {
    const feedUrl = `https://rendition-${++n}.test/rss`;
    await news(feedUrl);
    await poll({ now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => feedPhoto) } }).guards });
    const photos = web(answers);
    const stub = imagesStub();
    const jobs = take();
    await consume(jobs, { guards: photos.guards, images: stub.images });
    return { asked: photos.requests.map((r) => r.url), draws: stub.draws, stored: await row(feedPhoto), jobs };
  }

  /** The photo's recheck, as its weekly poll queues it: each request's URL and the ETag it sent. */
  async function rechecked(jobs: FeedImageJob[], answers: Parameters<typeof web>[0]) {
    const photos = web(answers);
    await consume(jobs, { guards: photos.guards, images: imagesStub().images }, NOW + DAY_MS * 7);
    return photos.requests.map((r) => [r.url, r.headers.get('if-none-match')]);
  }

  /** An answer with ETag `etag`, a 304 to a request that sends it: BBC's, the same for every size of a photo. */
  const tagged = (etag: string, body: Uint8Array) => (req: Request) =>
    req.headers.get('if-none-match') === etag ? { status: 304 } : { body, headers: { etag } };

  it("fetches the CDN's copy and stores it under the feed's URL", async () => {
    const { feedPhoto, copy } = bbc();
    const lead = jpeg(1920, 1080, 'lead');
    const { asked, draws, stored } = await delivered({ feedPhoto }, { [copy]: { body: lead } });
    expect(asked).toEqual([copy]);
    expect(draws).toEqual(['image/jpeg@480x270']);
    expect(stored).toMatchObject({ fileSha256: await sha256Hex(lead), lastError: null });
  });

  it("falls back to the feed's own URL when the CDN refuses the size", async () => {
    const { feedPhoto, copy } = bbc();
    const thumb = jpeg(240, 135, 'small');
    const { asked, draws, stored } = await delivered({ feedPhoto }, { [copy]: { status: 404 }, [feedPhoto]: { body: thumb } });
    expect(asked).toEqual([copy, feedPhoto]);
    expect(draws).toEqual([]);
    expect(stored).toMatchObject({ fileSha256: await sha256Hex(thumb), lastError: null });
  });

  it("falls back when the CDN's copy is not a photo, or will not decode", async () => {
    for (const body of ['<html>gone</html>', jpeg(1920, 1080, 'BROKEN')]) {
      const { feedPhoto, copy } = bbc();
      const thumb = jpeg(240, 135, `small-${n}`);
      const { asked, stored } = await delivered({ feedPhoto }, { [copy]: { body }, [feedPhoto]: { body: thumb } });
      expect(asked).toEqual([copy, feedPhoto]);
      expect(stored).toMatchObject({ fileSha256: await sha256Hex(thumb), lastError: null });
    }
  });

  it("does not fall back on the CDN's own trouble, which passes", async () => {
    const { feedPhoto, copy } = bbc();
    const { asked, stored } = await delivered({ feedPhoto }, { [copy]: { status: 503 }, [feedPhoto]: { body: jpeg(240, 135) } });
    expect(asked).toEqual([copy]);
    expect(stored).toMatchObject({ fileSha256: null, lastError: 'http-status', nextCheckAt: NOW + RETRY_MS });
  });

  // #518: a 429 is the CDN's own trouble, like a 5xx: the copy is asked for again later, not the feed's small photo now.
  it('waits and asks for the copy again after a 429', async () => {
    const { feedPhoto, copy } = bbc();
    const { asked, stored } = await delivered({ feedPhoto }, { [copy]: { status: 429 }, [feedPhoto]: { body: jpeg(240, 135) } });
    expect(asked).toEqual([copy]);
    expect(stored).toMatchObject({ fileSha256: null, lastError: 'http-status', nextCheckAt: NOW + RETRY_MS });
  });

  // #518: a copy over the 8 MB a photo may be loses nothing: the feed's own is stored.
  it('falls back when the copy is too large to fetch', async () => {
    const { feedPhoto, copy } = bbc();
    const thumb = jpeg(240, 135, 'tiny');
    const { asked, stored } = await delivered(
      { feedPhoto },
      { [copy]: { body: jpeg(1920, 1080), headers: { 'content-length': '9000000' } }, [feedPhoto]: { body: thumb } },
    );
    expect(asked).toEqual([copy, feedPhoto]);
    expect(stored).toMatchObject({ fileSha256: await sha256Hex(thumb), lastError: null });
  });

  // #518: a copy Images refuses as too large (9413) falls back too.
  it('falls back when Images refuses the copy as too large', async () => {
    const { feedPhoto, copy } = bbc();
    const thumb = jpeg(240, 135, 'fits');
    const { asked, stored } = await delivered({ feedPhoto }, { [copy]: { body: jpeg(1920, 1080, 'HUGE') }, [feedPhoto]: { body: thumb } });
    expect(asked).toEqual([copy, feedPhoto]);
    expect(stored).toMatchObject({ fileSha256: await sha256Hex(thumb), lastError: null });
  });

  // #518: BBC answers every size of a photo with one ETag, so validators go only to the URL they came from.
  describe('at its recheck', () => {
    it('asks the copy conditionally when the copy is what it holds', async () => {
      const { feedPhoto, copy } = bbc();
      const { jobs } = await delivered({ feedPhoto }, { [copy]: tagged('"e1"', jpeg(1920, 1080, 'held')) });
      expect(await rechecked(jobs, { [copy]: tagged('"e1"', jpeg(1920, 1080, 'held')) })).toEqual([[copy, '"e1"']]);
    });

    it('asks the copy afresh after falling back to the feed’s photo, and keeps the larger one', async () => {
      const { feedPhoto, copy } = bbc();
      const { jobs } = await delivered({ feedPhoto }, { [copy]: { status: 404 }, [feedPhoto]: tagged('"e2"', jpeg(240, 135, 'fell')) });
      const lead = jpeg(1920, 1080, 'back');
      expect(await rechecked(jobs, { [copy]: tagged('"e2"', lead) })).toEqual([[copy, null]]);
      expect(await row(feedPhoto)).toMatchObject({ fileSha256: await sha256Hex(lead), validatedFrom: copy });
    });

    it('asks the copy afresh for a photo stored from the feed’s URL before #512', async () => {
      const { feedPhoto, copy } = bbc();
      const { jobs } = await delivered({ feedPhoto }, { [copy]: { status: 404 }, [feedPhoto]: tagged('"e3"', jpeg(240, 135, 'old')) });
      // As a row written before #512: the feed's 240, with BBC's ETag, and no record of where it came from.
      await env.DB.prepare('UPDATE feed_images SET validated_from = NULL WHERE url = ?').bind(feedPhoto).run();
      const lead = jpeg(1920, 1080, 'new');
      expect(await rechecked(jobs, { [copy]: tagged('"e3"', lead) })).toEqual([[copy, null]]);
      expect(await row(feedPhoto)).toMatchObject({ fileSha256: await sha256Hex(lead), validatedFrom: copy });
    });

    // Review of #520: the feed's 240 would take the place of the 1920 a screen shows.
    it('keeps the copy it holds when the CDN refuses it, and records the refusal', async () => {
      const { feedPhoto, copy } = bbc();
      const lead = jpeg(1920, 1080, 'kept');
      const { jobs } = await delivered({ feedPhoto }, { [copy]: tagged('"e5"', lead) });
      expect(await rechecked(jobs, { [copy]: { status: 404 }, [feedPhoto]: tagged('"e5"', jpeg(240, 135, 'small')) })).toEqual([[copy, '"e5"']]);
      expect(await row(feedPhoto)).toMatchObject({ fileSha256: await sha256Hex(lead), validatedFrom: copy, lastError: 'http-status' });
    });

    it('asks a photo no CDN rewrites conditionally, as before', async () => {
      const url = `https://plain-${++n}.test/a.jpg`;
      const feedUrl = `https://plain-${n}.test/rss`;
      await news(feedUrl);
      await poll({ now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => url) } }).guards });
      const jobs = take();
      await consume(jobs, { guards: web({ [url]: tagged('"e4"', jpeg(800, 450)) }).guards, images: imagesStub().images });
      await env.DB.prepare('UPDATE feed_images SET validated_from = NULL WHERE url = ?').bind(url).run();
      expect(await rechecked(jobs, { [url]: tagged('"e4"', jpeg(800, 450)) })).toEqual([[url, '"e4"']]);
    });
  });

  it("records the feed's failure when both are refused", async () => {
    const { feedPhoto, copy } = bbc();
    const { asked, stored } = await delivered({ feedPhoto }, { [copy]: { status: 404 }, [feedPhoto]: { status: 410 } });
    expect(asked).toEqual([copy, feedPhoto]);
    expect(stored).toMatchObject({ fileSha256: null, lastError: 'http-status', nextCheckAt: NOW + FAIL_WAIT_MS });
  });
});

// #524: a snapshot names only photos stored when its poll saved it, so the last of a poll's new photos to be
// delivered makes the source due at the poller's next run, once, rather than at its next hourly poll.
describe('photos stored after their poll', () => {
  /** A source of three stories, polled at NOW and its photos queued; the photo URLs and their jobs. */
  async function polled() {
    const feedUrl = `https://after-${++n}.test/rss`;
    const id = await news(feedUrl);
    const urls = [0, 1, 2].map((i) => `https://after-${n}.test/${i}.jpg`);
    const feed = web({ [feedUrl]: { body: feedOf(3, (i) => urls[i]) } });
    await poll({ now: NOW, guards: feed.guards });
    const jobs = take();
    expect(jobs.map((j) => j.url).sort()).toEqual([...urls].sort());
    const nextPollAt = async () => (await o.scope.dataSources.get(id))!.nextPollAt;
    return { id, feed, jobs, urls, nextPollAt };
  }
  const answers = (urls: string[]) => Object.fromEntries(urls.map((u, i) => [u, { body: jpeg(640, 360, `p${i}-${n}`) }]));
  const of = (jobs: FeedImageJob[], url: string) => jobs.filter((j) => j.url === url);

  it('re-polls once the last is stored, and its snapshot names them all', async () => {
    const { id, feed, jobs, urls, nextPollAt } = await polled();
    const hourly = await nextPollAt();
    const photos = web(answers(urls));
    const { images } = imagesStub();
    // Two of three stored: the third still waits, so the source is not due yet.
    await consume([...of(jobs, urls[0]!), ...of(jobs, urls[1]!)], { guards: photos.guards, images }, NOW + MIN);
    expect(await nextPollAt()).toBe(hourly);
    await consume(of(jobs, urls[2]!), { guards: photos.guards, images }, NOW + 2 * MIN);
    expect(await nextPollAt()).toBe(NOW + 2 * MIN);
    // The poller's next run reads the feed afresh, and the snapshot names every photo.
    await poll({ now: NOW + 3 * MIN, guards: feed.guards });
    expect((await snapshot(id)).items.map((i) => i.image !== undefined)).toEqual([true, true, true]);
    expect(await nextPollAt()).toBeGreaterThan(NOW + 3 * MIN);
    // Rechecks that change nothing make it due no more.
    const later = await nextPollAt();
    await consume(jobs, { guards: photos.guards, images }, NOW + 4 * MIN);
    expect(await nextPollAt()).toBe(later);
  });

  it('re-polls once the last is delivered, though it failed', async () => {
    const { jobs, urls, nextPollAt } = await polled();
    const hourly = await nextPollAt();
    const photos = web(answers(urls.slice(0, 2)));
    const { images } = imagesStub();
    await consume([...of(jobs, urls[0]!), ...of(jobs, urls[1]!)], { guards: photos.guards, images }, NOW + MIN);
    expect(await nextPollAt()).toBe(hourly);
    // The third answers 404.
    await consume(of(jobs, urls[2]!), { guards: photos.guards, images }, NOW + 2 * MIN);
    expect(await row(urls[2]!)).toMatchObject({ lastError: 'http-status' });
    expect(await nextPollAt()).toBe(NOW + 2 * MIN);
  });

  it('does not re-poll when none of them could be stored', async () => {
    const { jobs, nextPollAt } = await polled();
    const hourly = await nextPollAt();
    await consume(jobs, { guards: web({}).guards, images: imagesStub().images }, NOW + MIN);
    expect(await nextPollAt()).toBe(hourly);
  });
});

describe('photos switched off', () => {
  /** Runs `during` while a poll at `at` is held inside its RSS fetch, then lets the poll finish. */
  async function whilePollFetches(at: number, guards: FetchGuards, during: () => Promise<void>) {
    const fetching = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const inFlight = poll({
      now: at,
      guards: {
        ...guards,
        fetch: async (input, init) => {
          fetching.resolve();
          await resume.promise;
          return guards.fetch(input, init);
        },
      },
    });
    await fetching.promise;
    try {
      await during();
    } finally {
      resume.resolve();
      await inFlight;
    }
  }
  const setPhotos = (dataSourceId: string, photos: boolean) =>
    dispatch(
      registry,
      'save_data_source',
      { dataSourceId, photos },
      {
        org: o.scope,
        role: 'owner',
        actor: { kind: 'user', id: 'photos-switch-test', clientId: 'cms' },
        blobs: env.BLOBS,
        services: { feedUrls: feedUrlSealer(env) },
      },
    );

  it('looks for no photo, queues none, and stores the feed as text', async () => {
    const id = await news('https://quiet.test/rss', { photos: false });
    await poll({
      now: NOW,
      guards: web({ 'https://quiet.test/rss': { body: feedOf(3, (i) => `https://cdn.quiet.test/${i}.jpg`) } }).guards,
    });
    expect(take()).toEqual([]);
    expect(await o.scope.feedPhotos.get(['https://cdn.quiet.test/0.jpg'])).toEqual([]);
    expect(JSON.stringify(await snapshot(id))).not.toMatch(/image|cdn\.quiet/);
  });

  it('keeps the Photos switch reread when an enabled poll was already fetching RSS', async () => {
    const feed = 'https://photos-switch.test/rss';
    const url = 'https://photos-switch.test/photo.jpg';
    const id = await news(feed);
    const rss = web({
      [feed]: (req) =>
        req.headers.get('if-none-match') === '"story"'
          ? { status: 304 }
          : { body: feedOf(1, () => url), headers: { etag: '"story"', 'last-modified': 'Fri, 20 Nov 2026 23:00:00 GMT' } },
    });
    await poll({ now: NOW, guards: rss.guards });
    const initial = await o.scope.dataSources.snapshots([id]);
    await consume(take(), { guards: web({ [url]: { body: jpeg(320, 180, 'switch race') } }).guards, images: imagesStub().images });
    expect((await row(url))?.fileSha256).toBeTruthy();

    const at = NOW + 5 * MIN;
    await whilePollFetches(at, rss.guards, async () => {
      expect(await setPhotos(id, false)).toMatchObject({ ok: true });
    });
    const afterRace = await o.scope.dataSources.get(id);
    const afterSnapshot = await o.scope.dataSources.snapshots([id]);
    await poll({ now: at + 5 * MIN, guards: rss.guards });

    expect((await snapshot(id)).items[0]?.image).toBeUndefined();
    expect(afterSnapshot).toEqual(initial);
    expect(afterRace).toMatchObject({ photos: false, etag: null, lastModified: null, photoUrlsJson: null });
    expect(afterRace?.nextPollAt).toBeLessThanOrEqual(at);
    expect(rss.requests).toHaveLength(3);
    expect(rss.requests[2]?.headers.get('if-none-match')).toBeNull();
    expect(rss.requests[2]?.headers.get('if-modified-since')).toBeNull();
    expect((await o.scope.dataSources.snapshots([id]))[0]?.checkedAt).toBe(at + 5 * MIN);
  });

  it('keeps the forced reread after Photos changes off, on, and off during a disabled poll', async () => {
    const feed = 'https://photos-switch-twice.test/rss';
    const url = 'https://photos-switch-twice.test/photo.jpg';
    const id = await news(feed, { photos: false });
    const sha = await sha256Hex(jpeg(320, 180, 'switch twice'));
    await o.scope.feedPhotos.put({ url, sourceId: id, fileSha256: sha, thumbSha256: sha, nextCheckAt: NOW + RECHECK_MS, createdAt: NOW });
    const body = feedOf(1, () => url);
    await poll({ now: NOW, guards: web({ [feed]: { body, headers: { etag: '"previous"' } } }).guards });
    expect((await snapshot(id)).items[0]?.image).toBeUndefined();

    const rss = web({
      [feed]: (req) =>
        req.headers.get('if-none-match') === '"story"'
          ? { status: 304 }
          : { body, headers: { etag: '"story"', 'last-modified': 'Fri, 20 Nov 2026 23:00:00 GMT' } },
    });
    const at = NOW + 5 * MIN;
    await whilePollFetches(at, rss.guards, async () => {
      expect(await setPhotos(id, true)).toMatchObject({ ok: true });
      await poll({ now: at + MIN, guards: rss.guards });
      expect((await snapshot(id)).items[0]?.image).toEqual({ file: sha, thumb: sha });
      expect(await setPhotos(id, false)).toMatchObject({ ok: true });
    });
    const afterRace = await o.scope.dataSources.get(id);
    const [afterSnapshot] = await o.scope.dataSources.snapshots([id]);
    await poll({ now: at + 5 * MIN, guards: rss.guards });

    expect((await snapshot(id)).items[0]?.image).toBeUndefined();
    expect(afterSnapshot?.checkedAt).toBe(at + MIN);
    expect(afterRace).toMatchObject({ photos: false, etag: null, lastModified: null, photoUrlsJson: null });
    expect(afterRace?.nextPollAt).toBeLessThanOrEqual(at);
    expect(rss.requests).toHaveLength(3);
    expect(rss.requests[1]?.headers.get('if-none-match')).toBe('"previous"');
    expect(rss.requests[2]?.headers.get('if-none-match')).toBeNull();
    expect(rss.requests[2]?.headers.get('if-modified-since')).toBeNull();
  });

  it('stores nothing queued before it was switched off', async () => {
    const id = await news('https://late.test/rss');
    const url = 'https://cdn.late.test/a.jpg';
    await poll({ now: NOW, guards: web({ 'https://late.test/rss': { body: feedOf(1, () => url) } }).guards });
    const jobs = take();
    await o.scope.dataSources.update(id, { photos: false });
    const photos = web({ [url]: { body: jpeg(10, 10) } });
    const { images } = imagesStub();
    expect(await consume(jobs, { guards: photos.guards, images })).toEqual({ acked: [url], retried: [] });
    expect(photos.requests).toEqual([]);
  });
});

describe('two orgs naming the same photo', () => {
  it('each fetch and keep their own copy, in their own storage, with no cross-org sharing', async () => {
    const other = await seedOrg(env.DB, 'photos-other');
    await other.scope.dataSources.update(other.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const url = 'https://cdn.shared.test/a.jpg';
    const body = feedOf(1, () => url);
    const mine = await news('https://shared.test/rss');
    const theirs = await news('https://shared.test/rss', { org: other });
    await poll({ now: NOW, guards: web({ 'https://shared.test/rss': { body } }).guards });
    const jobs = take();
    expect(jobs.map((j) => j.orgId).sort()).toEqual([o.orgId, other.orgId].sort());
    const { images } = imagesStub();
    const bytes = jpeg(800, 450, 'shared');
    await consume(
      jobs.filter((j) => j.orgId === other.orgId),
      { guards: web({ [url]: { body: bytes } }).guards, images },
    );
    const copy = (await row(url, other))!;
    expect(copy.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(photoBlobs.has(feedBlobKey(other.orgId, copy.fileSha256!))).toBe(true);
    // This org fetched nothing yet: it holds no copy, and sees none of the other's.
    expect(await row(url)).toMatchObject({ fileSha256: null });
    expect(photoBlobs.has(feedBlobKey(o.orgId, copy.fileSha256!))).toBe(false);
    for (const [org, id] of [
      [o, mine],
      [other, theirs],
    ] as const) {
      await org.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    }
    await poll({ now: NOW + 5 * MIN, guards: web({ 'https://shared.test/rss': { body } }).guards });
    expect((await snapshot(theirs, other)).items[0]?.image?.file).toBe(copy.fileSha256);
    expect((await snapshot(mine)).items[0]?.image).toBeUndefined();
  });
});

describe('the queue handler', () => {
  it("hands the photos queue's batches to the consumer, under each environment's name, and refuses a queue it does not know", async () => {
    const batchOf = (queue: string, acked: string[]) =>
      ({
        queue,
        messages: [
          {
            id: 'm',
            timestamp: new Date(NOW),
            attempts: 1,
            body: { orgId: o.orgId, sourceId: 'gone', url: 'https://cdn.gone.test/a.jpg' },
            ack: () => acked.push(queue),
            retry: () => {},
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      }) as unknown as MessageBatch<FeedImageJob>;
    const acked: string[] = [];
    // A source deleted since its photo was queued: acked, nothing fetched.
    for (const queue of ['signforge-feed-images', 'signforge-feed-images-prod']) await worker.queue(batchOf(queue, acked), env);
    expect(acked).toEqual(['signforge-feed-images', 'signforge-feed-images-prod']);
    await expect(worker.queue(batchOf('signforge-other', acked), env)).rejects.toThrow('No consumer for queue "signforge-other"');
  });

  it('wires Cloudflare R2 and Queue adapters directly to the bindings', async () => {
    const bytes = jpeg(100, 100, 'r2-adapter');
    const sha = await sha256Hex(bytes);
    const literalKey = `o/${o.orgId}/f/${sha}`;
    expect(feedBlobKey(o.orgId, sha)).toBe(literalKey);
    const r2 = r2PhotoBlobs(env.BLOBS);
    await r2.put(literalKey, bytes, { sha256: sha, contentType: 'image/jpeg' });
    expect(await env.BLOBS.head(literalKey)).not.toBeNull();
    await r2.delete([literalKey]);
    expect(await env.BLOBS.head(literalKey)).toBeNull();

    const batches: { body: FeedImageJob }[][] = [];
    const cfQueue = cfPhotoQueue({ sendBatch: async (batch) => void batches.push([...batch]) });
    await cfQueue.enqueue([]);
    expect(batches).toEqual([]);
    const job = { orgId: o.orgId, sourceId: 'news', url: 'https://adapter.test/a.jpg' };
    await cfQueue.enqueue([job]);
    expect(batches).toEqual([[{ body: job }]]);
  });
});
