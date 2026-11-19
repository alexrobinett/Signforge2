// The spot tools: drafts made and edited through the registry, refused when the contract would
// refuse them, and the preview input the editor's stage compiles a draft against.
import { compileScreen } from '@signforge/compiler';
import type { TemplateManifest } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrganization } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { editorCalls, ok } from './calls';

const sha = (c: string) => c.repeat(64);
const hash = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

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
  const org = scoped(env.DB, orgId);
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

describe('spot drafts', () => {
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
});

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
    for (const [bindings, message] of refused)
      expect(await call('update_spot', { spotId, bindings }), JSON.stringify(bindings)).toMatchObject({
        ok: false,
        error: 'invalid_input',
        details: [{ path: 'bindings', message }],
      });
    expect(await call('update_spot', { spotId, bindings: { headline: { dataSourceId: 'weather', path: 'a..b' } } })).toMatchObject({
      ok: false,
      error: 'invalid_input',
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
      { hash, now: new Date() },
    );
    expect(result.problems).toEqual([]);
    expect(result.manifest?.brand?.id).toBe(kitId);
    expect(result.manifest?.spots.s).toMatchObject({ data: { accent: '#ffcc00' } });
  });
});
