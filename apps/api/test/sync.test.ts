// The sync (M3-07): one periodic call carries the heartbeat and play counts up, and the desired
// manifest, changed snapshots, a socket ticket, the server time and commands down.
import { MANIFEST_SCHEMA, MAX_SYNC_BLOBS, MAX_SYNC_REQUEST_BYTES, MAX_SYNC_RESPONSE_BLOBS, MAX_SYNC_SOURCES, type SyncRequest } from '@signforge/contract';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mintCredential } from '../src/device/credential';
import { parseHeartbeat } from '@signforge/tools';
import { manifestKey } from '../src/r2';
import { syncAs, syncBody } from './sync-client';

const BASE = 'https://api.test/v1/device';
const HOUR = '2026-11-17T09:00Z';
const HOUR_MS = Date.parse(HOUR);
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

interface Screen {
  seed: SeededOrg;
  credential: string;
}

async function setUp(orgId: string): Promise<Screen> {
  const seed = await seedOrg(env.DB, orgId);
  const { credential, secretHash } = await mintCredential(seed.screen);
  await seed.scope.screens.credentials.insert({ screenId: seed.screen, secretHash });
  return { seed, credential };
}

/** Put a manifest in R2, with what every manifest has, and make it the screen's desired one. */
async function publish(
  s: Screen,
  id: string,
  manifest: { schema: number; dataSources?: Record<string, unknown>; templates?: Record<string, unknown>; spots?: Record<string, unknown> },
) {
  await env.BLOBS.put(
    manifestKey(s.seed.orgId, s.seed.screen, id),
    JSON.stringify({
      id,
      files: {},
      templates: {},
      dataSources: {},
      spots: {},
      screen: { id: s.seed.screen, name: 'Lobby', timezone: 'UTC', orientation: 'landscape' },
      ...manifest,
    }),
  );
  await s.seed.scope.screens.setDesiredManifest(s.seed.screen, id);
}

const body = syncBody;
const sync = (s: Screen, req: SyncRequest) => syncAs(s.credential, req);

const plays = async (s: Screen) =>
  (await s.seed.scope.playCounts.list({ from: HOUR_MS, to: HOUR_MS + 3_600_000, screenId: s.seed.screen })).map((c) => [c.spotId, c.plays, c.ms]);

