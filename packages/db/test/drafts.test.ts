// Drafts and their published versions: editing changes the draft, only `stage.publish` the
// published version. See docs/backend-plan.md#publishing.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { draftChanged, published, scoped } from '../src/index';
import { seedOrg, type SeededOrg } from '../src/testing';

let o: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'drafts-org');
});

describe('drafts', () => {
  it('starts unpublished, and publishing snapshots the draft as it was read', async () => {
    const org = scoped(env.DB, o.orgId);
    const spot = (await org.spots.get(o.imageSpot))!;
    expect(published(spot)).toBeUndefined();
    expect(draftChanged(spot)).toBe(true);

    const { row, writes } = org.spots.stage.publish(spot);
    await org.commit(writes);
    expect(row.publishedAt).toEqual(expect.any(Number));
    const stored = (await org.spots.get(o.imageSpot))!;
    expect(stored).toEqual(row);
    expect(published(stored)).toMatchObject({ id: o.imageSpot, name: 'Logo', kind: 'image', durationMs: 8000, assetId: o.asset, fit: 'cover' });
    expect(draftChanged(stored)).toBe(false);

    // An edit changes the draft only.
    const edited = (await org.spots.update(o.imageSpot, { name: 'Logo, new', durationMs: 9000 }))!;
    expect(edited.name).toBe('Logo, new');
    expect(published(edited)).toMatchObject({ name: 'Logo', durationMs: 8000 });
    expect(draftChanged(edited)).toBe(true);
  });

  it('never lets an edit set the published version', async () => {
    const org = scoped(env.DB, o.orgId);
    const forged = { name: 'Forged', publishedJson: '{"name":"forged"}', publishedAt: 1 } as never;
    await org.spots.update(o.templateSpot, forged);
    const current = (await org.spots.get(o.templateSpot))!;
    await org.commit((await org.spots.stage.update(current, forged)).writes);
    const after = (await org.spots.get(o.templateSpot))!;
    expect(after.name).toBe('Forged');
    expect(after.publishedJson).toBeNull();
    expect(after.publishedAt).toBeNull();
  });

  it('publishes a playlist with its items, so a later draft edit to the items is not live', async () => {
    const org = scoped(env.DB, o.orgId);
    const row = (await org.playlists.get(o.playlist))!;
    const items = await org.playlists.items(o.playlist);
    await org.commit(org.playlists.stage.publish(row, items).writes);
    await org.playlists.setItems(o.playlist, [o.imageSpot]);

    const stored = (await org.playlists.get(o.playlist))!;
    expect(published(stored)).toMatchObject({ id: o.playlist, name: 'Main', items: [o.templateSpot, o.imageSpot] });
    expect(draftChanged(stored, await org.playlists.items(o.playlist))).toBe(true);
    expect(draftChanged(stored, [o.templateSpot, o.imageSpot])).toBe(false);
    expect(await org.playlists.allItems()).toEqual(new Map([[o.playlist, [o.imageSpot]]]));
  });

  it('publishes schedule entries', async () => {
    const org = scoped(env.DB, o.orgId);
    const row = (await org.scheduleEntries.get(o.scheduleEntry))!;
    await org.commit(org.scheduleEntries.stage.publish(row).writes);
    await org.scheduleEntries.update(o.scheduleEntry, { priority: 7 });
    expect(published((await org.scheduleEntries.get(o.scheduleEntry))!)).toMatchObject({ target: 'group', groupId: o.group, priority: 1 });
  });

  it('counts an asset a published spot still uses as in use, so it cannot be deleted from under a screen', async () => {
    const org = scoped(env.DB, o.orgId);
    const other = await org.assets.insert({ kind: 'image', name: 'other.png', sha256: 'f'.repeat(64), type: 'image/png', size: 10, status: 'verified' });
    const spot = (await org.spots.get(o.imageSpot))!;
    await org.commit(org.spots.stage.publish(spot).writes);
    await org.spots.update(o.imageSpot, { assetId: other.id });
    const usage = await org.assets.usage([o.asset, other.id]);
    expect(usage.get(o.asset)).toEqual([o.imageSpot]);
    expect(usage.get(other.id)).toEqual([o.imageSpot]);
  });
});

describe('org settings', () => {
  it('holds the default playlist, which must be one of the org own', async () => {
    const org = scoped(env.DB, o.orgId);
    expect(await org.settings.get()).toBeUndefined();
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: o.playlist })).writes);
    expect(await org.settings.get()).toMatchObject({ defaultPlaylistId: o.playlist });
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: null })).writes);
    expect(await org.settings.get()).toMatchObject({ defaultPlaylistId: null });

    const elsewhere = await seedOrg(env.DB, 'drafts-other');
    await expect(org.settings.stage.set({ defaultPlaylistId: elsewhere.playlist })).rejects.toThrow(/playlist .* not found/);
  });

  it('lists every group membership at once', async () => {
    const org = scoped(env.DB, o.orgId);
    expect(await org.screenGroups.allMembers()).toEqual([{ groupId: o.group, screenId: o.screen }]);
  });
});
