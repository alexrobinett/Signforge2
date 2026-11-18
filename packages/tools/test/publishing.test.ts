// The publish model: drafts promoted when they pass their checks, and the loader from the
// database to `compileScreen`. See docs/backend-plan.md#publishing.
import { compileScreen } from '@signforge/compiler';
import { templateKey, type ScreenManifest, type Spot, type TemplateManifest } from '@signforge/contract';
import { platform, published, scoped, StaleVersionError, type OrgScope } from '@signforge/db';
import { seedOrganization, seedScreen } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import stressGolden from '@signforge/cli/golden/stress.json';
import { loadCompileInput, loadOrg, publishOrg } from '../src/publishing';

const hash = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const NOW = new Date('2026-11-17T12:00:00.000Z');
const opts = { hash, now: NOW };
const sha = (c: string) => c.repeat(64);
/** Spot, playlist and entry ids are unique across orgs; each test's org prefixes its own. */
let prefix = '';
const x = (name: string) => `${prefix}-${name}`;

const promo: TemplateManifest = {
  id: 'promo',
  version: '1.0.0',
  name: 'Promo',
  fields: { title: { type: 'text', label: 'Title', default: 'Hello', maxLength: 40 }, photo: { type: 'image', label: 'Photo' } },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape', 'portrait'],
  uses: [],
  background: '#000',
  protocol: 1,
};

/** An org template version, registered as the template tools would leave it. */
async function addTemplate(org: OrgScope, manifest: TemplateManifest, bundle: string, status: 'draft' | 'approved' | 'retired' = 'approved') {
  const t = (await org.templates.ownByKey(manifest.id)) ?? (await org.templates.insert({ key: manifest.id, name: manifest.name }));
  return org.templates.versions.insert({
    templateId: t.id,
    version: manifest.version,
    manifestJson: JSON.stringify(manifest),
    bundleSha256: bundle,
    status,
    checkReportJson: JSON.stringify({ ok: true, bundleBytes: 1234, checks: [], checkedAt: 0, sourcesSha256: sha('0') }),
  });
}

/** An image asset with both renditions, verified. */
async function addImage(org: OrgScope, landscape: string, portrait: string) {
  const asset = await org.assets.insert({
    kind: 'image',
    name: 'photo.jpg',
    sha256: landscape,
    type: 'image/jpeg',
    size: 2000,
    width: 1920,
    height: 1080,
    status: 'verified',
  });
  await org.assets.renditions.insert({
    assetId: asset.id,
    orientation: 'landscape',
    sha256: landscape,
    type: 'image/jpeg',
    size: 2000,
    width: 1920,
    height: 1080,
  });
  await org.assets.renditions.insert({
    assetId: asset.id,
    orientation: 'portrait',
    sha256: portrait,
    type: 'image/jpeg',
    size: 1500,
    width: 1080,
    height: 1920,
  });
  return asset;
}

/**
 * A small org, all draft: two screens (one portrait) in group "front", a default playlist with a
 * template spot and a photo, and a takeover for the group.
 */
async function seedSmallOrg(orgId: string) {
  prefix = orgId;
  await seedOrganization(env.DB, orgId);
  const org = scoped(env.DB, orgId);
  const lobby = await org.screens.insert({ name: 'Lobby', timezone: 'Europe/London', orientation: 'landscape' });
  const hall = await org.screens.insert({ name: 'Hall', timezone: 'Europe/London', orientation: 'portrait', locale: 'en-GB' });
  const front = await org.screenGroups.insert({ name: 'Front' });
  await org.screenGroups.setMembers(front.id, [lobby.id, hall.id]);
  const version = await addTemplate(org, promo, sha('a'));
  const photo = await addImage(org, sha('b'), sha('c'));
  const deal = await org.spots.insert({
    id: x('deal'),
    name: 'Deal',
    kind: 'template',
    durationMs: 8000,
    templateVersionId: version.id,
    dataJson: JSON.stringify({ title: 'Two for $4' }),
    assetMapJson: JSON.stringify({ photo: photo.id }),
  });
  const still = await org.spots.insert({ id: x('still'), name: 'Still', kind: 'image', durationMs: 5000, assetId: photo.id, fit: 'contain' });
  const main = await org.playlists.insert({ id: x('main'), name: 'Main', transitionJson: JSON.stringify({ type: 'fade', ms: 500 }) });
  await org.playlists.setItems(main.id, [deal.id, still.id]);
  const evenings = await org.playlists.insert({ id: x('evenings'), name: 'Evenings', transitionJson: JSON.stringify({ type: 'cut' }) });
  await org.playlists.setItems(evenings.id, [still.id]);
  await org.scheduleEntries.insert({
    id: x('evening-takeover'),
    playlistId: evenings.id,
    priority: 5,
    target: 'group',
    groupId: front.id,
    fromTime: '18:00',
    toTime: '22:00',
  });
  await org.commit((await org.settings.stage.set({ defaultPlaylistId: main.id })).writes);
  return { org, lobby, hall, front, version, photo };
}

