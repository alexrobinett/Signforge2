// The spot tools: drafts made and edited through the registry, refused when the contract would
// refuse them, and the preview input the editor's stage compiles a draft against.
import { compileScreen } from '@signforge/compiler';
import type { TemplateManifest } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrg, seedOrganization, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { type AgentLimiter, type Caller, CMS_AGENT_CLIENT_ID, dispatch, registry } from '../src';
import { editorCalls, ok } from './calls';
import { memberOf } from './member';
import { sha256Hex } from '../src/dispatch';

const sha = (c: string) => c.repeat(64);
const promo: TemplateManifest = {
  id: 'promo',
  version: '1.0.0',
  name: 'Promo',
  fields: {
    photo: { type: 'image', label: 'Photo' },
    headline: { type: 'text', label: 'Headline', default: 'Fresh', maxLength: 12 },
    accent: { type: 'color', label: 'Accent', default: '$brand.accent' },
    items: { type: 'list', label: 'Items', item: { name: { type: 'text', label: 'Name' } }, maxItems: 2, default: [] },
  },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape', 'portrait'],
  uses: [],
  background: '#000',
  protocol: 2,
};

/** An approved version 1.0.0 of an org template with `manifest`, as registering one would leave it. */
async function approvedVersion(org: ReturnType<typeof testScope>, manifest: TemplateManifest) {
  const t = await org.templates.insert({ key: manifest.id, name: manifest.name });
  return org.templates.versions.insert({
    templateId: t.id,
    version: '1.0.0',
    manifestJson: JSON.stringify(manifest),
    bundleSha256: sha('a'),
    status: 'approved',
    checkReportJson: JSON.stringify({ ok: true, bundleBytes: 1234, checks: [], checkedAt: 0, sourcesSha256: sha('0') }),
  });
}

async function setup(orgId: string) {
  await seedOrganization(env.DB, orgId);
  const org = testScope(env.DB, orgId);
  const v = await approvedVersion(org, promo);
  const asset = await org.assets.insert({
    kind: 'image',
    name: 'berries.png',
    sha256: sha('b'),
    type: 'image/png',
    size: 10,
    width: 1920,
    height: 1080,
    status: 'verified',
  });
  for (const [orientation, c] of [
    ['landscape', 'c'],
    ['portrait', 'd'],
  ] as const)
    await org.assets.renditions.insert({ assetId: asset.id, orientation, sha256: sha(c), type: 'image/png', size: 10, width: 1920, height: 1080 });
  await org.dataSources.insert({ id: 'weather', name: 'Weather', format: 'json', urlEncrypted: 'enc:w', refreshS: 300 });
  await org.dataSources.insert({ id: 'news', name: 'News', format: 'rss', urlEncrypted: 'enc:n', refreshS: 300 });
  return { org, version: v.id, asset: asset.id, call: editorCalls(org) };
}

/** A countdown: a target no default or min fits, which a new spot leaves for the editor to pick. */
const countdown: TemplateManifest = {
  id: 'countdown',
  version: '1.0.0',
  name: 'Countdown',
  fields: {
    target: { type: 'datetime', label: 'Target' },
    title: { type: 'text', label: 'Title', default: 'Launch' },
    events: {
      type: 'list',
      label: 'Events',
      item: { name: { type: 'text', label: 'Name', maxLength: 10 }, at: { type: 'datetime', label: 'At' } },
      default: [],
    },
  },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape'],
  uses: [],
  background: '#000',
  protocol: 2,
};

async function addCountdown(org: Awaited<ReturnType<typeof setup>>['org']) {
  const t = await org.templates.insert({ key: 'countdown', name: 'Countdown' });
  const v = await org.templates.versions.insert({
    templateId: t.id,
    version: '1.0.0',
    manifestJson: JSON.stringify(countdown),
    bundleSha256: sha('f'),
    status: 'approved',
    checkReportJson: JSON.stringify({ ok: true, bundleBytes: 1234, checks: [], checkedAt: 0, sourcesSha256: sha('0') }),
  });
  return v.id;
}

