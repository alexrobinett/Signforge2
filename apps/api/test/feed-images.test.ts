// Stories' photos (#195): the poll looks up and queues them, the queue's consumer fetches, checks
// and stores them. No network and no image service: fetch, DNS and the Images binding are stubs,
// the queue is a list, and the clock is a parameter.
import { MAX_SNAPSHOT_BYTES, type NewsFeed } from '@signforge/contract';
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { feedUrlSealer } from '../src/data/cipher';
import type { FetchGuards } from '../src/data/fetch';
import { type FeedImageJob, HOLD_MS, PHOTOS_PER_SOURCE, type PhotoDeps, RECHECK_MS, RETRY_MS, storeFeedImages } from '../src/data/images';
import { pollDataSources } from '../src/data/poller';
import worker from '../src/index';
import { orgBlobKey } from '../src/r2';

const NOW = Date.UTC(2026, 10, 21, 9);
const MIN = 60_000;

// ------------------------------------------------------------------ images

/** The first bytes of a w x h baseline JPEG: as far as its frame header, which is all a header reader needs. */
function jpeg(w: number, h: number, tail = ''): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    0x03,
    ...Array(9).fill(0),
    ...new TextEncoder().encode(tail),
  ]);
}
/** A w x h WebP's header (VP8X). */
function webp(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  b[16] = 10;
  b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16, (h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16], 24);
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
 * A stand-in for the Images binding: it "decodes" the headers above (bytes holding `BROKEN` fail,
 * as damaged files do), draws to the size asked as a header of the type asked, and gives a
 * drawn image's pixels opaque, or half transparent when `transparent` is set. It records each
 * draw, `type@WxH`.
 */
