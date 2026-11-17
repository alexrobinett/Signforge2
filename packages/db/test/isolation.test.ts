import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { NotInOrgError, scoped } from '../src/index';
import { seedTwoOrgs, type Seeded } from '../src/testing';

let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

describe('seed', () => {
  it('gives each org one of everything, visible to itself', async () => {
    for (const o of [s.a, s.b]) {
      const r = o.scope;
      expect(await r.screens.get(o.screen)).toMatchObject({ orgId: o.orgId, status: 'active' });
      expect(await r.screenGroups.members(o.group)).toEqual([o.screen]);
      expect(await r.screens.groupsOf(o.screen)).toEqual([o.group]);
      expect(await r.screens.credentials.forScreen(o.screen)).toHaveLength(1);
      expect(await r.assets.renditions.forAsset(o.asset)).toHaveLength(1);
      expect(await r.templates.versions.get(o.templateVersion)).toBeDefined();
      expect(await r.playlists.items(o.playlist)).toEqual([o.templateSpot, o.imageSpot]);
      expect(await r.scheduleEntries.get(o.scheduleEntry)).toMatchObject({ target: 'group', groupId: o.group });
      expect(await r.publishes.screens(o.publish)).toEqual([{ screenId: o.screen, manifestId: 'd'.repeat(64) }]);
      expect(await r.dataSources.snapshot(o.dataSource)).toMatchObject({ version: 'v1' });
      expect(await r.auditLog.list()).toEqual([expect.objectContaining({ id: o.auditEntry })]);
      expect(await r.playCounts.list({ from: o.hour, to: o.hour + 3_600_000 })).toEqual([
        expect.objectContaining({ screenId: o.screen, spotId: o.templateSpot, plays: 3, ms: 30_000 }),
      ]);
    }
  });
});

describe("a call made for org B with org A's ids", () => {
  it('reads nothing', async () => {
    const { a } = s;
    const b = s.b.scope;
    const reads: [string, () => Promise<unknown>][] = [
      ['screens.get', () => b.screens.get(a.screen)],
      ['screens.getMany', () => b.screens.getMany([a.screen])],
      ['screens.groupsOf', () => b.screens.groupsOf(a.screen)],
      ['screens.credentials.get', () => b.screens.credentials.get(a.credential)],
      ['screens.credentials.forScreen', () => b.screens.credentials.forScreen(a.screen)],
      ['screenGroups.get', () => b.screenGroups.get(a.group)],
      ['screenGroups.members', () => b.screenGroups.members(a.group)],
      ['assets.get', () => b.assets.get(a.asset)],
      ['assets.renditions.get', () => b.assets.renditions.get(a.rendition)],
      ['assets.renditions.forAsset', () => b.assets.renditions.forAsset(a.asset)],
      ['templates.get', () => b.templates.get(a.template)],
      ['templates.versions.get', () => b.templates.versions.get(a.templateVersion)],
      ['templates.versions.getMany', () => b.templates.versions.getMany([a.templateVersion])],
      ['templates.versions.forTemplate', () => b.templates.versions.forTemplate(a.template)],
      ['spots.get', () => b.spots.get(a.templateSpot)],
      ['spots.getMany', () => b.spots.getMany([a.templateSpot, a.imageSpot])],
      ['playlists.get', () => b.playlists.get(a.playlist)],
      ['playlists.items', () => b.playlists.items(a.playlist)],
      ['scheduleEntries.get', () => b.scheduleEntries.get(a.scheduleEntry)],
      ['publishes.get', () => b.publishes.get(a.publish)],
      ['publishes.screens', () => b.publishes.screens(a.publish)],
      ['dataSources.get', () => b.dataSources.get(a.dataSource)],
      ['dataSources.snapshot', () => b.dataSources.snapshot(a.dataSource)],
      ['dataSources.snapshots', () => b.dataSources.snapshots([a.dataSource])],
      ['playCounts.list', () => b.playCounts.list({ from: a.hour, to: a.hour + 3_600_000, screenId: a.screen })],
    ];
    for (const [name, read] of reads) {
      const got = await read();
      expect(got === undefined || (Array.isArray(got) && got.length === 0), `${name} returned ${JSON.stringify(got)}`).toBe(true);
    }
  });

  it('lists nothing of org A', async () => {
    const b = s.b.scope;
    const lists = {
      screens: await b.screens.list(),
      credentials: await b.screens.credentials.list(),
      screenGroups: await b.screenGroups.list(),
      assets: await b.assets.list(),
      renditions: await b.assets.renditions.list(),
      templates: await b.templates.list(),
      templateVersions: await b.templates.versions.list(),
      spots: await b.spots.list(),
      playlists: await b.playlists.list(),
      scheduleEntries: await b.scheduleEntries.list(),
      publishes: await b.publishes.list(),
      dataSources: await b.dataSources.list(),
      auditLog: await b.auditLog.list(),
      playCounts: await b.playCounts.list({ from: 0, to: Number.MAX_SAFE_INTEGER }),
    };
    for (const [name, rows] of Object.entries(lists)) {
      expect(rows.length, name).toBeGreaterThan(0);
      for (const row of rows) expect(row.orgId === 'org-b' || row.orgId === null, `${name} leaked ${JSON.stringify(row)}`).toBe(true);
    }
  });

  it('changes nothing', async () => {
    const { a } = s;
    const b = s.b.scope;
    expect(await b.screens.update(a.screen, { name: 'hijacked' })).toBeUndefined();
    expect(await b.screens.credentials.update(a.credential, { revokedAt: 1 })).toBeUndefined();
    expect(await b.screens.setDesiredManifest(a.screen, 'f'.repeat(64))).toBe(false);
    expect(await b.spots.update(a.imageSpot, { name: 'hijacked' })).toBeUndefined();
    expect(await b.templates.update(a.template, { name: 'hijacked' })).toBeUndefined();
    expect(await b.screenGroups.removeMember(a.group, a.screen)).toBe(false);
    for (const del of [
      () => b.screens.delete(a.screen),
      () => b.screens.credentials.delete(a.credential),
      () => b.screenGroups.delete(a.group),
      () => b.assets.delete(a.asset),
      () => b.assets.renditions.delete(a.rendition),
      () => b.templates.delete(a.template),
      () => b.templates.versions.delete(a.templateVersion),
      () => b.spots.delete(a.imageSpot),
      () => b.playlists.delete(a.playlist),
      () => b.scheduleEntries.delete(a.scheduleEntry),
      () => b.publishes.delete(a.publish),
      () => b.dataSources.delete(a.dataSource),
    ]) expect(await del()).toBe(false);

    const ra = s.a.scope;
    expect(await ra.screens.get(a.screen)).toMatchObject({ name: 'org-a lobby', desiredManifestId: null });
    expect((await ra.screens.credentials.get(a.credential))?.revokedAt).toBeNull();
    expect(await ra.spots.get(a.imageSpot)).toMatchObject({ name: 'Logo' });
    expect(await ra.screenGroups.members(a.group)).toEqual([a.screen]);
    expect(await ra.playlists.items(a.playlist)).toHaveLength(2);
  });

  it('refuses to link to them', async () => {
    const { a } = s;
    const b = s.b.scope;
    const refused: [string, () => Promise<unknown>][] = [
      ['addMember: A group', () => b.screenGroups.addMember(a.group, s.b.screen)],
      ['addMember: A screen', () => b.screenGroups.addMember(s.b.group, a.screen)],
      ['setItems: A playlist', () => b.playlists.setItems(a.playlist, [s.b.imageSpot])],
      ['setItems: A spot', () => b.playlists.setItems(s.b.playlist, [a.imageSpot])],
      ['addScreens: A publish', () => b.publishes.addScreens(a.publish, [{ screenId: s.b.screen, manifestId: 'x' }])],
      ['addScreens: A screen', () => b.publishes.addScreens(s.b.publish, [{ screenId: a.screen, manifestId: 'x' }])],
      ['putSnapshot', () => b.dataSources.putSnapshot(a.dataSource, { version: 'x', fetchedAt: 0, dataJson: '{}' })],
      ['playCounts.add', () => b.playCounts.add(a.screen, [{ hour: a.hour, spotId: a.templateSpot, plays: 1, ms: 1 }])],
      ['spot on A template version', () => b.spots.insert({ name: 'x', kind: 'template', durationMs: 1000, templateVersionId: a.templateVersion })],
      ['spot moved to A template version', () => b.spots.update(s.b.templateSpot, { templateVersionId: a.templateVersion })],
    ];
    for (const [name, call] of refused) await expect(call(), name).rejects.toBeInstanceOf(NotInOrgError);
    expect(await b.playlists.items(s.b.playlist)).toEqual([s.b.templateSpot, s.b.imageSpot]);
  });
});

