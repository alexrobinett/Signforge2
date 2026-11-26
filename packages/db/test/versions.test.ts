// Row versions: a guarded change is written only if the row is still the version it was read at,
// checked inside the batch that writes it.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { NotInOrgError, StaleVersionError } from '../src';
import { seedOrg, testScope } from '../src/testing';

describe('row versions', () => {
  it('start at 1 and move on with every change', async () => {
    const o = await seedOrg(env.DB, 'ver-move');
    const org = testScope(env.DB, o.orgId);
    const screen = (await org.screens.get(o.screen))!;
    expect(screen.rowVersion).toBe(1);
    const renamed = org.screens.stage.update(screen, { name: 'Renamed' });
    expect(renamed.row.rowVersion).toBe(2);
    await org.commit(renamed.writes);
    expect((await org.screens.get(o.screen))!.rowVersion).toBe(2);
  });

  it('refuse a change staged against an old version, before anything is staged', async () => {
    const o = await seedOrg(env.DB, 'ver-stale');
    const org = testScope(env.DB, o.orgId);
    const screen = (await org.screens.get(o.screen))!;
    expect(() => org.screens.stage.update(screen, { name: 'Late' }, 7)).toThrow(StaleVersionError);
    try {
      org.screens.stage.update(screen, { name: 'Late' }, 7);
    } catch (err) {
      expect(err).toMatchObject({ id: o.screen, version: 1 });
    }
  });

  it('refuse in the batch a change whose row moved on after it was read, writing nothing', async () => {
    const o = await seedOrg(env.DB, 'ver-race');
    const org = testScope(env.DB, o.orgId);
    const read = (await org.screens.get(o.screen))!;
    const mine = org.screens.stage.update(read, { name: 'Mine' }, read.rowVersion);
    const audit = org.auditLog.stage({ actorKind: 'user', actorId: 'u', action: 'update_screen' });
    // Someone else's change lands between the read and the commit.
    await org.commit(org.screens.stage.update(read, { timezone: 'Asia/Tokyo' }).writes);

    const err = await org.commit([...mine.writes, ...audit.writes]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: o.screen, version: 2 });
    const now = (await org.screens.get(o.screen))!;
    expect(now).toMatchObject({ name: read.name, timezone: 'Asia/Tokyo', rowVersion: 2 });
    expect((await org.auditLog.list()).filter((a) => a.action === 'update_screen')).toEqual([]);
  });

  it('commit a change made at the current version', async () => {
    const o = await seedOrg(env.DB, 'ver-ok');
    const org = testScope(env.DB, o.orgId);
    const read = (await org.screens.get(o.screen))!;
    await org.commit(org.screens.stage.update(read, { name: 'Mine' }, read.rowVersion).writes);
    expect(await org.screens.get(o.screen)).toMatchObject({ name: 'Mine', rowVersion: 2 });
  });

  it('say not found for a guarded row deleted before the commit', async () => {
    const o = await seedOrg(env.DB, 'ver-gone');
    const org = testScope(env.DB, o.orgId);
    const group = (await org.screenGroups.get(o.group))!;
    const mine = org.screenGroups.stage.update(group, { name: 'Mine' }, group.rowVersion);
    await org.commit(org.screenGroups.stage.delete(group.id).writes);
    await expect(org.commit(mine.writes)).rejects.toBeInstanceOf(NotInOrgError);
  });

  it("move a group's version when its members change, and guard it like a field", async () => {
    const o = await seedOrg(env.DB, 'ver-members');
    const org = testScope(env.DB, o.orgId);
    const extra = await org.screens.insert({ name: 'Extra', timezone: 'UTC', orientation: 'landscape' });
    const group = (await org.screenGroups.get(o.group))!;

    const added = await org.screenGroups.stage.addMembers(group, [extra.id]);
    expect(added.row.rowVersion).toBe(2);
    await org.commit(added.writes);
    expect((await org.screenGroups.members(o.group)).toSorted()).toEqual([o.screen, extra.id].toSorted());

    // A replace staged from the version before the add is refused in the batch.
    const replace = await org.screenGroups.stage.setMembers(group, [o.screen], { ifVersion: 1 });
    await expect(org.commit(replace.writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect((await org.screenGroups.members(o.group)).toSorted()).toEqual([o.screen, extra.id].toSorted());

    const now = (await org.screenGroups.get(o.group))!;
    const removed = await org.screenGroups.stage.removeMembers(now, [o.screen]);
    expect(removed.row.rowVersion).toBe(3);
    await org.commit(removed.writes);
    expect(await org.screenGroups.members(o.group)).toEqual([extra.id]);
  });

  it('guard org settings too, counting an org with no settings row as version 1', async () => {
    const o = await seedOrg(env.DB, 'ver-settings');
    const org = testScope(env.DB, o.orgId);
    // Two first saves made from the same read: the one that commits second is refused in the batch.
    const mine = await org.settings.stage.set({ locale: 'en-GB' }, 1);
    await org.commit((await org.settings.stage.set({ timezone: 'Asia/Tokyo' }, 1)).writes);
    const err = await org.commit(mine.writes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: 'settings', version: 2 });
    expect(await org.settings.get()).toMatchObject({ timezone: 'Asia/Tokyo', locale: null, rowVersion: 2 });

    await expect(org.settings.stage.set({ locale: 'en-GB' }, 1)).rejects.toBeInstanceOf(StaleVersionError);
    await org.commit((await org.settings.stage.set({ locale: 'en-GB' })).writes);
    expect(await org.settings.get()).toMatchObject({ locale: 'en-GB', rowVersion: 3 });
  });
});