describe('play counts', () => {
  let s: Screen;
  beforeAll(async () => {
    s = await setUp('sync-counts');
  });

  it('are stored once per seq, and acknowledged in the request epoch', async () => {
    const counts = [
      { hour: HOUR, spot: 'menu', plays: 3, ms: 30_000 },
      { hour: HOUR, spot: 'news', plays: 1, ms: 8000 },
    ];
    const first = await sync(s, body({ seq: 1, playCounts: counts }));
    expect(first).toMatchObject({ epoch: 'ep1', ackSeq: 1 });
    // The response was lost: the screen sends the same batch again.
    expect(await sync(s, body({ seq: 1, playCounts: counts }))).toMatchObject({ ackSeq: 1 });
    expect(await plays(s)).toEqual([
      ['menu', 3, 30_000],
      ['news', 1, 8000],
    ]);
    expect(await sync(s, body({ seq: 2, playCounts: [{ hour: HOUR, spot: 'menu', plays: 2, ms: 20_000 }] }))).toMatchObject({ ackSeq: 2 });
    expect(await plays(s)).toEqual([
      ['menu', 5, 50_000],
      ['news', 1, 8000],
    ]);
  });

  it('from a screen that lost its counter start again in a new epoch', async () => {
    expect(await sync(s, body({ epoch: 'ep2', seq: 1, playCounts: [{ hour: HOUR, spot: 'news', plays: 1, ms: 8000 }] }))).toMatchObject({
      epoch: 'ep2',
      ackSeq: 1,
    });
    expect(await plays(s)).toEqual([
      ['menu', 5, 50_000],
      ['news', 2, 16_000],
    ]);
  });

  it('count once when retries from before and after a re-image interleave', async () => {
    const r = await setUp('sync-reimage');
    const batch = (epoch: string, seq: number, n: number) => body({ epoch, seq, playCounts: [{ hour: HOUR, spot: 'menu', plays: n, ms: n * 1000 }] });
    const acks: [string, number][] = [];
    const deliveries: [string, number, number][] = [
      ['old', 1, 1],
      ['new', 1, 10],
      ['old', 1, 1],
      ['new', 1, 10],
      ['old', 2, 2],
      ['new', 2, 20],
      ['old', 2, 2],
      ['new', 2, 20],
    ];
    for (const [epoch, seq, n] of deliveries) {
      const res = await sync(r, batch(epoch, seq, n));
      acks.push([res.epoch, res.ackSeq]);
    }
    expect(acks).toEqual([
      ['old', 1],
      ['new', 1],
      ['old', 1],
      ['new', 1],
      ['old', 2],
      ['new', 2],
      ['old', 2],
      ['new', 2],
    ]);
    expect(await plays(r)).toEqual([['menu', 33, 33_000]]);
  });

  it('for an hour that has not begun are dropped, the rest kept', async () => {
    const future = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 13) + ':00Z';
    expect(
      await sync(
        s,
        body({
          epoch: 'ep2',
          seq: 2,
          playCounts: [
            { hour: future, spot: 'menu', plays: 9, ms: 1 },
            { hour: HOUR, spot: 'news', plays: 1, ms: 8000 },
          ],
        }),
      ),
    ).toMatchObject({ ackSeq: 2 });
    expect(await s.seed.scope.playCounts.list({ from: Date.parse(future), to: Date.parse(future) + 3_600_000 })).toEqual([]);
    expect((await plays(s)).at(-1)).toEqual(['news', 3, 24_000]);
  });
});

