// The spot tools: drafts made and edited through the registry, refused when the contract would
// refuse them, and the preview input the editor's stage compiles a draft against.
import { compileScreen } from '@signforge/compiler';
import type { TemplateManifest } from '@signforge/contract';
import { seedOrganization, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { editorCalls, ok } from './calls';
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

async function setup(orgId: string) {
  await seedOrganization(env.DB, orgId);
  const org = testScope(env.DB, orgId);
  const t = await org.templates.insert({ key: 'promo', name: 'Promo' });
  const v = await org.templates.versions.insert({
    templateId: t.id,
    version: '1.0.0',
    manifestJson: JSON.stringify(promo),
    bundleSha256: sha('a'),
    status: 'approved',
    checkReportJson: JSON.stringify({ ok: true, bundleBytes: 1234, checks: [], checkedAt: 0, sourcesSha256: sha('0') }),
  });
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
  fields: { target: { type: 'datetime', label: 'Target' }, title: { type: 'text', label: 'Title', default: 'Launch' } },
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
    // What the New spot dialog sends for a field with no default or min (apps/cms startData), and what an agent may leave out.
    const { spot } = await ok(call('create_spot', { name: 'Launch', kind: 'template', templateVersionId: version, data: { target: '' } }));
    expect(spot).toMatchObject({ data: { target: '' }, version: 1 });
    await ok(call('create_spot', { name: 'Launch too', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    expect(await ok(call('update_spot', { spotId, data: { target: '2026-12-24T18:00' } }))).toMatchObject({ spot: { data: { target: '2026-12-24T18:00' } } });
    expect(await call('update_spot', { spotId, data: { target: '0026-12-24T18:00' } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [{ path: 'data', message: 'field "target" must be in 1900 or later' }],
    });
    expect(await call('update_spot', { spotId, data: { target: '2026-12-24', title: 'x' } })).toMatchObject({
      ok: false,
      details: [{ path: 'data', message: 'field "target" must be a date and time (YYYY-MM-DDTHH:mm)' }],
    });
    // Unpicked again, the rest of the data is still checked.
    expect(await call('update_spot', { spotId, data: { target: '', nope: 1 } })).toMatchObject({
      ok: false,
      details: [{ path: 'data', message: 'unknown field "nope"' }],
    });
  });

  it('creates a template spot with the template duration, and reads it back', async () => {
    const { call, version } = await setup('spots-create');
    const { spot } = await ok(call('create_spot', { name: 'Fresh picked', kind: 'template', templateVersionId: version, idempotencyKey: 'key-create-1' }));
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

  it('refuses data the contract refuses, naming the field', async () => {
    const { call, version } = await setup('spots-invalid');
    expect(await call('create_spot', { name: 'x', kind: 'template', templateVersionId: version, data: { headline: 'Far too long a headline' } })).toMatchObject(
      {
        ok: false,
        error: 'invalid_input',
        details: [{ path: 'data', message: 'field "headline" is longer than 12' }],
      },
    );
    const { spot } = await ok(call('create_spot', { name: 'x', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    for (const data of [{ nope: 1 }, { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, { accent: '$brand.nope' }]) {
      expect(await call('update_spot', { spotId, data }), JSON.stringify(data)).toMatchObject({ ok: false, error: 'invalid_input' });
    }
    expect(await call('update_spot', { spotId, durationMs: 1000 })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('saves edits to the draft with ifVersion, and refuses a stale one', async () => {
    const { call, version, asset } = await setup('spots-update');
    const { spot } = await ok(call('create_spot', { name: 'x', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    const edited = await ok(call('update_spot', { spotId, data: { headline: 'Berries' }, assets: { photo: asset }, durationMs: 9000, ifVersion: 1 }));
    expect(edited).toMatchObject({ spot: { data: { headline: 'Berries' }, assets: { photo: asset }, durationMs: 9000, version: 2 } });
    expect(await call('update_spot', { spotId, name: 'y', ifVersion: 1 })).toMatchObject({ ok: false, error: 'conflict', details: { id: spotId, version: 2 } });
    expect(await call('update_spot', { spotId, assets: { headline: asset } })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('makes image and URL spots, and refuses fields of another kind or an unsafe URL', async () => {
    const { call, asset } = await setup('spots-media');
    const { spot: image } = await ok(call('create_spot', { name: 'Logo', kind: 'image', assetId: asset }));
    expect(image).toMatchObject({ kind: 'image', assetId: asset, fit: 'cover', durationMs: 10_000 });
    expect(await call('create_spot', { name: 'Site', kind: 'url', url: 'http://example.com' })).toMatchObject({ ok: false, error: 'invalid_input' });
    const { spot: site } = await ok(call('create_spot', { name: 'Site', kind: 'url', url: 'https://example.com/board' }));
    const spotId = (site as { id: string }).id;
    expect(await call('update_spot', { spotId, url: 'javascript:alert(1)' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('update_spot', { spotId, fit: 'contain' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await ok(call('update_spot', { spotId, url: 'https://example.com/other', durationMs: 20_000 }))).toMatchObject({
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
      expect(await call('create_spot', { name: 'x', kind: 'image', assetId: a })).toMatchObject({
        ok: false,
        error: 'invalid_input',
        details: [{ path: 'assetId', message: `asset ${a} ${message}` }],
      });
    }
    expect(await call('create_spot', { name: 'x', kind: 'video', assetId: asset })).toMatchObject({
      details: [{ path: 'assetId', message: `asset ${asset} is not a video` }],
    });
  });
});

/** Each binding set is refused by update_spot with its one message, at `bindings`. */
async function refusesBindings(call: ReturnType<typeof editorCalls>, spotId: string, refused: [unknown, string][]) {
  for (const [bindings, message] of refused)
    expect(await call('update_spot', { spotId, bindings }), JSON.stringify(bindings)).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: [{ path: 'bindings', message }],
    });
}

describe('spot bindings', () => {
  it("binds fields to the org's data sources, keeping the data as the fallback, and reads them back", async () => {
    const { call, version } = await setup('spots-bind');
    const bindings = { headline: { dataSourceId: 'news', path: 'items.0.title' }, items: { dataSourceId: 'news', path: 'items' } };
    const { spot } = await ok(call('create_spot', { name: 'Headlines', kind: 'template', templateVersionId: version, data: { headline: 'Fresh' }, bindings }));
    expect(spot).toMatchObject({ data: { headline: 'Fresh' }, bindings });
    const spotId = (spot as { id: string }).id;
    expect(await ok(call('get_spot', { spotId }))).toMatchObject({ spot: { bindings } });

    const moved = await ok(call('update_spot', { spotId, bindings: { headline: { dataSourceId: 'weather', path: 'current.summary' } }, ifVersion: 1 }));
    expect(moved).toMatchObject({ spot: { bindings: { headline: { dataSourceId: 'weather', path: 'current.summary' } }, version: 2 } });
    expect(await call('update_spot', { spotId, bindings: {}, ifVersion: 1 })).toMatchObject({ ok: false, error: 'conflict' });
    expect(await ok(call('update_spot', { spotId, bindings: {}, ifVersion: 2 }))).toMatchObject({ spot: { bindings: null } });
    // Edits that leave bindings out keep them.
    await ok(call('update_spot', { spotId, bindings: { items: { dataSourceId: 'news', path: 'items' } } }));
    expect(await ok(call('update_spot', { spotId, name: 'Renamed' }))).toMatchObject({
      spot: { bindings: { items: { dataSourceId: 'news', path: 'items' } } },
    });
  });

  it('refuses a source the org does not have', async () => {
    const { call, version } = await setup('spots-bind-missing');
    expect(
      await call('create_spot', { name: 'x', kind: 'template', templateVersionId: version, bindings: { headline: { dataSourceId: 'gone', path: 'a' } } }),
    ).toMatchObject({ ok: false, error: 'not_found', message: 'data source gone not found' });
  });

  it("refuses a field the template cannot bind, and a path the source's feed does not have", async () => {
    const { call, version } = await setup('spots-bind-invalid');
    const { spot } = await ok(call('create_spot', { name: 'x', kind: 'template', templateVersionId: version }));
    const spotId = (spot as { id: string }).id;
    const refused: [unknown, string][] = [
      [{ photo: { dataSourceId: 'weather', path: 'url' } }, 'image field "photo" cannot be bound to live data'],
      [{ nope: { dataSourceId: 'weather', path: 'a' } }, 'binding for unknown field "nope"'],
      [{ headline: { dataSourceId: 'news', path: 'entries.0.title' } }, 'news is a news feed, which has no entries.0.title (it has title, language, items)'],
      [{ headline: { dataSourceId: 'news', path: 'items.0.body' } }, 'news is a news feed, which has no items.0.body (it has title, language, items)'],
    ];
    await refusesBindings(call, spotId, refused);
    expect(await call('update_spot', { spotId, bindings: { headline: { dataSourceId: 'weather', path: 'a..b' } } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it("maps a table's columns onto a list field, and refuses an unknown column, a source that is not a table and a field that is not a list", async () => {
    const { call, version, org } = await setup('spots-bind-table');
    await org.dataSources.insert({ id: 'menu', name: 'Menu', format: 'csv', urlEncrypted: 'enc:m', refreshS: 300 });
    const items = { dataSourceId: 'menu', path: 'rows', table: { columns: { name: 'Item' }, filter: { column: 'Section', equals: 'Mains' } } };
    // Before its first poll the columns are not known: the poller checks them.
    const { spot } = await ok(call('create_spot', { name: 'Menu', kind: 'template', templateVersionId: version, bindings: { items } }));
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
    expect(await ok(call('update_spot', { spotId, bindings: { items, headline: { dataSourceId: 'menu', path: 'rows.0.0' } } }))).toMatchObject({
      spot: { bindings: { headline: { dataSourceId: 'menu', path: 'rows.0.0' } } },
    });
  });

  it("refuses a table binding to another org's table, without reading its columns", async () => {
    const other = await setup('spots-bind-table-other');
    await other.org.dataSources.insert({ id: 'menu', name: 'Menu', format: 'csv', urlEncrypted: 'enc:m', refreshS: 300 });
    const { call, version } = await setup('spots-bind-table-mine');
    const items = { dataSourceId: 'menu', path: 'rows', table: { columns: { name: 'Item' } } };
    expect(await call('create_spot', { name: 'x', kind: 'template', templateVersionId: version, bindings: { items } })).toMatchObject({
      ok: false,
      error: 'not_found',
      message: 'data source menu not found',
    });
  });

  it('refuses bindings on a spot that is not a template', async () => {
    const { call, asset } = await setup('spots-bind-image');
    expect(await call('create_spot', { name: 'x', kind: 'image', assetId: asset, bindings: {} })).toMatchObject({ ok: false, error: 'invalid_input' });
  });
});

describe('get_spot_preview', () => {
  it("gives what the stage compiles a draft against, for the orientation and the org's default kit", async () => {
    const { call, version, asset, org } = await setup('spots-preview');
    const { brandKit } = await ok(
      call('create_brand_kit', {
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