describe('publishOrg', () => {
  it('publishes every screen when one draft spot is broken, and reports that spot', async () => {
    const { org, lobby, hall, version } = await seedSmallOrg('pub-broken');
    // Broken: outside the template's duration range, and in a playlist no screen plays yet.
    await org.spots.insert({
      id: x('broken'),
      name: 'Broken',
      kind: 'template',
      durationMs: 1000,
      templateVersionId: version.id,
      dataJson: '{}',
      assetMapJson: '{}',
    });
    const side = await org.playlists.insert({ id: x('side'), name: 'Side', transitionJson: JSON.stringify({ type: 'cut' }) });
    await org.playlists.setItems(side.id, [x('broken')]);

    const result = await publishOrg(org, opts);
    expect(result.screens.map((s) => [s.screenId, s.problems])).toEqual(
      [
        [hall.id, []],
        [lobby.id, []],
      ].sort(),
    );
    for (const s of result.screens) expect(s.manifest).toBeDefined();
    expect(result.drafts.held).toEqual([
      { kind: 'playlist', id: x('side'), problems: [`spot ${x('broken')} is not published`] },
      {
        kind: 'spot',
        id: x('broken'),
        problems: [
          `spot ${x('broken')}: duration 1000 ms is outside the template's range 4000 to 60000`,
          `spot ${x('broken')}: image field "photo" has no asset`,
        ],
      },
    ]);
    expect(result.drafts.promoted).toEqual([
      { kind: 'playlist', id: x('evenings') },
      { kind: 'playlist', id: x('main') },
      { kind: 'schedule_entry', id: x('evening-takeover') },
      { kind: 'spot', id: x('deal') },
      { kind: 'spot', id: x('still') },
    ]);

    // Each screen gets its own orientation's rendition and only what it reaches.
    const landscape = result.screens.find((s) => s.screenId === lobby.id)!.manifest!;
    const portrait = result.screens.find((s) => s.screenId === hall.id)!.manifest!;
    expect(landscape.spots[x('still')]).toEqual({ id: x('still'), name: 'Still', kind: 'image', durationMs: 5000, file: sha('b'), fit: 'contain' });
    expect(portrait.spots[x('still')]).toMatchObject({ file: sha('c') });
    expect(portrait.screen).toEqual({ id: hall.id, name: 'Hall', timezone: 'Europe/London', locale: 'en-GB', orientation: 'portrait' });
    expect(Object.keys(landscape.playlists).sort()).toEqual([x('evenings'), x('main')]);
    expect(landscape.schedule).toEqual([{ id: x('evening-takeover'), playlist: x('evenings'), priority: 5, target: 'group', from: '18:00', to: '22:00' }]);
    expect(landscape.files[sha('a')]).toEqual({ size: 1234, type: 'text/html' });

    // Once committed, the drafts are published and a second publish promotes nothing.
    await org.commit(result.writes);
    expect(published((await org.spots.get(x('deal')))!)).toBeDefined();
    expect(published((await org.spots.get(x('broken')))!)).toBeUndefined();
    const again = await publishOrg(org, opts);
    expect(again.drafts.promoted).toEqual([]);
    expect(again.screens.map((s) => s.manifest!.id)).toEqual(result.screens.map((s) => s.manifest!.id));
  });

  it('keeps the published version of a draft that breaks, and reports it', async () => {
    const { org, lobby } = await seedSmallOrg('pub-keep');
    await org.commit((await publishOrg(org, opts)).writes);
    await org.spots.update(x('deal'), { dataJson: JSON.stringify({ title: 'x'.repeat(41) }) });

    const result = await publishOrg(org, opts);
    expect(result.drafts.held).toEqual([{ kind: 'spot', id: x('deal'), problems: [`spot ${x('deal')}: field "title" is longer than 40`] }]);
    const manifest = result.screens.find((s) => s.screenId === lobby.id)!.manifest!;
    expect((manifest.spots[x('deal')] as Extract<Spot, { kind: 'template' }>).data.title).toBe('Two for $4');
  });

  it('publishes only approved template versions, but lets a published spot keep a retired one', async () => {
    const { org, version } = await seedSmallOrg('pub-status');
    const draftVersion = await addTemplate(org, { ...promo, version: '2.0.0' }, sha('d'), 'draft');
    await org.spots.update(x('deal'), { templateVersionId: draftVersion.id });
    let result = await publishOrg(org, opts);
    expect(result.drafts.held).toEqual([
      { kind: 'playlist', id: x('main'), problems: [`spot ${x('deal')} is not published`] },
      {
        kind: 'spot',
        id: x('deal'),
        problems: [`template ${templateKey({ id: 'promo', version: '2.0.0' }, 'pub-status')} is draft; only an approved version can be published`],
      },
    ]);
    // The default playlist uses the spot that never published, so it is held too, and no screen can publish.
    expect(result.screens[0]!.problems).toEqual(['manifest: defaultPlaylist does not exist']);

    await org.spots.update(x('deal'), { templateVersionId: version.id });
    await org.commit((await publishOrg(org, opts)).writes);
    await org.templates.versions.update(version.id, { status: 'retired' });
    result = await publishOrg(org, opts);
    expect(result.drafts.held).toEqual([]);
    expect(result.screens.every((s) => s.manifest)).toBe(true);
  });

  it('holds an entry whose playlist is not published', async () => {
    const { org, front, version } = await seedSmallOrg('pub-entry');
    await org.spots.insert({
      id: x('broken'),
      name: 'Broken',
      kind: 'template',
      durationMs: 1000,
      templateVersionId: version.id,
      dataJson: '{}',
      assetMapJson: '{}',
    });
    const side = await org.playlists.insert({ id: x('side'), name: 'Side', transitionJson: JSON.stringify({ type: 'cut' }) });
    await org.playlists.setItems(side.id, [x('broken')]);
    await org.scheduleEntries.insert({ id: x('side-show'), playlistId: side.id, target: 'group', groupId: front.id, priority: 9 });
    const result = await publishOrg(org, opts);
    expect(result.drafts.held).toContainEqual({ kind: 'schedule_entry', id: x('side-show'), problems: [`playlist ${x('side')} is not published`] });
    expect(result.screens.every((s) => s.manifest && s.manifest.schedule.length === 1)).toBe(true);
  });

  it('reports a screen it cannot publish without stopping the others', async () => {
    const { org, lobby, hall } = await seedSmallOrg('pub-one-bad');
    const other = await addImage(org, sha('e'), sha('f'));
    await org.spots.insert({ id: x('extra'), name: 'Extra', kind: 'image', durationMs: 5000, assetId: other.id, fit: 'cover' });
    const lonely = await org.playlists.insert({ id: x('lonely'), name: 'Lonely', transitionJson: JSON.stringify({ type: 'cut' }) });
    await org.playlists.setItems(lonely.id, [x('extra')]);
    await org.scheduleEntries.insert({ id: x('hall-only'), playlistId: lonely.id, target: 'screen', screenId: hall.id, priority: 1 });
    await org.commit((await publishOrg(org, opts)).writes);

    // Published content broken from outside the draft model: its asset is rejected.
    await org.assets.update(other.id, { status: 'rejected' });
    const result = await publishOrg(org, opts);
    // Screen ids are the server's, so their order is not fixed.
    expect([...result.screens].sort((p, q) => (p.screenId === hall.id ? -1 : q.screenId === hall.id ? 1 : 0))).toEqual([
      {
        screenId: hall.id,
        problems: [`spot ${x('extra')}: asset ${other.id} is not verified`, `manifest: playlist "${x('lonely')}" lists unknown spot "${x('extra')}"`],
      },
      { screenId: lobby.id, problems: [], manifest: expect.objectContaining({ defaultPlaylist: x('main') }) },
    ]);
  });

  it('says so when the org has no default playlist', async () => {
    await seedOrganization(env.DB, 'pub-no-default');
    const org = scoped(env.DB, 'pub-no-default');
    const only = await org.screens.insert({ name: 'Only', timezone: 'UTC', orientation: 'landscape' });
    expect((await publishOrg(org, opts)).screens).toEqual([{ screenId: only.id, problems: ['the organization has no default playlist'] }]);
  });
});