describe('the heartbeat', () => {
  it('records last seen, the player version and what the screen reported', async () => {
    const s = await setUp('sync-heartbeat');
    // The server's clock (vi.setSystemTime: the Worker runs in the tests' isolate).
    const now = Date.parse('2026-11-20T12:00:00Z');
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime(now);
    const deviceTime = new Date(now - 3_600_000).toISOString();
    await sync(
      s,
      body({
        player: { version: '2.1.0', manifestSchemas: [MANIFEST_SCHEMA], protocols: [2] },
        manifest: { active: OLD, filesMissing: 2, fallbackFrom: NEW },
        display: { on: false, methods: { cec: 'ok' } },
        deviceTime,
        clock: { offsetMs: 3_600_000, trusted: true },
        dataRejected: { weather: 4 },
      }),
    );
    const row = await s.seed.scope.screens.get(s.seed.screen);
    expect(row?.lastSeenAt).toBe(now);
    expect(row?.playerVersion).toBe('2.1.0');
    const beat = parseHeartbeat(row!.heartbeatJson);
    expect(beat).toMatchObject({
      manifest: { active: OLD, filesMissing: 2, fallbackFrom: NEW },
      display: { on: false, methods: { cec: 'ok' } },
      clock: { offsetMs: 3_600_000, trusted: true },
      dataRejected: { weather: 4 },
      player: { manifestSchemas: [MANIFEST_SCHEMA], protocols: [2] },
    });
    // The device clock is an hour slow: the drift the server saw is an hour.
    expect(beat!.driftMs).toBe(3_600_000);
  });

  it('takes a heartbeat from a player that reports every source it has seen, and stores at most MAX_SYNC_SOURCES', async () => {
    const s = await setUp('sync-heartbeat-sources');
    // As a player before gh-45 sends after source turnover: every source since it started, kept across retries.
    const seen = Object.fromEntries(Array.from({ length: MAX_SYNC_SOURCES + 44 }, (_, i) => [`old-${i}`, i]));
    const first = await sync(s, body({ seq: 1, snapshots: seen, dataRejected: seen, playCounts: [{ hour: HOUR, spot: 'menu', plays: 1, ms: 8000 }] }));
    expect(first).toMatchObject({ ackSeq: 1, socketTicket: expect.any(String) });
    const beat = parseHeartbeat((await s.seed.scope.screens.get(s.seed.screen))!.heartbeatJson);
    expect(Object.keys(beat!.dataRejected)).toHaveLength(MAX_SYNC_SOURCES);
  });

  it('bounds the work a large heartbeat makes: a legacy one near the ceiling syncs, one over it is refused unread', async () => {
    const s = await setUp('sync-heartbeat-ceiling');
    const post = (payload: BodyInit, headers: Record<string, string> = {}) =>
      exports.default.fetch(`${BASE}/sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.credential}`, 'content-type': 'application/json', ...headers },
        body: payload,
      });
    // Some 5000 sources in each map, 64-character ids: a player before gh-45 after long source turnover.
    const legacy = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`s${String(i).padStart(63, '0')}`, 1_763_384_400_000]));
    const near = JSON.stringify(body({ seq: 1, snapshots: legacy, dataRejected: legacy }));
    expect(near.length).toBeGreaterThan(MAX_SYNC_REQUEST_BYTES * 0.7);
    expect(near.length).toBeLessThan(MAX_SYNC_REQUEST_BYTES);
    const ok = await post(near);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ackSeq: 1 });
    expect(Object.keys(parseHeartbeat((await s.seed.scope.screens.get(s.seed.screen))!.heartbeatJson)!.dataRejected)).toHaveLength(MAX_SYNC_SOURCES);

    // Every entry bad: one problem per map, not one per entry.
    const bad = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`bad id ${i}`, -1]));
    const refused = await post(JSON.stringify(body({ snapshots: bad, dataRejected: bad })));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { problems: string[] }).problems).toHaveLength(2);

    // A play-count list filling the ceiling: one problem, not one per entry (a 500 before).
    const counts = JSON.stringify({ ...body({}), playCounts: Array.from({ length: 349_000 }, () => ({})) });
    expect(counts.length).toBeLessThan(MAX_SYNC_REQUEST_BYTES);
    const tooMany = await post(counts);
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { problems: string[] }).problems).toHaveLength(1);

    // Over the ceiling: refused before it is parsed, with a length or streamed without one.
    const seenAt = (await s.seed.scope.screens.get(s.seed.screen))?.lastSeenAt;
    const more = { ...legacy, ...Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`t${String(i).padStart(63, '0')}`, 1_763_384_400_000])) };
    const over = JSON.stringify(body({ seq: 2, snapshots: more, dataRejected: more }));
    expect(over.length).toBeGreaterThan(MAX_SYNC_REQUEST_BYTES);
    expect((await post(over)).status).toBe(413);
    const streamed = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(over));
        c.close();
      },
    });
    expect((await post(streamed)).status).toBe(413);
    // Neither was read: the screen's row is as the last sync left it.
    expect((await s.seed.scope.screens.get(s.seed.screen))?.lastSeenAt).toBe(seenAt);
  });

  it('stores only the contract fields of a heartbeat, so an unknown nested key cannot lock the screen out', async () => {
    const s = await setUp('sync-heartbeat-unknown-keys');
    // SQLite's json_extract refuses JSON nested 1000 deep, and the device lookup reads the row with it.
    let deep: unknown = 1;
    for (let i = 0; i < 1000; i++) deep = { d: deep };
    const base = body({ seq: 1 });
    for (const [field, value] of [
      ['player', { ...base.player, extra: deep }],
      ['manifest', { ...base.manifest, extra: deep }],
      ['display', { ...base.display, extra: deep }],
      ['display', { ...base.display, override: { state: 'on', until: '2026-11-18T23:00:00Z', extra: deep } }],
      ['clock', { ...base.clock, extra: deep }],
    ] as const) {
      const res = await exports.default.fetch(`${BASE}/sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, [field]: value }),
      });
      expect(res.status, field).toBe(200);
      // The next ordinary sync still finds the screen.
      expect(await sync(s, body({ seq: 1 })), field).toMatchObject({ ackSeq: 1 });
    }
  });

  it('refuses a manifest id that is not a sha256, and stores nothing', async () => {
    const s = await setUp('sync-heartbeat-bounds');
    const res = await exports.default.fetch(`${BASE}/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body({ manifest: { active: 'x'.repeat(10_000), filesMissing: 0 } })),
    });
    expect(res.status).toBe(400);
    const row = await s.seed.scope.screens.get(s.seed.screen);
    expect(row?.heartbeatJson).toBeNull();
  });
});

