// Bound fields (#155): which fields a data source feeds, and whether a snapshot of it may replace
// the last good one, is one rule for the player (as it keeps a snapshot, player-core), the sync
// (as it sends one) and the poller (as it stores one). On every case here the three agree, for a
// screen in es-ES, which writes 1234.5 as "1234,50" where en-US writes "1,234.50".
// No network: the feed is served by stubbed guards, and the clock is a parameter.
import { canonicalJson, MANIFEST_SCHEMA, type ScreenManifest, type Spot, templateKey, type TemplateManifest } from '@signforge/contract';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { manifestBoundFields, snapshotFit } from '@signforge/player-core';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { feedUrlSealer } from '../src/data/cipher';
import type { FetchGuards } from '../src/data/fetch';
import { pollDataSources } from '../src/data/poller';
import { mintCredential } from '../src/device/credential';
import { manifestKey } from '../src/r2';
import { syncAs, syncBody } from './sync-client';

const NOW = Date.UTC(2026, 11, 1, 12);
const MIN = 60_000;
const URL_ = 'https://menu.test/menu.json';
const LOCALE = 'es-ES';

/** A menu: a title, and items whose prices are written in at most 7 characters. */
const template: TemplateManifest = {
  id: 'bound-menu',
  version: '7.1.0',
  name: 'Bound menu',
  orientations: ['landscape'],
  background: '#000',
  uses: [],
  duration: { minMs: 1000, defaultMs: 12_000, maxMs: 60_000 },
  fields: {
    title: { type: 'text', label: 'Title', default: 'Menu', maxLength: 20 },
    items: {
      type: 'list',
      label: 'Items',
      maxItems: 5,
      item: { name: { type: 'text', label: 'Name', maxLength: 20 }, price: { type: 'text', label: 'Price', maxLength: 7 } },
    },
  },
};

let o: SeededOrg;
let credential: string;
let src: string;
let manifest: ScreenManifest;

beforeAll(async () => {
  o = await seedOrg(env.DB, 'bound-org');
  await o.scope.dataSources.update(o.dataSource, { nextPollAt: Number.MAX_SAFE_INTEGER });
  await o.scope.screens.update(o.screen, { locale: LOCALE });
  const { credential: c, secretHash } = await mintCredential(o.screen);
  await o.scope.screens.credentials.insert({ screenId: o.screen, secretHash });
  credential = c;
  src = 'bound-org-menu';
  await o.scope.dataSources.insert({
    id: src,
    name: 'Menu',
    format: 'json',
    urlEncrypted: await feedUrlSealer(env).seal({ orgId: o.orgId, id: src }, URL_),
    refreshS: 300,
    nextPollAt: Number.MAX_SAFE_INTEGER,
  });
  // One spot binds two fields to the source: the title to the third column's name, the items to its rows.
  const bindings = {
    title: { source: src, path: 'columns.2' },
    items: { source: src, path: 'rows', table: { columns: { name: 'Item', price: 'Price' } } },
  };
  const fallback = { title: 'Menu', items: [{ name: 'Soup', price: '5' }] };
  const version = await o.scope.templates.versions.insert({
    templateId: o.template,
    version: template.version,
    manifestJson: JSON.stringify(template),
    bundleSha256: 'e'.repeat(64),
    status: 'approved',
  });
  const row = await o.scope.spots.update(o.templateSpot, {
    templateVersionId: version.id,
    dataJson: JSON.stringify(fallback),
    bindingsJson: JSON.stringify(bindings),
  });
  await o.scope.commit(o.scope.spots.stage.publish(row!).writes);
  // What the screen plays: the same spot, as the compiler writes it.
  const key = templateKey(template);
  const spot: Spot = { id: 'menu', name: 'Menu', kind: 'template', template: key, durationMs: 12_000, data: fallback, assets: {}, bindings };
  manifest = {
    id: 'm-bound',
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date(NOW).toISOString(),
    defaultPlaylist: 'main',
    files: {},
    templates: { [key]: { manifest: template, html: 'e'.repeat(64) } },
    dataSources: { [src]: { id: src, refreshS: 300 } },
    spots: { menu: spot },
    playlists: { main: { id: 'main', name: 'Main', transition: { type: 'cut' }, items: [{ spot: 'menu' }] } },
    schedule: [],
    screen: { id: o.screen, name: 'Lobby', timezone: 'Europe/Madrid', locale: LOCALE, orientation: 'landscape' },
  };
  await env.BLOBS.put(manifestKey(o.orgId, o.screen, manifest.id), JSON.stringify(manifest));
  await o.scope.screens.setDesiredManifest(o.screen, manifest.id);
});

let at = NOW;

/** Whether the poller stores `data` as the source's snapshot, and why not. */
async function pollerStores(data: unknown): Promise<string | null> {
  at += 10 * MIN;
  await o.scope.dataSources.update(src, { nextPollAt: at });
  const guards: FetchGuards = {
    resolve: async () => ['93.184.216.34'],
    fetch: async (input) =>
      String(input instanceof Request ? input.url : input) === URL_ ? new Response(JSON.stringify(data)) : new Response('', { status: 404 }),
  };
  await pollDataSources(env, { now: at, guards });
  const [row, held] = await Promise.all([o.scope.dataSources.get(src), o.scope.dataSources.snapshot(src)]);
  return row!.lastError ?? (held?.dataJson === canonicalJson(data) ? null : 'not stored');
}

/** Whether the sync sends `data` to the screen, stored as the source's latest whatever the poller said. */
async function syncSends(data: unknown): Promise<boolean> {
  at += MIN;
  await o.scope.dataSources.savePoll(src, {
    source: { nextPollAt: Number.MAX_SAFE_INTEGER },
    snapshot: { version: `v${at}`, fetchedAt: at, checkedAt: at, dataJson: canonicalJson(data) },
  });
  return (await syncAs(credential, syncBody())).snapshots.some((s) => s.id === src);
}

/** Whether the player keeps `data` as the source's latest, on the screen's manifest. */
const playerKeeps = (data: unknown) => snapshotFit(manifestBoundFields(manifest).get(src) ?? [], data).refused === null;

/** Each side's answer: the player and the sync keep or refuse; the poller stores, or fails with a reason. */
async function sides(data: unknown) {
  const poller = await pollerStores(data);
  return { player: playerKeeps(data), sync: await syncSends(data), poller };
}

describe('the player, the sync and the poller', () => {
  it('all keep a table that fills the items', async () => {
    expect(await sides({ columns: ['Item', 'Price'], rows: [['Soup', 4.5]] })).toEqual({ player: true, sync: true, poller: null });
  });

  it("all keep a price that fits only as the screen's locale writes it", async () => {
    // es-ES: "1234,50", 7 characters; en-US would write "1,234.50", 8.
    expect(await sides({ columns: ['Item', 'Price'], rows: [['Steak', 1234.5]] })).toEqual({ player: true, sync: true, poller: null });
  });

  it('all refuse a table that lacks a column the items map, though the title still fits', async () => {
    expect(await sides({ columns: ['Dish', 'Price', 'Note'], rows: [['Soup', 4.5, 'x']] })).toEqual({ player: false, sync: false, poller: 'missing-column' });
  });

  it('all refuse a table no bound field fits', async () => {
    expect(await sides({ columns: ['Item', 'Price'], rows: [['Steak', 'Twelve fifty']] })).toEqual({ player: false, sync: false, poller: 'unfit' });
  });
});