describe('concurrent publishes (R09)', () => {
  type Publish = Awaited<ReturnType<typeof publishOrg>>;
  /** Commit a publish as M3-18's publish tool will: its writes and every screen's switch, in one batch. */
  const commitPublish = (org: OrgScope, result: Publish) =>
    org.commit([
      ...result.writes,
      ...result.screens.flatMap((s) => (s.manifest ? org.screens.stage.setDesiredManifest(s.screenId, s.manifest.id).writes : [])),
    ]);
  const titleOn = (result: Publish, screenId: string) =>
    (result.screens.find((s) => s.screenId === screenId)!.manifest!.spots[x('deal')] as Extract<Spot, { kind: 'template' }>).data.title;
  const editDeal = (org: OrgScope, title: string) => org.spots.update(x('deal'), { dataJson: JSON.stringify({ title }) });

  it('refuses an older publish that commits after a newer one, so the newest content stays on screen', async () => {
    const { org, lobby } = await seedSmallOrg('pub-race-old');
    await commitPublish(org, await publishOrg(org, opts));
    await editDeal(org, 'Three for $5');
    const older = await publishOrg(org, opts);
    await editDeal(org, 'Four for $6');
    const newer = await publishOrg(org, opts);
    expect([titleOn(older, lobby.id), titleOn(newer, lobby.id)]).toEqual(['Three for $5', 'Four for $6']);

    await commitPublish(org, newer);
    await expect(commitPublish(org, older)).rejects.toBeInstanceOf(StaleVersionError);
    expect((await org.screens.get(lobby.id))!.desiredManifestId).toBe(newer.screens.find((s) => s.screenId === lobby.id)!.manifest!.id);
    expect(JSON.parse(published((await org.spots.get(x('deal')))!)!.dataJson!)).toEqual({ title: 'Four for $6' });
  });

  it('refuses an older publish with nothing to promote, which would switch screens back', async () => {
    const { org, lobby } = await seedSmallOrg('pub-race-idle');
    await commitPublish(org, await publishOrg(org, opts));
    const older = await publishOrg(org, opts);
    expect(older.drafts.promoted).toEqual([]);
    await editDeal(org, 'Three for $5');
    const newer = await publishOrg(org, opts);

    await commitPublish(org, newer);
    await expect(commitPublish(org, older)).rejects.toBeInstanceOf(StaleVersionError);
    expect((await org.screens.get(lobby.id))!.desiredManifestId).toBe(newer.screens.find((s) => s.screenId === lobby.id)!.manifest!.id);
  });

  it('refuses the later of two publishes read at once, and the newest content wins when it runs again', async () => {
    const { org, lobby } = await seedSmallOrg('pub-race-new');
    await commitPublish(org, await publishOrg(org, opts));
    const first = await publishOrg(org, opts);
    await editDeal(org, 'Three for $5');
    const second = await publishOrg(org, opts);

    await commitPublish(org, first);
    await expect(commitPublish(org, second)).rejects.toBeInstanceOf(StaleVersionError);
    const again = await publishOrg(org, opts);
    await commitPublish(org, again);
    expect(titleOn(again, lobby.id)).toBe('Three for $5');
    expect((await org.screens.get(lobby.id))!.desiredManifestId).toBe(again.screens.find((s) => s.screenId === lobby.id)!.manifest!.id);
  });
});

