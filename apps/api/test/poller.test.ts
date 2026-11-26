// The data-source poller (M3-23): the one-minute Cron Trigger fetches due feeds through the
// guards, normalises them, and writes a snapshot only when the data changed. No network: fetch
// and DNS are stubbed, and the clock is a parameter.
import { MAX_SNAPSHOT_BYTES } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { feedUrlSealer, openFeedUrl } from '../src/data/cipher';
import type { FetchGuards } from '../src/data/fetch';
import { BACKOFF_MAX_MS, pollDataSources } from '../src/data/poller';
import worker from '../src/index';

const NOW = Date.UTC(2026, 10, 17, 14);
const MIN = 60_000;

type Answer = { status?: number; body?: string; headers?: Record<string, string> };

/** Guards whose fetch answers from `feeds` by URL and records requests; every host resolves to a public address. */
function feedsAt(feeds: Record<string, Answer | (() => Answer)>) {
  const requests: Request[] = [];
  const guards: FetchGuards = {
    fetch: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      const f = feeds[req.url];
      if (!f) return new Response('nope', { status: 404 });
      const a = typeof f === 'function' ? f() : f;
      return new Response(a.body ?? null, { status: a.status ?? 200, headers: a.headers });
    },
    resolve: async () => ['93.184.216.34'],
  };
  return { guards, requests };
}

let o: SeededOrg;
let n = 0;

/** A source due now, its URL sealed as the tools seal it. */
async function source(format: 'json' | 'ical' | 'rss', url: string, extra: { refreshS?: number; horizonDays?: number } = {}) {
  const id = `src-${++n}`;
  const urlEncrypted = await feedUrlSealer(env).seal({ orgId: o.orgId, id }, url);
  await o.scope.dataSources.insert({
    id,
    name: id,
    format,
    urlEncrypted,
    refreshS: extra.refreshS ?? 300,
    horizonDays: extra.horizonDays ?? null,
    nextPollAt: NOW,
  });
  return id;
}

/** Run the poller at `at`, on this org's due sources only. A news source's photos go nowhere: test/feed-images.test.ts follows them. */
const poll = (guards: FetchGuards, at = NOW) => pollDataSources(env, { now: at, guards, photoQueue: { enqueue: async () => {} } });