describe('a batch a guard failed, though every guard holds again by the time it is diagnosed (round 3 of #393)', () => {
  it('is still a refusal, StaleVersionError, never the raw database error', async () => {
    const o = await seedOrg(env.DB, 'ver-reverted');
    const setDefault = async (playlistId: string | null) => {
      const org = testScope(env.DB, o.orgId);
      await org.commit((await org.settings.stage.set({ defaultPlaylistId: playlistId })).writes);
    };
    await setDefault(o.playlist);
    // A switch to none lands as the batch runs, and is taken back before the failure is diagnosed.
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop !== 'batch') return typeof v === 'function' ? v.bind(target) : v;
        return async (statements: D1PreparedStatement[]) => {
          await setDefault(null);
          try {
            return await target.batch(statements);
          } finally {
            await setDefault(o.playlist);
          }
        };
      },
    });
    const org = testScope(racing, o.orgId);
    const renamed = org.screens.stage.update((await org.screens.get(o.screen))!, { name: 'Renamed' });
    const err = await org.commit([...org.settings.stage.defaultIs(o.playlist).writes, ...renamed.writes]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: 'batch', version: 0 });
    expect((await testScope(env.DB, o.orgId).screens.get(o.screen))!.name).not.toBe('Renamed');
  });
});

describe('a batch the database failed, not a guard, though a guard is in it (round 4 of #393)', () => {
  it('is the database error, as it is: never a conflict', async () => {
    const o = await seedOrg(env.DB, 'ver-not-guard');
    const org = testScope(env.DB, o.orgId);
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: o.playlist })).writes);
    // A spot whose bindings are not JSON: the feed cleanup's statement reads them, and SQLite refuses it.
    const spot = await org.spots.insert({ name: 'Broken', kind: 'template', durationMs: 8000, templateVersionId: o.templateVersion });
    await env.DB.prepare("UPDATE spots SET bindings_json = '{not json' WHERE id = ?").bind(spot.id).run();
    const err = await org
      .commit([...org.settings.stage.defaultIs(o.playlist).writes, ...org.dataSources.stage.deleteUnbound([o.dataSource], Date.now()).writes])
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(StaleVersionError);
    expect(String(err)).toMatch(/malformed JSON/);
  });
});
