// The playlist tools: drafts made, ordered and deleted through the registry, as the CMS's
// playlist editor calls them.
import { scoped } from '@signforge/db';
import { seedOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller } from '../src';
import { editorCalls, ok } from './calls';
import { fakeServices } from './services';

async function setup(orgId: string) {
  const o = await seedOrg(env.DB, orgId);
  const org = scoped(env.DB, orgId);
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
    const viewer: Caller = { org, role: 'viewer', actor: { kind: 'user', id: 'user-2', clientId: 'cms' }, blobs: env.BLOBS, services: fakeServices };
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
    let edited = () => {};
    const done = new Promise<void>((r) => {
      edited = r;
    });
    // Another edit commits right after the items are read; the rows are read as late as the listing lets them be.
    const racing = {
      ...org,
      playlists: {
        ...org.playlists,
        list: async () => {
          await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
          return org.playlists.list();
        },
        allItems: async () => {
          const items = await org.playlists.allItems();
          const row = (await org.playlists.get(o.playlist))!;
          await org.commit((await org.playlists.stage.update(row, {}, row.rowVersion, [o.imageSpot])).writes);
          edited();
          return items;
        },
      },
    };
    const { playlists } = await ok(editorCalls(racing)('list_playlists', {}));
    const listed = (playlists as { id: string; version: number; spotIds: string[] }[]).find((p) => p.id === o.playlist)!;
    expect([
      [2, [o.templateSpot, o.imageSpot]],
      [3, [o.imageSpot]],
    ]).toContainEqual([listed.version, listed.spotIds]);
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