beforeAll(async () => {
  o = await seedOrg(env.DB, 'poller-org');
  // The seeded source is not due in these tests.
  await o.scope.dataSources.update(o.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
});

afterEach(async () => {
  for (const row of await o.scope.dataSources.list()) {
    if (row.nextPollAt !== Number.MAX_SAFE_INTEGER) await o.scope.dataSources.update(row.id, { nextPollAt: Number.MAX_SAFE_INTEGER });
  }
});

describe('the feed URL at rest', () => {
  it('opens only for the source it was sealed for', async () => {
    const sealed = await feedUrlSealer(env).seal({ orgId: 'org-a', id: 'cal' }, 'https://calendar.test/private.ics');
    expect(sealed).not.toContain('calendar.test');
    expect(await openFeedUrl(env, { orgId: 'org-a', id: 'cal' }, sealed)).toBe('https://calendar.test/private.ics');
    expect(await openFeedUrl(env, { orgId: 'org-b', id: 'cal' }, sealed)).toBeUndefined();
    expect(await openFeedUrl(env, { orgId: 'org-a', id: 'other' }, sealed)).toBeUndefined();
    expect(await openFeedUrl({ ENVIRONMENT: 'dev', DATA_SOURCE_KEY: 'another key entirely' }, { orgId: 'org-a', id: 'cal' }, sealed)).toBeUndefined();
  });
});

describe('pollDataSources', () => {
  it('stores a new feed as a snapshot, and polls it again after its refresh', async () => {
    const id = await source('json', 'https://weather.test/now', { refreshS: 600 });
    const feed = feedsAt({ 'https://weather.test/now': { body: '{"t":12}', headers: { etag: '"a"' } } });
    await poll(feed.guards);
    const [snap] = await o.scope.dataSources.snapshots([id]);
    expect(snap).toMatchObject({ fetchedAt: NOW, checkedAt: NOW, dataJson: '{"t":12}' });
    expect(snap?.version).toMatch(/^[0-9a-f]{64}$/);
    expect(await o.scope.dataSources.get(id)).toMatchObject({ nextPollAt: NOW + 600_000, etag: '"a"', failures: 0, lastError: null });
    // Not due again until then.
    await poll(feed.guards, NOW + 5 * MIN);
    expect(feed.requests).toHaveLength(1);
  });

  it('asks conditionally, and an unchanged feed only moves checkedAt', async () => {
    const id = await source('json', 'https://same.test/');
    let answer: Answer = { body: '{"t":1}', headers: { etag: '"v1"', 'last-modified': 'Tue, 17 Nov 2026 12:00:00 GMT' } };
    const feed = feedsAt({ 'https://same.test/': () => answer });
    await poll(feed.guards);
    answer = { status: 304 };
    await poll(feed.guards, NOW + 5 * MIN);
    expect(feed.requests[1]?.headers.get('if-none-match')).toBe('"v1"');
    expect(feed.requests[1]?.headers.get('if-modified-since')).toBe('Tue, 17 Nov 2026 12:00:00 GMT');
    // A 200 with the same data (a server without validators) counts as unchanged too.
    answer = { body: '{ "t": 1 }' };
    await poll(feed.guards, NOW + 10 * MIN);
    expect((await o.scope.dataSources.snapshots([id]))[0]).toMatchObject({ fetchedAt: NOW, checkedAt: NOW + 10 * MIN });
    answer = { body: '{"t":2}' };
    await poll(feed.guards, NOW + 15 * MIN);
    expect((await o.scope.dataSources.snapshots([id]))[0]).toMatchObject({ fetchedAt: NOW + 15 * MIN, checkedAt: NOW + 15 * MIN, dataJson: '{"t":2}' });
  });

  it('backs off on failure, doubling to at most 6 hours, keeping the last good snapshot and recording only a category', async () => {
    const id = await source('json', 'https://flaky.test/');
    let answer: Answer = { body: '{"ok":true}' };
    const feed = feedsAt({ 'https://flaky.test/': () => answer });
    await poll(feed.guards);
    answer = { status: 503, body: 'upstream says: internal token abc' };
    let at = NOW + 5 * MIN;
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      await poll(feed.guards, at);
      const row = await o.scope.dataSources.get(id);
      waits.push(row!.nextPollAt - at);
      at = row!.nextPollAt;
    }
    expect(waits.map((ms) => ms / MIN)).toEqual([10, 20, 40, 80, 160, 320, 360, 360, 360]);
    expect(BACKOFF_MAX_MS).toBe(6 * 60 * MIN);
    const row = await o.scope.dataSources.get(id);
    expect(row).toMatchObject({ failures: 9, lastError: 'http-status' });
    expect(JSON.stringify(row)).not.toContain('token');
    // The last good check stays where it was, so the snapshot ages on screens and goes stale at its source's age (#624).
    expect((await o.scope.dataSources.snapshots([id]))[0]).toMatchObject({ dataJson: '{"ok":true}', checkedAt: NOW });
    // The first success clears it.
    answer = { body: '{"ok":true}' };
    await poll(feed.guards, at);
    expect(await o.scope.dataSources.get(id)).toMatchObject({ failures: 0, lastError: null, nextPollAt: at + 5 * MIN });
  });

  it('records a guard refusal as its category', async () => {
    const id = await source('json', 'https://inside.test/');
    await poll({ ...feedsAt({}).guards, resolve: async () => ['10.0.0.8'] });
    expect(await o.scope.dataSources.get(id)).toMatchObject({ failures: 1, lastError: 'private-address' });
  });

  it('converts calendars with their look-ahead and news feeds, and never asks a calendar conditionally', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART;VALUE=DATE:20270101',
      'SUMMARY:New Year',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const near = await source('ical', 'https://cal.test/h.ics');
    const far = await source('ical', 'https://cal.test/h.ics?far', { horizonDays: 120 });
    const news = await source('rss', 'https://news.test/rss');
    const feed = feedsAt({
      'https://cal.test/h.ics': { body: ics, headers: { etag: '"c"' } },
      'https://cal.test/h.ics?far': { body: ics },
      'https://news.test/rss': {
        body: '<rss><channel><title>T</title><language>fr</language><item><title>Bonjour</title><pubDate>Tue, 17 Nov 2026 13:00:00 GMT</pubDate></item></channel></rss>',
      },
    });
    await poll(feed.guards);
    const data = async (id: string) => JSON.parse((await o.scope.dataSources.snapshots([id]))[0]!.dataJson);
    expect(await data(near)).toEqual({ events: [] });
    expect((await data(far)).events).toEqual([{ title: 'New Year', start: '2027-01-01', end: '2027-01-02', allDay: true, location: '', organizer: '' }]);
    expect(await data(news)).toEqual({ title: 'T', language: 'fr', items: [{ title: 'Bonjour', published: '2026-11-17T13:00:00+00:00', source: 'T' }] });
    // A calendar's events depend on the time as well as the feed, so it is always fetched whole.
    await poll(feed.guards, NOW + 5 * MIN);
    expect(feed.requests.filter((r) => r.url === 'https://cal.test/h.ics').map((r) => r.headers.get('if-none-match'))).toEqual([null, null]);
  });

  it("stores a news feed's text alone: the images and the logo it names stay out of the snapshot", async () => {
    const news = await source('rss', 'https://pics.test/rss');
    const body = `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel><title>Pics</title><image><url>/logo.png</url></image>
        <item><title>One</title><link>https://pics.test/1</link><pubDate>Tue, 17 Nov 2026 13:00:00 GMT</pubDate><media:content url="https://cdn.pics.test/1.jpg" medium="image" width="1600"/></item>
        <item><title>Two</title><pubDate>Tue, 17 Nov 2026 12:00:00 GMT</pubDate><enclosure url="https://cdn.pics.test/2.jpg" type="image/jpeg"/><content:encoded><![CDATA[<img src="/3.jpg">]]></content:encoded></item>
      </channel></rss>`;
    await poll(feedsAt({ 'https://pics.test/rss': { body } }).guards);
    const json = (await o.scope.dataSources.snapshots([news]))[0]!.dataJson;
    expect(JSON.parse(json)).toEqual({
      title: 'Pics',
      language: '',
      items: [
        { title: 'One', published: '2026-11-17T13:00:00+00:00', source: 'Pics' },
        { title: 'Two', published: '2026-11-17T12:00:00+00:00', source: 'Pics' },
      ],
    });
    expect(json).not.toMatch(/\.(jpg|png)|image|logo/);
  });

  it('refuses a feed that is not what its format says, or converts to more than 64 kB', async () => {
    const bad = await source('json', 'https://bad.test/');
    const big = await source('json', 'https://big.test/');
    await poll(
      feedsAt({ 'https://bad.test/': { body: '<html>' }, 'https://big.test/': { body: JSON.stringify({ x: 'a'.repeat(MAX_SNAPSHOT_BYTES) }) } }).guards,
    );
    expect(await o.scope.dataSources.get(bad)).toMatchObject({ failures: 1, lastError: 'malformed' });
    expect(await o.scope.dataSources.get(big)).toMatchObject({ failures: 1, lastError: 'too-large' });
    expect(await o.scope.dataSources.snapshots([bad, big])).toEqual([]);
  });

  it('keeps a snapshot that fills at least one bound field, and refuses one that fills none', async () => {
    const id = await source('json', 'https://bound.test/');
    // The seeded template's `title` is text; a published spot binds it twice over, at two paths.
    const spot = await o.scope.spots.update(o.templateSpot, { bindingsJson: JSON.stringify({ title: { source: id, path: 'name' } }) });
    await o.scope.commit(o.scope.spots.stage.publish(spot!).writes);
    let body = '{"name":7}';
    const feed = feedsAt({ 'https://bound.test/': () => ({ body }) });
    await poll(feed.guards);
    expect(await o.scope.dataSources.get(id)).toMatchObject({ failures: 1, lastError: 'unfit' });
    expect(await o.scope.dataSources.snapshots([id])).toEqual([]);

    body = '{"name":"Lobby"}';
    await poll(feed.guards, NOW + 10 * MIN);
    expect((await o.scope.dataSources.snapshots([id]))[0]?.dataJson).toBe('{"name":"Lobby"}');

    // A draft binding is not what screens play: only the published spot counts.
    const draft = await o.scope.spots.update(o.templateSpot, { bindingsJson: JSON.stringify({ title: { source: id, path: 'missing' } }) });
    expect(draft).toBeDefined();
    body = '{"name":"Hall"}';
    await poll(feed.guards, NOW + 20 * MIN);
    expect((await o.scope.dataSources.snapshots([id]))[0]?.dataJson).toBe('{"name":"Hall"}');
  });

  it('fetches at most 2 at a time from one host', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await source('json', `https://busy.test/${i}`));
    const feed = feedsAt(Object.fromEntries(ids.map((_, i) => [`https://busy.test/${i}`, { body: `{"i":${i}}` }])));
    // Each request is answered only when the test lets it go, so what is in flight is the test's to see.
    const held: (() => void)[] = [];
    const arrived: (() => void)[] = [];
    const guards: FetchGuards = {
      ...feed.guards,
      fetch: async (input, init) => {
        await new Promise<void>((answer) => {
          held.push(answer);
          for (const wake of arrived.splice(0)) wake();
        });
        return feed.guards.fetch(input, init);
      },
    };
    const inFlight = async (n: number) => {
      while (held.length < n) await new Promise<void>((r) => arrived.push(r));
    };
    // Every source asked D1 for its row before the first request started, and D1 answers in order:
    // once a read asked for now returns, every source has its row, and any request free to start has started.
    const startedAll = () => o.scope.dataSources.get(ids[0]!);

    const run = poll(guards);
    await inFlight(2);
    await startedAll();
    expect(held).toHaveLength(2);
    // As each one is answered, the next starts.
    for (let next = 2; next < 5; next++) {
      held.shift()?.();
      await inFlight(2);
      await startedAll();
      expect(held).toHaveLength(2);
    }
    while (held.length) held.shift()?.();
    await run;
    expect(feed.requests).toHaveLength(5);
  });

  it("calls the Worker's own fetch as workerd requires, unbound from any object", async () => {
    for (const d of await o.scope.dataSources.list()) await o.scope.dataSources.update(d.id, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const id = await source('json', 'https://real.test/feed');
    // workerd's fetch throws "Illegal invocation" when called as a method of another object.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://cloudflare-dns.com/'))
        return Promise.resolve(Response.json({ Answer: url.includes('type=A&') || url.endsWith('type=A') ? [{ type: 1, data: '93.184.216.34' }] : [] }));
      return Promise.resolve(new Response('{"ok":1}'));
    });
    try {
      await pollDataSources(env, { now: NOW + 3 * 365 * 24 * 60 * MIN });
    } finally {
      spy.mockRestore();
    }
    expect(await o.scope.dataSources.get(id)).toMatchObject({ failures: 0, lastError: null });
  });

  it('runs from the one-minute Cron Trigger only, at the time it was scheduled for', async () => {
    // Only one source due, at a local name: the guard refuses it before any request, so the Worker's real fetch and DNS are never reached.
    for (const d of await o.scope.dataSources.list()) await o.scope.dataSources.update(d.id, { nextPollAt: Number.MAX_SAFE_INTEGER });
    const id = await source('json', 'https://printer.local/feed');
    const at = NOW + 365 * 24 * 60 * MIN;
    const run = async (cron: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: at, cron }), env, ctx);
      await waitOnExecutionContext(ctx);
    };
    // The five-minute trigger is the offline alert check's: it polls nothing.
    await run('*/5 * * * *');
    expect(await scoped(env.DB, o.orgId).dataSources.get(id)).toMatchObject({ failures: 0, lastError: null });
    await run('* * * * *');
    expect(await scoped(env.DB, o.orgId).dataSources.get(id)).toMatchObject({ failures: 1, lastError: 'private-address', nextPollAt: at + 10 * MIN });
  });
});
