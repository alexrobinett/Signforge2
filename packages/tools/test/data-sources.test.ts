// Data source tools (M3-23): CRUD over an org's feeds, with the feed URL sealed before it is stored.
import { contentJson } from '@signforge/db';
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller, type FeedUrlSealer, type PlaceFinder, type Scope, type TableReader, ToolError } from '../src';
import { racing, unlimited } from './calls';
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
    const { dataSource } = await call('save_data_source', {
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

  it('polls a news feed hourly by default, and the rest every five minutes; a person may still choose faster (#339)', async () => {
    const rss = await call('save_data_source', { name: 'Hourly news', format: 'rss', feedUrl: 'https://news.example.com/hourly' });
    expect(rss.dataSource).toMatchObject({ format: 'rss', refreshS: 3600 });
    const json = await call('save_data_source', { name: 'Five-minute data', format: 'json', feedUrl: 'https://data.example.com/five' });
    expect(json.dataSource).toMatchObject({ format: 'json', refreshS: 300 });
    const fast = await call('save_data_source', { name: 'Fast news', format: 'rss', feedUrl: 'https://news.example.com/fast', refreshS: 300 });
    expect(fast.dataSource).toMatchObject({ format: 'rss', refreshS: 300 });
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
    const unpolled = await call('save_data_source', { id: 'unpolled', name: 'Not polled yet', format: 'rss', feedUrl: 'https://news.example.com/rss' });
    expect((await call('list_data_sources', {})).dataSources.find((d: { id: string }) => d.id === unpolled.dataSource.id)).toMatchObject({
      lastCheckedAt: null,
      spots: [],
    });
    await o.scope.spots.update(o.templateSpot, { bindingsJson: null });
    await call('delete', { type: 'data_source', id: 'unpolled' });
  });

  it('updates, polling a changed URL afresh', async () => {
    await o.scope.dataSources.update('holidays', { etag: '"old"', failures: 3, lastError: 'timeout', nextPollAt: 99 });
    const { dataSource } = await call('save_data_source', { dataSourceId: 'holidays', feedUrl: 'https://other.example.com/h.ics', horizonDays: null });
    expect(dataSource).toMatchObject({ horizonDays: null, failures: 0, lastError: null });
    expect(await owner.org.dataSources.get('holidays')).toMatchObject({
      etag: null,
      nextPollAt: 0,
      urlEncrypted: 'sealed:feeds-org/holidays:https://other.example.com/h.ics',
    });
  });

  it("shows a news feed's photos unless they are switched off, and reads the feed afresh when they are", async () => {
    const { dataSource } = await call('save_data_source', { id: 'headlines', name: 'Headlines', format: 'rss', feedUrl: 'https://news.example.com/rss' });
    expect(dataSource).toMatchObject({ photos: true });
    await o.scope.dataSources.update('headlines', { etag: '"old"', nextPollAt: 99 });
    // Unchanged, it is no reason to read the feed again.
    await call('save_data_source', { dataSourceId: 'headlines', photos: true });
    expect(await owner.org.dataSources.get('headlines')).toMatchObject({ etag: '"old"', nextPollAt: 99 });
    const off = await call('save_data_source', { dataSourceId: 'headlines', photos: false });
    expect(off.dataSource).toMatchObject({ photos: false });
    expect(await owner.org.dataSources.get('headlines')).toMatchObject({ photos: false, etag: null, nextPollAt: 0 });
    expect((await call('save_data_source', { name: 'Quiet', format: 'rss', feedUrl: 'https://news.example.com/q', photos: false })).dataSource).toMatchObject({
      photos: false,
    });
    for (const id of ['headlines', (await owner.org.dataSources.list()).find((d) => d.name === 'Quiet')!.id])
      await call('delete', { type: 'data_source', id: id });
  });

  it('refuses the photos switch on anything but a news feed', async () => {
    expect(await refusal('save_data_source', { name: 'x', format: 'ical', feedUrl: 'https://a.example.com/c.ics', photos: false })).toMatchObject({
      error: 'invalid_input',
    });
    await call('save_data_source', { id: 'cal', name: 'Cal', format: 'ical', feedUrl: 'https://a.example.com/c.ics' });
    expect(await refusal('save_data_source', { dataSourceId: 'cal', photos: true })).toMatchObject({
      error: 'invalid_input',
      message: 'photos is for rss sources only',
    });
    await call('delete', { type: 'data_source', id: 'cal' });
  });

  it('shows photos off for anything but a news feed, stored so, and as read from a row stored before (#345)', async () => {
    const { dataSource } = await call('save_data_source', { id: 'forecast', name: 'Forecast', format: 'json', feedUrl: 'https://api.example.com/f.json' });
    expect(dataSource).toMatchObject({ photos: false });
    expect(await owner.org.dataSources.get('forecast')).toMatchObject({ photos: false });
    // A row stored with the old default, true: read as off all the same.
    await o.scope.dataSources.update('forecast', { photos: true });
    const listed = await call('list_data_sources', {});
    expect(listed.dataSources.find((d: { id: string }) => d.id === 'forecast')).toMatchObject({ photos: false });
    await call('delete', { type: 'data_source', id: 'forecast' });
  });

  it('refuses a feed URL the poller would refuse, before storing it', async () => {
    for (const feedUrl of ['http://feed.example.com/a', 'https://feed.example.com:8443/a', 'https://10.0.0.1/a', 'https://printer.local/a', 'nope'])
      expect(await refusal('save_data_source', { name: 'x', format: 'rss', feedUrl }), feedUrl).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('refuses a refresh faster than 5 minutes, and a look-ahead on anything but a calendar', async () => {
    expect(await refusal('save_data_source', { name: 'x', format: 'json', feedUrl: 'https://a.example.com/', refreshS: 60 })).toMatchObject({
      error: 'invalid_input',
    });
    expect(await refusal('save_data_source', { name: 'x', format: 'rss', feedUrl: 'https://a.example.com/', horizonDays: 10 })).toMatchObject({
      error: 'invalid_input',
    });
  });

  it('allows 10 sources per org', async () => {
    const have = (await owner.org.dataSources.list()).length;
    for (let i = have; i < 10; i++) await call('save_data_source', { name: `Feed ${i}`, format: 'json', feedUrl: `https://a.example.com/${i}` });
    // With the cap in its details, which the spot editor tells from another conflict by (review of #546).
    expect(await refusal('save_data_source', { name: 'Eleventh', format: 'json', feedUrl: 'https://a.example.com/11' })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { max: 10 },
    });
  });

  it('refuses to delete a source a spot binds, and deletes one no spot binds', async () => {
    await o.scope.spots.update(o.templateSpot, { bindingsJson: JSON.stringify({ title: { source: 'holidays', path: 'events.0.title' } }) });
    expect(await refusal('delete', { type: 'data_source', id: 'holidays' })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { spotIds: [o.templateSpot] },
    });
    await o.scope.spots.update(o.templateSpot, { bindingsJson: null });
    expect(await call('delete', { type: 'data_source', id: 'holidays' })).toEqual({ deleted: 'holidays', version: null });
    expect(await owner.org.dataSources.snapshot('holidays')).toBeUndefined();
  });
});

