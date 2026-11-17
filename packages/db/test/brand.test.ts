import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { NotInOrgError, scoped } from '../src/index';
import { seedTwoOrgs, type Seeded } from '../src/testing';

const COLORS = JSON.stringify({ primary: '#112233', accent: '#ffcc00', background: '#000000', surface: '#111111', text: '#ffffff', muted: '#aaaaaa' });

let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

describe('brand kits', () => {
  it('get ids from the server, never the caller, so two orgs cannot collide', async () => {
    const a = s.a.scope;
    const b = s.b.scope;
    const one = await a.brandKits.stage.insert({ id: 'house', name: 'House', colorsJson: COLORS, shape: 'soft' } as never);
    const two = await b.brandKits.stage.insert({ id: 'house', name: 'House', colorsJson: COLORS, shape: 'soft' } as never);
    expect(one.row.id).toMatch(/^bk_[a-z2-7]{24}$/);
    expect(two.row.id).not.toBe(one.row.id);
    await a.commit(one.writes);
    await b.commit(two.writes);
    expect(await a.brandKits.get(one.row.id)).toMatchObject({ orgId: 'org-a', name: 'House' });
    expect(await b.brandKits.get(one.row.id)).toBeUndefined();
  });

  it("assign to the org, a group or a screen, one kit each, and clear with null; another org's rows are refused", async () => {
    const a = s.a.scope;
    const kit = s.a.brandKit;
    const other = await a.brandKits.stage.insert({ name: 'Winter', colorsJson: COLORS, shape: 'round' });
    await a.commit(other.writes);

    await a.commit((await a.brandKits.assignments.stage.set({ target: 'group', groupId: s.a.group }, other.row.id)).writes);
    await a.commit((await a.brandKits.assignments.stage.set({ target: 'group', groupId: s.a.group }, kit)).writes);
    await a.commit((await a.brandKits.assignments.stage.set({ target: 'screen', screenId: s.a.screen }, other.row.id)).writes);
    const list = await a.brandKits.assignments.list();
    expect(list.map((r) => [r.target, r.groupId ?? r.screenId ?? null, r.brandKitId])).toEqual([
      ['group', s.a.group, kit],
      ['org', null, kit],
      ['screen', s.a.screen, other.row.id],
    ]);
    await a.commit((await a.brandKits.assignments.stage.set({ target: 'screen', screenId: s.a.screen }, null)).writes);
    expect((await a.brandKits.assignments.list()).map((r) => r.target)).toEqual(['group', 'org']);

    const b = s.b.scope;
    await expect(b.brandKits.assignments.stage.set({ target: 'org' }, kit)).rejects.toBeInstanceOf(NotInOrgError);
    await expect(b.brandKits.assignments.stage.set({ target: 'screen', screenId: s.a.screen }, s.b.brandKit)).rejects.toBeInstanceOf(NotInOrgError);
    await expect(b.brandKits.assignments.stage.set({ target: 'group', groupId: s.a.group }, s.b.brandKit)).rejects.toBeInstanceOf(NotInOrgError);
    await expect(b.brandKits.stage.insert({ name: 'x', colorsJson: COLORS, shape: 'soft', logoOnDarkAssetId: s.a.asset })).rejects.toBeInstanceOf(
      NotInOrgError,
    );
    expect((await b.brandKits.assignments.list()).every((r) => r.orgId === 'org-b')).toBe(true);
  });
});