describe('snapshots', () => {
  it('are sent for the desired manifest sources the screen does not hold, or holds older', async () => {
    const s = await setUp('sync-snapshots');
    const src = s.seed.dataSource;
    // A second source, not in the manifest: never sent.
    const other = await s.seed.scope.dataSources.insert({ name: 'Other', format: 'json', urlEncrypted: 'enc:o', refreshS: 300 });
    await s.seed.scope.dataSources.putSnapshot(other.id, { version: 'o1', fetchedAt: 1000, checkedAt: 1000, dataJson: '{"o":1}' });

    expect((await sync(s, body())).snapshots).toEqual([]);
    await publish(s, 'm-data', { schema: MANIFEST_SCHEMA, dataSources: { [src]: { id: src, refreshS: 300 } } });

    const seededAt = (await s.seed.scope.dataSources.snapshot(src))!.fetchedAt;
    const at = (ms: number) => new Date(ms).toISOString();
    const first = await sync(s, body());
    expect(first.snapshots).toEqual([{ id: src, version: seededAt, fetchedAt: at(seededAt), checkedAt: at(seededAt), data: { t: 12 } }]);
    expect(first.checked).toEqual({});
    const held = await sync(s, body({ snapshots: { [src]: seededAt } }));
    expect(held.snapshots).toEqual([]);
    expect(held.checked).toEqual({ [src]: { version: seededAt, checkedAt: at(seededAt) } });

    // The poller found the feed unchanged: the data is not sent again, only when it was checked.
    await s.seed.scope.dataSources.savePoll(src, { source: { nextPollAt: seededAt + 330_000 }, checkedAt: seededAt + 30_000 });
    const rechecked = await sync(s, body({ snapshots: { [src]: seededAt } }));
    expect(rechecked.snapshots).toEqual([]);
    expect(rechecked.checked).toEqual({ [src]: { version: seededAt, checkedAt: at(seededAt + 30_000) } });

    await s.seed.scope.dataSources.putSnapshot(src, { version: 'v2', fetchedAt: seededAt + 60_000, checkedAt: seededAt + 60_000, dataJson: '{"t":13}' });
    const changed = await sync(s, body({ snapshots: { [src]: seededAt } }));
    expect(changed.snapshots).toEqual([
      { id: src, version: seededAt + 60_000, fetchedAt: at(seededAt + 60_000), checkedAt: at(seededAt + 60_000), data: { t: 13 } },
    ]);
    expect(changed.checked).toEqual({});
  });
});