describe('table sources', () => {
  it('adds a csv source, and a json-table source with the path to its rows, which only json-table takes', async () => {
    await call('delete', {
      type: 'data_source',
      id: (await call('save_data_source', { name: 'x', format: 'json', feedUrl: 'https://a.example.com/x' })).dataSource.id,
    });
    const ids = (await owner.org.dataSources.list()).map((d) => d.id);
    for (const id of ids.slice(0, 2)) await o.scope.dataSources.delete(id);
    const { dataSource: csv } = await call('save_data_source', { id: 'menu', name: 'Menu', format: 'csv', feedUrl: 'https://menu.example.com/menu.csv' });
    expect(csv).toMatchObject({ format: 'csv', rowsPath: null });
    const { dataSource: json } = await call('save_data_source', {
      id: 'stock',
      name: 'Stock',
      format: 'json-table',
      feedUrl: 'https://shop.example.com/stock.json',
      rowsPath: 'data.items',
    });
    expect(json).toMatchObject({ format: 'json-table', rowsPath: 'data.items' });
    expect(await refusal('save_data_source', { name: 'x', format: 'csv', feedUrl: 'https://a.example.com/', rowsPath: 'a' })).toMatchObject({
      error: 'invalid_input',
      details: [{ path: 'rowsPath', message: 'rowsPath is for json-table sources only' }],
    });
    expect(await refusal('save_data_source', { dataSourceId: 'menu', rowsPath: 'a' })).toMatchObject({
      error: 'invalid_input',
      details: [{ path: 'rowsPath', message: 'rowsPath is for json-table sources only' }],
    });
  });

  it("points each refusal of a save at the fields it gave or left out, as the schema's own refusals do (#507)", async () => {
    const fields = async (input: Record<string, unknown>) => {
      const r = await refusal('save_data_source', input);
      if (r.ok) throw new Error('saved');
      return { error: r.error, paths: (r.details as { path: string }[]).map((d) => d.path) };
    };
    expect(await fields({ name: 'Menu', feedUrl: 'https://menu.example.com/a.csv' })).toEqual({ error: 'invalid_input', paths: ['format'] });
    expect(await fields({ format: 'csv', feedUrl: 'https://menu.example.com/a.csv', ifVersion: 1 })).toEqual({ error: 'invalid_input', paths: ['ifVersion'] });
    expect(await fields({ name: 'Menu', format: 'csv', connectionId: 'con_x', resource: 'A1' })).toEqual({
      error: 'invalid_input',
      paths: ['feedUrl', 'connectionId', 'resource'],
    });
    // A feed with no feedUrl, and a provider source with no resource: each points at what is missing (#507).
    expect(await fields({ name: 'Menu', format: 'csv' })).toEqual({ error: 'invalid_input', paths: ['feedUrl'] });
    expect(await fields({ name: 'Rota', format: 'provider', connectionId: 'con_x' })).toEqual({ error: 'invalid_input', paths: ['resource'] });
    await call('save_data_source', { id: 'paths', name: 'Paths', format: 'csv', feedUrl: 'https://menu.example.com/p.csv' });
    expect(await fields({ dataSourceId: 'paths', format: 'json' })).toEqual({ error: 'invalid_input', paths: ['format'] });
    expect(await fields({ dataSourceId: 'paths', horizonDays: 9 })).toEqual({ error: 'invalid_input', paths: ['horizonDays'] });
    expect(await fields({ dataSourceId: 'paths', resource: 'A1' })).toEqual({ error: 'invalid_input', paths: ['resource'] });
  });

  it('polls a json-table source afresh when the path to its rows changes', async () => {
    await o.scope.dataSources.update('stock', { etag: '"e"', failures: 2, lastError: 'not-a-table', nextPollAt: 99 });
    expect(await call('save_data_source', { dataSourceId: 'stock', rowsPath: null })).toMatchObject({
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

describe("an agent's change that reaches screens with no publish (#122, review of #419)", () => {
  // An org of its own: the tests above fill the first one's ten sources.
  let a: SeededOrg;
  let person: Caller;
  const userOf = (role: string) => `${a.orgId}-agent-${role}`;
  const change = (name: string, input: unknown, caller = person) => dispatch(registry, name, input, caller);
  /** An agent connected by a member in `role`, holding `scopes`; the poller takes a source's change to screens itself. */
  const agent = (role: 'owner' | 'editor', scopes: Scope[]): Caller => ({
    ...memberOf(testScope(env.DB, a.orgId), role, { feedUrls: sealer }),
    actor: { kind: 'agent', id: `agt_${role}`, clientId: 'some-agent' },
    scopes,
    agentLimiter: unlimited,
    member: userOf(role),
  });
  const drafts: Scope[] = ['content:read', 'content:draft'];
  const publishes: Scope[] = [...drafts, 'content:publish'];
  const sealed = async (id: string) => (await person.org.dataSources.get(id))?.urlEncrypted;

  beforeAll(async () => {
    a = await seedOrg(env.DB, 'feeds-agents');
    person = memberOf(testScope(env.DB, a.orgId), 'editor', { feedUrls: sealer });
    const now = new Date(0).toISOString();
    for (const role of ['owner', 'editor'])
      await env.DB.batch([
        env.DB.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind(
          userOf(role),
          role,
          `${userOf(role)}@signforge.test`,
          now,
          now,
        ),
        env.DB.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)').bind(
          `mem-${userOf(role)}`,
          a.orgId,
          userOf(role),
          role,
          now,
        ),
      ]);
    for (const id of ['quiet', 'live'])
      expect(await change('save_data_source', { id, name: id, format: 'json', feedUrl: `https://${id}.example.com/feed.json` })).toMatchObject({ ok: true });
    // What screens show of `live`: a published spot binds it.
    const spot = (await a.scope.spots.get(a.templateSpot))!;
    const live = { ...JSON.parse(contentJson(spot)), bindingsJson: JSON.stringify({ title: { source: 'live', path: 'title' } }) };
    await env.DB.prepare('UPDATE spots SET published_json = ? WHERE id = ?').bind(JSON.stringify(live), spot.id).run();
  });

  it("refuses a draft-only agent a source's address, wherever it is bound, keeping the sealed one", async () => {
    for (const id of ['quiet', 'live']) {
      const before = await sealed(id);
      expect(await change('save_data_source', { dataSourceId: id, feedUrl: 'https://evil.example.com/feed.json' }, agent('owner', drafts))).toMatchObject({
        ok: false,
        error: 'forbidden',
        message: expect.stringContaining('needs the right to publish'),
      });
      expect(await sealed(id)).toBe(before);
    }
  });

  it('refuses a draft-only agent any change but the name, whether or not a published spot shows the source (review of #419)', async () => {
    // A spot published, or a screen rolled back, later: screens would follow the change with no publish. So no read of
    // what shows it now decides.
    for (const id of ['quiet', 'live']) {
      for (const input of [{ refreshS: 600 }, { photos: false }, { name: 'Renamed', refreshS: 600 }])
        expect(await change('save_data_source', { dataSourceId: id, ...input }, agent('owner', drafts)), `${id} ${JSON.stringify(input)}`).toMatchObject({
          ok: false,
          error: 'forbidden',
          message: expect.stringContaining('Its name alone may change'),
        });
      expect(await change('save_data_source', { dataSourceId: id, name: `${id} feed` }, agent('owner', drafts))).toMatchObject({ ok: true });
    }
    expect(await person.org.dataSources.get('quiet')).toMatchObject({ refreshS: 300 });
  });

  it('is refused a change whose source a person publishes between its read and its batch', async () => {
    // What a read of the published spots would have missed: the right is asked for before any is read.
    const published = racing(agent('owner', drafts), async () => {
      const spot = (await a.scope.spots.get(a.templateSpot))!;
      const live = { ...JSON.parse(contentJson(spot)), bindingsJson: JSON.stringify({ title: { source: 'quiet', path: 'title' } }) };
      await env.DB.prepare('UPDATE spots SET published_json = ? WHERE id = ?').bind(JSON.stringify(live), spot.id).run();
    });
    expect(await change('save_data_source', { dataSourceId: 'quiet', refreshS: 900 }, published)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await person.org.dataSources.get('quiet')).toMatchObject({ refreshS: 300 });
  });

  it('lets an agent that may publish change it, held to the commit: one whose editors stop publishing meanwhile is refused', async () => {
    expect(await change('save_data_source', { dataSourceId: 'live', refreshS: 900 }, agent('editor', publishes))).toMatchObject({ ok: true });
    const before = await sealed('live');
    const raced = racing(agent('editor', publishes), async () => person.org.commit((await person.org.settings.stage.set({ editorsPublish: false })).writes));
    try {
      expect(await change('save_data_source', { dataSourceId: 'live', feedUrl: 'https://other.example.com/feed.json' }, raced)).toMatchObject({
        ok: false,
        error: 'forbidden',
        message: 'Only owners publish in this organization',
      });
    } finally {
      await person.org.commit((await person.org.settings.stage.set({ editorsPublish: true })).writes);
    }
    expect(await sealed('live')).toBe(before);
  });

  it("refuses a draft-only agent a new provider source, which reads a resource through a person's connection; a feed it may add", async () => {
    expect(
      await change('save_data_source', { name: 'Sheet', format: 'provider', connectionId: 'con_any', resource: 'Payroll!A1:Z99' }, agent('owner', drafts)),
    ).toMatchObject({ ok: false, error: 'forbidden', message: expect.stringContaining('needs the right to publish') });
    expect(await change('save_data_source', { name: 'News', format: 'rss', feedUrl: 'https://news.example.com/rss' }, agent('owner', drafts))).toMatchObject({
      ok: true,
    });
  });
});

describe("a person's change that reaches screens with no publish (owner decision on #424)", () => {
  // An org of its own, with an editor who is a member: their right is read in the batch as it runs.
  let p: SeededOrg;
  const editorId = () => `${p.orgId}-editor-user`;
  const editor = (): Caller => ({ ...memberOf(testScope(env.DB, p.orgId), 'editor', { feedUrls: sealer }), member: editorId() });
  const setPublish = async (on: boolean) => {
    const org = testScope(env.DB, p.orgId);
    await org.commit((await org.settings.stage.set({ editorsPublish: on })).writes);
  };
  const sealedOf = async (id: string) => (await testScope(env.DB, p.orgId).dataSources.get(id))?.urlEncrypted;

  beforeAll(async () => {
    p = await seedOrg(env.DB, 'feeds-people');
    const now = new Date(0).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind(
        editorId(),
        'Ed',
        `${editorId()}@signforge.test`,
        now,
        now,
      ),
      env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'editor', ?)").bind(
        `${editorId()}-m`,
        p.orgId,
        editorId(),
        now,
      ),
    ]);
    expect(
      await dispatch(registry, 'save_data_source', { id: 'menu', name: 'Menu', format: 'json', feedUrl: 'https://menu.example.com/a.json' }, editor()),
    ).toMatchObject({
      ok: true,
    });
  });

  it('refuses an editor anything but the name while only owners publish, and a provider source; allows them while editors publish', async () => {
    await setPublish(false);
    try {
      const before = await sealedOf('menu');
      for (const input of [{ feedUrl: 'https://menu.example.com/b.json' }, { refreshS: 900 }])
        expect(await dispatch(registry, 'save_data_source', { dataSourceId: 'menu', ...input }, editor()), JSON.stringify(input)).toMatchObject({
          ok: false,
          error: 'forbidden',
          message: expect.stringContaining('needs the right to publish'),
        });
      expect(await sealedOf('menu')).toBe(before);
      expect(await dispatch(registry, 'save_data_source', { dataSourceId: 'menu', name: 'Menu board' }, editor())).toMatchObject({ ok: true });
      expect(
        await dispatch(registry, 'save_data_source', { name: 'Sheet', format: 'provider', connectionId: 'con_any', resource: 'Menu!A1:B9' }, editor()),
      ).toMatchObject({ ok: false, error: 'forbidden' });
      // A feed of its own an editor may still add: nothing shows it until a spot binding it is published.
      expect(await dispatch(registry, 'save_data_source', { name: 'News', format: 'rss', feedUrl: 'https://news.example.com/rss' }, editor())).toMatchObject({
        ok: true,
      });
    } finally {
      await setPublish(true);
    }
    expect(await dispatch(registry, 'save_data_source', { dataSourceId: 'menu', refreshS: 900 }, editor())).toMatchObject({ ok: true });
  });

  it('holds the right to the commit: editors stopped from publishing between the read and the batch are refused', async () => {
    const before = await sealedOf('menu');
    const raced = racing(editor(), () => setPublish(false));
    try {
      expect(await dispatch(registry, 'save_data_source', { dataSourceId: 'menu', feedUrl: 'https://menu.example.com/c.json' }, raced)).toMatchObject({
        ok: false,
        error: 'forbidden',
        message: 'Only owners publish in this organization',
      });
    } finally {
      await setPublish(true);
    }
    expect(await sealedOf('menu')).toBe(before);
  });
});
