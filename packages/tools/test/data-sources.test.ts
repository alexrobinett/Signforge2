// Data source tools (M3-23): CRUD over an org's feeds, with the feed URL sealed before it is stored.
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller, type FeedUrlSealer, type PlaceFinder, type TableReader, ToolError } from '../src';
import { memberOf } from './member';

let o: SeededOrg;
let owner: Caller;

/** Reversible, so a test can see what was sealed and for which source. */
const sealer: FeedUrlSealer = { seal: async (source, url) => `sealed:${source.orgId}/${source.id}:${url}` };

const call = async <T = any>(name: string, input: unknown): Promise<T> => {
  const r = await dispatch(registry, name, input, owner);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const refusal = (name: string, input: unknown, caller = owner) => dispatch(registry, name, input, caller);

beforeAll(async () => {
  o = await seedOrg(env.DB, 'feeds-org');
  owner = memberOf(testScope(env.DB, o.orgId), 'owner', { feedUrls: sealer });
});

describe('data sources', () => {
  it('creates a source with its URL sealed, never showing it', async () => {
    const { dataSource } = await call('create_data_source', {
      id: 'holidays',
      name: 'US holidays',
      format: 'ical',
      feedUrl: 'https://calendar.example.com/us.ics?key=private',
      refreshS: 3600,
      horizonDays: 120,
    });
    expect(dataSource).toMatchObject({ id: 'holidays', name: 'US holidays', format: 'ical', refreshS: 3600, horizonDays: 120, failures: 0 });
    expect(JSON.stringify(dataSource)).not.toContain('example.com');
    const row = await owner.org.dataSources.get('holidays');
    expect(row).toMatchObject({ urlEncrypted: 'sealed:feeds-org/holidays:https://calendar.example.com/us.ics?key=private', nextPollAt: 0 });
    // The audit log never holds the URL.
    expect(JSON.stringify(await owner.org.auditLog.list())).not.toContain('key=private');
  });

  it('lists and gets, with the latest snapshot', async () => {
    const { dataSources } = await call('list_data_sources', {});
    expect(dataSources.map((d: { id: string }) => d.id)).toContain('holidays');
    await owner.org.dataSources.putSnapshot('holidays', { version: 'h', fetchedAt: 1000, checkedAt: 2000, dataJson: '{"events":[]}' });
    expect(await call('get_data_source', { dataSourceId: 'holidays' })).toMatchObject({
      dataSource: { id: 'holidays' },
      snapshot: { id: 'holidays', version: 1000, fetchedAt: new Date(1000).toISOString(), checkedAt: new Date(2000).toISOString(), data: { events: [] } },
    });
  });

  it('lists each source with its last good check and the spots that bind it, as drafted or as published', async () => {
    await o.scope.spots.update(o.templateSpot, { bindingsJson: JSON.stringify({ title: { source: 'holidays', path: 'events.0.title' } }) });
    const { dataSources } = await call('list_data_sources', {});
    const holidays = dataSources.find((d: { id: string }) => d.id === 'holidays');
    expect(holidays).toMatchObject({ lastCheckedAt: 2000, spots: [{ id: o.templateSpot, name: expect.any(String) }] });
    expect(holidays).not.toHaveProperty('lastFetchedAt');
    const unpolled = await call('create_data_source', { id: 'unpolled', name: 'Not polled yet', format: 'rss', feedUrl: 'https://news.example.com/rss' });
    expect((await call('list_data_sources', {})).dataSources.find((d: { id: string }) => d.id === unpolled.dataSource.id)).toMatchObject({
      lastCheckedAt: null,
      spots: [],
    });
    await o.scope.spots.update(o.templateSpot, { bindingsJson: null });
    await call('delete_data_source', { dataSourceId: 'unpolled' });
  });

  it('updates, polling a changed URL afresh', async () => {
    await o.scope.dataSources.update('holidays', { etag: '"old"', failures: 3, lastError: 'timeout', nextPollAt: 99 });
    const { dataSource } = await call('update_data_source', { dataSourceId: 'holidays', feedUrl: 'https://other.example.com/h.ics', horizonDays: null });
    expect(dataSource).toMatchObject({ horizonDays: null, failures: 0, lastError: null });
    expect(await owner.org.dataSources.get('holidays')).toMatchObject({
      etag: null,
      nextPollAt: 0,
      urlEncrypted: 'sealed:feeds-org/holidays:https://other.example.com/h.ics',
    });
  });

  it("shows a news feed's photos unless they are switched off, and reads the feed afresh when they are", async () => {
    const { dataSource } = await call('create_data_source', { id: 'headlines', name: 'Headlines', format: 'rss', feedUrl: 'https://news.example.com/rss' });
    expect(dataSource).toMatchObject({ photos: true });
    await o.scope.dataSources.update('headlines', { etag: '"old"', nextPollAt: 99 });
    // Unchanged, it is no reason to read the feed again.
    await call('update_data_source', { dataSourceId: 'headlines', photos: true });
    expect(await owner.org.dataSources.get('headlines')).toMatchObject({ etag: '"old"', nextPollAt: 99 });
    const off = await call('update_data_source', { dataSourceId: 'headlines', photos: false });
    expect(off.dataSource).toMatchObject({ photos: false });
    expect(await owner.org.dataSources.get('headlines')).toMatchObject({ photos: false, etag: null, nextPollAt: 0 });
    expect((await call('create_data_source', { name: 'Quiet', format: 'rss', feedUrl: 'https://news.example.com/q', photos: false })).dataSource).toMatchObject({
      photos: false,
    });
    for (const id of ['headlines', (await owner.org.dataSources.list()).find((d) => d.name === 'Quiet')!.id]) await call('delete_data_source', { dataSourceId: id });
  });

  it('refuses the photos switch on anything but a news feed', async () => {
    expect(await refusal('create_data_source', { name: 'x', format: 'ical', feedUrl: 'https://a.example.com/c.ics', photos: false })).toMatchObject({
      error: 'invalid_input',
    });
    await call('create_data_source', { id: 'cal', name: 'Cal', format: 'ical', feedUrl: 'https://a.example.com/c.ics' });
    expect(await refusal('update_data_source', { dataSourceId: 'cal', photos: true })).toMatchObject({ error: 'invalid_input', message: 'photos is for rss sources only' });
    await call('delete_data_source', { dataSourceId: 'cal' });
  });

  it('refuses a feed URL the poller would refuse, before storing it', async () => {
    for (const feedUrl of ['http://feed.example.com/a', 'https://feed.example.com:8443/a', 'https://10.0.0.1/a', 'https://printer.local/a', 'nope'])
      expect(await refusal('create_data_source', { name: 'x', format: 'rss', feedUrl }), feedUrl).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('refuses a refresh faster than 5 minutes, and a look-ahead on anything but a calendar', async () => {
    expect(await refusal('create_data_source', { name: 'x', format: 'json', feedUrl: 'https://a.example.com/', refreshS: 60 })).toMatchObject({
      error: 'invalid_input',
    });
    expect(await refusal('create_data_source', { name: 'x', format: 'rss', feedUrl: 'https://a.example.com/', horizonDays: 10 })).toMatchObject({
      error: 'invalid_input',
    });
  });

  it('allows 10 sources per org', async () => {
    const have = (await owner.org.dataSources.list()).length;
    for (let i = have; i < 10; i++) await call('create_data_source', { name: `Feed ${i}`, format: 'json', feedUrl: `https://a.example.com/${i}` });
    expect(await refusal('create_data_source', { name: 'Eleventh', format: 'json', feedUrl: 'https://a.example.com/11' })).toMatchObject({
      ok: false,
      error: 'conflict',
    });
  });

  it('refuses to delete a source a spot binds, and deletes one no spot binds', async () => {
    await o.scope.spots.update(o.templateSpot, { bindingsJson: JSON.stringify({ title: { source: 'holidays', path: 'events.0.title' } }) });
    expect(await refusal('delete_data_source', { dataSourceId: 'holidays' })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { spotIds: [o.templateSpot] },
    });
    await o.scope.spots.update(o.templateSpot, { bindingsJson: null });
    expect(await call('delete_data_source', { dataSourceId: 'holidays' })).toEqual({ deleted: 'holidays' });
    expect(await owner.org.dataSources.snapshot('holidays')).toBeUndefined();
  });
});

describe('table sources', () => {
  it('adds a csv source, and a json-table source with the path to its rows, which only json-table takes', async () => {
    await call('delete_data_source', {
      dataSourceId: (await call('create_data_source', { name: 'x', format: 'json', feedUrl: 'https://a.example.com/x' })).dataSource.id,
    });
    const ids = (await owner.org.dataSources.list()).map((d) => d.id);
    for (const id of ids.slice(0, 2)) await o.scope.dataSources.delete(id);
    const { dataSource: csv } = await call('create_data_source', { id: 'menu', name: 'Menu', format: 'csv', feedUrl: 'https://menu.example.com/menu.csv' });
    expect(csv).toMatchObject({ format: 'csv', rowsPath: null });
    const { dataSource: json } = await call('create_data_source', {
      id: 'stock',
      name: 'Stock',
      format: 'json-table',
      feedUrl: 'https://shop.example.com/stock.json',
      rowsPath: 'data.items',
    });
    expect(json).toMatchObject({ format: 'json-table', rowsPath: 'data.items' });
    expect(await refusal('create_data_source', { name: 'x', format: 'csv', feedUrl: 'https://a.example.com/', rowsPath: 'a' })).toMatchObject({
      error: 'invalid_input',
      details: [{ path: 'rowsPath', message: 'rowsPath is for json-table sources only' }],
    });
    expect(await refusal('update_data_source', { dataSourceId: 'menu', rowsPath: 'a' })).toMatchObject({ error: 'invalid_input' });
  });

  it('polls a json-table source afresh when the path to its rows changes', async () => {
    await o.scope.dataSources.update('stock', { etag: '"e"', failures: 2, lastError: 'not-a-table', nextPollAt: 99 });
    expect(await call('update_data_source', { dataSourceId: 'stock', rowsPath: null })).toMatchObject({
      dataSource: { rowsPath: null, failures: 0, lastError: null },
    });
    expect(await owner.org.dataSources.get('stock')).toMatchObject({ etag: null, nextPollAt: 0 });
  });
});

describe('read_table', () => {
  const table = { columns: ['Item', 'Price'], rows: [['Soup', '4.50']] };
  const asked: unknown[] = [];
  const tables: TableReader = {
    read: async (source) => {
      asked.push(source);
      if (source.url.endsWith('bad.csv')) throw new ToolError('invalid_input', 'the file is not a table SignForge can read');
      return table;
    },
  };
  const rateLimit = async (bucket: string) => bucket === 'table_read';

  it('reads a table at a URL now, storing nothing, for a viewer too', async () => {
    const before = (await owner.org.dataSources.list()).length;
    const r = await dispatch(
      registry,
      'read_table',
      { feedUrl: 'https://menu.example.com/m.json', format: 'json-table', rowsPath: 'items' },
      { ...owner, role: 'viewer', services: { tables, rateLimit } },
    );
    expect(r).toEqual({ ok: true, output: { table } });
    expect(asked).toEqual([{ url: 'https://menu.example.com/m.json', format: 'json-table', rowsPath: 'items' }]);
    expect((await owner.org.dataSources.list()).length).toBe(before);
    expect(
      await dispatch(registry, 'read_table', { feedUrl: 'https://menu.example.com/bad.csv', format: 'csv' }, { ...owner, services: { tables, rateLimit } }),
    ).toMatchObject({
      ok: false,
      error: 'invalid_input',
      message: 'the file is not a table SignForge can read',
    });
  });

  it('refuses a URL the poller would refuse, a caller over its limit or with none, without fetching', async () => {
    asked.length = 0;
    expect(
      await dispatch(registry, 'read_table', { feedUrl: 'https://10.0.0.1/m.csv', format: 'csv' }, { ...owner, services: { tables, rateLimit } }),
    ).toMatchObject({
      error: 'invalid_input',
    });
    expect(
      await dispatch(
        registry,
        'read_table',
        { feedUrl: 'https://a.example.com/m.csv', format: 'csv' },
        { ...owner, services: { tables, rateLimit: async () => false } },
      ),
    ).toMatchObject({
      error: 'rate_limited',
    });
    expect(await dispatch(registry, 'read_table', { feedUrl: 'https://a.example.com/m.csv', format: 'csv' }, { ...owner, services: { tables } })).toMatchObject(
      {
        error: 'forbidden',
      },
    );
    expect(asked).toEqual([]);
  });
});

describe('find_places', () => {
  const atlanta = {
    id: 4180439,
    name: 'Atlanta',
    region: 'Georgia',
    country: 'United States',
    latitude: 33.749,
    longitude: -84.38798,
    timezone: 'America/New_York',
  };
  const places: PlaceFinder = { search: async (query) => (query.trim().toLowerCase() === 'atlanta' ? [atlanta] : []) };
  /** Every search the caller is let make, and the buckets it was counted in. */
  const counted: string[] = [];
  const rateLimit = async (bucket: string) => {
    counted.push(bucket);
    return true;
  };

  it('finds places by name, with what a weather source needs: coordinates and time zone', async () => {
    const r = await dispatch(registry, 'find_places', { query: '  Atlanta ' }, { ...owner, role: 'viewer', services: { places, rateLimit } });
    expect(r).toEqual({ ok: true, output: { places: [atlanta] } });
    expect(await dispatch(registry, 'find_places', { query: 'Nowhere' }, { ...owner, services: { places, rateLimit } })).toEqual({
      ok: true,
      output: { places: [] },
    });
  });

  it('counts each search against the caller, and refuses one over its limit, and refuses a caller with none, without asking the geocoder', async () => {
    let asked = 0;
    const counting: PlaceFinder = { search: async () => (asked++, [atlanta]) };
    counted.length = 0;
    await dispatch(registry, 'find_places', { query: 'Atlanta' }, { ...owner, services: { places: counting, rateLimit } });
    expect(counted).toEqual(['place_search']);
    expect(
      await dispatch(registry, 'find_places', { query: 'Atlanta' }, { ...owner, services: { places: counting, rateLimit: async () => false } }),
    ).toMatchObject({
      ok: false,
      error: 'rate_limited',
    });
    // No limiter is no rate to wait out: refused as claim_screen refuses it.
    expect(await dispatch(registry, 'find_places', { query: 'Atlanta' }, { ...owner, services: { places: counting } })).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(asked).toBe(1);
  });

  it('refuses a query too short to mean a place', async () => {
    expect(await dispatch(registry, 'find_places', { query: ' a ' }, { ...owner, services: { places, rateLimit } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });
});
