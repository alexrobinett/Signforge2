// The playlist tools: drafts made, ordered and deleted through the registry, as the CMS's
// playlist editor calls them.
import { published, type OrgScope, type Write } from '@signforge/db';
import { seedOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dispatch, publishOrg, registry, sha256Hex } from '../src';
import { editorCalls, ok } from './calls';
import { memberOf } from './member';

async function setup(orgId: string) {
  const o = await seedOrg(env.DB, orgId);
  const org = testScope(env.DB, orgId);
  return { o, org, call: editorCalls(org) };
}

const idOf = (out: Record<string, unknown>) => (out.playlist as { id: string }).id;

describe('playlist drafts', () => {
  it('creates a playlist with its spots in order, fading by default, and reads it back', async () => {
    const { o, call } = await setup('pl-create');
    const made = await ok(call('create_playlist', { name: 'Lunch', spotIds: [o.imageSpot, o.templateSpot, o.imageSpot], idempotencyKey: 'pl-create-1' }));
    expect(made.playlist).toMatchObject({
      name: 'Lunch',
      transition: { type: 'fade', ms: 500 },
      spotIds: [o.imageSpot, o.templateSpot, o.imageSpot],
      version: 1,
      published: false,
      draftChanged: true,
    });
    const id = idOf(made);
    expect(await ok(call('get_playlist', { playlistId: id }))).toEqual(made);
    const { playlists } = await ok(call('list_playlists', {}));
    expect(playlists).toContainEqual(made.playlist);
    expect(await ok(call('create_playlist', { name: 'Empty', transition: { type: 'cut' } }))).toMatchObject({
      playlist: { spotIds: [], transition: { type: 'cut' } },
    });
  });

  it('lists the default playlist alone, or the unpublished ones, and counts every playlist the filters match (#357)', async () => {
    const { o, call } = await setup('pl-filters');
    const lunch = idOf(await ok(call('create_playlist', { name: 'Lunch', spotIds: [o.imageSpot] })));
    expect(await ok(call('list_playlists', { isDefault: true }))).toMatchObject({ playlists: [], total: 0 });
    await ok(call('set_default_playlist', { playlistId: lunch }));
    expect(await ok(call('list_playlists', { isDefault: true }))).toMatchObject({ playlists: [{ id: lunch, isDefault: true }], total: 1 });
    const listed = await ok(call('list_playlists', { unpublished: true }));
    const playlists = listed.playlists as { id: string; draftChanged: boolean }[];
    expect(playlists.every((p) => p.draftChanged)).toBe(true);
    expect(listed.total).toBe(playlists.length);
    expect(playlists.map((p) => p.id)).toContain(lunch);
  });

  it('reorders, renames and changes the transition with ifVersion, and refuses an edit from an old read', async () => {
    const { o, org, call } = await setup('pl-update');
    const id = idOf(await ok(call('create_playlist', { name: 'Lunch', spotIds: [o.imageSpot, o.templateSpot] })));
    const edited = await ok(
      call('update_playlist', {
        playlistId: id,
        name: 'Dinner',
        transition: { type: 'crossfade', ms: 800 },
        spotIds: [o.templateSpot, o.imageSpot],
        ifVersion: 1,
      }),
    );
    expect(edited.playlist).toMatchObject({ name: 'Dinner', transition: { type: 'crossfade', ms: 800 }, spotIds: [o.templateSpot, o.imageSpot], version: 2 });

    expect(await call('update_playlist', { playlistId: id, spotIds: [o.imageSpot], ifVersion: 1 })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id, version: 2 },
    });
    expect(await org.playlists.items(id)).toEqual([o.templateSpot, o.imageSpot]);
    // The order alone is a change: the version moves on.
    expect(await ok(call('update_playlist', { playlistId: id, spotIds: [], ifVersion: 2 }))).toMatchObject({ playlist: { spotIds: [], version: 3 } });
  });

  it('refuses a spot the organization does not have, and a transition a screen would refuse', async () => {
    const { o, call } = await setup('pl-refuse');
    const other = await seedOrg(env.DB, 'pl-refuse-other');
    expect(await call('create_playlist', { name: 'x', spotIds: [other.imageSpot] })).toMatchObject({ ok: false, error: 'not_found' });
    const id = idOf(await ok(call('create_playlist', { name: 'x' })));
    expect(await call('update_playlist', { playlistId: id, spotIds: [o.imageSpot, 'spt_missing'] })).toMatchObject({ ok: false, error: 'not_found' });
    for (const transition of [{ type: 'fade', ms: 0 }, { type: 'crossfade', ms: 20_000 }, { type: 'crossfade' }, { type: 'wipe', ms: 500 }])
      expect(await call('update_playlist', { playlistId: id, transition }), JSON.stringify(transition)).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await call('update_playlist', { playlistId: id })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('deletes a playlist, but not the default playlist or one a schedule entry plays', async () => {
    const { o, org, call } = await setup('pl-delete');
    expect(await call('delete_playlist', { playlistId: o.playlist })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { scheduleEntryIds: [o.scheduleEntry] },
    });
    await org.scheduleEntries.delete(o.scheduleEntry);
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: o.playlist })).writes);
    expect(await call('delete_playlist', { playlistId: o.playlist })).toMatchObject({ ok: false, error: 'conflict' });
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: null })).writes);

    expect(await ok(call('delete_playlist', { playlistId: o.playlist }))).toEqual({ deleted: o.playlist });
    expect(await call('get_playlist', { playlistId: o.playlist })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await org.playlists.allItems()).toEqual(new Map());
  });

  it('refuses an edit read before a delete on a playlist made again with its id, and writes nothing (#64)', async () => {
    const { o, org, call } = await setup('pl-tomb');
    const made = await ok(call('create_playlist', { name: 'Lunch', spotIds: [o.imageSpot] }));
    const id = idOf(made);
    const read = (await ok(call('update_playlist', { playlistId: id, name: 'Lunch, edited', ifVersion: 1 }))).playlist as { version: number };
    expect(read.version).toBe(2);
    expect(await ok(call('delete_playlist', { playlistId: id }))).toEqual({ deleted: id });

    // Made again with the same id, as a content import or `sf push` may: it continues the versions.
    await org.commit((await org.playlists.stage.insert({ id, name: 'Again', transitionJson: JSON.stringify({ type: 'cut' }) })).writes);
    const again = await ok(call('get_playlist', { playlistId: id }));
    expect(again.playlist).toMatchObject({ version: 3, name: 'Again', spotIds: [] });

    expect(await call('update_playlist', { playlistId: id, name: 'From the old read', spotIds: [o.templateSpot], ifVersion: read.version })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id, version: 3 },
    });
    expect(await ok(call('get_playlist', { playlistId: id }))).toEqual(again);
  });

  it('lets a viewer read but not change playlists', async () => {
    const { o, org } = await setup('pl-viewer');
    const viewer = memberOf(org, 'viewer', {}, 'user-2');
    expect(await dispatch(registry, 'get_playlist', { playlistId: o.playlist }, viewer)).toMatchObject({ ok: true });
    for (const [name, input] of [
      ['create_playlist', { name: 'x' }],
      ['update_playlist', { playlistId: o.playlist, name: 'x' }],
      ['delete_playlist', { playlistId: o.playlist }],
    ] as const)
      expect(await dispatch(registry, name, input, viewer)).toMatchObject({ ok: false, error: 'forbidden' });
  });
});

