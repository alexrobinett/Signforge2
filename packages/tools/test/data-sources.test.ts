// Data source tools (M3-23): CRUD over an org's feeds, with the feed URL sealed before it is stored.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller, type FeedUrlSealer } from '../src';

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
  owner = { org: scoped(env.DB, o.orgId), role: 'owner', actor: { kind: 'user', id: 'user-1', clientId: 'cms' }, blobs: env.BLOBS, feedUrls: sealer };
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
    await owner.org.spots.update(o.templateSpot, { bindingsJson: JSON.stringify({ title: { source: 'holidays', path: 'events.0.title' } }) });
    const { dataSources } = await call('list_data_sources', {});
    const holidays = dataSources.find((d: { id: string }) => d.id === 'holidays');
    expect(holidays).toMatchObject({ lastFetchedAt: 1000, lastCheckedAt: 2000, spots: [{ id: o.templateSpot, name: expect.any(String) }] });
    const unpolled = await call('create_data_source', { id: 'unpolled', name: 'Not polled yet', format: 'rss', feedUrl: 'https://news.example.com/rss' });
    expect((await call('list_data_sources', {})).dataSources.find((d: { id: string }) => d.id === unpolled.dataSource.id)).toMatchObject({
      lastFetchedAt: null,
      lastCheckedAt: null,
      spots: [],
    });
    await owner.org.spots.update(o.templateSpot, { bindingsJson: null });
    await call('delete_data_source', { dataSourceId: 'unpolled' });
  });

  it('updates, polling a changed URL afresh', async () => {
    await owner.org.dataSources.update('holidays', { etag: '"old"', failures: 3, lastError: 'timeout', nextPollAt: 99 });
    const { dataSource } = await call('update_data_source', { dataSourceId: 'holidays', feedUrl: 'https://other.example.com/h.ics', horizonDays: null });
    expect(dataSource).toMatchObject({ horizonDays: null, failures: 0, lastError: null });
    expect(await owner.org.dataSources.get('holidays')).toMatchObject({
      etag: null,
      nextPollAt: 0,
      urlEncrypted: 'sealed:feeds-org/holidays:https://other.example.com/h.ics',
    });
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
    await owner.org.spots.update(o.templateSpot, { bindingsJson: JSON.stringify({ title: { source: 'holidays', path: 'events.0.title' } }) });
    expect(await refusal('delete_data_source', { dataSourceId: 'holidays' })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { spotIds: [o.templateSpot] },
    });
    await owner.org.spots.update(o.templateSpot, { bindingsJson: null });
    expect(await call('delete_data_source', { dataSourceId: 'holidays' })).toEqual({ deleted: 'holidays' });
    expect(await owner.org.dataSources.snapshot('holidays')).toBeUndefined();
  });
});