describe('rows a scope writes', () => {
  it('belong to its org whatever the caller passes', async () => {
    const b = s.b.scope;
    const row = await b.screenGroups.insert({ name: 'smuggled', orgId: 'org-a' } as never);
    expect(row.orgId).toBe('org-b');
    expect(row.id).toMatch(/^grp_[a-z2-7]{24}$/);
    const moved = await b.screenGroups.update(row.id, { orgId: 'org-a', id: 'stolen' } as never);
    expect(moved).toMatchObject({ orgId: 'org-b', id: row.id });
    expect(await s.a.scope.screenGroups.get(row.id)).toBeUndefined();
  });

  it('need ids matching ID_PATTERN', async () => {
    expect(() => scoped(env.DB, 'org/a')).toThrow(TypeError);
    await expect(s.b.scope.screenGroups.insert({ id: 'a.b', name: 'x' })).rejects.toThrow(TypeError);
  });
});

describe('base templates', () => {
  it('are visible to every org and writable by none', async () => {
    for (const o of [s.a.scope, s.b.scope]) {
      expect(await o.templates.get(s.base.template)).toMatchObject({ orgId: null });
      expect(await o.templates.versions.forTemplate(s.base.template)).toHaveLength(1);
      expect(await o.templates.update(s.base.template, { name: 'hijacked' })).toBeUndefined();
      expect(await o.templates.versions.delete(s.base.templateVersion)).toBe(false);
    }
    expect(await s.b.scope.spots.get(s.b.templateSpot)).toMatchObject({ templateVersionId: s.base.templateVersion });
  });
});

describe('composite foreign keys', () => {
  // Proves local D1 enforces them; M3-00 verifies production. Isolation does not rely on it.
  it('stop a row pointing into another org, even written around the repository', async () => {
    const insert = env.DB.prepare('INSERT INTO playlist_items (org_id, playlist_id, position, spot_id) VALUES (?, ?, ?, ?)');
    await expect(insert.bind('org-b', s.b.playlist, 99, s.a.imageSpot).run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(insert.bind('org-b', s.a.playlist, 99, s.b.imageSpot).run()).rejects.toThrow(/FOREIGN KEY/);
  });
});