describe('a snapshot that fits none of the fields the screen binds to it', () => {
  it('is not sent, while one that fills a bound field is', async () => {
    const s = await setUp('sync-fit');
    const src = s.seed.dataSource;
    const template = { manifest: { fields: { temp: { type: 'number', label: 'Temperature' } } }, html: 'a'.repeat(64) };
    const spot = { id: 'w', kind: 'template', template: 'base/w@1.0.0', data: {}, bindings: { temp: { source: src, path: 'now.temp' } } };
    await publish(s, 'm-fit', {
      schema: MANIFEST_SCHEMA,
      dataSources: { [src]: { id: src, refreshS: 300 } },
      templates: { 'base/w@1.0.0': template },
      spots: { w: spot },
    });
    // The seeded snapshot is {"t":12}: nothing at now.temp.
    expect((await sync(s, body())).snapshots).toEqual([]);
    await s.seed.scope.dataSources.putSnapshot(src, { version: 'v2', fetchedAt: 2000, checkedAt: 2000, dataJson: '{"now":{"temp":"warm"}}' });
    expect((await sync(s, body())).snapshots).toEqual([]);
    await s.seed.scope.dataSources.putSnapshot(src, { version: 'v3', fetchedAt: 3000, checkedAt: 3000, dataJson: '{"now":{"temp":21}}' });
    expect((await sync(s, body())).snapshots).toMatchObject([{ id: src, version: 3000, data: { now: { temp: 21 } } }]);
  });
});

describe('commands', () => {
  it('tell a player that cannot play the desired manifest to reload', async () => {
    const s = await setUp('sync-reload');
    await publish(s, 'm-new', {
      schema: MANIFEST_SCHEMA,
      templates: { 'base/clock@1.1.0': { html: 'a'.repeat(64), manifest: { protocol: 2 } } },
    });
    expect((await sync(s, body())).commands).toEqual([]);
    const oldSchema = body({ player: { version: '1.0.0', manifestSchemas: [MANIFEST_SCHEMA - 1], protocols: [1, 2] } });
    expect((await sync(s, oldSchema)).commands).toEqual([{ type: 'reload' }]);
    const oldProtocol = body({ player: { version: '1.0.0', manifestSchemas: [MANIFEST_SCHEMA], protocols: [1] } });
    expect((await sync(s, oldProtocol)).commands).toEqual([{ type: 'reload' }]);
  });

  // Each schema bump: a template only the new schema allows, and the schemas the player before it reports.
  // Its validator refuses such a template in any manifest, so it must reload; a current player must not.
  const bumps: [issue: string, what: string, key: string, manifest: Record<string, unknown>, before: number[]][] = [
    ['#191', 'a url field', 'base/announcement@1.0.0', { fields: { qrUrl: { type: 'url', label: 'QR link', default: '' } } }, [3, 4]],
    [
      '#192',
      'date and datetime fields',
      'base/countdown@1.0.0',
      { fields: { day: { type: 'date', label: 'Day', default: '2026-11-27' }, target: { type: 'datetime', label: 'Target', default: '2026-11-27T18:00' } } },
      [4, 5],
    ],
    [
      '#193',
      'several live sources',
      'base/frame@1.0.0',
      {
        fields: {
          temp: { type: 'number', label: 'Temperature', default: 72 },
          items: { type: 'list', label: 'Headlines', item: { title: { type: 'text', label: 'Title' } } },
        },
        live: {
          sources: {
            weather: { label: 'Weather', source: 'open-meteo', fields: { temp: 'current.temperature_2m' } },
            headlines: { label: 'Headlines', source: 'rss', fields: { items: 'items' } },
          },
        },
      },
      [5, 6],
    ],
    [
      '#196',
      'an image property in a list item',
      'base/news@2.0.0',
      {
        fields: {
          items: {
            type: 'list',
            label: 'Headlines',
            default: [],
            item: { title: { type: 'text', label: 'Title' }, image: { type: 'image', label: 'Photo' } },
          },
        },
        live: { source: 'rss', fields: { items: 'items' } },
      },
      [6, 7],
    ],
  ];
  it.each(bumps)(
    'tell a player from before %s, which refuses %s, to reload for a template with them: a player that knows them is not',
    async (issue, _, key, manifest, before) => {
      const s = await setUp(`sync-bump-${issue.slice(1)}`);
      await publish(s, `m-${issue.slice(1)}`, {
        schema: MANIFEST_SCHEMA,
        templates: { [key]: { html: 'a'.repeat(64), manifest: { ...manifest, protocol: 2 } } },
      });
      expect((await sync(s, body({ player: { version: '1.0.0', manifestSchemas: before, protocols: [1, 2] } }))).commands).toEqual([{ type: 'reload' }]);
      expect((await sync(s, body())).commands).toEqual([]);
    },
  );

  it("carry the screen's display override while the screen reports another, and its clearing", async () => {
    const s = await setUp('sync-override');
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await s.seed.scope.screens.update(s.seed.screen, { displayOverrideJson: JSON.stringify({ state: 'on', until }) });
    expect((await sync(s, body())).commands).toEqual([{ type: 'display', override: { state: 'on', until } }]);
    // The screen has it now: nothing more to send.
    expect((await sync(s, body({ display: { on: true, override: { state: 'on', until } } }))).commands).toEqual([]);
    // Cleared in the CMS, while the screen still holds it.
    await s.seed.scope.screens.update(s.seed.screen, { displayOverrideJson: null });
    expect((await sync(s, body({ display: { on: true, override: { state: 'on', until } } }))).commands).toEqual([{ type: 'display', override: null }]);
    // An override that has ended is not sent.
    await s.seed.scope.screens.update(s.seed.screen, {
      displayOverrideJson: JSON.stringify({ state: 'off', until: new Date(Date.now() - 1000).toISOString() }),
    });
    expect((await sync(s, body())).commands).toEqual([]);
  });
});