describe('spot drafts', () => {
  it('creates a spot whose datetime is not picked yet, as one whose photo is not, and holds a picked one to the contract', async () => {
    const { org, call } = await setup('spots-date');
    const version = await addCountdown(org);
    // What the New spot dialog sends for a field with no default or min (`startData` in @signforge/compiler/draft), and what an agent may leave out.
    const { spot } = await ok(call('save_spot', { name: 'Launch', kind: 'template', templateVersionId: version, data: { target: '' } }));
    expect(spot).toMatchObject({ data: { target: '' }, version: 1 });
    await ok(call('save_spot', { name: 'Launch too', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    expect(await ok(call('save_spot', { spotId, data: { target: '2026-12-24T18:00' } }))).toMatchObject({ spot: { data: { target: '2026-12-24T18:00' } } });
    expect(await call('save_spot', { spotId, data: { target: '0026-12-24T18:00' } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [{ path: 'data', message: 'field "target" must be in 1900 or later' }],
    });
    expect(await call('save_spot', { spotId, data: { target: '2026-12-24', title: 'x' } })).toMatchObject({
      ok: false,
      details: [{ path: 'data', message: 'field "target" must be a date and time (YYYY-MM-DDTHH:mm)' }],
    });
    // Unpicked again, the rest of the data is still checked.
    expect(await call('save_spot', { spotId, data: { target: '', nope: 1 } })).toMatchObject({
      ok: false,
      details: [{ path: 'data', message: 'unknown field "nope"' }],
    });
  });

  it('creates a template spot with the template duration, and reads it back', async () => {
    const { call, version } = await setup('spots-create');
    const { spot } = await ok(call('save_spot', { name: 'Fresh picked', kind: 'template', templateVersionId: version, idempotencyKey: 'key-create-1' }));
    expect(spot).toMatchObject({
      name: 'Fresh picked',
      kind: 'template',
      templateVersionId: version,
      durationMs: 8000,
      data: {},
      assets: {},
      version: 1,
      published: false,
    });
    const id = (spot as { id: string }).id;
    expect(await ok(call('get_spot', { spotId: id }))).toMatchObject({ spot: { id, version: 1 } });
    expect(await ok(call('list_spots', {}))).toMatchObject({ spots: [{ id }], next: null });
  });

  it('lists by kind, or the unpublished only, and counts every spot the filters match (#357)', async () => {
    const { call, version } = await setup('spots-filters');
    for (const name of ['One', 'Two', 'Three']) await ok(call('save_spot', { name, kind: 'template', templateVersionId: version }));
    const page = await ok(call('list_spots', { unpublished: true, limit: 2 }));
    expect(page.spots).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.next).not.toBeNull();
    expect(await ok(call('list_spots', { kind: 'template', limit: 1 }))).toMatchObject({ total: 3 });
    expect(await ok(call('list_spots', { kind: 'image' }))).toMatchObject({ spots: [], total: 0 });
  });

  it('refuses data the contract refuses, naming the field', async () => {
    const { call, version } = await setup('spots-invalid');
    expect(await call('save_spot', { name: 'x', kind: 'template', templateVersionId: version, data: { headline: 'Far too long a headline' } })).toMatchObject(
      {
        ok: false,
        error: 'invalid_input',
        details: [{ path: 'data', message: 'field "headline" is longer than 12' }],
      },
    );
    const { spot } = await ok(call('save_spot', { name: 'x', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    for (const data of [{ nope: 1 }, { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, { accent: '$brand.nope' }]) {
      expect(await call('save_spot', { spotId, data }), JSON.stringify(data)).toMatchObject({ ok: false, error: 'invalid_input' });
    }
    expect(await call('save_spot', { spotId, durationMs: 1000 })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('saves edits to the draft with ifVersion, and refuses a stale one', async () => {
    const { call, version, asset } = await setup('spots-update');
    const { spot } = await ok(call('save_spot', { name: 'x', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    const edited = await ok(call('save_spot', { spotId, data: { headline: 'Berries' }, assets: { photo: asset }, durationMs: 9000, ifVersion: 1 }));
    expect(edited).toMatchObject({ spot: { data: { headline: 'Berries' }, assets: { photo: asset }, durationMs: 9000, version: 2 } });
    expect(await call('save_spot', { spotId, name: 'y', ifVersion: 1 })).toMatchObject({ ok: false, error: 'conflict', details: { id: spotId, version: 2 } });
    expect(await call('save_spot', { spotId, assets: { headline: asset } })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('makes image and URL spots, and refuses fields of another kind or an unsafe URL', async () => {
    const { call, asset } = await setup('spots-media');
    const { spot: image } = await ok(call('save_spot', { name: 'Logo', kind: 'image', assetId: asset }));
    expect(image).toMatchObject({ kind: 'image', assetId: asset, fit: 'cover', durationMs: 10_000 });
    expect(await call('save_spot', { name: 'Site', kind: 'url', url: 'http://example.com' })).toMatchObject({ ok: false, error: 'invalid_input' });
    const { spot: site } = await ok(call('save_spot', { name: 'Site', kind: 'url', url: 'https://example.com/board' }));
    const spotId = (site as { id: string }).id;
    expect(await call('save_spot', { spotId, url: 'javascript:alert(1)' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('save_spot', { spotId, fit: 'contain' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await ok(call('save_spot', { spotId, url: 'https://example.com/other', durationMs: 20_000 }))).toMatchObject({
      spot: { url: 'https://example.com/other', durationMs: 20_000, version: 2 },
    });
  });

  it('refuses an image spot an asset that is still being checked or was rejected, in the words the publish uses, or one of another kind', async () => {
    const { call, org, asset } = await setup('spots-unverified');
    const upload = (status: 'pending' | 'rejected') =>
      org.assets.insert({ kind: 'image', name: `${status}.png`, sha256: sha('e'), type: 'image/png', size: 10, width: 1920, height: 1080, status });
    for (const [a, message] of [
      [(await upload('pending')).id, 'is still being checked'],
      [(await upload('rejected')).id, 'was rejected'],
    ] as const) {
      expect(await call('save_spot', { name: 'x', kind: 'image', assetId: a })).toMatchObject({
        ok: false,
        error: 'invalid_input',
        details: [{ path: 'assetId', message: `asset ${a} ${message}` }],
      });
    }
    expect(await call('save_spot', { name: 'x', kind: 'video', assetId: asset })).toMatchObject({
      details: [{ path: 'assetId', message: `asset ${asset} is not a video` }],
    });
  });
});

/** Each binding set is refused by save_spot with its one message, at `bindings`. */
async function refusesBindings(call: ReturnType<typeof editorCalls>, spotId: string, refused: [unknown, string][]) {
  for (const [bindings, message] of refused)
    expect(await call('save_spot', { spotId, bindings }), JSON.stringify(bindings)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [{ path: 'bindings', message }],
    });
}

describe('spot drafts with dates not picked yet (re-check of #217)', () => {
  it('refuses a bound datetime with no fallback as one with no date, not as a binding for an unknown field, and takes it with one', async () => {
    const { org, call } = await setup('spots-date-bound');
    const version = await addCountdown(org);
    const { spot } = await ok(call('save_spot', { name: 'Launch', kind: 'template', templateVersionId: version, data: { target: '' } }));
    const spotId = (spot as { id: string }).id;
    const bindings = { target: { dataSourceId: 'weather', path: 'next.start' } };
    expect(await call('save_spot', { spotId, bindings })).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [{ path: 'data', message: 'field "target" has no date and time yet' }],
    });
    expect(await ok(call('save_spot', { spotId, data: { target: '2026-12-24T18:00' }, bindings }))).toMatchObject({
      spot: { data: { target: '2026-12-24T18:00' }, bindings: { target: { dataSourceId: 'weather', path: 'next.start' } } },
    });
  });

  it("saves a list row whose datetime is not picked yet, as the field's own, and still checks the rest of the row", async () => {
    const { org, call } = await setup('spots-date-rows');
    const version = await addCountdown(org);
    const { spot } = await ok(
      call('save_spot', {
        name: 'Launch',
        kind: 'template',
        templateVersionId: version,
        data: { target: '', events: [{ name: 'Doors', at: '' }, { name: 'Talk' }] },
      }),
    );
    expect(spot).toMatchObject({ data: { events: [{ name: 'Doors', at: '' }, { name: 'Talk' }] } });
    const spotId = (spot as { id: string }).id;
    expect(await call('save_spot', { spotId, data: { target: '', events: [{ name: 'Far too long', at: '' }] } })).toMatchObject({
      ok: false,
      details: [{ path: 'data', message: 'field "events[1].name" is longer than 10' }],
    });
    expect(await call('save_spot', { spotId, data: { target: '', events: [{ name: 'Doors', at: '0026-11-27T18:00' }] } })).toMatchObject({
      ok: false,
      details: [{ path: 'data', message: 'field "events[1].at" must be in 1900 or later' }],
    });
  });
});

describe('spot bindings', () => {
  it("binds fields to the org's data sources, keeping the data as the fallback, and reads them back", async () => {
    const { call, version } = await setup('spots-bind');
    const bindings = { headline: { dataSourceId: 'news', path: 'items.0.title' }, items: { dataSourceId: 'news', path: 'items' } };
    const { spot } = await ok(call('save_spot', { name: 'Headlines', kind: 'template', templateVersionId: version, data: { headline: 'Fresh' }, bindings }));
    expect(spot).toMatchObject({ data: { headline: 'Fresh' }, bindings });
    const spotId = (spot as { id: string }).id;
    expect(await ok(call('get_spot', { spotId }))).toMatchObject({ spot: { bindings } });

    const moved = await ok(call('save_spot', { spotId, bindings: { headline: { dataSourceId: 'weather', path: 'current.summary' } }, ifVersion: 1 }));
    expect(moved).toMatchObject({ spot: { bindings: { headline: { dataSourceId: 'weather', path: 'current.summary' } }, version: 2 } });
    expect(await call('save_spot', { spotId, bindings: {}, ifVersion: 1 })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await ok(call('save_spot', { spotId, bindings: {}, ifVersion: 2 }))).toMatchObject({ spot: { bindings: null } });
    // Edits that leave bindings out keep them.
    await ok(call('save_spot', { spotId, bindings: { items: { dataSourceId: 'news', path: 'items' } } }));
    expect(await ok(call('save_spot', { spotId, name: 'Renamed' }))).toMatchObject({
      spot: { bindings: { items: { dataSourceId: 'news', path: 'items' } } },
    });
  });

  it("binds a template's two sources each to a data source of its own, and reads both back (#193)", async () => {
    const { call, org } = await setup('spots-bind-two');
    const frame: TemplateManifest = {
      ...promo,
      id: 'frame',
      fields: { ...promo.fields, temp: { type: 'number', label: 'Temperature', default: 72 } },
      live: {
        sources: {
          weather: { label: 'Weather', source: 'open-meteo', fields: { temp: 'current.temperature_2m' } },
          headlines: { label: 'Headlines', source: 'rss', fields: { items: 'items' } },
        },
      },
    };
    const v = await approvedVersion(org, frame);
    const bindings = { temp: { dataSourceId: 'weather', path: 'current.temperature_2m' }, items: { dataSourceId: 'news', path: 'items' } };
    const { spot } = await ok(call('save_spot', { name: 'Frame', kind: 'template', templateVersionId: v.id, assets: {}, bindings }));
    const spotId = (spot as { id: string }).id;
    expect(await ok(call('get_spot', { spotId }))).toMatchObject({ spot: { bindings } });
    const { dataSources } = await ok(call('list_data_sources', {}));
    for (const id of ['weather', 'news'])
      expect((dataSources as { id: string; spots: { id: string }[] }[]).find((d) => d.id === id)?.spots).toEqual([expect.objectContaining({ id: spotId })]);
  });

  it('refuses a source the org does not have', async () => {
    const { call, version } = await setup('spots-bind-missing');
    expect(
      await call('save_spot', { name: 'x', kind: 'template', templateVersionId: version, bindings: { headline: { dataSourceId: 'gone', path: 'a' } } }),
    ).toMatchObject({ ok: false, error: 'not_found', message: 'data source gone not found' });
  });

  it("refuses a field the template cannot bind, and a path the source's feed does not have", async () => {
    const { call, version } = await setup('spots-bind-invalid');
    const { spot } = await ok(call('save_spot', { name: 'x', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    const refused: [unknown, string][] = [
      [{ photo: { dataSourceId: 'weather', path: 'url' } }, 'image field "photo" cannot be bound to live data'],
      [{ nope: { dataSourceId: 'weather', path: 'a' } }, 'binding for unknown field "nope"'],
      [{ headline: { dataSourceId: 'news', path: 'entries.0.title' } }, 'news is a news feed, which has no entries.0.title (it has title, language, items)'],
      [{ headline: { dataSourceId: 'news', path: 'items.0.body' } }, 'news is a news feed, which has no items.0.body (it has title, language, items)'],
    ];
    await refusesBindings(call, spotId, refused);
    expect(await call('save_spot', { spotId, bindings: { headline: { dataSourceId: 'weather', path: 'a..b' } } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it("maps a table's columns onto a list field, and refuses an unknown column, a source that is not a table and a field that is not a list", async () => {
    const { call, version, org } = await setup('spots-bind-table');
    await org.dataSources.insert({ id: 'menu', name: 'Menu', format: 'csv', urlEncrypted: 'enc:m', refreshS: 300 });
    const items = { dataSourceId: 'menu', path: 'rows', table: { columns: { name: 'Item' }, filter: { column: 'Section', equals: 'Mains' } } };
    // Before its first poll the columns are not known: the poller checks them.
    const { spot } = await ok(call('save_spot', { name: 'Menu', kind: 'template', templateVersionId: version, bindings: { items } }));
    expect(spot).toMatchObject({ bindings: { items } });
    const spotId = (spot as { id: string }).id;
    expect(await ok(call('get_spot', { spotId }))).toMatchObject({ spot: { bindings: { items } } });
    expect(await org.spots.get(spotId)).toMatchObject({ bindingsJson: JSON.stringify({ items: { source: 'menu', path: 'rows', table: items.table } }) });

    await org.dataSources.putSnapshot('menu', {
      version: 'm',
      fetchedAt: 1,
      checkedAt: 1,
      dataJson: JSON.stringify({ columns: ['Item', 'Price', 'Section'], rows: [['Soup', '4', 'Mains']] }),
    });
    const refused: [unknown, string][] = [
      [
        { items: { ...items, table: { columns: { name: 'Dish' }, sort: { column: 'Rank' } } } },
        'binding for "items": menu has no column "Dish", "Rank" (it has Item, Price, Section)',
      ],
      [{ items: { ...items, dataSourceId: 'news' } }, 'binding for "items": news is a news feed, not a table (csv or json-table)'],
      [{ items: { ...items, dataSourceId: 'weather' } }, 'binding for "items": weather is a json source, not a table (csv or json-table)'],
      [{ headline: items }, 'binding for "headline" maps a table, which fills a list field only, and "headline" is a text field'],
      [{ items: { ...items, table: { columns: { name: 'Item', size: 'Price' } } } }, 'binding for "items": "size" is not a property of its items (name)'],
      [{ items: { ...items, table: { columns: {} } } }, 'binding for "items" needs a column for "name"'],
      [{ headline: { dataSourceId: 'menu', path: 'items.0' } }, 'menu is a table, which has no items.0 (it has columns, rows)'],
    ];
    await refusesBindings(call, spotId, refused);
    // A single field takes one cell by its path.
    expect(await ok(call('save_spot', { spotId, bindings: { items, headline: { dataSourceId: 'menu', path: 'rows.0.0' } } }))).toMatchObject({
      spot: { bindings: { headline: { dataSourceId: 'menu', path: 'rows.0.0' } } },
    });
  });

  it("refuses a table binding to another org's table, without reading its columns", async () => {
    const other = await setup('spots-bind-table-other');
    await other.org.dataSources.insert({ id: 'menu', name: 'Menu', format: 'csv', urlEncrypted: 'enc:m', refreshS: 300 });
    const { call, version } = await setup('spots-bind-table-mine');
    const items = { dataSourceId: 'menu', path: 'rows', table: { columns: { name: 'Item' } } };
    expect(await call('save_spot', { name: 'x', kind: 'template', templateVersionId: version, bindings: { items } })).toMatchObject({
      ok: false,
      error: 'not_found',
      message: 'data source menu not found',
    });
  });

  it('refuses bindings on a spot that is not a template', async () => {
    const { call, asset } = await setup('spots-bind-image');
    expect(await call('save_spot', { name: 'x', kind: 'image', assetId: asset, bindings: {} })).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

describe('get_spot_preview', () => {
  it("gives what the stage compiles a draft against, for the orientation and the org's default kit", async () => {
    const { call, version, asset, org } = await setup('spots-preview');
    const { brandKit } = await ok(
      call('save_brand_kit', {
        name: 'House',
        colors: { primary: '#1d4ed8', accent: '#ffcc00', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' },
        logoOnDarkAssetId: asset,
      }),
    );
    const kitId = (brandKit as { id: string }).id;
    const out = await ok(call('get_spot_preview', { orientation: 'portrait', templateVersionId: version }));
    expect(out.brandKitId).toBe(kitId);
    expect(out.problems).toEqual([]);
    const preview = out.preview as Parameters<typeof compileScreen>[0];
    expect(preview.files).toMatchObject({ [sha('a')]: { size: 1234, type: 'text/html' }, [sha('d')]: { type: 'image/png' } });

    // The editor adds the screen and the one spot, and compiles in the browser.
    const key = `${org.orgId}/promo@1.0.0`;
    const result = await compileScreen(
      {
        ...preview,
        screen: { id: 'preview', name: 'Preview', timezone: 'UTC', orientation: 'portrait' },
        groups: [],
        files: { ...preview.files, [sha('d')]: { size: 10, type: 'image/png' } },
        spots: [{ id: 's', name: 's', kind: 'template', durationMs: 8000, template: key, data: {}, assets: { photo: sha('d') } }],
        playlists: [{ id: 'p', name: 'p', transition: { type: 'cut' }, items: [{ spot: 's' }] }],
        schedule: [],
        defaultPlaylist: 'p',
      },
      { hash: sha256Hex, now: new Date() },
    );
    expect(result.problems).toEqual([]);
    expect(result.manifest?.brand?.id).toBe(kitId);
    expect(result.manifest?.spots.s).toMatchObject({ data: { accent: '#ffcc00' } });
  });
});

describe('deleting a spot (#242)', () => {
  async function seeded(orgId: string) {
    const o = await seedOrg(env.DB, orgId);
    const org = testScope(env.DB, orgId);
    return { o, org, call: editorCalls(org) };
  }

  it('deletes one no playlist plays, a draft or a published one, and audits it', async () => {
    const { o, org, call } = await seeded('spot-del');
    // The seed's playlist plays its two spots: take the image out, and publish the spot so screens could have it.
    await org.playlists.setItems(o.playlist, [o.templateSpot]);
    await org.commit(org.spots.stage.publish((await org.spots.get(o.imageSpot))!).writes);
    expect(await ok(call('delete_spot', { spotId: o.imageSpot }))).toEqual({ deleted: o.imageSpot });
    expect(await call('get_spot', { spotId: o.imageSpot })).toMatchObject({ ok: false, error: 'not_found' });
    const [entry] = await org.auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({ action: 'delete_spot', targetKind: 'spot', targetId: o.imageSpot, actorKind: 'user' });

    const { spot } = await ok(call('save_spot', { name: 'Site', kind: 'url', url: 'https://example.com/board' }));
    const id = (spot as { id: string }).id;
    expect(await ok(call('delete_spot', { spotId: id }))).toEqual({ deleted: id });
    expect(await call('delete_spot', { spotId: id })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('refuses while a playlist plays it, in its draft or only in its published version, naming each, and writes nothing', async () => {
    const { o, org, call } = await seeded('spot-del-used');
    const lunch = (await ok(call('save_playlist', { name: 'Lunch', spotIds: [o.imageSpot] }))).playlist as { id: string };
    expect(await call('delete_spot', { spotId: o.imageSpot })).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringContaining('"Lunch"'),
      details: {
        playlists: expect.arrayContaining([
          { id: lunch.id, name: 'Lunch' },
          { id: o.playlist, name: expect.any(String) },
        ]),
      },
    });

    // Published with it, then taken out of the drafts: screens may still play it.
    const row = (await org.playlists.get(o.playlist))!;
    await org.commit(org.playlists.stage.publish(row, await org.playlists.items(o.playlist)).writes);
    await org.playlists.setItems(o.playlist, [o.templateSpot]);
    await ok(call('save_playlist', { playlistId: lunch.id, spotIds: [] }));
    expect(await call('delete_spot', { spotId: o.imageSpot })).toMatchObject({ ok: false, error: 'conflict', details: { playlists: [{ id: o.playlist }] } });
    expect(await org.spots.get(o.imageSpot)).toBeDefined();

    // Published without it: gone from screens, so it may go.
    const now = (await org.playlists.get(o.playlist))!;
    await org.commit(org.playlists.stage.publish(now, [o.templateSpot]).writes);
    expect(await ok(call('delete_spot', { spotId: o.imageSpot }))).toEqual({ deleted: o.imageSpot });
  });

  it('continues its versions when made again with its id, so an edit read before the delete is refused (draft_tombstones)', async () => {
    const { org, call } = await seeded('spot-del-tomb');
    const { spot } = await ok(call('save_spot', { name: 'Site', kind: 'url', url: 'https://example.com/a', idempotencyKey: 'spot-del-tomb' }));
    const read = (await ok(call('save_spot', { spotId: (spot as { id: string }).id, name: 'Site, edited', ifVersion: 1 }))).spot as {
      id: string;
      version: number;
    };
    await ok(call('delete_spot', { spotId: read.id }));
    const again = await org.spots.insert({ id: read.id, name: 'Again', kind: 'url', durationMs: 10_000, url: 'https://example.com/b' });
    expect(again.rowVersion).toBe(read.version + 1);
    expect(await call('save_spot', { spotId: read.id, name: 'From the old read', ifVersion: read.version })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: read.id, version: read.version + 1 },
    });
  });

  it("is a person's: refused to a viewer, a grant's agent and the in-CMS agent alike, before anything is read", async () => {
    const { o, org } = await seeded('spot-del-who');
    await org.playlists.setItems(o.playlist, [o.templateSpot]);
    const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };
    const owner = memberOf(org, 'owner');
    const callers: [string, Caller][] = [
      ['viewer', memberOf(org, 'viewer')],
      ['grant', { ...owner, actor: { kind: 'agent', id: 'agt_x', clientId: 'agent-app' }, scopes: ['content:read', 'content:draft'], agentLimiter: unlimited }],
      ['in-CMS agent', { ...owner, actor: { kind: 'user', id: 'user-1', clientId: CMS_AGENT_CLIENT_ID } }],
    ];
    for (const [who, caller] of callers)
      expect(await dispatch(registry, 'delete_spot', { spotId: o.imageSpot }, caller), who).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await org.spots.get(o.imageSpot)).toBeDefined();
    expect(registry.get('delete_spot')?.people).toBe(true);
  });

  it('refuses with conflict, not a fault, when a playlist takes the spot in between its check and its commit', async () => {
    const { o, org } = await seeded('spot-del-race');
    await org.playlists.setItems(o.playlist, [o.templateSpot]);
    let raced = false;
    const racing = {
      ...org,
      spots: {
        ...org.spots,
        usedBy: async (spotId: string) => {
          const used = await org.spots.usedBy(spotId);
          if (!raced) {
            raced = true;
            await org.playlists.setItems(o.playlist, [o.templateSpot, o.imageSpot]);
          }
          return used;
        },
      },
    };
    expect(await editorCalls(racing)('delete_spot', { spotId: o.imageSpot })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { playlists: [{ id: o.playlist }] },
    });
    expect(await scoped(env.DB, 'spot-del-race').spots.get(o.imageSpot)).toBeDefined();
  });
  it('refuses a delete at a version someone has saved past, at the read or between the read and the commit, and keeps the spot', async () => {
    const { org, call } = await seeded('spot-del-version');
    const { spot } = await ok(call('save_spot', { name: 'Site', kind: 'url', url: 'https://example.com/a', idempotencyKey: 'spot-del-version' }));
    const id = (spot as { id: string }).id;
    await ok(call('save_spot', { spotId: id, name: 'Their edit', ifVersion: 1 }));
    expect(await call('delete_spot', { spotId: id, ifVersion: 1 })).toMatchObject({ ok: false, error: 'conflict', details: { id, version: 2 } });

    // Saved again after the delete read the spot: the batch's guard refuses it.
    let raced = false;
    const racing = {
      ...org,
      spots: {
        ...org.spots,
        usedBy: async (spotId: string) => {
          if (!raced) {
            raced = true;
            await editorCalls(org)('save_spot', { spotId, name: 'Saved meanwhile', ifVersion: 2 });
          }
          return org.spots.usedBy(spotId);
        },
      },
    };
    expect(await editorCalls(racing)('delete_spot', { spotId: id, ifVersion: 2 })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await org.spots.get(id)).toMatchObject({ name: 'Saved meanwhile', rowVersion: 3 });
    expect(await ok(call('delete_spot', { spotId: id, ifVersion: 3 }))).toEqual({ deleted: id });
  });
});
