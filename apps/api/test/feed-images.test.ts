// Stories' photos (#195): the poll looks up and queues them, the queue's consumer fetches, checks
// and stores them. No network and no image service: fetch, DNS and the Images binding are stubs,
// the queue is a list, and the clock is a parameter.
import { MAX_SNAPSHOT_BYTES, type NewsFeed } from '@signforge/contract';
import { FEED_IMAGE_TTL_MS } from '@signforge/db';
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedUrlSealer } from '../src/data/cipher';
import type { FetchGuards } from '../src/data/fetch';
import {
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
import { orgBlobKey } from '../src/r2';

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
function web(answers: Record<string, Answer | (() => Answer)>, addresses: Record<string, string[]> = {}) {
  const requests: Request[] = [];
  const guards: FetchGuards = {
    fetch: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      const a = answers[req.url];
      if (!a) return new Response('nope', { status: 404 });
      const { status = 200, body = null, headers } = typeof a === 'function' ? a() : a;
      return new Response(body, { status, headers });
    },
    resolve: async (host) => addresses[host] ?? ['93.184.216.34'],
  };
  return { guards, requests };
}

// ------------------------------------------------------------------- setup

let o: SeededOrg;
let n = 0;
const photoVersions = new Map<string, string>();
const createdSpots: { orgId: string; id: string }[] = [];
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
async function consume(jobs: FeedImageJob[], deps: Omit<PhotoDeps, 'now'>, at = NOW, { attempts = 1, customEnv = env } = {}) {
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

// Only a test's own sources and spots are active in it: a run claims at most 12, and spots stay tiny.
afterEach(async () => {
  vi.restoreAllMocks();
  for (const org of [o.orgId, 'photos-other'])
    for (const d of await testScope(env.DB, org).dataSources.list())
      await testScope(env.DB, org).dataSources.update(d.id, { nextPollAt: Number.MAX_SAFE_INTEGER });
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
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, stored.fileSha256!))).not.toBeNull();
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

  it('asks again a week later with its validators, and keeps the copy when unchanged', async () => {
    const id = await news('https://etag.test/rss');
    const url = 'https://cdn.etag.test/a.png';
    const body = feedOf(1, () => url);
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://etag.test/rss': { body } }).guards });
    const { images, draws } = imagesStub();
    let answer: Answer = { body: png(800, 600), headers: { etag: '"img1"', 'last-modified': 'Thu, 19 Nov 2026 08:00:00 GMT' } };
    const photos = web({ [url]: () => answer });
    await consume(take(), { guards: photos.guards, images });
    const first = (await row(url))!;
    // A PNG becomes a WebP; one larger than NEWS_THUMB_BOX also makes a thumbnail.
    expect(draws).toEqual(['image/webp@800x600', 'image/webp@480x360']);

    // Not due within the week: a poll queues nothing.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + DAY_MS });
    await pollDataSources(pollEnv, { now: NOW + DAY_MS, guards: web({ 'https://etag.test/rss': { body } }).guards });
    expect(take()).toEqual([]);

    const later = NOW + RECHECK_MS;
    await o.scope.dataSources.update(id, { nextPollAt: later });
    await pollDataSources(pollEnv, { now: later, guards: web({ 'https://etag.test/rss': { body } }).guards });
    const jobs = take();
    expect(jobs.map((j) => j.url)).toEqual([url]);
    answer = { status: 304 };
    await consume(jobs, { guards: photos.guards, images }, later);
    expect(photos.requests.at(-1)?.headers.get('if-none-match')).toBe('"img1"');
    expect(photos.requests.at(-1)?.headers.get('if-modified-since')).toBe('Thu, 19 Nov 2026 08:00:00 GMT');
    // Nothing drawn again, the copy kept, and the source not read afresh for it.
    expect(draws).toHaveLength(2);
    expect(await row(url)).toMatchObject({ fileSha256: first.fileSha256, nextCheckAt: later + RECHECK_MS, lastError: null });
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
  it('skips photo work for an unbound source, a draft-only spot, and a text-only template, and re-checks at poll time', async () => {
    const photo = 'https://cdn.bound.test/hero.jpg';
    const body = feedOf(1, () => photo);

    // 1. Unbound source (photos: true, no published spot): no image rows, nothing queued.
    const unboundId = await news('https://unbound.test/rss', { bind: false });
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://unbound.test/rss': { body } }).guards });
    expect(take()).toEqual([]);
    expect(await row(photo)).toBeUndefined();

    // 2. Draft spot binding a photo template, not published: still skipped.
    const draftSpotId = await bindSpot(o, unboundId, { publish: false });
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 5 * MIN, etag: null });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: web({ 'https://unbound.test/rss': { body } }).guards });
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
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 10 * MIN, etag: null });
    await pollDataSources(pollEnv, { now: NOW + 10 * MIN, guards: web({ 'https://unbound.test/rss': { body } }).guards });
    expect(take()).toEqual([]);

    // 4. Publishing the photo-capable spot makes the next poll queue the photo.
    const draftSpot = (await o.scope.spots.get(draftSpotId))!;
    await o.scope.commit(o.scope.spots.stage.publish(draftSpot).writes);
    await o.scope.dataSources.update(unboundId, { nextPollAt: NOW + 15 * MIN, etag: null });
    await pollDataSources(pollEnv, { now: NOW + 15 * MIN, guards: web({ 'https://unbound.test/rss': { body } }).guards });
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

    // Images 9422 -> images-quota (1h backoff); transient Images error -> images-unavailable (1h backoff); 9412 -> undecodable (24h).
    const quota = 'https://err.test/quota.jpg';
    const unavail = 'https://err.test/unavail.jpg';
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
      await queueOne(decodeErr),
      { guards: web({ [decodeErr]: { body: bigJpeg } }).guards, images: imagesStub({ failWith: () => new Error('ERROR 9412: corrupt') }).images },
      NOW,
    );
    expect(await row(quota)).toMatchObject({ lastError: 'images-quota', nextCheckAt: NOW + RETRY_MS });
    expect(await row(unavail)).toMatchObject({ lastError: 'images-unavailable', nextCheckAt: NOW + RETRY_MS });
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

  it('forgets expired unreferenced rows and deletes their R2 blobs on the daily run, keeping blobs still in a snapshot', async () => {
    const id = await news('https://gc.test/rss');
    const dropUrl = 'https://cdn.gc.test/drop.jpg';
    const keepUrl = 'https://cdn.gc.test/keep.jpg';
    await pollDataSources(pollEnv, {
      now: NOW,
      guards: web({ 'https://gc.test/rss': { body: feedOf(2, (i) => (i === 0 ? dropUrl : keepUrl)) } }).guards,
    });
    const jobs = take();
    const { images } = imagesStub();
    await consume(jobs, { guards: web({ [dropUrl]: { body: jpeg(320, 180, 'drop') }, [keepUrl]: { body: jpeg(320, 180, 'keep') } }).guards, images }, NOW);
    const dropSha = (await row(dropUrl))!.fileSha256!;
    const keepSha = (await row(keepUrl))!.fileSha256!;
    // Next poll writes a snapshot naming only keepUrl (dropUrl has dropped off the feed).
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN, etag: null });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: web({ 'https://gc.test/rss': { body: feedOf(1, () => keepUrl) } }).guards });
    expect((await snapshot(id)).items[0]?.image?.file).toBe(keepSha);

    // Past RECHECK_MS + FEED_IMAGE_TTL_MS, forgetFeedImages deletes dropUrl and its R2 blob, while keepUrl (in snapshot) stays.
    const cleanupAt = NOW + RECHECK_MS + FEED_IMAGE_TTL_MS + 1;
    expect(await forgetFeedImages(env, cleanupAt)).toBeGreaterThanOrEqual(2);
    expect(await row(dropUrl)).toBeUndefined();
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, dropSha))).toBeNull();
    expect(await row(keepUrl)).toBeDefined();
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, keepSha))).not.toBeNull();

    // Daily cron at 00:00 UTC runs forgetFeedImages too.
    const midnight = Math.ceil((cleanupAt + DAY_MS) / DAY_MS) * DAY_MS;
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: midnight, cron: '*/5 * * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
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
    expect(await env.BLOBS.head(orgBlobKey(other.orgId, copy.fileSha256!))).not.toBeNull();
    // This org fetched nothing yet: it holds no copy, and sees none of the other's.
    expect(await row(url)).toMatchObject({ fileSha256: null });
    expect(await env.BLOBS.head(orgBlobKey(o.orgId, copy.fileSha256!))).toBeNull();
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
