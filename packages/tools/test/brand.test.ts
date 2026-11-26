// The brand tool group, and brand kits through the publish: a kit is frozen into each manifest
// and an edit reaches screens only at the next publish.
import type { Spot, TemplateManifest } from '@signforge/contract';
import { fontById } from '@signforge/compiler';
import type { OrgScope } from '@signforge/db';
import { seedOrganization, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dispatch, publishOrg, registry } from '../src';
import { memberOf } from './member';
import { sha256Hex } from '../src/dispatch';

const opts = { hash: sha256Hex, now: new Date('2026-11-17T12:00:00.000Z') };
const sha = (c: string) => c.repeat(64);

const COLORS = { primary: '#1d4ed8', accent: '#ffcc00', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' };

const branded: TemplateManifest = {
  id: 'branded',
  version: '1.0.0',
  name: 'Branded',
  fields: { title: { type: 'text', label: 'Title', default: 'Hello' }, accent: { type: 'color', label: 'Accent', default: '$brand.accent' } },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape', 'portrait'],
  uses: [],
  background: '#000',
  protocol: 2,
};

/** An org with two screens in group "front", one spot on the branded template, published content. */
async function setup(orgId: string) {
  await seedOrganization(env.DB, orgId);
  const org = testScope(env.DB, orgId);
  const lobby = await org.screens.insert({ name: 'Lobby', timezone: 'UTC', orientation: 'landscape' });
  const hall = await org.screens.insert({ name: 'Hall', timezone: 'UTC', orientation: 'landscape' });
  const front = await org.screenGroups.insert({ id: `${orgId}-front`, name: 'Front' });
  const back = await org.screenGroups.insert({ id: `${orgId}-back`, name: 'Back' });
  await org.screenGroups.setMembers(front.id, [lobby.id, hall.id]);
  const t = await org.templates.insert({ key: 'branded', name: 'Branded' });
  const v = await org.templates.versions.insert({
    templateId: t.id,
    version: '1.0.0',
    manifestJson: JSON.stringify(branded),
    bundleSha256: sha('a'),
    status: 'approved',
    checkReportJson: JSON.stringify({ ok: true, bundleBytes: 1000, checks: [], checkedAt: 0, sourcesSha256: sha('0') }),
  });
  await org.spots.insert({
    id: `${orgId}-hello`,
    name: 'Hello',
    kind: 'template',
    durationMs: 8000,
    templateVersionId: v.id,
    dataJson: '{}',
    assetMapJson: '{}',
  });
  const main = await org.playlists.insert({ id: `${orgId}-main`, name: 'Main', transitionJson: JSON.stringify({ type: 'cut' }) });
  await org.playlists.setItems(main.id, [`${orgId}-hello`]);
  await org.commit((await org.settings.stage.set({ defaultPlaylistId: main.id })).writes);
  const owner = memberOf(org, 'owner');
  const call = async <T = any>(name: string, input: unknown): Promise<T> => {
    const r = await dispatch(registry, name, input, owner);
    if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
    return r.output as T;
  };
  const refusal = (name: string, input: unknown) => dispatch(registry, name, input, owner);
  return { org, lobby, hall, front, back, call, refusal, spot: `${orgId}-hello` };
}

/** Publish as the publish tool does: commit the writes and make each manifest desired, in one batch. */
async function publish(org: OrgScope) {
  const result = await publishOrg(org, opts);
  await org.commit([
    ...result.writes,
    ...result.screens.flatMap((s) => (s.manifest ? org.screens.stage.setDesiredManifest(s.screenId, s.manifest.id).writes : [])),
  ]);
  return result;
}
const accentOf = (r: Awaited<ReturnType<typeof publishOrg>>, screenId: string, spot: string) =>
  (r.screens.find((s) => s.screenId === screenId)?.manifest?.spots[spot] as Extract<Spot, { kind: 'template' }> | undefined)?.data.accent;

describe('brand tools', () => {
  it('lists the curated fonts with their licences', async () => {
    const { call } = await setup('brand-fonts');
    const { fonts, next } = await call('list_fonts', {});
    expect(next).toBeNull();
    expect(fonts.length).toBeGreaterThanOrEqual(6);
    expect(fonts[0]).toMatchObject({ id: expect.stringMatching(/^base\//), licence: { spdx: 'OFL-1.1' } });
  });

  it('creates a kit with derived on-colours and warnings, makes the first the default, and shows where it reaches', async () => {
    const { call, lobby, hall } = await setup('brand-create');
    const { brandKit } = await call('save_brand_kit', { name: 'House', colors: { ...COLORS, muted: '#22272f' }, displayFontId: 'base/oswald' });
    expect(brandKit.id).toMatch(/^bk_/);
    expect(brandKit).toMatchObject({
      name: 'House',
      shape: 'soft',
      colors: { ...COLORS, muted: '#22272f', onPrimary: '#ffffff', onAccent: '#000000' },
      derived: ['onPrimary', 'onAccent'],
      displayFont: { id: 'base/oswald', family: 'Oswald' },
      bodyFont: null,
      logo: null,
      isDefault: true,
      reach: [hall.id, lobby.id].sort(),
      warnings: ['muted on background is 1.27:1, below 4.5:1'],
    });
    const second = await call('save_brand_kit', { name: 'Winter', colors: COLORS, shape: 'round' });
    expect(second.brandKit).toMatchObject({ isDefault: false, reach: [], warnings: [] });
    const { brandKits, next } = await call('list_brand_kits', {});
    expect(brandKits.map((k: { name: string }) => k.name).sort()).toEqual(['House', 'Winter']);
    expect(next).toBeNull();
  });

  it('refuses a font not in the catalogue and a logo that is not an image of this org', async () => {
    const { refusal } = await setup('brand-refuse');
    expect(await refusal('save_brand_kit', { name: 'x', colors: COLORS, bodyFontId: 'base/comic-sans' })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
    expect(await refusal('save_brand_kit', { name: 'x', colors: { ...COLORS, accent: 'yellow' } })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('save_brand_kit', { name: 'x', colors: COLORS, logoOnDarkAssetId: 'ast_nothing' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('assigns kits to screens and groups, and a group conflict shows on that screen only', async () => {
    const { call, refusal, lobby, hall, front, back, org } = await setup('brand-assign');
    const house = (await call('save_brand_kit', { name: 'House', colors: COLORS })).brandKit;
    const winter = (await call('save_brand_kit', { name: 'Winter', colors: { ...COLORS, accent: '#00aaff' } })).brandKit;
    await call('assign_brand_kit', { brandKitId: winter.id, groupId: back.id });
    await org.screenGroups.setMembers(back.id, [lobby.id]);

    // Lobby is in front (no choice) and back (winter): back's choice applies.
    expect((await call('get_brand_kit', { brandKitId: winter.id })).brandKit).toMatchObject({ groupIds: [back.id], reach: [lobby.id] });
    await call('assign_brand_kit', { brandKitId: house.id, groupId: front.id });
    const { brandKit } = await call('get_brand_kit', { brandKitId: house.id });
    expect(brandKit).toMatchObject({ groupIds: [front.id], reach: [hall.id] });
    expect(brandKit.conflicts).toEqual([
      {
        screenId: lobby.id,
        problem: `groups ${[back.id, front.id].sort().join(' and ')} choose different brand kits (${[house.id, winter.id].sort().join(', ')}); choose one for the screen`,
      },
    ]);

    const result = await publishOrg(org, opts);
    expect(result.screens.find((s) => s.screenId === hall.id)).toMatchObject({ problems: [] });
    const torn = result.screens.find((s) => s.screenId === lobby.id)!;
    expect(torn.manifest).toBeUndefined();
    expect(torn.problems).toEqual([`brand: ${brandKit.conflicts[0].problem}`]);

    // The screen's own choice settles it; null removes it again.
    await call('assign_brand_kit', { brandKitId: winter.id, screenId: lobby.id });
    expect((await call('get_brand_kit', { brandKitId: winter.id })).brandKit).toMatchObject({ screenIds: [lobby.id], reach: [lobby.id], conflicts: [] });
    await call('assign_brand_kit', { brandKitId: null, screenId: lobby.id });
    expect((await call('get_brand_kit', { brandKitId: winter.id })).brandKit).toMatchObject({ screenIds: [], reach: [] });

    expect(await refusal('assign_brand_kit', { brandKitId: house.id })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('assign_brand_kit', { brandKitId: house.id, screenId: lobby.id, groupId: front.id })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('sets the default', async () => {
    const { call } = await setup('brand-default');
    await call('save_brand_kit', { name: 'House', colors: COLORS });
    const winter = (await call('save_brand_kit', { name: 'Winter', colors: COLORS })).brandKit;
    expect((await call('save_brand_kit', { brandKitId: winter.id, makeDefault: true })).brandKit).toMatchObject({ isDefault: true, reach: expect.any(Array) });
    const { brandKits } = await call('list_brand_kits', {});
    expect(brandKits.filter((k: { isDefault: boolean }) => k.isDefault).map((k: { id: string }) => k.id)).toEqual([winter.id]);
  });

  it('updates a kit: a hand-set on-colour is kept, null derives it again', async () => {
    const { call } = await setup('brand-update');
    const kit = (await call('save_brand_kit', { name: 'House', colors: { ...COLORS, onAccent: '#333333' } })).brandKit;
    expect(kit.derived).toEqual(['onPrimary']);
    const { brandKit } = await call('save_brand_kit', { brandKitId: kit.id, colors: { accent: '#ff0000', onAccent: null }, shape: 'square', name: 'Home' });
    expect(brandKit).toMatchObject({
      name: 'Home',
      shape: 'square',
      colors: { accent: '#ff0000', onAccent: '#000000', primary: COLORS.primary },
      derived: ['onPrimary', 'onAccent'],
    });
  });
});

describe('brand at publish', () => {
  it('leaves stored manifests unchanged when a kit is edited, until the next publish', async () => {
    const { call, org, lobby, spot } = await setup('brand-frozen');
    const kit = (await call('save_brand_kit', { name: 'House', colors: COLORS })).brandKit;
    const first = await publish(org);
    expect(accentOf(first, lobby.id, spot)).toBe('#ffcc00');
    expect(first.screens.find((s) => s.screenId === lobby.id)?.manifest?.brand).toMatchObject({
      id: kit.id,
      colors: { accent: '#ffcc00', onAccent: '#000000' },
      shape: 'soft',
    });
    const stored = await org.screens.get(lobby.id);

    await call('save_brand_kit', { brandKitId: kit.id, colors: { accent: '#ff0000' } });
    expect(await org.screens.get(lobby.id)).toEqual(stored);

    const second = await publish(org);
    expect(accentOf(second, lobby.id, spot)).toBe('#ff0000');
    expect((await org.screens.get(lobby.id))?.desiredManifestId).not.toBe(stored?.desiredManifestId);
  });

  it('carries the logo as the rendition for the screen, and the catalogue font with its files', async () => {
    const { call, org, lobby } = await setup('brand-logo');
    const logo = await org.assets.insert({
      kind: 'image',
      name: 'logo.png',
      sha256: sha('c'),
      type: 'image/png',
      size: 500,
      width: 400,
      height: 200,
      status: 'verified',
    });
    await org.assets.renditions.insert({ assetId: logo.id, orientation: 'landscape', sha256: sha('c'), type: 'image/png', size: 500, width: 400, height: 200 });
    await org.assets.renditions.insert({ assetId: logo.id, orientation: 'portrait', sha256: sha('d'), type: 'image/png', size: 500, width: 400, height: 200 });
    await call('save_brand_kit', { name: 'House', colors: COLORS, logoOnDarkAssetId: logo.id, bodyFontId: 'base/inter' });
    const manifest = (await publishOrg(org, opts)).screens.find((s) => s.screenId === lobby.id)!.manifest!;
    expect(manifest.brand?.logo).toEqual({ onDark: sha('c') });
    expect(manifest.files[sha('c')]).toEqual({ size: 500, type: 'image/png' });
    const inter = fontById('base/inter')!;
    expect(manifest.brand?.fonts.body).toEqual({
      id: 'base/inter',
      family: 'Inter',
      files: inter.files.map(({ weight, style, file }) => ({ weight, style, file })),
    });
    expect(manifest.brand?.fonts.display).toBeUndefined();
    for (const f of inter.files) expect(manifest.files[f.file]).toEqual({ size: f.size, type: 'font/woff2' });
  });

  it('refuses a logo that is still being checked or was rejected, in the words the publish uses', async () => {
    const { refusal, org } = await setup('brand-logo-unverified');
    for (const [status, message] of [
      ['pending', 'is still being checked'],
      ['rejected', 'was rejected'],
    ] as const) {
      const logo = await org.assets.insert({
        kind: 'image',
        name: 'logo.png',
        sha256: sha('f'),
        type: 'image/png',
        size: 500,
        width: 400,
        height: 200,
        status,
      });
      expect(await refusal('save_brand_kit', { name: 'House', colors: COLORS, logoOnDarkAssetId: logo.id })).toMatchObject({
        ok: false,
        error: 'invalid_input',
        details: [{ path: 'logoOnDarkAssetId', message: `asset ${logo.id} ${message}` }],
      });
    }
  });

  it('refuses to delete an asset a kit uses as its logo', async () => {
    const { call, refusal, org } = await setup('brand-logo-delete');
    const logo = await org.assets.insert({
      kind: 'image',
      name: 'logo.svg',
      sha256: sha('e'),
      type: 'image/svg+xml',
      size: 500,
      width: 0,
      height: 0,
      status: 'verified',
    });
    const kit = (await call('save_brand_kit', { name: 'House', colors: COLORS, logoOnDarkAssetId: logo.id })).brandKit;
    expect(await refusal('delete', { type: 'asset', id: logo.id })).toMatchObject({ ok: false, error: 'conflict', details: { brandKitIds: [kit.id] } });
  });
});