describe('loadCompileInput', () => {
  /**
   * The stress project as the database would hold it after upload: base templates, assets with
   * renditions, spots, a playlist and data sources, all published. The golden is `sf build`'s
   * output for examples/stress (packages/cli/test/golden.test.ts keeps it honest).
   */
  async function seedStress(orgId: string) {
    const golden = stressGolden as unknown as ScreenManifest;
    await seedOrganization(env.DB, orgId);
    const org = scoped(env.DB, orgId);
    const p = platform(env.DB);
    const versionIds = new Map<string, string>();
    for (const [key, t] of Object.entries(golden.templates)) {
      const template = await p.templates.insert({ key: t.manifest.id, name: t.manifest.name });
      const v = await p.templates.versions.insert({
        templateId: template.id,
        version: t.manifest.version,
        manifestJson: JSON.stringify(t.manifest),
        bundleSha256: t.html,
        status: 'approved',
        checkReportJson: JSON.stringify({ ok: true, bundleBytes: golden.files[t.html]!.size, checks: [], checkedAt: 0, sourcesSha256: sha('0') }),
      });
      versionIds.set(key, v.id);
    }
    const assetIds = new Map<string, string>();
    const assetFor = async (file: string) => {
      if (!assetIds.has(file)) {
        const f = golden.files[file]!;
        const video = f.type.startsWith('video/');
        const asset = await org.assets.insert({
          kind: video ? 'video' : 'image',
          name: file.slice(0, 8),
          sha256: file,
          type: f.type,
          size: f.size,
          status: 'verified',
        });
        if (!video) {
          await org.assets.renditions.insert({ assetId: asset.id, orientation: 'landscape', sha256: file, type: f.type, size: f.size, width: 0, height: 0 });
          await org.assets.renditions.insert({ assetId: asset.id, orientation: 'portrait', sha256: sha('9'), type: f.type, size: 1, width: 0, height: 0 });
        }
        assetIds.set(file, asset.id);
      }
      return assetIds.get(file)!;
    };
    // The golden names its screen; a screen's id is otherwise always the server's.
    await seedScreen(env.DB, orgId, golden.screen);
    for (const s of Object.values(golden.spots)) {
      if (s.kind === 'template') {
        const assetMap: Record<string, string> = {};
        for (const [field, file] of Object.entries(s.assets)) assetMap[field] = await assetFor(file);
        await org.spots.insert({
          id: s.id,
          name: s.name,
          kind: 'template',
          durationMs: s.durationMs,
          templateVersionId: versionIds.get(s.template)!,
          dataJson: JSON.stringify(s.data),
          assetMapJson: JSON.stringify(assetMap),
          bindingsJson: s.bindings ? JSON.stringify(s.bindings) : null,
        });
      } else if (s.kind === 'image' || s.kind === 'video') {
        await org.spots.insert({ id: s.id, name: s.name, kind: s.kind, durationMs: s.durationMs, assetId: await assetFor(s.file), fit: s.fit });
      } else {
        await org.spots.insert({ id: s.id, name: s.name, kind: 'url', durationMs: s.durationMs, url: s.url });
      }
    }
    for (const pl of Object.values(golden.playlists)) {
      await org.playlists.insert({ id: pl.id, name: pl.name, transitionJson: JSON.stringify(pl.transition) });
      await org.playlists.setItems(
        pl.id,
        pl.items.map((i) => i.spot),
      );
    }
    for (const d of Object.values(golden.dataSources)) {
      await org.dataSources.insert({ id: d.id, name: d.id, format: 'json', urlEncrypted: 'enc:test', refreshS: d.refreshS });
    }
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: golden.defaultPlaylist })).writes);
    return { org, golden };
  }

  it('with the compiler, produces the manifest sf build produces for examples/stress', async () => {
    const { org, golden } = await seedStress('stress-org');
    const promotion = await publishOrg(org, opts);
    expect(promotion.drafts.held).toEqual([]);
    await org.commit(promotion.writes);

    const input = await loadCompileInput(org, golden.screen.id);
    const { manifest, problems } = await compileScreen(input!, opts);
    expect(problems).toEqual([]);
    // golden.test.ts checks the golden's id is the hash of its body, so compare it whole.
    const { generatedAt: _a, ...compiled } = manifest!;
    expect(compiled).toEqual(golden);
  });

  it('reads only the published graph, and nothing for a screen the org does not have', async () => {
    const { org, lobby, hall } = await seedSmallOrg('load-published');
    await seedOrganization(env.DB, 'load-other');
    const elsewhere = await scoped(env.DB, 'load-other').screens.insert({ name: 'Elsewhere', timezone: 'UTC', orientation: 'landscape' });
    const before = await loadCompileInput(org, lobby.id);
    expect(before).toMatchObject({ spots: [], playlists: [], schedule: [], defaultPlaylist: x('main') });
    await org.commit((await publishOrg(org, opts)).writes);
    await org.spots.update(x('deal'), { name: 'Renamed in draft' });
    const after = (await loadCompileInput(org, lobby.id))!;
    expect(after.spots.find((s) => s.id === x('deal'))!.name).toBe('Deal');
    expect(after.groups).toHaveLength(1);
    expect(await loadCompileInput(org, elsewhere.id)).toBeUndefined();
    expect((await loadOrg(org)).screens.map((s) => s.id).sort()).toEqual([hall.id, lobby.id].sort());
  });
});
