// A CSV or JSON link mapped onto a list field (#84), end to end on the server: a published
// menu-board spot binds its items to a csv source, the poller reads the file through the guards,
// the screen's sync carries the snapshot, and the player's own rule (player-core) fills the items.
// No network: the file is served by stubbed guards, and the clock is a parameter.
import { MANIFEST_SCHEMA, type Spot, type SyncResponse, templateKey, type TemplateManifest } from '@signforge/contract';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { resolveSpotData } from '@signforge/player-core';
import { ToolError } from '@signforge/tools';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import menuBoard from '@signforge/template-menu-board/template.json';
import { feedUrlSealer } from '../src/data/cipher';
import { feedGuards, type FetchGuards } from '../src/data/fetch';
import { pollDataSources } from '../src/data/poller';
import { tableReader } from '../src/data/tables';
import { mintCredential } from '../src/device/credential';
import { manifestKey } from '../src/r2';
import { Client, clockLimits, email, nextIp, testApp } from './client';
import { syncAs, syncBody } from './sync-client';

const NOW = Date.UTC(2026, 11, 1, 12);
const MIN = 60_000;
const URL_ = 'https://menu.test/menu.csv';
const manifest: TemplateManifest = JSON.parse(JSON.stringify(menuBoard));
const MAX = 12;

/** A CSV of `n` mains, 2x maxItems by default, with prices `price(i)`. */
const csv = (n = 2 * MAX, price = (i: number) => `${(4 + i / 4).toFixed(2)}`, header = 'Item,Price,Section,Tag') =>
  [header, ...Array.from({ length: n }, (_, i) => `Dish ${i + 1},${price(i)},${i % 2 ? 'Mains' : 'Starters'},${i === 0 ? 'vegan' : ''}`)].join('\r\n');

/** Guards that serve `file()` at URL_, and count the requests. */
function serving(file: () => string): FetchGuards & { requests: number } {
  const g = {
    requests: 0,
    resolve: async () => ['93.184.216.34'],
    fetch: async (input: RequestInfo | URL) => {
      g.requests++;
      return String(input instanceof Request ? input.url : input) === URL_ ? new Response(file()) : new Response('nope', { status: 404 });
    },
  };
  return g;
}

let o: SeededOrg;
let credential: string;
let src: string;
let spot: Extract<Spot, { kind: 'template' }>;
const key = templateKey(manifest);

const binding = { source: '', path: 'rows', table: { columns: { name: 'Item', price: 'Price', tag: 'Tag' } } };

