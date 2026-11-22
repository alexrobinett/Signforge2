// Stories' photos (#195): the poll looks up and queues them, the queue's consumer fetches, checks
// and stores them. No network and no image service: fetch, DNS and the Images binding are stubs,
// the queue is a list, and the clock is a parameter.
import { MAX_SNAPSHOT_BYTES, type NewsFeed } from '@signforge/contract';
import { FEED_IMAGE_DELETE_GRACE_MS, FEED_IMAGE_TTL_MS } from '@signforge/db';
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
  DELETE_LEASE_MS,
  FAIL_WAIT_MS,
  type FeedImageJob,
  forgetFeedImages,
  HOLD_MS,
  NEW_PER_ORG_PER_DAY,
  NEW_PER_SOURCE_PER_DAY,
  PASS_THROUGH_MAX_BYTES,
  PHOTOS_PER_SOURCE,
  type PhotoDeps,
  RECHECK_MS,
  RETRY_MS,
  sha256Hex,
  storeFeedImages,
} from '../src/data/images';
import { pollDataSources } from '../src/data/poller';
import worker from '../src/index';
import { feedBlobKey, orgBlobKey } from '../src/r2';
import { fakeProvider } from './fake-provider';

const DAY_MS = 24 * 3_600_000;
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
function countingDb(db: D1Database, hooks: { afterRead?: (query: string) => Promise<void>; beforeBatch?: (queries: string[]) => Promise<void> } = {}) {
  let apiCalls = 0;
  let statements = 0;
  const prepared = new WeakMap<D1PreparedStatement, { stmt: D1PreparedStatement; query: string }>();
  const wrapStmt = (stmt: D1PreparedStatement, query: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') {
          return (...args: unknown[]) => wrapStmt(target.bind(...args), query);
        }
        if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
          return async (...args: unknown[]) => {
            apiCalls++;
            statements++;
            const result = await (target[prop] as (...a: unknown[]) => unknown)(...args);
            if (prop !== 'run') await hooks.afterRead?.(query);
            return result;
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });
    prepared.set(proxy, { stmt, query });
    return proxy;
  };
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (query: string) => wrapStmt(target.prepare(query), query);
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          apiCalls++;
          statements += stmts.length;
          await hooks.beforeBatch?.(stmts.map((s) => prepared.get(s)?.query ?? ''));
          return target.batch(stmts.map((s) => prepared.get(s)?.stmt ?? s));
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

// ------------------------------------------------------------------- setup

let o: SeededOrg;
let n = 0;
const photoVersions = new Map<string, string>();
const createdSpots: { orgId: string; id: string }[] = [];
const extraPollOrgs = new Set<string>();
const sent: FeedImageJob[] = [];
/** The poller's env, with the photos queue a list. */
const pollEnv = {
  ...env,
  FEED_IMAGES: { sendBatch: async (batch: { body: FeedImageJob }[]) => void sent.push(...batch.map((m) => m.body)) },
} as unknown as Env;

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
const take = () => sent.splice(0);

/** Run the consumer on these jobs at `at`; the messages it acked and retried. */
async function consume(
  jobs: FeedImageJob[],
  deps: Omit<PhotoDeps, 'now'>,
  at = NOW,
  { attempts = 1, customEnv = env }: { attempts?: number; customEnv?: Env } = {},
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
  await storeFeedImages(batch, customEnv, { ...deps, now: at });
  return { acked, retried };
}

const snapshot = async (id: string, org = o): Promise<NewsFeed> => JSON.parse((await org.scope.dataSources.snapshots([id]))[0]!.dataJson);
const row = async (url: string, org = o) => (await org.scope.feedImages.get([url]))[0];

