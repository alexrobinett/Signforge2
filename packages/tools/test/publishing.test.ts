// The publish model: drafts promoted when they pass their checks, and the loader from the
// database to `compileScreen`. See docs/backend-plan.md#publishing.
import { compileScreen } from '@signforge/compiler';
import { templateKey, type ScreenManifest, type Spot, type TemplateManifest } from '@signforge/contract';
import { draftChanged, platform, published, scoped, StaleVersionError, type OrgScope } from '@signforge/db';
import { seedOrganization, seedScreen } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import stressGolden from '@signforge/cli/golden/stress.json';
import { editorCalls, ok } from './calls';
import { loadCompileInput, loadOrg, publishOrg } from '../src/publishing';
import { dispatch, manifestKey, registry, type Caller, type ScreenNotifier } from '../src';
import { fakeServices } from './services';
import { sha256Hex } from '../src/dispatch';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const opts = { hash: sha256Hex, now: NOW };
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
        current: null,
        problems: [`spot ${x('extra')}: asset ${other.id} is not verified`, `manifest: playlist "${x('lonely')}" lists unknown spot "${x('extra')}"`],
      },
      { screenId: lobby.id, current: null, problems: [], manifest: expect.objectContaining({ defaultPlaylist: x('main') }) },
    ]);
  });

  it('says so when the org has no default playlist', async () => {
    await seedOrganization(env.DB, 'pub-no-default');
    const org = scoped(env.DB, 'pub-no-default');
    const only = await org.screens.insert({ name: 'Only', timezone: 'UTC', orientation: 'landscape' });
    expect((await publishOrg(org, opts)).screens).toEqual([{ screenId: only.id, current: null, problems: ['the organization has no default playlist'] }]);
  });
});