beforeAll(async () => {
  o = await seedOrg(env.DB, 'tables-org');
  await o.scope.dataSources.update(o.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
  const { credential: c, secretHash } = await mintCredential(o.screen);
  await o.scope.screens.credentials.insert({ screenId: o.screen, secretHash });
  credential = c;
  src = 'tables-org-menu';
  await o.scope.dataSources.insert({
    id: src,
    name: 'Menu',
    format: 'csv',
    urlEncrypted: await feedUrlSealer(env).seal({ orgId: o.orgId, id: src }, URL_),
    refreshS: 300,
    nextPollAt: NOW,
  });
  binding.source = src;
  // The published spot the poller checks the file against: menu-board, items from the table.
  const version = await o.scope.templates.versions.insert({
    templateId: o.template,
    version: manifest.version,
    manifestJson: JSON.stringify(manifest),
    bundleSha256: 'e'.repeat(64),
    status: 'approved',
  });
  const fallback = { title: 'Menu', items: [{ name: 'Soup of the day', price: '$5' }] };
  const row = await o.scope.spots.update(o.templateSpot, {
    templateVersionId: version.id,
    dataJson: JSON.stringify(fallback),
    bindingsJson: JSON.stringify({ items: binding }),
  });
  await o.scope.commit(o.scope.spots.stage.publish(row!).writes);
  // What the screen plays: the same spot, as the compiler writes it.
  spot = { id: 'menu', name: 'Menu', kind: 'template', template: key, durationMs: 12_000, data: fallback, assets: {}, bindings: { items: binding } };
  const m = {
    id: 'm-menu',
    schema: MANIFEST_SCHEMA,
    files: {},
    templates: { [key]: { manifest, html: 'e'.repeat(64) } },
    dataSources: { [src]: { id: src, refreshS: 300 } },
    spots: { menu: spot },
    screen: { id: o.screen, name: 'Lobby', timezone: 'America/New_York', locale: 'en-US', orientation: 'landscape' },
  };
  await env.BLOBS.put(manifestKey(o.orgId, o.screen, m.id), JSON.stringify(m));
  await o.scope.screens.setDesiredManifest(o.screen, m.id);
});

const poll = (guards: FetchGuards, at: number) => pollDataSources(env, { now: at, guards });

const sync = (held: Record<string, number> = {}) => syncAs(credential, syncBody({ snapshots: held }));

/** What the screen draws for the spot, from the snapshots it holds. */
const played = (snapshots: SyncResponse['snapshots'], at: number) =>
  resolveSpotData(spot, manifest.fields, new Map(snapshots.map((s) => [s.id, s])), at, true, 'en-US').data.items as {
    name: string;
    price: string;
    tag: string;
  }[];

describe('a menu-board spot fed by a CSV link', () => {
  let held: SyncResponse['snapshots'] = [];
  let file = csv();
  const guards = serving(() => file);

  it('plays maxItems of its rows after the first poll and sync, prices and tags as the file has them', async () => {
    await poll(guards, NOW);
    expect(await o.scope.dataSources.get(src)).toMatchObject({ failures: 0, lastError: null });
    held = (await sync()).snapshots;
    expect(held).toMatchObject([{ id: src, data: { columns: ['Item', 'Price', 'Section', 'Tag'] } }]);
    expect(held[0]?.data).toHaveProperty('rows.length', 2 * MAX);
    const items = played(held, NOW);
    expect(items).toHaveLength(MAX);
    expect(items[0]).toEqual({ name: 'Dish 1', price: '4.00', description: '', tag: 'Vegan' });
  });

  it('plays the edited file after the next poll and sync', async () => {
    file = csv(2 * MAX, (i) => `$${10 + i}`);
    await poll(guards, NOW + 5 * MIN);
    const next = (await sync(Object.fromEntries(held.map((s) => [s.id, s.version])))).snapshots;
    expect(next).toHaveLength(1);
    held = next;
    expect(played(held, NOW + 5 * MIN)[1]).toEqual({ name: 'Dish 2', price: '$11', description: '', tag: '' });
  });

  it('fails as malformed, missing-column or too-large, with the last good snapshot kept and nothing new sent', async () => {
    const versions = Object.fromEntries(held.map((s) => [s.id, s.version]));
    const cases: [string, string][] = [
      ['Item,Price,Section,Tag\r\n"Dish 1,4,Mains,\r\n', 'malformed'],
      [csv(3, undefined, 'Dish,Price,Section,Tag'), 'missing-column'],
      [csv(3000), 'too-large'],
      // 20 kB, short rows under a 3000-column header: refused before 9M cells are built.
      [[Array.from({ length: 3000 }, (_, i) => `c${i}`).join(','), ...Array(3000).fill('x')].join('\n'), 'too-large'],
      // Every row read, none fits (each price longer than the item's 10): not an empty menu.
      [csv(4, () => 'Twelve dollars fifty'), 'unfit'],
    ];
    let at = NOW + 10 * MIN;
    for (const [body, error] of cases) {
      file = body;
      await o.scope.dataSources.update(src, { nextPollAt: at });
      await poll(guards, at);
      expect(await o.scope.dataSources.get(src), error).toMatchObject({ lastError: error });
      expect((await sync(versions)).snapshots).toEqual([]);
      at += 10 * MIN;
    }
    expect(played(held, at)[1]?.price).toBe('$11');
  });
});

describe('a player from before #84', () => {
  it("is told to reload to play menu-board 1.3.0's table source, which it would refuse: a player that knows it is not", async () => {
    // What master's player reports before #84: schemas 2 and 3. Menu-board 1.3.0 declares live.source 'table', which its validator refuses.
    const before = await syncAs(credential, syncBody({ player: { version: '1.0.0', manifestSchemas: [2, 3], protocols: [1, 2] } }));
    expect(before.commands).toEqual([{ type: 'reload' }]);
    expect((await sync()).commands).toEqual([]);
  });
});

describe('read_table', () => {
  it('reads what the poller would, and says why it cannot in words, never echoing the file', async () => {
    const guards = serving(() => 'Item,Price\nTea,2\n');
    expect(await tableReader(guards).read({ url: URL_, format: 'csv' })).toEqual({ columns: ['Item', 'Price'], rows: [['Tea', '2']] });
    const refusal = await tableReader(serving(() => '{"secret":"abc"}'))
      .read({ url: URL_, format: 'json-table', rowsPath: 'items' })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ToolError);
    expect(refusal).toMatchObject({
      code: 'invalid_input',
      message: 'Could not read the table: the JSON is not a list of objects at that path',
      details: { reason: 'not-a-table' },
    });
    expect(JSON.stringify(refusal)).not.toContain('abc');
    // 71 kB of objects each with a key of its own: 36M cells, refused before they are built.
    const sparse = JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ [`k${i}`]: 1 })));
    await expect(tableReader(serving(() => sparse)).read({ url: URL_, format: 'json-table' })).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Could not read the table: the file is larger than a screen may hold',
      details: { reason: 'too-large' },
    });
    const local = await tableReader({ ...guards, resolve: async () => ['10.0.0.8'] })
      .read({ url: URL_, format: 'csv' })
      .catch((e: unknown) => e);
    expect(local).toMatchObject({ code: 'invalid_input', details: { reason: 'private-address' } });
  });

  it('in dev only, sends every feed to FEED_STUB_URL, keeping the path, with the URL checks run on what was typed', async () => {
    const asked: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response('A\n1\n');
    };
    const stubbed = feedGuards({ ENVIRONMENT: 'dev', FEED_STUB_URL: 'http://127.0.0.1:9' }, fetcher);
    expect(await tableReader(stubbed).read({ url: 'https://menu.test/a/menu.csv?v=2', format: 'csv' })).toEqual({ columns: ['A'], rows: [['1']] });
    expect(asked).toEqual(['http://127.0.0.1:9/a/menu.csv?v=2']);
    await expect(tableReader(stubbed).read({ url: 'https://printer.local/menu.csv', format: 'csv' })).rejects.toMatchObject({
      details: { reason: 'private-address' },
    });
    // Anywhere else the stub is never read: the real DNS lookup comes first.
    asked.length = 0;
    await tableReader(feedGuards({ ENVIRONMENT: 'prod', FEED_STUB_URL: 'http://127.0.0.1:9' }, fetcher))
      .read({ url: 'https://menu.test/menu.csv', format: 'csv' })
      .catch(() => undefined);
    expect(asked[0]).toMatch(/^https:\/\/cloudflare-dns\.com\//);
  });
});

describe('read_table through /api/tools', () => {
  const t = testApp();

  it('lets one member read 30 tables a minute, then refuses with rate_limited until the next minute', async () => {
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime('2026-11-20T12:00:00Z');
    const member = new Client(t, nextIp(), clockLimits());
    await member.signIn(email('table-reader'));
    await member.setActive((await member.createOrg('Reader')).id);
    // Feeds go to a closed local port in the tests (vitest.config.ts): an allowed read fails upstream, as invalid_input.
    for (let i = 0; i < 30; i++) expect((await member.tool('read_table', { feedUrl: URL_, format: 'csv' })).status, `read ${i + 1}`).toBe(400);
    vi.setSystemTime('2026-11-20T12:00:59.999Z');
    const refused = await member.tool('read_table', { feedUrl: URL_, format: 'csv' });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: 'rate_limited' });
    vi.setSystemTime('2026-11-20T12:01:00Z');
    expect((await member.tool('read_table', { feedUrl: URL_, format: 'csv' })).status).toBe(400);
  });
});