beforeAll(async () => {
  o = await seedOrg(env.DB, 'photos-org');
  await o.scope.dataSources.update(o.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
});

// Move the clock forward 30 days before each test so daily budgets and holds from earlier tests never interfere.
beforeEach(() => {
  NOW += 30 * DAY_MS;
  take();
});

// Only a test's own sources and spots are active in it.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const org of [o.orgId, 'photos-other', ...extraPollOrgs])
    for (const d of await testScope(env.DB, org).dataSources.list())
      await testScope(env.DB, org).dataSources.update(d.id, { nextPollAt: Number.MAX_SAFE_INTEGER });
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
    await pollDataSources(pollEnv, { now: NOW, guards: feed.guards });
    // At most PHOTOS_PER_SOURCE per source: a screen shows no more.
    expect(take().map((j) => j.url)).toEqual(Array.from({ length: PHOTOS_PER_SOURCE }, (_, i) => photo(i)));
    expect((await snapshot(id)).items.some((i) => i.image)).toBe(false);
    expect(await row(photo(0))).toMatchObject({ fileSha256: null, nextCheckAt: NOW + HOLD_MS });

    // Polled again before they are stored: held, so not queued twice.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN, etag: null });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: feed.guards });
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
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, stored.fileSha256!))).not.toBeNull();
    // Read afresh next time, so a 304 cannot leave the snapshot without them.
    expect(await o.scope.dataSources.get(id)).toMatchObject({ etag: null });

    await o.scope.dataSources.update(id, { nextPollAt: NOW + 10 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 10 * MIN, guards: feed.guards });
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
      await pollDataSources(pollEnv, { now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => url) } }).guards });
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
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://long.test/rss': { body } }).guards });
    const jobs = take();
    const { images } = imagesStub();
    await consume(jobs, { guards: web(Object.fromEntries(jobs.map((j, i) => [j.url, { body: jpeg(320, 180, `l${i}`) }]))).guards, images });
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: web({ 'https://long.test/rss': { body } }).guards });
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
    await pollDataSources(pollEnv, { now: NOW, guards: rss.guards });
    const { images, draws } = imagesStub();
    let answer: Answer = { body: png(800, 600), headers: { etag: '"img1"', 'last-modified': 'Thu, 19 Nov 2026 08:00:00 GMT' } };
    const photos = web({ [url]: () => answer });
    await consume(take(), { guards: photos.guards, images });
    const first = (await row(url))!;
    // A PNG becomes a WebP; one larger than NEWS_THUMB_BOX also makes a thumbnail.
    expect(draws).toEqual(['image/webp@800x600', 'image/webp@480x360']);

    // Poll once to populate snapshot and restore RSS ETag '"rss-v1"'.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: rss.guards });
    expect((await o.scope.dataSources.get(id))?.etag).toBe('"rss-v1"');

    // Not due within the week: RSS returns 304 and poll queues nothing.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + DAY_MS });
    await pollDataSources(pollEnv, { now: NOW + DAY_MS, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"rss-v1"');
    expect(take()).toEqual([]);

    // A week later, RSS STILL returns 304 (etag never manually cleared!), yet photo revalidation is queued.
    const later = NOW + RECHECK_MS;
    await o.scope.dataSources.update(id, { nextPollAt: later });
    await pollDataSources(pollEnv, { now: later, guards: rss.guards });
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

    // 1. Initial 200 poll saves snapshot + ETag + photoUrlsJson, but queue sendBatch fails.
    const brokenQueueEnv = { ...env, FEED_IMAGES: { sendBatch: async () => Promise.reject(new Error('queue down')) } } as unknown as Env;
    await pollDataSources(brokenQueueEnv, { now: NOW, guards: rss.guards });
    expect((await o.scope.dataSources.get(id))?.etag).toBe('"r304"');
    expect(consoleErr).toHaveBeenCalled();

    // 2. Once the hold expires, RSS returns 304 and the poller still retries enqueueing the photo.
    const t1 = NOW + HOLD_MS;
    await o.scope.dataSources.update(id, { nextPollAt: t1 });
    await pollDataSources(pollEnv, { now: t1, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"r304"');
    const retryJobs = take();
    expect(retryJobs.map((j) => j.url)).toEqual([url]);

    // 3. Consumer gets 503 -> backs off RETRY_MS (1h). Before 1h, 304 poll queues nothing.
    const { images } = imagesStub();
    await consume(retryJobs, { guards: web({ [url]: { status: 503 } }).guards, images }, t1);
    await o.scope.dataSources.update(id, { nextPollAt: t1 + 10 * MIN });
    await pollDataSources(pollEnv, { now: t1 + 10 * MIN, guards: rss.guards });
    expect(take()).toEqual([]);

    // 4. At 1h backoff, RSS STILL returns 304 and the poller queues the retry; consumer succeeds and marks source readAfresh.
    const t2 = t1 + RETRY_MS;
    await o.scope.dataSources.update(id, { nextPollAt: t2 });
    await pollDataSources(pollEnv, { now: t2, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"r304"');
    const secondTry = take();
    expect(secondTry.map((j) => j.url)).toEqual([url]);
    await consume(secondTry, { guards: web({ [url]: { body: jpeg(320, 180, 'recovered') } }).guards, images }, t2);
    expect((await o.scope.dataSources.get(id))?.etag).toBeNull();

    // 5. Next poll fetches 200 and writes the recovered photo into the snapshot.
    await o.scope.dataSources.update(id, { nextPollAt: t2 + 5 * MIN });
    await pollDataSources(pollEnv, { now: t2 + 5 * MIN, guards: rss.guards });
    expect((await snapshot(id)).items[0]?.image?.file).toBe((await row(url))!.fileSha256);
  });

  it('keeps photo invalidation when an in-flight RSS poll saves a snapshot built without the photo', async () => {
    const feed = 'https://in-flight.test/rss';
    const url = 'https://in-flight.test/photo.jpg';
    const id = await news(feed);
    const body = feedOf(1, () => url);
    const rss = web({
      [feed]: (req) => (req.headers.has('if-none-match') && rss.requests.length > 2 ? { status: 304 } : { body, headers: { etag: '"rss"' } }),
    });
    await pollDataSources(pollEnv, { now: NOW, guards: rss.guards });
    const jobs = take();
    const at = NOW + 5 * MIN;
    const bytes = jpeg(320, 180, 'in-flight');
    const sha = await sha256Hex(bytes);
    const counter = countingDb(env.DB, {
      afterRead: async (query) => {
        if (query.startsWith('select ') && query.includes('from "feed_images"')) {
          expect(await consume(jobs, { guards: web({ [url]: { body: bytes } }).guards, images: imagesStub().images }, at)).toEqual({
            acked: [url],
            retried: [],
          });
          expect((await o.scope.dataSources.get(id))?.etag).toBeNull();
        }
      },
    });
    await pollDataSources({ ...pollEnv, DB: counter.db }, { now: at, guards: rss.guards });
    expect((await snapshot(id)).items[0]?.image).toBeUndefined();
    expect(await o.scope.dataSources.get(id)).toMatchObject({ etag: null, lastModified: null, nextPollAt: at });
    await pollDataSources(pollEnv, { now: at + MIN, guards: rss.guards });
    expect(rss.requests).toHaveLength(3);
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBeNull();
    expect((await snapshot(id)).items[0]?.image).toEqual({ file: sha, thumb: sha });
  });

  it('attaches a first-seen photo stored by another source while the RSS poll was in flight', async () => {
    const feedA = 'https://first-shared.test/owner.rss';
    const feedB = 'https://first-shared.test/reader.rss';
    const url = 'https://first-shared.test/photo.jpg';
    const owner = await news(feedA);
    const body = feedOf(1, () => url);
    await pollDataSources(pollEnv, { now: NOW, guards: web({ [feedA]: { body } }).guards });
    const jobs = take();
    expect(jobs).toEqual([{ orgId: o.orgId, sourceId: owner, url }]);

    const at = NOW + MIN;
    const reader = await news(feedB, { at });
    const rss = web({
      [feedA]: { body },
      [feedB]: (req) => (req.headers.has('if-none-match') ? { status: 304 } : { body, headers: { etag: '"first-shared"' } }),
    });
    const bytes = jpeg(320, 180, 'shared first appearance');
    const sha = await sha256Hex(bytes);
    let delivered = false;
    const counter = countingDb(env.DB, {
      afterRead: async (query) => {
        if (!delivered && query.startsWith('select ') && query.includes('from "feed_images"')) {
          const result = await consume(jobs, { guards: web({ [url]: { body: bytes } }).guards, images: imagesStub().images }, at);
          delivered = result.acked.includes(url);
        }
      },
    });
    await pollDataSources({ ...pollEnv, DB: counter.db }, { now: at, guards: rss.guards });
    expect(delivered).toBe(true);
    expect((await snapshot(reader)).items[0]?.image).toBeUndefined();
    const saved = await o.scope.dataSources.get(reader);
    expect(saved?.photoGeneration).toBe(0);

    await pollDataSources(pollEnv, { now: at + 5 * MIN, guards: rss.guards });
    const readerRequests = rss.requests.filter((req) => req.url === feedB);
    expect(readerRequests).toHaveLength(2);
    expect(readerRequests.at(-1)?.headers.get('if-none-match')).toBeNull();
    expect(saved?.nextPollAt).toBeLessThanOrEqual(at);
    expect((await snapshot(reader)).items[0]?.image).toEqual({ file: sha, thumb: sha });
  });

  it('repairs a snapshot missing an already-stored photo when its weekly recheck returns 304', async () => {
    const feed = 'https://repair-304.test/rss';
    const url = 'https://repair-304.test/photo.jpg';
    const id = await news(feed);
    const body = feedOf(1, () => url);
    const rss = web({ [feed]: (req) => (req.headers.has('if-none-match') ? { status: 304 } : { body, headers: { etag: '"rss"' } }) });
    await pollDataSources(pollEnv, { now: NOW, guards: rss.guards });
    const bytes = jpeg(320, 180, 'repair');
    await consume(take(), { guards: web({ [url]: { body: bytes, headers: { etag: '"photo"' } } }).guards, images: imagesStub().images });
    // An older poller could leave an RSS validator on a snapshot that never got the stored copy.
    const at = NOW + RECHECK_MS;
    await o.scope.dataSources.update(id, { etag: '"rss"', nextPollAt: at, photoUrlsJson: JSON.stringify([url]) });
    expect((await snapshot(id)).items[0]?.image).toBeUndefined();
    await pollDataSources(pollEnv, { now: at, guards: rss.guards });
    const photo = web({ [url]: { status: 304 } });
    const jobs = take();
    expect(jobs.map((job) => job.url)).toEqual([url]);
    await consume(jobs, { guards: photo.guards, images: imagesStub().images }, at);
    expect(photo.requests[0]?.headers.get('if-none-match')).toBe('"photo"');
    await pollDataSources(pollEnv, { now: at + 5 * MIN, guards: rss.guards });
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
    await pollDataSources(pollEnv, { now: NOW, guards: rss.guards });
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
    await pollDataSources(pollEnv, { now: fullAt, guards: rss.guards });
    const stale = await snapshot(id);
    expect(stale.items.map((item) => item.image)).toEqual([copy, copy]);
    delete stale.items[1]?.image;
    await o.scope.dataSources.putSnapshot(id, { version: 'stale', fetchedAt: fullAt, checkedAt: fullAt, dataJson: JSON.stringify(stale) });

    const at = NOW + RECHECK_MS;
    await pollDataSources(pollEnv, { now: at, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBe('"rss"');
    const jobs = take();
    expect(jobs.map((job) => job.url).sort()).toEqual(urls);
    await consume(jobs, { guards: photos.guards, images }, at);
    expect(photos.requests.slice(-2).map((req) => req.headers.get('if-none-match'))).toEqual(['"photo"', '"photo"']);
    await pollDataSources(pollEnv, { now: at + 5 * MIN, guards: rss.guards });
    expect((await snapshot(id)).items.map((item) => item.image)).toEqual([copy, copy]);
  });

  it('dedupes by content hash across URLs in the same org with no transform or new blob', async () => {
    const id = await news('https://dedupe.test/rss');
    const url1 = 'https://cdn.dedupe.test/a.jpg?v=1';
    const url2 = 'https://cdn.dedupe.test/a.jpg?v=2';
    const bytes = jpeg(3000, 2000, 'same-photo');
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://dedupe.test/rss': { body: feedOf(1, () => url1) } }).guards });
    const stub1 = imagesStub();
    await consume(take(), { guards: web({ [url1]: { body: bytes } }).guards, images: stub1.images });
    expect(stub1.draws).toEqual(['image/jpeg@1920x1280', 'image/jpeg@480x320']);
    const first = (await row(url1))!;

    // Another URL in the same org serves the exact same bytes: 0 Images calls, 0 R2 puts, same hashes, source read afresh.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN, etag: '"kept"' });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: web({ 'https://dedupe.test/rss': { body: feedOf(1, () => url2) } }).guards });
    const stub2 = imagesStub();
    const putSpy = vi.spyOn(env.BLOBS, 'put');
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
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://avif.test/rss': { body: feedOf(1, () => url) } }).guards });
    const { images, draws } = imagesStub();
    await consume(take(), { guards: web({ [url]: { body: avif() } }).guards, images });
    expect(draws).toEqual(['image/webp@1920x1280', 'image/webp@480x320']);
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
    await pollDataSources(pollEnv, { now: NOW, guards: rss.guards });
    expect((await o.scope.dataSources.get(unboundId))?.etag).toBe('"b1"');
    expect(take()).toEqual([]);
    expect(await row(photo)).toBeUndefined();

    // 2. Draft spot binding a photo template, not published: RSS returns 304, still skipped.
    const draftSpotId = await bindSpot(o, unboundId, { publish: false });
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 5 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: rss.guards });
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
    await pollDataSources(pollEnv, { now: NOW + 10 * MIN, guards: rss.guards });
    expect(take()).toEqual([]);

    // 4. Publishing the photo-capable spot without clearing the RSS ETag: poller omits validators once (photoUrlsJson is null) and queues the photo.
    const draftSpot = (await o.scope.spots.get(draftSpotId))!;
    await o.scope.commit(o.scope.spots.stage.publish(draftSpot).writes);
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 15 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 15 * MIN, guards: rss.guards });
    expect(rss.requests.at(-1)?.headers.get('if-none-match')).toBeNull();
    expect(take().map((j) => j.url)).toEqual([photo]);

    // 5. Removing the photo spot (leaving only the text-only spot) stops photo work again at the next poll.
    await o.scope.spots.delete(draftSpotId);
    const photo2 = 'https://cdn.bound.test/next.jpg';
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 20 * MIN, etag: null });
    await pollDataSources(pollEnv, { now: NOW + 20 * MIN, guards: web({ 'https://unbound.test/rss': { body: feedOf(1, () => photo2) } }).guards });
    expect(take()).toEqual([]);
    expect(await row(photo2)).toBeUndefined();
    await o.scope.spots.delete(textOnlySpotId);
  });
});