describe('concurrent publishes (R09)', () => {
  type Publish = Awaited<ReturnType<typeof publishOrg>>;
  /** Commit a publish as the publish tool does: its writes and every screen's switch, in one batch. */
  const commitPublish = (org: OrgScope, result: Publish) =>
    org.commit([
      ...result.writes,
      ...result.screens.flatMap((s) => (s.manifest ? org.screens.stage.setDesiredManifest(s.screenId, s.manifest.id).writes : [])),
    ]);
  const titleOn = (result: Publish, screenId: string) =>
    (result.screens.find((s) => s.screenId === screenId)!.manifest!.spots[x('deal')] as Extract<Spot, { kind: 'template' }>).data.title;
  const editDeal = (org: OrgScope, title: string) => org.spots.update(x('deal'), { dataJson: JSON.stringify({ title }) });
  const desiredOn = async (org: OrgScope, screenId: string) => (await org.screens.get(screenId))!.desiredManifestId;
  const manifestOn = (result: Publish, screenId: string) => result.screens.find((s) => s.screenId === screenId)!.manifest!.id;

  /**
   * A slow D1 read, as the review reproduced: `read` waits, when `first` is in flight beside it,
   * until `first` has returned and `between` has run. Reads made one after the other are not held.
   */
  function interleave<A, B>(first: () => Promise<A>, read: () => Promise<B>, between: () => Promise<unknown>) {
    let inFlight: Promise<unknown> | undefined;
    return {
      first: async () => {
        const done = first().then(async (r) => {
          await between();
          return r;
        });
        inFlight = done;
        try {
          return await done;
        } finally {
          inFlight = undefined;
        }
      },
      read: async () => {
        // Let the calls beside it in the same Promise.all start first.
        await Promise.resolve();
        if (inFlight) await inFlight;
        return read();
      },
    };
  }

  it('refuses an older publish whose revision was read after a newer publish committed (review 1)', async () => {
    const { org, lobby } = await seedSmallOrg('pub-race-slow-rev');
    await commitPublish(org, await publishOrg(org, opts));
    let newer: Publish | undefined;
    const slow = interleave(org.spots.list, org.settings.get, async () => {
      await editDeal(org, 'Three for $5');
      newer = await publishOrg(org, opts);
      await commitPublish(org, newer);
    });
    const older = await publishOrg({ ...org, spots: { ...org.spots, list: slow.first }, settings: { ...org.settings, get: slow.read } }, opts);
    expect(titleOn(older, lobby.id)).toBe('Two for $4');

    await expect(commitPublish(org, older)).rejects.toBeInstanceOf(StaleVersionError);
    expect(await desiredOn(org, lobby.id)).toBe(manifestOn(newer!, lobby.id));
  });

  it('refuses a playlist promotion whose items were read before an items edit and its version after (review 2)', async () => {
    const { org } = await seedSmallOrg('pub-race-items');
    await commitPublish(org, await publishOrg(org, opts));
    await org.playlists.setItems(x('main'), [x('still'), x('deal')]);
    const slow = interleave(org.playlists.allItems, org.playlists.list, () => org.playlists.setItems(x('main'), [x('deal')]));
    const stale = await publishOrg({ ...org, playlists: { ...org.playlists, allItems: slow.first, list: slow.read } }, opts);
    expect(stale.drafts.promoted).toContainEqual({ kind: 'playlist', id: x('main') });

    await expect(commitPublish(org, stale)).rejects.toBeInstanceOf(StaleVersionError);
    expect(published((await org.playlists.get(x('main')))!)!.items).toEqual([x('deal'), x('still')]);
  });

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
  const golden = stressGolden as unknown as ScreenManifest;
  /** The golden's templates as base ones, registered once for the file's database: their keys are unique. */
  let base: Promise<Map<string, string>> | undefined;
  async function baseTemplates() {
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
    return versionIds;
  }

  /**
   * The stress project as the database would hold it after upload: base templates, assets with
   * renditions, spots, a playlist and data sources, all published. The golden is `sf build`'s
   * output for examples/stress (packages/cli/test/golden.test.ts keeps it honest).
   * `playlists: false` leaves out the playlist and the default; a second org in the file needs
   * its own `screenId`, since screen ids are global.
   */
  async function seedStress(orgId: string, { playlists = true, screenId = golden.screen.id } = {}) {
    await seedOrganization(env.DB, orgId);
    const org = scoped(env.DB, orgId);
    base ??= baseTemplates();
    const versionIds = await base;
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
    await seedScreen(env.DB, orgId, { ...golden.screen, id: screenId });
    // Before the spots: a spot may bind only to the org's own data sources.
    for (const d of Object.values(golden.dataSources)) {
      await org.dataSources.insert({ id: d.id, name: d.id, format: 'json', urlEncrypted: 'enc:test', refreshS: d.refreshS });
    }
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
    for (const pl of playlists ? Object.values(golden.playlists) : []) {
      await org.playlists.insert({ id: pl.id, name: pl.name, transitionJson: JSON.stringify(pl.transition) });
      await org.playlists.setItems(
        pl.id,
        pl.items.map((i) => i.spot),
      );
    }
    if (playlists) await org.commit((await org.settings.stage.set({ defaultPlaylistId: golden.defaultPlaylist })).writes);
    return { org };
  }

  it('with the compiler, produces the manifest sf build produces for examples/stress', async () => {
    const { org } = await seedStress('stress-org');
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

  it('compiles a playlist built with the playlist tools, as the CMS builds it, to the one sf build makes for examples/stress (M3-17)', async () => {
    const { org } = await seedStress('stress-tools', { playlists: false, screenId: 'stress-tools-screen' });
    const tool = editorCalls(org);
    const call = async (name: string, input: unknown) => (await ok(tool(name, input))).playlist as { id: string; version: number };
    // The editor's path: make it empty, then add the spots and pick the transition, each an edit.
    const want = golden.playlists[golden.defaultPlaylist]!;
    const made = await call('create_playlist', { name: want.name, transition: { type: 'cut' } });
    const added = await call('update_playlist', { playlistId: made.id, spotIds: want.items.map((i) => i.spot).toReversed(), ifVersion: made.version });
    const ordered = await call('update_playlist', { playlistId: made.id, spotIds: want.items.map((i) => i.spot), ifVersion: added.version });
    await call('update_playlist', { playlistId: made.id, transition: want.transition, ifVersion: ordered.version });
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: made.id })).writes);

    const promotion = await publishOrg(org, opts);
    expect(promotion.drafts.held).toEqual([]);
    await org.commit(promotion.writes);
    const { manifest, problems } = await compileScreen((await loadCompileInput(org, 'stress-tools-screen'))!, opts);
    expect(problems).toEqual([]);
    expect(manifest!.playlists).toEqual({ [made.id]: { ...want, id: made.id } });
    expect(manifest!.spots).toEqual(golden.spots);
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

describe('the publish tools (M3-18)', () => {
  /** Calls as an editor, with a notifier that records which screens it was told of and a bucket `put` can be wrapped around. */
  function publisher(org: OrgScope, opts: { onPut?: (attempt: number) => Promise<void>; lock?: boolean } = {}) {
    const told: { screenId: string; manifestId: string }[][] = [];
    let puts = 0;
    let locked = 0;
    const blobs = new Proxy(env.BLOBS, {
      get: (target, key) =>
        key === 'put'
          ? async (...args: Parameters<R2Bucket['put']>) => {
              puts += 1;
              await opts.onPut?.(puts);
              return target.put(...args);
            }
          : Reflect.get(target, key, target),
    });
    const screens: ScreenNotifier = {
      manifest: async () => {},
      manifests: async (rows) => void told.push([...rows]),
      revoked: async () => {},
      command: async () => {},
    };
    const caller: Caller = {
      org,
      role: 'editor',
      actor: { kind: 'user', id: 'user-1', clientId: 'cms' },
      blobs,
      services: { ...fakeServices, notify: screens },
      ...(opts.lock ? { publishLock: async <T>(run: () => Promise<T>) => ((locked += 1), run()) } : {}),
    };
    return { call: (name: string, input: unknown) => dispatch(registry, name, input, caller), told, locked: () => locked };
  }
  const editDeal = (org: OrgScope, title: string) => org.spots.update(x('deal'), { dataJson: JSON.stringify({ title }) });
  type Out = {
    publish: { id: string; revision: number; screens: number; previousId: string | null } | null;
    promoted: unknown[];
    screens: { screenId: string; outcome: string }[];
  };

  it('publishes every changed draft, stores each manifest, switches the screens in one batch and tells them', async () => {
    const { org, lobby, hall } = await seedSmallOrg('tool-pub');
    const p = publisher(org, { lock: true });
    const out = (await ok(p.call('publish', {}))) as unknown as Out;
    expect(out.publish).toMatchObject({ revision: 1, screens: 2 });
    expect(out.promoted).toHaveLength(5);
    expect(out.screens.map((s) => s.outcome)).toEqual(['updated', 'updated']);
    expect(p.locked()).toBe(1);
    for (const s of [lobby, hall]) {
      const desired = (await org.screens.get(s.id))!.desiredManifestId!;
      const stored = await env.BLOBS.get(manifestKey(org.orgId, s.id, desired));
      expect(((await stored!.json()) as ScreenManifest).id).toBe(desired);
    }
    expect(p.told).toEqual([await org.publishes.screens(out.publish!.id)]);
    expect((await org.settings.get())!.publishRevision).toBe(1);
    expect(await org.auditLog.list({ target: { kind: 'publish', id: out.publish!.id } })).toHaveLength(1);
  });

  it('touches no screen and writes nothing when nothing changed', async () => {
    const { org } = await seedSmallOrg('tool-pub-same');
    const p = publisher(org);
    await ok(p.call('publish', {}));
    const audit = (await org.auditLog.list()).length;
    const again = (await ok(p.call('publish', {}))) as unknown as Out;
    expect(again).toMatchObject({ publish: null, promoted: [] });
    expect(again.screens.map((s) => s.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(p.told).toHaveLength(1);
    expect((await org.settings.get())!.publishRevision).toBe(1);
    expect(await org.auditLog.list()).toHaveLength(audit);
  });

  it("publishes only the pinned drafts, and refuses a pin whose draft changed since or is another org's", async () => {
    await seedSmallOrg('tool-pub-pins-theirs');
    const theirs = x('deal');
    const { org } = await seedSmallOrg('tool-pub-pins');
    const p = publisher(org);
    await ok(p.call('publish', {}));
    await editDeal(org, 'Three for $5');
    await org.spots.update(x('still'), { durationMs: 6000 });
    const deal = (await org.spots.get(x('deal')))!;
    const out = (await ok(p.call('publish', { drafts: [{ kind: 'spot', id: deal.id, version: deal.rowVersion }] }))) as unknown as Out;
    expect(out.promoted).toEqual([{ kind: 'spot', id: deal.id }]);
    expect(draftChanged((await org.spots.get(x('still')))!)).toBe(true);

    await editDeal(org, 'Four for $6');
    expect(await p.call('publish', { drafts: [{ kind: 'spot', id: deal.id, version: deal.rowVersion }] })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: deal.id, version: deal.rowVersion + 1 },
    });
    expect(await p.call('publish', { drafts: [{ kind: 'playlist', id: 'pls_gone', version: 1 }] })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: 'pls_gone', version: 0 },
    });
    expect(await p.call('publish', { drafts: [{ kind: 'spot', id: theirs, version: 1 }] })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: theirs, version: 0 },
    });
    expect((await org.settings.get())!.publishRevision).toBe(2);
    expect(draftChanged((await scoped(env.DB, 'tool-pub-pins-theirs').spots.get(theirs))!)).toBe(true);
  });

  it('is refused to an editor when only owners publish', async () => {
    const { org } = await seedSmallOrg('tool-pub-owners');
    await org.commit((await org.settings.stage.set({ editorsPublish: false })).writes);
    expect(await publisher(org).call('publish', {})).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('runs again from a fresh read when another publish commits first, and when a screen is deleted mid-publish', async () => {
    const { org, lobby, hall } = await seedSmallOrg('tool-pub-race');
    // Between this publish's read and its commit (its R2 writes), another publish commits.
    const rival = publisher(org);
    const p = publisher(org, {
      onPut: async (n) => {
        if (n === 1) {
          await ok(rival.call('publish', {}));
          await editDeal(org, 'Three for $5');
        }
      },
    });
    const out = (await ok(p.call('publish', {}))) as unknown as Out;
    expect(out.publish!.revision).toBe(2);

    // A screen deleted while it compiles: the batch's screen guard fails, and the next read has one screen.
    await editDeal(org, 'Five for $7');
    const q = publisher(org, { onPut: async (n) => void (n === 1 && (await org.screens.delete(hall.id))) });
    const after = (await ok(q.call('publish', {}))) as unknown as Out;
    expect(after.publish).toMatchObject({ revision: 3, screens: 1 });
    expect(after.screens.map((s) => s.screenId)).toEqual([lobby.id]);
  });

  it('gives up with a conflict after losing three times', async () => {
    const { org } = await seedSmallOrg('tool-pub-lose');
    const rival = publisher(org);
    let n = 0;
    const p = publisher(org, {
      // Two screens, two concurrent puts an attempt: the first of each pair lets the rival in.
      onPut: async (put) => {
        if (put % 2 === 0) return;
        await ok(rival.call('publish', {}));
        await editDeal(org, `Deal ${++n}`);
      },
    });
    await editDeal(org, 'Mine');
    expect(await p.call('publish', {})).toMatchObject({ ok: false, error: 'conflict', details: { id: 'publish revision' } });
    expect(n).toBe(3);
  });

  it('rolls screens back to an earlier publish without compiling, as a new publish', async () => {
    const { org, lobby } = await seedSmallOrg('tool-rollback');
    const p = publisher(org);
    const first = (await ok(p.call('publish', {}))) as unknown as Out;
    const v1 = (await org.screens.get(lobby.id))!.desiredManifestId;
    expect(first.publish!.previousId).toBeNull();
    await editDeal(org, 'Three for $5');
    const second = (await ok(p.call('publish', {}))) as unknown as Out;
    expect(second.publish!.previousId).toBe(first.publish!.id);
    const v2 = (await org.screens.get(lobby.id))!.desiredManifestId;
    expect(v2).not.toBe(v1);

    const back = (await ok(p.call('roll_back_publish', { publishId: first.publish!.id }))) as unknown as Out;
    expect(back.publish).toMatchObject({ revision: 3, screens: 2, previousId: second.publish!.id });
    expect((await org.screens.get(lobby.id))!).toMatchObject({ desiredManifestId: v1, previousManifestId: v2 });
    expect((await org.publishes.get(back.publish!.id))!.restoresId).toBe(first.publish!.id);
    expect((await ok(editorCalls(org)('get_publish', {}))).publish).toMatchObject({ revision: 3, restoresId: first.publish!.id, restoresRevision: 1 });
    expect(p.told.at(-1)).toContainEqual({ screenId: lobby.id, manifestId: v1 });
    expect(await ok(p.call('roll_back_publish', { publishId: first.publish!.id }))).toEqual({ publish: null });

    // Undo of the second publish after someone else published since: refused, so theirs stays on screen.
    await editDeal(org, 'Four for $6');
    const theirs = (await ok(p.call('publish', {}))) as unknown as Out;
    const onScreen = (await org.screens.get(lobby.id))!.desiredManifestId;
    expect(await p.call('roll_back_publish', { publishId: first.publish!.id, ifLatest: second.publish!.id })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { latestId: theirs.publish!.id },
    });
    expect((await org.screens.get(lobby.id))!.desiredManifestId).toBe(onScreen);
    // Undo of the latest goes through.
    expect(await ok(p.call('roll_back_publish', { publishId: back.publish!.id, ifLatest: theirs.publish!.id }))).toMatchObject({ publish: { revision: 5 } });
    expect(await p.call('roll_back_publish', { publishId: 'pub_gone' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it("lists publishes and reads a publish's rollout, screen by screen", async () => {
    const { org, lobby, hall } = await seedSmallOrg('tool-rollout');
    const p = publisher(org);
    const call = editorCalls(org);
    expect(await ok(call('get_publish', {}))).toEqual({ publish: null, screens: [] });
    const first = (await ok(p.call('publish', {}))) as unknown as Out;
    const manifest = (await org.screens.get(lobby.id))!.desiredManifestId!;
    await org.screens.reportManifest(lobby.id, manifest, { arrivedAt: Date.now() });
    await org.screens.update(hall.id, { lastSeenAt: Date.now() - 3_600_000 });

    const latest = await ok(call('get_publish', {}));
    expect(latest.publish).toMatchObject({ id: first.publish!.id, revision: 1, by: { kind: 'user', id: 'user-1' }, screens: 2, playing: 1, replaced: 0 });
    expect(latest.screens).toEqual([
      expect.objectContaining({ screenId: hall.id, name: 'Hall', outcome: 'offline' }),
      expect.objectContaining({ screenId: lobby.id, name: 'Lobby', outcome: 'playing', manifestId: manifest }),
    ]);
    await editDeal(org, 'Three for $5');
    await ok(p.call('publish', {}));
    expect((await ok(call('get_publish', { publishId: first.publish!.id }))).publish).toMatchObject({ revision: 1, playing: 1, replaced: 1 });
    // Lobby still says it plays v1, so it counts as playing it; Hall never did and v2 replaced it.
    const page1 = await ok(call('list_publishes', { limit: 1 }));
    expect((page1.publishes as { revision: number }[]).map((x) => x.revision)).toEqual([2]);
    const page2 = await ok(call('list_publishes', { limit: 1, cursor: page1.next }));
    expect(page2).toMatchObject({ publishes: [{ revision: 1 }], next: null });
    expect(await call('get_publish', { publishId: 'pub_gone' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('sets the default playlist, without which no screen can be published to', async () => {
    const { org } = await seedSmallOrg('tool-default');
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: null })).writes);
    const p = publisher(org);
    const none = (await ok(p.call('publish', {}))) as unknown as Out;
    expect(none.screens.map((s) => s.outcome)).toEqual(['failed', 'failed']);
    const call = editorCalls(org);
    expect(await ok(call('set_default_playlist', { playlistId: x('main') }))).toMatchObject({ playlist: { id: x('main'), isDefault: true } });
    expect((await ok(call('get_playlist', { playlistId: x('evenings') }))).playlist).toMatchObject({ isDefault: false });
    const out = (await ok(p.call('publish', {}))) as unknown as Out;
    expect(out.screens.map((s) => s.outcome)).toEqual(['updated', 'updated']);
    expect(await call('set_default_playlist', { playlistId: 'pls_gone' })).toMatchObject({ ok: false, error: 'not_found' });

    // It decides what every screen plays at the next publish, so where only owners publish, an editor may not.
    await org.commit((await org.settings.stage.set({ editorsPublish: false })).writes);
    expect(await call('set_default_playlist', { playlistId: x('evenings') })).toMatchObject({ ok: false, error: 'forbidden' });
    expect((await org.settings.get())!.defaultPlaylistId).toBe(x('main'));
  });

  it("deletes the spot editor's weather sources nothing binds, but not one a published version bound before the publish, nor one just made (#98)", async () => {
    const { org } = await seedSmallOrg('tool-pub-sources');
    const p = publisher(org);
    const call = editorCalls(org);
    const [w1, w2, w3, w4] = ['weather-1-c-kmh-aaaaaa', 'weather-2-f-mph-bbbbbb', 'weather-3-c-mph-cccccc', 'weather-4-f-kmh-dddddd'];
    const source = (id: string) =>
      org.dataSources.insert({ id, name: id, format: id.startsWith('news') ? 'rss' : 'json', urlEncrypted: `enc:${id}`, refreshS: 600 });
    // Made an hour ago: past the grace for one the editor has just made and not yet bound.
    const age = (id: string) =>
      env.DB.prepare('UPDATE data_sources SET created_at = ? WHERE id = ?')
        .bind(Date.now() - 3_600_000, id)
        .run();
    for (const id of [w1, w2, 'news-typed']) {
      await source(id);
      await age(id);
    }
    // w3: the editor made it a moment ago, and its autosave has not bound it yet.
    await source(w3);
    const bind = (id: string) => org.spots.update(x('deal'), { bindingsJson: JSON.stringify({ title: { source: id, path: 'current.title' } }) });
    const left = async () => new Set((await org.dataSources.list()).map((d) => d.id));

    await bind(w1);
    const first = (await ok(p.call('publish', {}))) as unknown as Out & { removedDataSources: string[] };
    expect(first.removedDataSources).toEqual([w2]);
    expect([...(await left())].filter((id) => [w1, w2, w3, 'news-typed'].includes(id)).sort()).toEqual([w1, w3, 'news-typed'].sort());

    // The editor moves the spot off w1: its delete is refused while the published version binds it,
    // and the publish that unbinds it keeps it, so Undo goes back to a manifest whose source is there.
    await source(w4);
    await age(w4);
    await bind(w4);
    expect(await call('delete_data_source', { dataSourceId: w1 })).toMatchObject({ ok: false, error: 'conflict' });
    const second = (await ok(p.call('publish', {}))) as unknown as Out & { removedDataSources: string[] };
    expect(second.removedDataSources).toEqual([]);
    await ok(p.call('roll_back_publish', { publishId: first.publish!.id, ifLatest: second.publish!.id }));
    expect((await left()).has(w1)).toBe(true);

    // The next publish (sending w4's content again after the Undo) is when w1 goes; w3 ages and goes too.
    await age(w3);
    const third = (await ok(p.call('publish', {}))) as unknown as Out & { removedDataSources: string[] };
    expect(third.removedDataSources).toEqual([w1, w3].sort());
    expect([...(await left())].filter((id) => [w1, w3, w4].includes(id))).toEqual([w4]);
  });
});