describe('snapshot feed blobs (#196)', () => {
  const hash = (n: number) => n.toString(16).padStart(64, '0');
  const newsTemplate = (withImage: boolean) => ({
    html: 'a'.repeat(64),
    manifest: {
      protocol: 2,
      fields: {
        items: {
          type: 'list',
          label: 'Headlines',
          maxItems: 20,
          default: [],
          item: {
            title: { type: 'text', label: 'Title' },
            ...(withImage ? { image: { type: 'image', label: 'Photo' } } : {}),
          },
        },
      },
    },
  });

  it('sends only missing feed image hashes, even when the snapshot version is already held, and omits them once held', async () => {
    const s = await setUp('sync-feed-blobs');
    const src = s.seed.dataSource;
    await publish(s, 'm-news-img', {
      schema: MANIFEST_SCHEMA,
      dataSources: { [src]: { id: src, refreshS: 300 } },
      templates: { 'base/news@2.0.0': newsTemplate(true) },
      spots: {
        n: { id: 'n', kind: 'template', template: 'base/news@2.0.0', data: { items: [] }, bindings: { items: { source: src, path: 'items' } } },
      },
    });
    const [f1, t1, f2] = [hash(1), hash(2), hash(3)];
    await s.seed.scope.dataSources.putSnapshot(src, {
      version: 'v-img',
      fetchedAt: 5000,
      checkedAt: 5000,
      dataJson: JSON.stringify({
        title: 'Feed',
        language: 'en',
        items: [
          { title: 'Story 1', published: '', source: '', image: { file: f1, thumb: t1 } },
          // Same file & thumb hash: deduplicated.
          { title: 'Story 2', published: '', source: '', image: { file: f2, thumb: f2 } },
          { title: 'Story 3', published: '', source: '' },
        ],
      }),
    });

    const first = await sync(s, body());
    expect(first.snapshots).toHaveLength(1);
    expect(first.blobs).toEqual([f1, t1, f2]);

    // Screen holds snapshot and f1, still missing t1 and f2 (e.g. evicted): snapshot not re-sent, missing blobs are.
    const partial = await sync(s, body({ snapshots: { [src]: 5000 }, blobs: [f1] }));
    expect(partial.snapshots).toEqual([]);
    expect(partial.checked).toHaveProperty(src);
    expect(partial.blobs).toEqual([t1, f2]);

    // Screen holds all three: no blobs sent.
    const complete = await sync(s, body({ snapshots: { [src]: 5000 }, blobs: [f1, t1, f2] }));
    expect(complete.snapshots).toEqual([]);
    expect(complete.blobs).toBeUndefined();
  });

  it('caps missing blobs per sync at MAX_SYNC_RESPONSE_BLOBS and sends the rest once reported held', async () => {
    const s = await setUp('sync-feed-blobs-limit');
    const src1 = s.seed.dataSource;
    const src2 = (await s.seed.scope.dataSources.insert({ name: 'News 2', format: 'rss', urlEncrypted: 'enc:2', refreshS: 300 })).id;
    await publish(s, 'm-news-many', {
      schema: MANIFEST_SCHEMA,
      dataSources: { [src1]: { id: src1, refreshS: 300 }, [src2]: { id: src2, refreshS: 300 } },
      templates: { 'base/news@2.0.0': newsTemplate(true) },
      spots: {
        n1: { id: 'n1', kind: 'template', template: 'base/news@2.0.0', data: { items: [] }, bindings: { items: { source: src1, path: 'items' } } },
        n2: { id: 'n2', kind: 'template', template: 'base/news@2.0.0', data: { items: [] }, bindings: { items: { source: src2, path: 'items' } } },
      },
    });
    const makeItems = (offset: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        title: `Story ${offset + i}`,
        published: '',
        source: '',
        image: { file: hash(offset + i * 2 + 1), thumb: hash(offset + i * 2 + 2) },
      }));
    await s.seed.scope.dataSources.putSnapshot(src1, { version: 'v1', fetchedAt: 6000, checkedAt: 6000, dataJson: JSON.stringify({ items: makeItems(100) }) });
    await s.seed.scope.dataSources.putSnapshot(src2, { version: 'v1', fetchedAt: 6000, checkedAt: 6000, dataJson: JSON.stringify({ items: makeItems(200) }) });

    const r1 = await sync(s, body());
    expect(r1.blobs).toHaveLength(MAX_SYNC_RESPONSE_BLOBS);

    const r2 = await sync(s, body({ snapshots: { [src1]: 6000, [src2]: 6000 }, blobs: r1.blobs }));
    expect(r2.blobs).toHaveLength(40 - MAX_SYNC_RESPONSE_BLOBS);
    expect(new Set([...r1.blobs!, ...r2.blobs!]).size).toBe(40);

    const r3 = await sync(s, body({ snapshots: { [src1]: 6000, [src2]: 6000 }, blobs: [...r1.blobs!, ...r2.blobs!] }));
    expect(r3.blobs).toBeUndefined();
  });

  it('sends no feed blobs for a text-only template (news 1.4.1) or an outdated player, and refuses over-limit SyncRequest.blobs', async () => {
    const s = await setUp('sync-feed-blobs-text');
    const src = s.seed.dataSource;
    await publish(s, 'm-news-v1', {
      schema: MANIFEST_SCHEMA,
      dataSources: { [src]: { id: src, refreshS: 300 } },
      templates: { 'base/news@1.4.1': newsTemplate(false) },
      spots: {
        n: { id: 'n', kind: 'template', template: 'base/news@1.4.1', data: { items: [] }, bindings: { items: { source: src, path: 'items' } } },
      },
    });
    await s.seed.scope.dataSources.putSnapshot(src, {
      version: 'v1',
      fetchedAt: 7000,
      checkedAt: 7000,
      dataJson: JSON.stringify({ items: [{ title: 'Story', image: { file: hash(10), thumb: hash(11) } }] }),
    });
    const r = await sync(s, body());
    expect(r.snapshots).toHaveLength(1);
    expect(r.blobs).toBeUndefined();

    // Over MAX_SYNC_BLOBS in request is rejected with 400.
    const tooMany = await exports.default.fetch(`${BASE}/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body({ blobs: Array.from({ length: MAX_SYNC_BLOBS + 1 }, (_, i) => hash(i + 1)) })),
    });
    expect(tooMany.status).toBe(400);
  });
});