describe('budgets, resilience and cleanup', () => {
  it('caps new photos per source per day and per org per day, resuming the next day', async () => {
    const s1 = await news('https://b1.test/rss');
    const s2 = await news('https://b2.test/rss');
    const s3 = await news('https://b3.test/rss');

    // Source 1 queues NEW_PER_SOURCE_PER_DAY (10); more new URLs on source 1 the same day are skipped.
    await pollDataSources(pollEnv, {
      now: NOW,
      guards: web({
        'https://b1.test/rss': { body: feedOf(12, (i) => `https://cdn.b1.test/day1-${i}.jpg`) },
        'https://b2.test/rss': { body: feedOf(10, (i) => `https://cdn.b2.test/day1-${i}.jpg`) },
        'https://b3.test/rss': { body: feedOf(5, (i) => `https://cdn.b3.test/day1-${i}.jpg`) },
      }).guards,
    });
    const first = take();
    // s1 + s2 hit NEW_PER_ORG_PER_DAY (20); s3 gets 0.
    expect(first).toHaveLength(NEW_PER_ORG_PER_DAY);
    expect(first.filter((j) => j.sourceId === s1).length).toBeLessThanOrEqual(NEW_PER_SOURCE_PER_DAY);
    expect(first.filter((j) => j.sourceId === s2).length).toBeLessThanOrEqual(NEW_PER_SOURCE_PER_DAY);

    // Another new URL on s1 the same day is refused by both caps.
    await o.scope.dataSources.update(s1, { nextPollAt: NOW + 5 * MIN, etag: null });
    await pollDataSources(pollEnv, {
      now: NOW + 5 * MIN,
      guards: web({ 'https://b1.test/rss': { body: feedOf(1, () => 'https://cdn.b1.test/extra.jpg') } }).guards,
    });
    expect(take()).toEqual([]);

    // 24 hours later, the budget resets and s3 can queue its photos.
    await o.scope.dataSources.update(s3, { nextPollAt: NOW + DAY_MS + 1, etag: null });
    await pollDataSources(pollEnv, {
      now: NOW + DAY_MS + 1,
      guards: web({ 'https://b3.test/rss': { body: feedOf(3, (i) => `https://cdn.b3.test/day2-${i}.jpg`) } }).guards,
    });
    expect(take()).toHaveLength(3);
  });

  it('saves headlines even when the photos queue rejects sendBatch', async () => {
    const id = await news('https://queue-down.test/rss');
    const url = 'https://cdn.queue-down.test/a.jpg';
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenEnv = {
      ...env,
      FEED_IMAGES: { sendBatch: async () => Promise.reject(new Error('queue quota exceeded')) },
    } as unknown as Env;
    await pollDataSources(brokenEnv, { now: NOW, guards: web({ 'https://queue-down.test/rss': { body: feedOf(1, () => url) } }).guards });
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
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://too-big.test/rss': { body: bigFeed } }).guards });
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
      bindings: { count: { source: unfitId, path: 'title' }, items: { source: unfitId, path: 'items' } },
      publish: true,
    });
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://unfit.test/rss': { body: feedOf(1, () => 'https://cdn.unfit.test/0.jpg') } }).guards });
    expect(await o.scope.dataSources.get(unfitId)).toMatchObject({ failures: 1, lastError: 'unfit' });
    expect(take()).toEqual([]);
    expect(await row('https://cdn.unfit.test/0.jpg')).toBeUndefined();
  });

  it('grows backoff for passing failures up to 24h, puts 4xx and blocked-address in the 24h group, and classifies Images errors', async () => {
    const queueOne = async (url: string) => {
      const feedUrl = `https://err-${++n}.test/rss`;
      await news(feedUrl);
      await pollDataSources(pollEnv, { now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => url) } }).guards });
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
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://internal.test/rss': { body: feedOf(1, () => url) } }).guards });
    const jobs = take();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const brokenBlobsEnv = {
      ...env,
      BLOBS: { ...env.BLOBS, put: async () => Promise.reject(new Error('R2 down')) },
    } as unknown as Env;
    const deps = { guards: web({ [url]: { body: jpeg(320, 180, 'r2fail') } }).guards, images: imagesStub().images };

    expect(await consume(jobs, deps, NOW, { attempts: 1, customEnv: brokenBlobsEnv })).toEqual({ acked: [], retried: [url] });
    expect(await consume(jobs, deps, NOW, { attempts: 2, customEnv: brokenBlobsEnv })).toEqual({ acked: [], retried: [url] });
    expect(await row(url)).toMatchObject({ lastError: null, failures: 0 });
    expect(await consume(jobs, deps, NOW, { attempts: 3, customEnv: brokenBlobsEnv })).toEqual({ acked: [url], retried: [] });
    expect(await row(url)).toMatchObject({ lastError: 'internal', failures: 1, nextCheckAt: NOW + RETRY_MS });
    expect(consoleErr).toHaveBeenCalled();
  });

  it('forgets expired unreferenced rows, deletes feed blobs after the grace window, and never touches an /admin manifest blob with the same hash', async () => {
    const id = await news('https://gc.test/rss');
    const dropUrl = 'https://cdn.gc.test/drop.jpg';
    const keepUrl = 'https://cdn.gc.test/keep.jpg';
    const dropBytes = jpeg(320, 180, 'drop-shared-with-manifest');
    await pollDataSources(pollEnv, {
      now: NOW,
      guards: web({ 'https://gc.test/rss': { body: feedOf(2, (i) => (i === 0 ? dropUrl : keepUrl)) } }).guards,
    });
    const jobs = take();
    const { images } = imagesStub();
    await consume(jobs, { guards: web({ [dropUrl]: { body: dropBytes }, [keepUrl]: { body: jpeg(320, 180, 'keep') } }).guards, images }, NOW);
    const dropSha = (await row(dropUrl))!.fileSha256!;
    const keepSha = (await row(keepUrl))!.fileSha256!;
    // Simulate a published /admin manifest holding the exact same content hash at orgBlobKey (no assets row).
    await env.BLOBS.put(orgBlobKey(o.orgId, dropSha), dropBytes, { sha256: dropSha, httpMetadata: { contentType: 'image/jpeg' } });

    // Next poll writes a snapshot naming only keepUrl (dropUrl has dropped off the feed).
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN, etag: null });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: web({ 'https://gc.test/rss': { body: feedOf(1, () => keepUrl) } }).guards });
    expect((await snapshot(id)).items[0]?.image?.file).toBe(keepSha);

    // Phase 1 at cleanupAt: forgets dropUrl and queues dropSha durably in feed_image_deletes (kept in R2 during grace window).
    const cleanupAt = NOW + RECHECK_MS + FEED_IMAGE_TTL_MS + 1;
    expect(await forgetFeedImages(env, cleanupAt)).toBeGreaterThanOrEqual(1);
    expect(await row(dropUrl)).toBeUndefined();
    expect((await o.scope.feedImages.pendingDeletes()).map((d) => d.sha256)).toContain(dropSha);
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, dropSha))).not.toBeNull();

    // Phase 2 after FEED_IMAGE_DELETE_GRACE_MS: deletes feed blob o/<org>/f/<dropSha>, keeps snapshot-referenced keepSha AND keeps /admin manifest blob o/<org>/b/<dropSha>.
    const drainAt = cleanupAt + FEED_IMAGE_DELETE_GRACE_MS;
    await forgetFeedImages(env, drainAt);
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, dropSha))).toBeNull();
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, dropSha))).not.toBeNull();
    expect((await o.scope.feedImages.pendingDeletes()).map((d) => d.sha256)).not.toContain(dropSha);
    expect(await row(keepUrl)).toBeDefined();
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, keepSha))).not.toBeNull();
  });

  it('queues replaced blobs for cleanup when a recheck replaces a photo at the same URL, and retries failed R2 deletes cleanly', async () => {
    const id = await news('https://replace.test/rss');
    const url = 'https://cdn.replace.test/hero.jpg';
    const body = feedOf(1, () => url);
    let photoBody = jpeg(800, 600, 'version-1');
    const photos = web({ [url]: () => ({ body: photoBody }) });
    const { images } = imagesStub();

    // 1. Fetch and store version 1 (800x600 -> distinct file and thumb blobs).
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://replace.test/rss': { body } }).guards });
    await consume(take(), { guards: photos.guards, images }, NOW);
    const v1 = (await row(url))!;
    expect(v1.fileSha256).not.toBe(v1.thumbSha256);
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, v1.fileSha256!))).not.toBeNull();
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, v1.thumbSha256!))).not.toBeNull();

    // 2. Recheck a week later serves version 2 (different aspect ratio so both file and thumb hashes change): old file & thumb are queued durably in feed_image_deletes.
    const later = NOW + RECHECK_MS;
    photoBody = jpeg(900, 500, 'version-2');
    await o.scope.dataSources.update(id, { nextPollAt: later });
    await pollDataSources(pollEnv, { now: later, guards: web({ 'https://replace.test/rss': { body } }).guards });
    await consume(take(), { guards: photos.guards, images }, later);
    const v2 = (await row(url))!;
    expect(v2.fileSha256).not.toBe(v1.fileSha256);
    expect(v2.thumbSha256).not.toBe(v1.thumbSha256);
    expect((await o.scope.feedImages.pendingDeletes()).map((d) => d.sha256)).toEqual(expect.arrayContaining([v1.fileSha256!, v1.thumbSha256!]));

    // While the snapshot still references v1 (before the next poll refreshes it to v2), cleanup keeps both v1 blobs AND keeps them durably queued.
    const beforeRefreshAt = later + FEED_IMAGE_DELETE_GRACE_MS;
    await forgetFeedImages(env, beforeRefreshAt);
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, v1.fileSha256!))).not.toBeNull();
    expect((await o.scope.feedImages.pendingDeletes()).map((d) => d.sha256)).toEqual(expect.arrayContaining([v1.fileSha256!, v1.thumbSha256!]));

    // Next poll updates the snapshot to v2, dropping v1 from snapshots.
    await o.scope.dataSources.update(id, { nextPollAt: beforeRefreshAt + 5 * MIN });
    await pollDataSources(pollEnv, { now: beforeRefreshAt + 5 * MIN, guards: web({ 'https://replace.test/rss': { body } }).guards });
    expect((await snapshot(id)).items[0]?.image?.file).toBe(v2.fileSha256);

    // 3. Failing R2 delete keeps the durable delete record intact, and after DELETE_LEASE_MS the next cleanup retries and succeeds.
    const drainAt = beforeRefreshAt + FEED_IMAGE_DELETE_GRACE_MS;
    const failingBlobsEnv = {
      ...env,
      BLOBS: { ...env.BLOBS, delete: async () => Promise.reject(new Error('R2 delete failed')) },
    } as unknown as Env;
    await expect(forgetFeedImages(failingBlobsEnv, drainAt)).rejects.toThrow('R2 delete failed');
    // Old blobs and their durable delete records survive the failed R2 delete.
    expect((await o.scope.feedImages.pendingDeletes()).map((d) => d.sha256)).toEqual(expect.arrayContaining([v1.fileSha256!, v1.thumbSha256!]));
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, v1.fileSha256!))).not.toBeNull();

    // While leased, a consumer writing the same hash retries rather than racing R2 delete.
    const racingUrl = 'https://cdn.replace.test/racing.jpg';
    await o.scope.feedImages.hold([racingUrl], { until: drainAt + HOLD_MS, now: drainAt, sourceId: id });
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const race = await consume(
      [{ orgId: o.orgId, sourceId: id, url: racingUrl }],
      { guards: web({ [racingUrl]: { body: jpeg(800, 600, 'version-1') } }).guards, images },
      drainAt + 1_000,
    );
    expect(race).toEqual({ acked: [], retried: [racingUrl] });
    expect(consoleErr).toHaveBeenCalled();

    // Once DELETE_LEASE_MS passes, cleanup retries R2 delete cleanly and removes old blobs + durable records while keeping v2.
    await forgetFeedImages(env, drainAt + DELETE_LEASE_MS);
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, v1.fileSha256!))).toBeNull();
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, v1.thumbSha256!))).toBeNull();
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, v2.fileSha256!))).not.toBeNull();
    expect((await o.scope.feedImages.pendingDeletes()).map((d) => d.sha256)).not.toContain(v1.fileSha256);
  });

  it('queues the copy displaced by overlapping deliveries and keeps duplicate deliveries idempotent', async () => {
    const id = await news('https://overlap.test/rss', { bind: false });
    const url = 'https://overlap.test/photo.jpg';
    const jobs = [{ orgId: o.orgId, sourceId: id, url }];
    await o.scope.feedImages.hold([url], { until: NOW + HOLD_MS, now: NOW, sourceId: id });
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
    const pending = () => o.scope.feedImages.pendingDeletes();
    const deletions = await pending();
    expect(deletions.map((d) => d.sha256)).toEqual(expect.arrayContaining(shas.slice(0, 2)));
    expect(deletions.map((d) => d.sha256)).not.toContain(shas[2]);
    expect(await consume(jobs, { guards: web({ [url]: { body: c } }).guards, images }, NOW + RECHECK_MS + 1)).toEqual({ acked: [url], retried: [] });
    expect(await pending()).toEqual(deletions);
    await forgetFeedImages(env, NOW + RECHECK_MS + FEED_IMAGE_DELETE_GRACE_MS);
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, shas[1]!))).toBeNull();
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, shas[2]!))).not.toBeNull();
  });

  it('leaves freshly requeued and newly snapshot-referenced blobs in R2 when cleanup already scanned them', async () => {
    const id = await news('https://claim-race.test/rss', { bind: false });
    const urls = ['https://claim-race.test/requeued.jpg', 'https://claim-race.test/snapshot.jpg'];
    const bytes = urls.map((url) => jpeg(320, 180, url));
    const [requeued, referenced] = await Promise.all(bytes.map(sha256Hex));
    const scope = o.scope.feedImages;
    const at = NOW + FEED_IMAGE_DELETE_GRACE_MS;
    for (const [i, url] of urls.entries()) {
      const sha = [requeued, referenced][i]!;
      await env.BLOBS.put(feedBlobKey(o.orgId, sha), bytes[i]!);
      await scope.hold([url], { until: NOW, now: NOW, sourceId: id });
      await scope.save(url, { fileSha256: sha, thumbSha256: sha, nextCheckAt: NOW - FEED_IMAGE_TTL_MS - 1 });
      await scope.forget([url], NOW);
    }

    let requeuedAfterScan = false;
    let wroteSnapshot = false;
    const counter = countingDb(env.DB, {
      afterRead: async (query) => {
        if (!requeuedAfterScan && query.includes('from "feed_image_deletes"')) {
          requeuedAfterScan = true;
          await env.DB.prepare('UPDATE feed_image_deletes SET queued_at = ? WHERE org_id = ? AND sha256 = ?').bind(at, o.orgId, requeued).run();
        }
      },
      beforeBatch: async (queries) => {
        if (!wroteSnapshot && queries.some((q) => q.startsWith('update "feed_image_deletes"') && q.includes('returning'))) {
          wroteSnapshot = true;
          await o.scope.dataSources.putSnapshot(id, {
            version: 'claim-race',
            checkedAt: at,
            fetchedAt: at,
            dataJson: JSON.stringify({ items: [{ image: { file: referenced, thumb: referenced } }] }),
          });
        }
      },
    });
    await forgetFeedImages({ DB: counter.db, BLOBS: env.BLOBS }, at);
    expect(requeuedAfterScan).toBe(true);
    expect(wroteSnapshot).toBe(true);
    for (const sha of [requeued!, referenced!]) {
      expect(await env.BLOBS.head(feedBlobKey(o.orgId, sha))).not.toBeNull();
      expect(await scope.pendingDeletes()).toContainEqual(expect.objectContaining({ sha256: sha, deletingUntil: 0 }));
    }
  });

  it('keeps a refreshed replacement and a newly snapshot-referenced row when expiry already scanned them', async () => {
    const id = await news('https://expiry-race.test/rss', { bind: false });
    const url = 'https://expiry-race.test/replaced.jpg';
    const shown = 'https://expiry-race.test/shown.jpg';
    const jobs = [url, shown].map((photo) => ({ orgId: o.orgId, sourceId: id, url: photo }));
    const initial = 0;
    const scope = o.scope.feedImages;
    await scope.hold([url, shown], { until: initial + HOLD_MS, now: initial, sourceId: id });
    const a = jpeg(320, 180, 'expiry old');
    const b = jpeg(320, 180, 'expiry replacement');
    const c = jpeg(320, 180, 'expiry new snapshot');
    const [oldSha, newSha, shownSha] = await Promise.all([a, b, c].map(sha256Hex));
    const { images } = imagesStub();
    await consume(jobs, { guards: web({ [url]: { body: a }, [shown]: { body: c } }).guards, images }, initial);

    let raced = false;
    const counter = countingDb(env.DB, {
      beforeBatch: async (queries) => {
        if (!raced && queries.some((q) => q.startsWith('delete from "feed_images"'))) {
          raced = true;
          expect(
            await scope.holdWithinBudget(id, {
              again: [url],
              fresh: [],
              until: NOW + HOLD_MS,
              now: NOW,
              since: NOW - DAY_MS,
              maxSource: 10,
              maxOrg: 20,
            }),
          ).toEqual([url]);
          const result = await consume([jobs[0]!], { guards: web({ [url]: { body: b } }).guards, images }, NOW);
          expect(result).toEqual({ acked: [url], retried: [] });
          await o.scope.dataSources.putSnapshot(id, {
            version: 'expiry-race',
            checkedAt: NOW,
            fetchedAt: NOW,
            dataJson: JSON.stringify({ items: [{ image: { file: shownSha, thumb: shownSha } }] }),
          });
        }
      },
    });
    await forgetFeedImages({ DB: counter.db, BLOBS: env.BLOBS }, NOW);
    expect(raced).toBe(true);
    expect(await row(url)).toMatchObject({ fileSha256: newSha, nextCheckAt: NOW + RECHECK_MS });
    expect(await row(shown)).toMatchObject({ fileSha256: shownSha });
    expect((await scope.pendingDeletes()).map((d) => d.sha256)).toContain(oldSha);
    await forgetFeedImages(env, NOW + FEED_IMAGE_DELETE_GRACE_MS);
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, oldSha!))).toBeNull();
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, newSha!))).not.toBeNull();
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, shownSha!))).not.toBeNull();
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
      const urls = Array.from({ length: 11 }, (_, j) => `https://expiry-protected.test/${i}/${j}.jpg`);
      await scope.feedImages.hold(urls, { until: 0, now: 0, sourceId });
      for (const url of urls) await scope.feedImages.save(url, { fileSha256: protectedSha, thumbSha256: protectedSha, nextCheckAt: 0 });
      await scope.dataSources.putSnapshot(sourceId, {
        version: 'expiry-protected',
        checkedAt: NOW,
        fetchedAt: NOW,
        dataJson: JSON.stringify({ items: [{ image: { file: protectedSha, thumb: protectedSha } }] }),
      });
    }

    const url = 'https://expiry-eligible.test/photo.jpg';
    const sha = '2'.repeat(64);
    const scope = o.scope.feedImages;
    await scope.hold([url], { until: 1, now: 1, sourceId: 'eligible' });
    await scope.save(url, { fileSha256: sha, thumbSha256: sha, nextCheckAt: 1 });

    await forgetFeedImages(env, NOW);

    expect(await scope.get([url])).toEqual([]);
    expect(await scope.pendingDeletes()).toContainEqual(expect.objectContaining({ sha256: sha, queuedAt: NOW }));
    expect(await testScope(env.DB, 'expiry-protected-0').feedImages.get(['https://expiry-protected.test/0/0.jpg'])).toHaveLength(1);
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
    const countedPollEnv = { ...pollEnv, DB: counter.db } as unknown as Env;
    await pollDataSources(countedPollEnv, { now: NOW, guards: web(answers).guards });
    const pollCounts = counter.counts();
    expect(pollCounts.apiCalls).toBeLessThan(25);
    expect(pollCounts.statements).toBeLessThan(40);
    // All 5 sources saved their snapshots and queued within the org's daily budget.
    expect(take()).toHaveLength(NEW_PER_ORG_PER_DAY);

    // 2. Cleanup of 25 expired rows with 2 distinct hashes each (50 hashes) stays well under 50 D1 queries.
    const expiredUrls = Array.from({ length: 25 }, (_, i) => `https://gc-bulk.test/${i}.jpg`);
    await o.scope.feedImages.hold(expiredUrls, { until: NOW, now: NOW, sourceId: 'bulk' });
    for (let i = 0; i < expiredUrls.length; i++) {
      const f = `${String(i).padStart(2, '0')}f`.padEnd(64, 'a');
      const t = `${String(i).padStart(2, '0')}t`.padEnd(64, 'b');
      await o.scope.feedImages.save(expiredUrls[i]!, { fileSha256: f, thumbSha256: t, nextCheckAt: NOW });
    }
    counter.reset();
    const countedCleanupEnv = { DB: counter.db, BLOBS: env.BLOBS };
    const expireAt = NOW + FEED_IMAGE_TTL_MS + 1;
    await forgetFeedImages(countedCleanupEnv, expireAt);
    expect(counter.counts().apiCalls).toBeLessThan(15);
    expect(counter.counts().statements).toBeLessThan(20);

    counter.reset();
    await forgetFeedImages(countedCleanupEnv, expireAt + FEED_IMAGE_DELETE_GRACE_MS);
    expect(counter.counts().apiCalls).toBeLessThan(15);
    expect(counter.counts().statements).toBeLessThan(20);
  });

  it('keeps a full mixed-source poll within the D1 budget when provider refreshes fail', async () => {
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
    await pollDataSources(
      { ...pollEnv, DB: counter.db },
      {
        now: NOW,
        guards: web(answers).guards,
        connectors: { adapters: [{ ...fake.adapter, refresh }], fetch: fake.fetch },
      },
    );
    expect(counter.counts().apiCalls).toBeLessThan(50);
    expect(refresh).toHaveBeenCalledTimes(2);
    for (const org of providers) expect(await org.scope.dataSources.get(org.dataSource)).toMatchObject({ failures: 1, lastError: 'needs-reconnect' });
    expect(take()).toHaveLength(4);
  });

  it('keeps the full midnight cron and the separate feed cleanup within the D1 budget under load', async () => {
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
        const gc = org.scope.feedImages;
        await gc.hold([url, pending], { until: expiredAt, now: expiredAt, sourceId: org.dataSource });
        await gc.save(url, { fileSha256: 'a'.repeat(64), thumbSha256: 'a'.repeat(64), nextCheckAt: expiredAt });
        await gc.save(pending, { fileSha256: 'b'.repeat(64), thumbSha256: 'b'.repeat(64), nextCheckAt: expiredAt });
        await gc.forget([pending], expiredAt + FEED_IMAGE_TTL_MS + 1);
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
    expect(await orgs[0]!.scope.feedImages.get(['https://midnight-gc.test/0.jpg'])).toHaveLength(1);

    counter.reset();
    await runCron('* * * * *', midnight + 60 * MIN);
    expect(counter.counts().apiCalls).toBe(11);
    for (const [i, org] of orgs.slice(0, 3).entries()) {
      expect(await org.scope.feedImages.get([`https://midnight-gc.test/${i}.jpg`])).toHaveLength(0);
      expect((await org.scope.feedImages.pendingDeletes()).map((row) => row.sha256)).toEqual(['a'.repeat(64)]);
    }
  });
});