function imagesStub({ transparent = false } = {}) {
  const draws: string[] = [];
  const read = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());
  const decoded = (b: Uint8Array) => {
    if (new TextDecoder().decode(b).includes('BROKEN')) throw new Error('ERROR 9412: Input image could not be decoded');
    const v = new DataView(b.buffer, b.byteOffset);
    if (b[0] === 0xff) return { w: v.getUint16(9), h: v.getUint16(7) };
    if (b[0] === 0x89) return { w: v.getUint32(16), h: v.getUint32(20) };
    if (b[0] === 0x52) return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    return { w: 2400, h: 1600 };
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
          if (format === 'rgba')
            return {
              response: () => new Response(new Uint8Array(width * height * 4).fill(transparent ? 128 : 255)),
              contentType: () => 'rgba',
              image: () => s,
            };
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
const sent: FeedImageJob[] = [];
/** The poller's env, with the photos queue a list. */
const pollEnv = {
  ...env,
  FEED_IMAGES: { sendBatch: async (batch: { body: FeedImageJob }[]) => void sent.push(...batch.map((m) => m.body)) },
} as unknown as Env;

/** A news source due at `at`, its URL sealed as the tools seal it. */
async function news(url: string, { org = o, photos = true, at = NOW } = {}) {
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
  return id;
}

/** An RSS feed whose stories each name a photo, by `photo(i)`. */
function feedOf(stories: number, photo: (i: number) => string | undefined) {
  const items = Array.from({ length: stories }, (_, i) => {
    const url = photo(i);
    const hour = String(23 - i).padStart(2, '0');
    return `<item><title>Story ${i}</title><pubDate>Fri, 20 Nov 2026 ${hour}:00:00 GMT</pubDate>${url ? `<media:content url="${url}" medium="image"/>` : ''}</item>`;
  });
  return `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Daily</title>${items.join('')}</channel></rss>`;
}

/** Take what the polls queued so far. */
const take = () => sent.splice(0);

/** Run the consumer on these jobs at `at`; the messages it acked and retried. */
async function consume(jobs: FeedImageJob[], deps: Omit<PhotoDeps, 'now'>, at = NOW) {
  const acked: string[] = [];
  const retried: string[] = [];
  const messages = jobs.map((body) => ({
    id: body.url,
    timestamp: new Date(at),
    attempts: 1,
    body,
    ack: () => acked.push(body.url),
    retry: () => retried.push(body.url),
  }));
  const batch = { queue: 'signforge-feed-images', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<FeedImageJob>;
  await storeFeedImages(batch, env, { ...deps, now: at });
  return { acked, retried };
}

const snapshot = async (id: string, org = o): Promise<NewsFeed> => JSON.parse((await org.scope.dataSources.snapshots([id]))[0]!.dataJson);
const row = async (url: string, org = o) => (await org.scope.feedImages.get([url]))[0];

beforeAll(async () => {
  o = await seedOrg(env.DB, 'photos-org');
});

// Only a test's own sources are due in it: a run claims at most 12, and the others would crowd them out.
afterEach(async () => {
  for (const org of [o.orgId, 'photos-other'])
    for (const d of await testScope(env.DB, org).dataSources.list())
      await testScope(env.DB, org).dataSources.update(d.id, { nextPollAt: Number.MAX_SAFE_INTEGER });
});

// ------------------------------------------------------------------- tests

describe('a news source with photos', () => {
  it('queues the first stories’ photos, stores them, and names the copies in its next snapshot', async () => {
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
    const photos = web(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [photo(i), { body: jpeg(3840, 2160), headers: { etag: `"p${i}"` } }])));
    const jobs = Array.from({ length: PHOTOS_PER_SOURCE }, (_, i) => ({ orgId: o.orgId, sourceId: id, url: photo(i) }));
    expect(await consume(jobs, { guards: photos.guards, images }, NOW + 6 * MIN)).toEqual({ acked: jobs.map((j) => j.url), retried: [] });
    // Covers a landscape screen, and a thumbnail covers the list box; a JPEG stays a JPEG.
    expect(new Set(draws)).toEqual(new Set(['image/jpeg@1920x1080', 'image/jpeg@480x270']));
    const stored = (await row(photo(0)))!;
    expect(stored).toMatchObject({ etag: '"p0"', lastError: null, nextCheckAt: NOW + 6 * MIN + RECHECK_MS });
    expect(stored.sampleSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const sha of [stored.fileSha256!, stored.thumbSha256!, stored.sampleSha256!]) expect(await env.BLOBS.head(orgBlobKey(o.orgId, sha))).not.toBeNull();
    // Read afresh next time, so a 304 cannot leave the snapshot without them.
    expect(await o.scope.dataSources.get(id)).toMatchObject({ etag: null });

    await o.scope.dataSources.update(id, { nextPollAt: NOW + 10 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 10 * MIN, guards: feed.guards });
    expect(take()).toEqual([]);
    const data = await snapshot(id);
    expect(data.items[0]?.image).toEqual({ file: stored.fileSha256, sample: stored.sampleSha256, thumb: stored.thumbSha256 });
    expect(data.items.filter((i) => i.image)).toHaveLength(PHOTOS_PER_SOURCE);
    expect(data.items.slice(PHOTOS_PER_SOURCE).some((i) => i.image)).toBe(false);
    expect(JSON.stringify(data)).not.toContain('cdn.daily.test');
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
    await consume(jobs, { guards: web(Object.fromEntries(jobs.map((j) => [j.url, { body: jpeg(1200, 800) }]))).guards, images });
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 5 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 5 * MIN, guards: web({ 'https://long.test/rss': { body } }).guards });
    const json = (await o.scope.dataSources.snapshots([id]))[0]!.dataJson;
    expect(JSON.parse(json).items.filter((i: { image?: unknown }) => i.image)).toHaveLength(PHOTOS_PER_SOURCE);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it('asks again a day later with its validators, and keeps the copy when it is unchanged', async () => {
    const id = await news('https://etag.test/rss');
    const url = 'https://cdn.etag.test/a.png';
    const body = feedOf(1, () => url);
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://etag.test/rss': { body } }).guards });
    const { images, draws } = imagesStub();
    let answer: Answer = { body: png(800, 600), headers: { etag: '"img1"', 'last-modified': 'Thu, 19 Nov 2026 08:00:00 GMT' } };
    const photos = web({ [url]: () => answer });
    await consume(take(), { guards: photos.guards, images });
    const first = (await row(url))!;
    // A PNG becomes a WebP; one that needs no scaling keeps its size.
    expect(draws).toEqual(['image/webp@800x600', 'image/webp@480x360']);

    // Not due within the day: a poll queues nothing.
    await o.scope.dataSources.update(id, { nextPollAt: NOW + 60 * MIN });
    await pollDataSources(pollEnv, { now: NOW + 60 * MIN, guards: web({ 'https://etag.test/rss': { body } }).guards });
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

  it('turns a photo whose pixels are not all opaque into a WebP with no sample', async () => {
    await news('https://alpha.test/rss');
    const url = 'https://cdn.alpha.test/a.webp';
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://alpha.test/rss': { body: feedOf(1, () => url) } }).guards });
    const { images } = imagesStub({ transparent: true });
    await consume(take(), { guards: web({ [url]: { body: webp(1000, 1000) } }).guards, images });
    expect(await row(url)).toMatchObject({ fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/), sampleSha256: null, thumbSha256: expect.any(String) });
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
    expect(await row(hop)).toMatchObject({ fileSha256: null, lastError: 'private-address', nextCheckAt: NOW + RECHECK_MS });
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
    for (const url of [said, unsaid]) expect(await row(url)).toMatchObject({ fileSha256: null, lastError: 'too-large', nextCheckAt: NOW + RECHECK_MS });
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
    // Changed into something its header passes for and the decoder refuses.
    body = jpeg(640, 480, 'BROKEN');
    await consume(jobs, { guards: photos.guards, images }, NOW + RECHECK_MS);
    expect(await row(url)).toMatchObject({
      fileSha256: good.fileSha256,
      thumbSha256: good.thumbSha256,
      lastError: 'undecodable',
      nextCheckAt: NOW + 2 * RECHECK_MS,
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
  it('each fetch and keep their own copy, in their own storage', async () => {
    const other = await seedOrg(env.DB, 'photos-other');
    await other.scope.dataSources.update(other.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    await o.scope.dataSources.update(o.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const url = 'https://cdn.shared.test/a.jpg';
    const body = feedOf(1, () => url);
    const mine = await news('https://shared.test/rss');
    const theirs = await news('https://shared.test/rss', { org: other });
    await pollDataSources(pollEnv, { now: NOW, guards: web({ 'https://shared.test/rss': { body } }).guards });
    const jobs = take();
    expect(jobs.map((j) => j.orgId).sort()).toEqual([o.orgId, other.orgId].sort());
    const { images } = imagesStub();
    await consume(
      jobs.filter((j) => j.orgId === other.orgId),
      { guards: web({ [url]: { body: jpeg(800, 450) } }).guards, images },
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