describe('playlist tools racing another commit (review of #97)', () => {
  it('lists each playlist with the order of the version it lists: an edit landing mid-read never pairs a new version with old items', async () => {
    const { o, org } = await setup('pl-race-list');
    const edit = async () => {
      const row = (await org.playlists.get(o.playlist))!;
      await org.commit((await org.playlists.stage.update(row, {}, row.rowVersion, [o.imageSpot])).writes);
    };
    // Another edit commits between the listing's two reads, whichever it makes first: after the
    // first returns and before the second starts.
    let between: Promise<void> | undefined;
    const inTurn =
      <T>(read: () => Promise<T>) =>
      async () => {
        if (between !== undefined) {
          await between;
          return read();
        }
        const out = read();
        between = out.then(edit);
        await between;
        return out;
      };
    const racing = { ...org, playlists: { ...org.playlists, list: inTurn(() => org.playlists.list()), allItems: inTurn(() => org.playlists.allItems()) } };
    const { playlists } = await ok(editorCalls(racing)('list_playlists', {}));
    const listed = (playlists as { id: string; version: number; spotIds: string[] }[]).find((p) => p.id === o.playlist)!;
    // Version 2 with the newer order: an edit made from this listing's version is refused, never lost.
    expect([listed.version, listed.spotIds]).toEqual([2, [o.imageSpot]]);
  });

  it('refuses a delete with conflict, not a fault, when the playlist is made the default or scheduled between its check and its commit', async () => {
    const { o, org } = await setup('pl-race-delete');
    await org.scheduleEntries.delete(o.scheduleEntry);
    const uses = {
      default: async () => org.commit((await org.settings.stage.set({ defaultPlaylistId: o.playlist })).writes),
      'schedule entry': async () => {
        await org.commit((await org.settings.stage.set({ defaultPlaylistId: null })).writes);
        await org.scheduleEntries.insert({ id: 'pl-race-entry', playlistId: o.playlist, target: 'org', priority: 1 });
      },
    };
    for (const [what, use] of Object.entries(uses)) {
      let used = false;
      const racing = {
        ...org,
        scheduleEntries: {
          ...org.scheduleEntries,
          list: async () => {
            const rows = await org.scheduleEntries.list();
            if (!used) {
              used = true;
              await use();
            }
            return rows;
          },
        },
      };
      expect(await editorCalls(racing)('delete_playlist', { playlistId: o.playlist }), what).toMatchObject({ ok: false, error: 'conflict' });
      expect(await org.playlists.get(o.playlist), what).toBeDefined();
    }
  });

  it('refuses an order with not_found, not a fault, when the playlist is deleted between its read and its commit', async () => {
    const { o, org } = await setup('pl-race-update');
    await org.scheduleEntries.delete(o.scheduleEntry);
    const racing = {
      ...org,
      playlists: {
        ...org.playlists,
        stage: {
          ...org.playlists.stage,
          update: async (...args: Parameters<typeof org.playlists.stage.update>) => {
            const staged = await org.playlists.stage.update(...args);
            await org.commit(org.playlists.stage.delete(o.playlist).writes);
            return staged;
          },
        },
      },
    };
    expect(await editorCalls(racing)('update_playlist', { playlistId: o.playlist, spotIds: [o.imageSpot] })).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('set_default_playlist with ifVersion (#336)', () => {
  it('replaces no default someone chose since the settings were read: refused as changed, and it stays theirs', async () => {
    const { o, call } = await setup('pl-default-guard');
    const read = (await ok(call('get_org_settings', {}))).settings as { version: number };
    // Someone else chooses one first.
    expect(await ok(call('set_default_playlist', { playlistId: o.playlist }))).toMatchObject({ playlist: { id: o.playlist } });
    const mine = await testScope(env.DB, o.orgId).playlists.insert({ name: 'Mine', transitionJson: JSON.stringify({ type: 'cut' }) });
    expect(await call('set_default_playlist', { playlistId: mine.id, ifVersion: read.version })).toMatchObject({ ok: false, error: 'conflict' });
    expect((await testScope(env.DB, o.orgId).settings.get())?.defaultPlaylistId).toBe(o.playlist);
    // At the version as it is now, it is set.
    const now = (await ok(call('get_org_settings', {}))).settings as { version: number };
    expect(await ok(call('set_default_playlist', { playlistId: mine.id, ifVersion: now.version }))).toMatchObject({ playlist: { id: mine.id } });
  });
});

describe('ifDefault on set_default_playlist and publish (#393)', () => {
  /** `org` with `before` run as its batch is committed: a change made between a call's read and its batch. */
  const racing = (org: OrgScope, before: () => Promise<unknown>): OrgScope => {
    let raced = false;
    const commit = async (writes: readonly Write[]) => {
      if (!raced) {
        raced = true;
        await before();
      }
      return org.commit(writes);
    };
    return new Proxy(org, { get: (t, k) => (k === 'commit' ? commit : Reflect.get(t, k)) });
  };
  const chooseDefault = async (org: OrgScope, playlistId: string) => org.commit((await org.settings.stage.set({ defaultPlaylistId: playlistId })).writes);

  it('sets a default only while there is none: refused when one was chosen before its read, or between its read and its batch', async () => {
    const { o, org, call } = await setup('pl-if-default');
    const theirs = await org.playlists.insert({ name: 'Theirs', transitionJson: JSON.stringify({ type: 'cut' }) });
    // Chosen between the read and the batch.
    const late = editorCalls(racing(org, () => chooseDefault(org, theirs.id)));
    expect(await late('set_default_playlist', { playlistId: o.playlist, ifDefault: null })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { defaultPlaylistId: theirs.id },
    });
    expect((await org.settings.get())?.defaultPlaylistId).toBe(theirs.id);
    // Chosen before it read: refused at once, naming it.
    expect(await call('set_default_playlist', { playlistId: o.playlist, ifDefault: null })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { defaultPlaylistId: theirs.id },
    });
    // Only if it is still theirs: it is, so it is replaced.
    expect(await ok(call('set_default_playlist', { playlistId: o.playlist, ifDefault: theirs.id }))).toMatchObject({ playlist: { id: o.playlist } });
  });

  it('publishes a default pinned as the default only while it is: refused when it was switched, before its read or before its batch', async () => {
    const { o, org } = await setup('pl-publish-default');
    const owner = (scope: OrgScope) => (name: string, input: unknown) => dispatch(registry, name, input, memberOf(scope, 'owner'));
    await chooseDefault(org, o.playlist);
    const other = await org.playlists.insert({ name: 'Other', transitionJson: JSON.stringify({ type: 'cut' }) });
    const spot = (await org.spots.get(o.templateSpot))!;
    const pins = { drafts: [{ kind: 'spot', id: spot.id, version: spot.rowVersion }], ifDefault: o.playlist };
    // Switched between its read and its batch: nothing is published.
    expect(await owner(racing(org, () => chooseDefault(org, other.id)))('publish', pins)).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { defaultPlaylistId: other.id },
    });
    expect(published((await org.spots.get(spot.id))!)).toBeUndefined();
    // Switched before it read: refused at once, naming the default now.
    expect(await owner(org)('publish', pins)).toMatchObject({ ok: false, error: 'conflict', details: { defaultPlaylistId: other.id } });
    // While it is: published.
    await chooseDefault(org, o.playlist);
    expect(await ok(owner(org)('publish', pins))).toMatchObject({ promoted: [{ kind: 'spot', id: spot.id }] });
    // Switched to another just as the compiler reads it, and back before its batch (A, B, A): every other read,
    // a check made before compiling included, sees A, and the guard alone would pass; so it holds to the
    // default the compiler read, and refuses, publishing nothing compiled against the other.
    await chooseDefault(org, o.playlist);
    const spotNow = (await org.spots.get(spot.id))!;
    const settings = org.settings;
    /** The settings reads that saw B: the compiler's alone. */
    const flipped: string[] = [];
    const aba = racing(
      new Proxy(org, {
        get: (t, k) =>
          k === 'settings'
            ? new Proxy(settings, {
                get: (st, sk) =>
                  sk === 'get'
                    ? async () => {
                        // The compiler's read (`loadOrg`, src/publishing.ts), by its caller.
                        if (new Error().stack?.includes('loadOrg')) {
                          flipped.push('loadOrg');
                          await chooseDefault(org, other.id);
                        }
                        return settings.get();
                      }
                    : Reflect.get(st, sk),
              })
            : Reflect.get(t, k),
      }),
      () => chooseDefault(org, o.playlist),
    );
    /** `input` published through `scope`: refused, naming the other default, with no publish made. */
    const refusedFor = async (scope: OrgScope, input: unknown) => {
      const revision = (await org.publishes.history({ limit: 1 }))[0]?.revision;
      expect(await owner(scope)('publish', input)).toMatchObject({ ok: false, error: 'conflict', details: { defaultPlaylistId: other.id } });
      expect((await org.publishes.history({ limit: 1 }))[0]?.revision).toBe(revision);
    };
    await refusedFor(aba, { drafts: [{ kind: 'spot', id: spotNow.id, version: spotNow.rowVersion }], ifDefault: o.playlist });
    expect(flipped).toEqual(['loadOrg']);
    await chooseDefault(org, o.playlist);
    // A publish that changes no screen (removals only, or nothing) is held to it as well.
    await refusedFor(
      racing(org, () => chooseDefault(org, other.id)),
      { drafts: [], ifDefault: o.playlist },
    );
  });

  it("holds a publish to the screens, default and brand kits a card showed, to its batch: a change between its read and its batch refuses it, writing nothing (#406)", async () => {
    const { o, org } = await setup('pl-publish-held');
    const owner = (scope: OrgScope) => (name: string, input: unknown) => dispatch(registry, name, input, memberOf(scope, 'owner'));
    await chooseDefault(org, o.playlist);
    const other = await org.playlists.insert({ name: 'Other', transitionJson: JSON.stringify({ type: 'cut' }) });
    const spot = (await org.spots.get(o.templateSpot))!;
    const playlist = (await org.playlists.get(o.playlist))!;
    const image = (await org.spots.get(o.imageSpot))!;
    const drafts = [
      { kind: 'spot' as const, id: spot.id, version: spot.rowVersion },
      { kind: 'spot' as const, id: image.id, version: image.rowVersion },
      { kind: 'playlist' as const, id: playlist.id, version: playlist.rowVersion },
    ];
    // What the drawer's card reads and binds (apps/api/src/agent/confirm.ts): the screens it switches, the default, the brand state.
    const dry = await publishOrg(org, { hash: sha256Hex, now: new Date() }, drafts);
    const ifScreens = dry.screens.flatMap((x) => (x.manifest && x.manifest.id !== x.current ? [x.screenId] : []));
    expect(ifScreens).toEqual([o.screen]);
    const input = { drafts, ifDefault: o.playlist, ifBrand: dry.brand, ifScreens };
    /** Published through `scope`, whose batch `change` races: refused as `why`, with no publish made and the spot not published. */
    const refusedFor = async (change: () => Promise<unknown>, why: Record<string, unknown>) => {
      const revision = (await org.publishes.history({ limit: 1 }))[0]?.revision;
      expect(await owner(racing(org, change))('publish', input)).toMatchObject({ ok: false, error: 'conflict', details: why });
      expect((await org.publishes.history({ limit: 1 }))[0]?.revision).toBe(revision);
      expect(published((await org.spots.get(spot.id))!)).toBeUndefined();
    };
    // Another default, between its read and its batch.
    await refusedFor(() => chooseDefault(org, other.id), { defaultPlaylistId: other.id });
    await chooseDefault(org, o.playlist);
    // A brand kit made.
    const kit = await org.brandKits.insert({
      name: 'House',
      colorsJson: JSON.stringify({ primary: '#000000', accent: '#ffffff', background: '#000000', surface: '#111111', text: '#ffffff', muted: '#aaaaaa' }),
      shape: 'soft',
    });
    await org.commit(org.brandKits.stage.delete(kit.id).writes);
    await refusedFor(
      () =>
        org.brandKits.insert({
          name: 'Later',
          colorsJson: JSON.stringify({ primary: '#000000', accent: '#ffffff', background: '#000000', surface: '#111111', text: '#ffffff', muted: '#aaaaaa' }),
          shape: 'soft',
        }),
      { brand: true },
    );
    // A screen added: it would switch that one too.
    const fresh = await publishOrg(org, { hash: sha256Hex, now: new Date() }, drafts);
    const now = { ...input, ifBrand: fresh.brand };
    const added = await (async () => {
      const revision = (await org.publishes.history({ limit: 1 }))[0]?.revision;
      let made = '';
      const raced = racing(org, async () => {
        made = (await org.screens.insert({ name: 'Annex', timezone: 'UTC', orientation: 'landscape' })).id;
      });
      const out = await owner(raced)('publish', now);
      expect((await org.publishes.history({ limit: 1 }))[0]?.revision).toBe(revision);
      expect(published((await org.spots.get(spot.id))!)).toBeUndefined();
      return { out, made };
    })();
    expect(added.out).toMatchObject({ ok: false, error: 'conflict', details: { screens: [o.screen, added.made].sort() } });
    // As shown, with nothing changed: published.
    const shown = await publishOrg(org, { hash: sha256Hex, now: new Date() }, drafts);
    const switches = shown.screens.flatMap((x) => (x.manifest && x.manifest.id !== x.current ? [x.screenId] : []));
    expect(await ok(owner(org)('publish', { ...input, ifBrand: shown.brand, ifScreens: switches }))).toMatchObject({ promoted: expect.arrayContaining([{ kind: 'spot', id: spot.id }]) });
  });
});