describe('a photo that may not be stored', () => {
  /** One story naming `url`, polled and its photo queued; the jobs. */
  async function queued(url: string) {
    const feedUrl = `https://refused-${++n}.test/rss`;
    await news(feedUrl);
    await pollDataSources(pollEnv, { now: NOW, guards: web({ [feedUrl]: { body: feedOf(1, () => url) } }).guards });
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

describe('photos switched off', () => {
  it('looks for no photo, queues none, and stores the feed as text', async () => {
    const id = await news('https://quiet.test/rss', { photos: false });
    await pollDataSources(pollEnv, {
      now: NOW,
      guards: web({ 'https://quiet.test/rss': { body: feedOf(3, (i) => `https://cdn.quiet.test/${i}.jpg`) } }).guards,
    });
    expect(take()).toEqual([]);
    expect(await o.scope.feedImages.get(['https://cdn.quiet.test/0.jpg'])).toEqual([]);
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
    await pollDataSources(pollEnv, { now: NOW, guards: rss.guards });
    const initial = await o.scope.dataSources.snapshots([id]);
    await consume(take(), { guards: web({ [url]: { body: jpeg(320, 180, 'switch race') } }).guards, images: imagesStub().images });
    expect((await row(url))?.fileSha256).toBeTruthy();

    const at = NOW + 5 * MIN;
    const fetching = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const inFlight = pollDataSources(pollEnv, {
      now: at,
      guards: {
        ...rss.guards,
        fetch: async (input, init) => {
          fetching.resolve();
          await resume.promise;
          return rss.guards.fetch(input, init);
        },
      },
    });
    await fetching.promise;
    try {
      expect(
        await dispatch(
          registry,
          'update_data_source',
          { dataSourceId: id, photos: false },
          {
            org: o.scope,
            role: 'owner',
            actor: { kind: 'user', id: 'photos-switch-test', clientId: 'cms' },
            blobs: env.BLOBS,
            services: { feedUrls: feedUrlSealer(env) },
          },
        ),
      ).toMatchObject({ ok: true });
    } finally {
      resume.resolve();
      await inFlight;
    }
    const afterRace = await o.scope.dataSources.get(id);
    const afterSnapshot = await o.scope.dataSources.snapshots([id]);
    await pollDataSources(pollEnv, { now: at + 5 * MIN, guards: rss.guards });

    expect((await snapshot(id)).items[0]?.image).toBeUndefined();
    expect(afterSnapshot).toEqual(initial);
    expect(afterRace).toMatchObject({ photos: false, etag: null, lastModified: null, photoUrlsJson: null });
    expect(afterRace?.nextPollAt).toBeLessThanOrEqual(at);
    expect(rss.requests).toHaveLength(3);
    expect(rss.requests[2]?.headers.get('if-none-match')).toBeNull();
    expect(rss.requests[2]?.headers.get('if-modified-since')).toBeNull();
    expect((await o.scope.dataSources.snapshots([id]))[0]?.checkedAt).toBe(at + 5 * MIN);
  });

  it('stores nothing queued before it was switched off', async () => {
    const id = await news('https://late.test/rss');
    const url = 'https://cdn.late.test/a.jpg';
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://late.test/rss': { body: feedOf(1, () => url) } }).guards });
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
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://shared.test/rss': { body } }).guards });
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
    expect(await env.BLOBS.head(feedBlobKey(other.orgId, copy.fileSha256!))).not.toBeNull();
    // This org fetched nothing yet: it holds no copy, and sees none of the other's.
    expect(await row(url)).toMatchObject({ fileSha256: null });
    expect(await env.BLOBS.head(feedBlobKey(o.orgId, copy.fileSha256!))).toBeNull();
    for (const [org, id] of [
      [o, mine],
      [other, theirs],
    ] as const) {
      await org.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    }
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: web({ 'https://shared.test/rss': { body } }).guards });
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
});
