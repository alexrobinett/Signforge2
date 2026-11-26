// The sync (M3-07): one periodic call carries the heartbeat and play counts up, and the desired
// manifest, changed snapshots, a socket ticket, the server time and commands down.
import { MANIFEST_SCHEMA, MAX_SYNC_BLOBS, MAX_SYNC_REQUEST_BYTES, MAX_SYNC_RESPONSE_BLOBS, MAX_SYNC_SOURCES, type SyncRequest } from '@signforge/contract';
import { seedOrg, seedPlayerRelease, type SeededOrg } from '@signforge/db/testing';
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
        display: { on: false, methods: { cec: 'ok' }, output: { mode: '3840x2160@60', resets: 3 } },
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
      display: { on: false, methods: { cec: 'ok' }, output: { mode: '3840x2160@60', resets: 3 } },
      clock: { offsetMs: 3_600_000, trusted: true },
      dataRejected: { weather: 4 },
      player: { manifestSchemas: [MANIFEST_SCHEMA], protocols: [2] },
    });
    // The device clock is an hour slow: the drift the server saw is an hour.
    expect(beat!.driftMs).toBe(3_600_000);
  });

  it('keeps the player release the device supervisor rolled back with the heartbeat, only one its channel was offered and only from a device (#628)', async () => {
    const s = await setUp('sync-failed-release');
    const release = (version: number, channel: 'canary' | 'stable') =>
      seedPlayerRelease(env.DB, { version, sha256: String(version % 10).repeat(64), size: 1, manifest: '{}', signature: 'c2ln', channel });
    await release(42, 'stable');
    await release(43, 'canary');
    const beat = async () => parseHeartbeat((await s.seed.scope.screens.get(s.seed.screen))!.heartbeatJson)!.failedRelease;
    await sync(s, syncBody({ failedRelease: { version: 42, reason: 'not-alive' } }));
    expect(await beat()).toEqual({ version: 42, reason: 'not-alive' });
    // Not reported again: it has installed a newer release, or the report is spent.
    await sync(s, syncBody({ seq: 1 }));
    expect(await beat()).toBeUndefined();
    // A canary release on a stable screen, and a version no release has: never offered to it, so not kept.
    await sync(s, syncBody({ seq: 2, failedRelease: { version: 43, reason: 'stopped' } }));
    expect(await beat()).toBeUndefined();
    await sync(s, syncBody({ seq: 3, failedRelease: { version: 99, reason: 'stopped' } }));
    expect(await beat()).toBeUndefined();
    // A browser screen has no supervisor to roll anything back.
    await s.seed.scope.screens.update(s.seed.screen, { kind: 'browser' });
    await sync(s, syncBody({ seq: 4, failedRelease: { version: 42, reason: 'not-alive' } }));
    expect(await beat()).toBeUndefined();
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

  it("carry a calendar's stale age from its source as it is now, with no publish (#624)", async () => {
    const s = await setUp('sync-stale-age');
    const cal = await s.seed.scope.dataSources.insert({ name: 'Rooms', format: 'ical', urlEncrypted: 'enc:c', refreshS: 300 });
    await s.seed.scope.dataSources.putSnapshot(cal.id, { version: 'c1', fetchedAt: 1000, checkedAt: 1000, dataJson: '{"events":[]}' });
    await publish(s, 'm-cal', { schema: MANIFEST_SCHEMA, dataSources: { [cal.id]: { id: cal.id, refreshS: 300 } } });
    expect((await sync(s, body())).snapshots).toMatchObject([{ id: cal.id, staleS: 1500 }]);
    await s.seed.scope.dataSources.update(cal.id, { refreshS: 600 });
    expect((await sync(s, body({ snapshots: { [cal.id]: 1000 } }))).checked).toEqual({
      [cal.id]: { version: 1000, checkedAt: new Date(1000).toISOString(), staleS: 2400 },
    });
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

  it("caps missing blobs per sync at MAX_SYNC_RESPONSE_BLOBS, every feed's first stories first, and asks for a sync soon while more wait", async () => {
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
    // Not the first feed's ten stories and none of the second's (#476's demo: The Verge, after The Guardian, showed no
    // photo for a sync interval or more): the first five stories' photo and thumbnail of each.
    const firstFive = (offset: number) => Array.from({ length: 10 }, (_, i) => hash(offset + i + 1));
    expect(new Set(r1.blobs)).toEqual(new Set([...firstFive(100), ...firstFive(200)]));
    // More wait: the screen comes back for them in seconds, not at the next 5-minute sync.
    expect(r1.nextSyncS).toBe(15);

    const r2 = await sync(s, body({ snapshots: { [src1]: 6000, [src2]: 6000 }, blobs: r1.blobs }));
    expect(r2.blobs).toHaveLength(40 - MAX_SYNC_RESPONSE_BLOBS);
    expect(new Set([...r1.blobs!, ...r2.blobs!]).size).toBe(40);
    expect(r2.nextSyncS).toBe(300);

    const r3 = await sync(s, body({ snapshots: { [src1]: 6000, [src2]: 6000 }, blobs: [...r1.blobs!, ...r2.blobs!] }));
    expect(r3.blobs).toBeUndefined();
  });

  it('falling back, sends the photos of a feed the manifest playing binds before those only the broken one names (#464)', async () => {
    const s = await setUp('sync-feed-blobs-fallback');
    const shared = s.seed.dataSource;
    const broken = (await s.seed.scope.dataSources.insert({ name: 'Only in the broken one', format: 'rss', urlEncrypted: 'enc:b', refreshS: 300 })).id;
    const spot = (id: string, source: string) => ({
      id,
      kind: 'template',
      template: 'base/news@2.0.0',
      data: { items: [] },
      bindings: { items: { source, path: 'items' } },
    });
    const items = (offset: number, length = 10) =>
      Array.from({ length }, (_, i) => ({
        title: `Story ${offset + i}`,
        published: '',
        source: '',
        image: { file: hash(offset + i * 2 + 1), thumb: hash(offset + i * 2 + 2) },
      }));
    const templates = { 'base/news@2.0.0': newsTemplate(true) };
    // The good one, played to the end once: the screen reports it as its last good.
    await publish(s, OLD, { schema: MANIFEST_SCHEMA, dataSources: { [shared]: { id: shared, refreshS: 300 } }, templates, spots: { n: spot('n', shared) } });
    await sync(s, body({ manifest: { active: OLD, filesMissing: 0, lastGood: OLD }, snapshots: { [shared]: 6000 } }));
    // The feeds' photos come after: this fallback is the first sync to ask for them.
    await s.seed.scope.dataSources.putSnapshot(shared, { version: 'v1', fetchedAt: 6000, checkedAt: 6000, dataJson: JSON.stringify({ items: items(100) }) });
    await s.seed.scope.dataSources.putSnapshot(broken, {
      version: 'v1',
      fetchedAt: 6000,
      checkedAt: 6000,
      dataJson: JSON.stringify({ items: items(200, 15) }),
    });
    await publish(s, NEW, {
      schema: MANIFEST_SCHEMA,
      dataSources: { [shared]: { id: shared, refreshS: 300 }, [broken]: { id: broken, refreshS: 300 } },
      templates,
      spots: { n: spot('n', shared), x: spot('x', broken) },
    });
    const r = await sync(s, body({ manifest: { active: OLD, filesMissing: 0, fallbackFrom: NEW, lastGood: OLD }, snapshots: { [shared]: 6000 } }));
    expect(new Set(r.blobs)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => hash(100 + i + 1))));
    expect(r.nextSyncS).toBe(15);

    // The screen stores those: the broken one's 30 are asked for next, soon, as photos came in.
    const fallingBack = { manifest: { active: OLD, filesMissing: 0, fallbackFrom: NEW, lastGood: OLD }, snapshots: { [shared]: 6000 } };
    const r2 = await sync(s, body({ ...fallingBack, blobs: r.blobs }));
    expect(new Set(r2.blobs)).toEqual(new Set(Array.from({ length: 20 }, (_, i) => hash(200 + i + 1))));
    expect(r2.nextSyncS).toBe(15);
    // It keeps only the photos of what it plays, so it lacks as many as before: one retry, then the full interval, as
    // long as it falls back.
    expect((await sync(s, body({ ...fallingBack, blobs: r.blobs }))).nextSyncS).toBe(15);
    for (let i = 0; i < 2; i++) expect((await sync(s, body({ ...fallingBack, blobs: r.blobs }))).nextSyncS).toBe(300);
  });

  // Review of #514, round 3: as the player reports it while falling back, only the playing manifest's sources and the
  // photos its snapshots name; the broken one's feeds unreported, so their snapshots come with every reply.
  describe('falling back, as the player reports it', () => {
    /** The playing feed's 20 photos missing, and a feed only the broken manifest binds with `broken` photos. */
    async function fallingBack(name: string, broken: number) {
      const s = await setUp(name);
      const spot = (id: string, source: string) => ({
        id,
        kind: 'template',
        template: 'base/news@2.0.0',
        data: { items: [] },
        bindings: { items: { source, path: 'items' } },
      });
      const templates = { 'base/news@2.0.0': newsTemplate(true) };
      const playing = s.seed.dataSource;
      const only = (await s.seed.scope.dataSources.insert({ name: 'Broken only', format: 'rss', urlEncrypted: 'enc:x', refreshS: 300 })).id;
      const items = (offset: number, photos: number) =>
        Array.from({ length: photos / 2 }, (_, i) => ({
          title: `Story ${i}`,
          published: '',
          source: '',
          image: { file: hash(offset + 2 * i + 1), thumb: hash(offset + 2 * i + 2) },
        }));
      await publish(s, OLD, {
        schema: MANIFEST_SCHEMA,
        dataSources: { [playing]: { id: playing, refreshS: 300 } },
        templates,
        spots: { n: spot('n', playing) },
      });
      await sync(s, body({ manifest: { active: OLD, filesMissing: 0, lastGood: OLD }, snapshots: { [playing]: 6000 } }));
      await s.seed.scope.dataSources.putSnapshot(playing, {
        version: 'v1',
        fetchedAt: 6000,
        checkedAt: 6000,
        dataJson: JSON.stringify({ items: items(100, 20) }),
      });
      await s.seed.scope.dataSources.putSnapshot(only, {
        version: 'v1',
        fetchedAt: 6000,
        checkedAt: 6000,
        dataJson: JSON.stringify({ items: items(200, broken) }),
      });
      await publish(s, NEW, {
        schema: MANIFEST_SCHEMA,
        dataSources: { [playing]: { id: playing, refreshS: 300 }, [only]: { id: only, refreshS: 300 } },
        templates,
        spots: { n: spot('n', playing), x: spot('x', only) },
      });
      const plays = new Set(Array.from({ length: 20 }, (_, i) => hash(100 + i + 1)));
      const held: string[] = [];
      const replies = [];
      for (let i = 0; i < 8; i++) {
        const r = await sync(
          s,
          body({
            manifest: { active: OLD, filesMissing: 0, fallbackFrom: NEW, lastGood: OLD },
            snapshots: { [playing]: 6000 },
            ...(held.length && { blobs: [...held] }),
          }),
        );
        replies.push(r);
        // It keeps only the photos its held snapshots name.
        for (const sha of r.blobs ?? []) if (plays.has(sha) && !held.includes(sha)) held.push(sha);
      }
      return { first: replies[0]!, paces: replies.map((r) => r.nextSyncS), plays };
    }

    for (const [broken, paces] of [
      [30, [15, 15, 15, 300, 300, 300, 300, 300]],
      [20, [15, 300, 300, 300, 300, 300, 300, 300]],
      [8, [15, 300, 300, 300, 300, 300, 300, 300]],
    ] as const)
      it(`asks for the playing feed's photos first and settles, with ${broken} photos only the broken manifest binds`, async () => {
        const r = await fallingBack(`sync-fallback-${broken}`, broken);
        expect(new Set(r.first.blobs)).toEqual(r.plays);
        expect(r.paces).toEqual(paces);
      });
  });

  // Review of #514, round 3: a screen that cannot fetch its new manifest does not report its new feeds either, so
  // their snapshots come again with every reply; only the first brings their photos first and a sync soon.
  // #531: a screen past its retry, then a publish that swaps its feeds and leaves as many photos missing.
  it('asks soon after a publish that leaves exactly as many missing, past the retry', async () => {
    const s = await setUp('sync-equal-count');
    const before = await newsSources(s, OLD, 0, 2);
    const paces = [];
    for (let i = 0; i < 3; i++) paces.push((await sync(s, body({ snapshots: before.snapshots }))).nextSyncS);
    expect(paces).toEqual([15, 15, 300]);
    await newsSources(s, NEW, 2, 2);
    const r = await sync(s, body({ snapshots: before.snapshots }));
    expect(new Set(r.blobs)).toEqual(new Set([2, 3].flatMap((n) => photosOf(n).slice(0, 10))));
    expect(r.nextSyncS).toBe(15);
  });

  it('settles when a manifest that cannot be fetched adds feeds with more than 20 photos', async () => {
    const s = await setUp('sync-unfetched-manifest');
    const old = await newsSources(s, OLD, 0, 1);
    expect((await sync(s, body({ snapshots: old.snapshots, blobs: photosOf(0) }))).blobs).toBeUndefined();
    await newsSources(s, NEW, 1, 2, 10, old.ids);
    const paces = [];
    for (let i = 0; i < 6; i++) paces.push((await sync(s, body({ snapshots: old.snapshots, blobs: photosOf(0) }))).nextSyncS);
    expect(paces).toEqual([15, 15, 300, 300, 300, 300]);
    // #531: the feed it holds turns over. The new story's photos come first, the screen stores them and takes the
    // snapshot, and that costs one sync soon: the stuck feeds' snapshots, sent with every reply, count for nothing.
    const photos = photosOf(0);
    const lead = [hash(95_001), hash(95_002)];
    const items = Array.from({ length: 10 }, (_, i) => ({
      title: `Story ${i}`,
      published: '',
      source: '',
      image: i === 0 ? { file: lead[0], thumb: lead[1] } : { file: photos[2 * i], thumb: photos[2 * i + 1] },
    }));
    await s.seed.scope.dataSources.putSnapshot(old.ids[0]!, { version: 'v2', fetchedAt: 7000, checkedAt: 7000, dataJson: JSON.stringify({ items }) });
    const r = await sync(s, body({ snapshots: old.snapshots, blobs: photos }));
    expect(r.blobs!.slice(0, 2)).toEqual(lead);
    const after = { snapshots: { [old.ids[0]!]: 7000 }, blobs: [...lead, ...photos.slice(2)] };
    const turnover = [r.nextSyncS];
    for (let i = 0; i < 3; i++) turnover.push((await sync(s, body(after))).nextSyncS);
    expect(turnover).toEqual([300, 15, 300, 300]);
  });

  it('syncs at the full interval while the photos it was asked for never arrive, and soon again once they do', async () => {
    const s = await setUp('sync-feed-blobs-stuck');
    const ids = [s.seed.dataSource];
    for (const n of [2, 3]) ids.push((await s.seed.scope.dataSources.insert({ name: `News ${n}`, format: 'rss', urlEncrypted: `enc:${n}`, refreshS: 300 })).id);
    const spot = (id: string, source: string) => ({
      id,
      kind: 'template',
      template: 'base/news@2.0.0',
      data: { items: [] },
      bindings: { items: { source, path: 'items' } },
    });
    await publish(s, 'm-news-stuck', {
      schema: MANIFEST_SCHEMA,
      dataSources: Object.fromEntries(ids.map((id) => [id, { id, refreshS: 300 }])),
      templates: { 'base/news@2.0.0': newsTemplate(true) },
      spots: Object.fromEntries(ids.map((id, n) => [`n${n}`, spot(`n${n}`, id)])),
    });
    /** Source `n`'s photos are hashes 100n+1 to 100n+20, in story order. */
    const photos = (n: number) => Array.from({ length: 20 }, (_, i) => hash(100 * (n + 1) + i + 1));
    for (const [n, id] of ids.entries())
      await s.seed.scope.dataSources.putSnapshot(id, {
        version: 'v1',
        fetchedAt: 6000,
        checkedAt: 6000,
        dataJson: JSON.stringify({
          items: Array.from({ length: 10 }, (_, i) => ({
            title: `Story ${i}`,
            published: '',
            source: '',
            image: { file: photos(n)[2 * i], thumb: photos(n)[2 * i + 1] },
          })),
        }),
      });
    const held = { snapshots: Object.fromEntries(ids.map((id) => [id, 6000])) };

    const r1 = await sync(s, body(held));
    expect(r1.blobs).toHaveLength(MAX_SYNC_RESPONSE_BLOBS);
    expect(r1.nextSyncS).toBe(15);
    // The screen fetches none of them (a store that fails, photos it may not keep, or a reply lost on the way): one
    // retry soon, then the full interval.
    const r2 = await sync(s, body(held));
    expect(r2.nextSyncS).toBe(15);
    const r3 = await sync(s, body(held));
    expect(r3.nextSyncS).toBe(300);
    // The retry asks for the same 20, as its reply may have been lost (#531); after it, each ask starts after the photo
    // the last one ended on, so photos that never come cannot hold the front.
    expect(r2.blobs).toEqual(r1.blobs);
    const r4 = await sync(s, body(held));
    expect(r4.nextSyncS).toBe(300);
    expect(new Set([...r1.blobs!, ...r3.blobs!, ...r4.blobs!])).toEqual(new Set([0, 1, 2].flatMap(photos)));
    // Once those it was last asked for come in, soon again.
    expect((await sync(s, body({ ...held, blobs: r4.blobs }))).nextSyncS).toBe(15);
  });

  /** Source `n`'s photos, in story order: hashes 1000(n+1)+1 on. */
  const photosOf = (n: number, stories = 10) => Array.from({ length: 2 * stories }, (_, i) => hash(1000 * (n + 1) + i + 1));

  /**
   * News sources `from` to `from + count - 1` of `stories` stories (`photosOf`), bound with the sources `keep` to a
   * manifest the screen is to play.
   */
  async function newsSources(s: Screen, manifest: string, from: number, count: number, stories = 10, keep: string[] = []) {
    const fresh: string[] = [];
    for (let n = from; n < from + count; n++) {
      const id = (await s.seed.scope.dataSources.insert({ name: `News ${n}`, format: 'rss', urlEncrypted: `enc:${n}`, refreshS: 300 })).id;
      fresh.push(id);
      const photos = photosOf(n, stories);
      await s.seed.scope.dataSources.putSnapshot(id, {
        version: 'v1',
        fetchedAt: 6000,
        checkedAt: 6000,
        dataJson: JSON.stringify({
          items: Array.from({ length: stories }, (_, i) => ({
            title: `Story ${i}`,
            published: '',
            source: '',
            image: { file: photos[2 * i], thumb: photos[2 * i + 1] },
          })),
        }),
      });
    }
    const ids = [...keep, ...fresh];
    await publish(s, manifest, {
      schema: MANIFEST_SCHEMA,
      dataSources: Object.fromEntries(ids.map((id) => [id, { id, refreshS: 300 }])),
      templates: { 'base/news@2.0.0': newsTemplate(true) },
      spots: Object.fromEntries(
        ids.map((id, n) => [
          `n${n}`,
          { id: `n${n}`, kind: 'template', template: 'base/news@2.0.0', data: { items: [] }, bindings: { items: { source: id, path: 'items' } } },
        ]),
      ),
    });
    return { ids, snapshots: Object.fromEntries(ids.map((id) => [id, 6000])) };
  }

  // #496: the player reports only the photos of what it plays, so the count it holds falls when a publish swaps feeds.
  it('keeps asking soon while the count still missing falls, though the count held does not rise', async () => {
    const s = await setUp('sync-feed-blobs-swap');
    // One feed's 20 photos, all held.
    const before = await newsSources(s, OLD, 0, 1);
    expect((await sync(s, body({ snapshots: before.snapshots, blobs: photosOf(0) }))).blobs).toBeUndefined();
    // Swapped for three feeds; until it adopts them it still reports the old feed's 20.
    const after = await newsSources(s, NEW, 1, 3);
    const r1 = await sync(s, body({ snapshots: before.snapshots, blobs: photosOf(0) }));
    expect(r1.nextSyncS).toBe(15);
    // It plays the new manifest and holds the 20 it was sent: as many as before, but 20 fewer missing.
    const r2 = await sync(s, body({ snapshots: after.snapshots, blobs: r1.blobs }));
    expect(r2.nextSyncS).toBe(15);
    const r3 = await sync(s, body({ snapshots: after.snapshots, blobs: [...r1.blobs!, ...r2.blobs!] }));
    expect(r3.blobs).toHaveLength(20);
    expect(r3.nextSyncS).toBe(300);
  });

  // #496: a photo that never downloads leaves an ask standing; a publish that adds many must not wait an interval.
  it('asks soon after a publish adds photos, though a photo asked for before never came', async () => {
    const s = await setUp('sync-feed-blobs-standing');
    const one = await newsSources(s, OLD, 0, 1);
    const stuck = photosOf(0).slice(0, -1);
    for (let i = 0; i < 3; i++)
      expect(await sync(s, body({ snapshots: one.snapshots, blobs: stuck }))).toMatchObject({ blobs: [photosOf(0).at(-1)], nextSyncS: 300 });
    await newsSources(s, NEW, 1, 2, 10, one.ids);
    // The reply that sends the new feeds' snapshots asks for their photos first, and soon for the rest.
    const r = await sync(s, body({ snapshots: one.snapshots, blobs: stuck }));
    expect(r.blobs).toEqual(expect.arrayContaining([photosOf(1)[0], photosOf(2)[0]]));
    expect(r.blobs).toHaveLength(MAX_SYNC_RESPONSE_BLOBS);
    expect(r.nextSyncS).toBe(15);
  });

  // #496: a screen reports at most MAX_SYNC_BLOBS photos, so those it holds past that look missing; the ask moves on
  // past them rather than asking for the same ones each time.
  it('reaches the deepest photos of a screen holding more than it can report', async () => {
    const s = await setUp('sync-feed-blobs-deep');
    const feeds = await newsSources(s, OLD, 0, 8, 20);
    const all = Array.from({ length: 8 }, (_, n) => photosOf(n, 20)).flat();
    expect(all).toHaveLength(320);
    // It lacks only the last story of the last two feeds, and reports the first MAX_SYNC_BLOBS it holds.
    const lacking = [...photosOf(6, 20).slice(-2), ...photosOf(7, 20).slice(-2)];
    const report = { snapshots: feeds.snapshots, blobs: all.filter((sha) => !lacking.includes(sha)).slice(0, MAX_SYNC_BLOBS) };
    const asked = new Set<string>();
    // 64 look missing, 20 an ask, the second reply its retry of the first: every one is asked for within five replies.
    for (let i = 0; i < 5; i++) for (const sha of (await sync(s, body(report))).blobs ?? []) asked.add(sha);
    expect(asked).toEqual(new Set(all.filter((sha) => !report.blobs.includes(sha))));
  });

  // Review of #514: a screen holding more than it can report spends its retry once, and a feed's turnover costs it at
  // most one sync soon, once it fetches the new story's photos.
  describe('a feed turning over on a screen holding more than it can report', () => {
    /** 8 feeds of 20 stories, the screen holding all 320 photos and reporting the first MAX_SYNC_BLOBS. */
    async function overCap(name: string) {
      const s = await setUp(name);
      const feeds = await newsSources(s, OLD, 0, 8, 20);
      const all = Array.from({ length: 8 }, (_, n) => photosOf(n, 20)).flat();
      const paces: number[] = [];
      for (let i = 0; i < 3; i++) paces.push((await sync(s, body({ snapshots: feeds.snapshots, blobs: all.slice(0, MAX_SYNC_BLOBS) }))).nextSyncS);
      return { s, feeds, all, paces };
    }

    /** Feed `n`'s lead story replaced, at version 7000: its two new photos. */
    async function turnOver(s: Screen, feeds: { ids: string[] }, n: number) {
      const fresh = [hash(90_000 + 2 * n + 1), hash(90_000 + 2 * n + 2)];
      const old = photosOf(n, 20);
      const items = Array.from({ length: 20 }, (_, i) => ({
        title: `Story ${i}`,
        published: '',
        source: '',
        image: i === 0 ? { file: fresh[0], thumb: fresh[1] } : { file: old[2 * i], thumb: old[2 * i + 1] },
      }));
      await s.seed.scope.dataSources.putSnapshot(feeds.ids[n]!, { version: 'v2', fetchedAt: 7000, checkedAt: 7000, dataJson: JSON.stringify({ items }) });
      return { fresh, gone: old.slice(0, 2) };
    }

    it('costs one sync soon when the screen fetches the new photos', async () => {
      const { s, feeds, all, paces: before } = await overCap('sync-turnover-fetches');
      // Its first ask, its one retry, then the full interval: nothing it is asked for shows as held.
      expect(before).toEqual([15, 15, 300]);
      const { fresh, gone } = await turnOver(s, feeds, 0);
      // The reply that sends the snapshot asks for the new story's photos first.
      const r1 = await sync(s, body({ snapshots: feeds.snapshots, blobs: all.slice(0, MAX_SYNC_BLOBS) }));
      expect(r1.blobs!.slice(0, 2)).toEqual(fresh);
      expect(r1.nextSyncS).toBe(300);
      // It adopts the snapshot and stores them, reporting in manifest order: the new two in place of the old.
      const held = all.flatMap((sha) => (sha === gone[0] ? [fresh[0]!] : sha === gone[1] ? [fresh[1]!] : [sha])).slice(0, MAX_SYNC_BLOBS);
      const after = { snapshots: { ...feeds.snapshots, [feeds.ids[0]!]: 7000 }, blobs: held };
      const paces = [];
      for (let i = 0; i < 3; i++) paces.push((await sync(s, body(after))).nextSyncS);
      expect(paces).toEqual([15, 300, 300]);
    });

    it('costs none when it does not', async () => {
      const { s, feeds, all } = await overCap('sync-turnover-stuck');
      await turnOver(s, feeds, 0);
      const paces = [];
      for (let i = 0; i < 3; i++) paces.push((await sync(s, body({ snapshots: feeds.snapshots, blobs: all.slice(0, MAX_SYNC_BLOBS) }))).nextSyncS);
      expect(paces).toEqual([300, 300, 300]);
    });

    it('costs one sync soon on a screen with photos it never fetches, under the cap too', async () => {
      const s = await setUp('sync-turnover-under-cap');
      const feeds = await newsSources(s, OLD, 0, 3, 20);
      const stuck = { snapshots: feeds.snapshots };
      const before = [];
      for (let i = 0; i < 3; i++) before.push((await sync(s, body(stuck))).nextSyncS);
      expect(before).toEqual([15, 15, 300]);
      const { fresh } = await turnOver(s, feeds, 0);
      expect((await sync(s, body(stuck))).blobs!.slice(0, 2)).toEqual(fresh);
      // It stores the new story's two, and nothing else.
      const after = { snapshots: { ...feeds.snapshots, [feeds.ids[0]!]: 7000 }, blobs: fresh };
      const paces = [];
      for (let i = 0; i < 3; i++) paces.push((await sync(s, body(after))).nextSyncS);
      expect(paces).toEqual([15, 300, 300]);
    });

    it("asks for a new story's photos with its snapshot in a feed past the photos reported", async () => {
      const { s, feeds, all } = await overCap('sync-turnover-deep');
      const { fresh } = await turnOver(s, feeds, 7);
      const r = await sync(s, body({ snapshots: feeds.snapshots, blobs: all.slice(0, MAX_SYNC_BLOBS) }));
      expect(r.blobs!.slice(0, 2)).toEqual(fresh);
    });

    // #531: the reply carrying a turnover is lost, so the screen syncs again as before it.
    it("asks for a new story's photos first again on the next sync, when that reply was lost, at no sync soon more", async () => {
      const { s, feeds, all, paces: pre } = await overCap('sync-turnover-lost');
      expect(pre).toEqual([15, 15, 300]);
      const { fresh } = await turnOver(s, feeds, 7);
      const before = { snapshots: feeds.snapshots, blobs: all.slice(0, MAX_SYNC_BLOBS) };
      const replies = [];
      for (let i = 0; i < 3; i++) replies.push(await sync(s, body(before)));
      expect(replies.map((r) => r.blobs!.slice(0, 2))).toEqual([fresh, fresh, expect.not.arrayContaining(fresh)]);
      // The feed past the 256 looks wholly missing, so its new snapshot's photos buy one sync soon; sent again, none.
      expect(replies.map((r) => r.nextSyncS)).toEqual([15, 300, 300]);
    });
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
