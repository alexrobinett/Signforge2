// Conditional updates: a change made from an old read is refused, not written over someone else's.
import { scoped, type OrgScope } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller } from '../src';

let o: SeededOrg;
let n = 0;
const as = (org: OrgScope, kind: 'user' | 'agent'): Caller => ({ org, role: 'owner', actor: { kind, id: `${kind}-1` }, blobs: env.BLOBS });
let person: Caller;
let agent: Caller;

const call = async <T = any>(caller: Caller, name: string, input: unknown): Promise<T> => {
  const r = await dispatch(registry, name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const audited = async (action: string) => (await person.org.auditLog.list()).filter((a) => a.action === action).length;

beforeEach(async () => {
  o = await seedOrg(env.DB, `ver-${++n}`);
  person = as(scoped(env.DB, o.orgId), 'user');
  agent = as(scoped(env.DB, o.orgId), 'agent');
});

describe('ifVersion', () => {
  it('lets a change made at the current version through, and moves the version on', async () => {
    const { screen } = await call(person, 'get_screen', { screenId: o.screen });
    expect(screen.version).toBe(1);
    const renamed = (await call(person, 'rename_screen', { screenId: o.screen, name: 'Counter', ifVersion: 1 })).screen;
    expect(renamed).toMatchObject({ name: 'Counter', version: 2 });
    expect((await call(person, 'get_screen', { screenId: o.screen })).screen.version).toBe(2);
  });

  it('refuses a stale one with conflict and the current version, writing nothing', async () => {
    await call(agent, 'rename_screen', { screenId: o.screen, name: 'Agent' });
    const r = await dispatch(registry, 'update_screen_settings', { screenId: o.screen, timezone: 'Asia/Tokyo', ifVersion: 1 }, person);
    expect(r).toMatchObject({ ok: false, error: 'conflict', details: { id: o.screen, version: 2 } });
    expect((await call(person, 'get_screen', { screenId: o.screen })).screen).toMatchObject({ name: 'Agent', timezone: 'Europe/London', version: 2 });
    expect(await audited('update_screen_settings')).toBe(0);
  });

  it('refuses inside the batch when the row moves on between the read and the commit', async () => {
    const org = scoped(env.DB, o.orgId);
    // The agent's rename lands after the person's tool has read the screen, just before it commits.
    const racing: OrgScope = {
      ...org,
      commit: async (writes) => {
        await call(agent, 'rename_screen', { screenId: o.screen, name: 'Agent' });
        return org.commit(writes);
      },
    };
    const r = await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'Person', ifVersion: 1 }, as(racing, 'user'));
    expect(r).toMatchObject({ ok: false, error: 'conflict', details: { id: o.screen, version: 2 } });
    expect((await call(person, 'get_screen', { screenId: o.screen })).screen).toMatchObject({ name: 'Agent', version: 2 });
    expect((await person.org.auditLog.list()).filter((a) => a.action === 'rename_screen').map((a) => a.actorKind)).toEqual(['agent']);
  });

  it('guards groups, brand kits and data sources the same way', async () => {
    const stale = [
      ['rename_group', { groupId: o.group, name: 'Late', ifVersion: 9 }],
      ['set_group_members', { groupId: o.group, screenIds: [], ifVersion: 9 }],
      ['update_brand_kit', { brandKitId: o.brandKit, shape: 'round', ifVersion: 9 }],
      ['update_data_source', { dataSourceId: o.dataSource, refreshS: 600, ifVersion: 9 }],
    ] as const;
    for (const [name, input] of stale) expect(await dispatch(registry, name, input, person), name).toMatchObject({ ok: false, error: 'conflict' });
    expect((await call(person, 'list_groups', {})).groups[0]).toMatchObject({ screenIds: [o.screen], version: 1 });
    expect((await call(person, 'rename_group', { groupId: o.group, name: 'Now', ifVersion: 1 })).group.version).toBe(2);
    expect((await call(person, 'update_brand_kit', { brandKitId: o.brandKit, shape: 'round', ifVersion: 1 })).brandKit.version).toBe(2);
    expect((await call(person, 'update_data_source', { dataSourceId: o.dataSource, refreshS: 600, ifVersion: 1 })).dataSource.version).toBe(2);
  });
});

describe('group members', () => {
  it("keep a member an agent added while a person's settings form was open", async () => {
    const org = scoped(env.DB, o.orgId);
    const other = await org.screens.insert({ name: 'Other', timezone: 'UTC', orientation: 'landscape' });
    const empty = (await call(person, 'create_group', { name: 'Windows' })).group;
    // The person opens the form for `other` (the group is empty then), and an agent adds the lobby.
    await call(agent, 'add_group_members', { groupId: empty.id, screenIds: [o.screen] });
    // Saving the form puts `other` in the group, as the CMS does.
    const saved = (await call(person, 'add_group_members', { groupId: empty.id, screenIds: [other.id] })).group;
    expect(saved.screenIds).toEqual([o.screen, other.id].toSorted());
    expect(saved.version).toBe(3);

    // A replace built from the form's stale list is refused instead of dropping the lobby.
    expect(await dispatch(registry, 'set_group_members', { groupId: empty.id, screenIds: [other.id], ifVersion: empty.version }, person)).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: empty.id, version: 3 },
    });

    const removed = (await call(person, 'remove_group_members', { groupId: empty.id, screenIds: [other.id, 'scr_notmember'] })).group;
    expect(removed.screenIds).toEqual([o.screen]);
  });

  it('refuse a screen of another org', async () => {
    const theirs = await seedOrg(env.DB, `ver-other-${n}`);
    expect(await dispatch(registry, 'add_group_members', { groupId: o.group, screenIds: [theirs.screen] }, person)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect((await call(person, 'list_groups', {})).groups[0]).toMatchObject({ screenIds: [o.screen], version: 1 });
  });
});
