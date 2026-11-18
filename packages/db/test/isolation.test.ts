import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { findMembership, NotInOrgError, organizationExists, platform, scoped } from '../src/index';
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
      ['brandKits.get', () => b.brandKits.get(a.brandKit)],
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
      brandKits: await b.brandKits.list(),
      brandAssignments: await b.brandKits.assignments.list(),
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
    expect(
      await b.screens.sync(a.screen, {
        at: 1,
        playerVersion: 'x',
        heartbeatJson: '{}',
        epoch: 'e',
        seq: 1,
        counts: [{ hour: a.hour, spotId: a.templateSpot, plays: 100, ms: 1 }],
      }),
    ).toBeUndefined();
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
      () => b.brandKits.delete(a.brandKit),
    ])
      expect(await del()).toBe(false);

    const ra = s.a.scope;
    expect(await ra.screens.get(a.screen)).toMatchObject({ name: 'org-a lobby', desiredManifestId: null, lastSeenAt: null, syncEpoch: null });
    expect((await ra.playCounts.list({ from: a.hour, to: a.hour + 3_600_000 })).map((c) => c.plays)).toEqual([3]);
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
      ['setMembers: A group', () => b.screenGroups.setMembers(a.group, [s.b.screen])],
      ['setMembers: A screen', () => b.screenGroups.setMembers(s.b.group, [s.b.screen, a.screen])],
      ['setItems: A playlist', () => b.playlists.setItems(a.playlist, [s.b.imageSpot])],
      ['setItems: A spot', () => b.playlists.setItems(s.b.playlist, [a.imageSpot])],
      ['addScreens: A publish', () => b.publishes.addScreens(a.publish, [{ screenId: s.b.screen, manifestId: 'x' }])],
      ['addScreens: A screen', () => b.publishes.addScreens(s.b.publish, [{ screenId: a.screen, manifestId: 'x' }])],
      ['putSnapshot', () => b.dataSources.putSnapshot(a.dataSource, { version: 'x', fetchedAt: 0, checkedAt: 0, dataJson: '{}' })],
      ['savePoll', () => b.dataSources.savePoll(a.dataSource, { source: { nextPollAt: 0, failures: 1 }, checkedAt: 0 })],
      ['playCounts.add', () => b.playCounts.add(a.screen, [{ hour: a.hour, spotId: a.templateSpot, plays: 1, ms: 1 }])],
      ['spot on A template version', () => b.spots.insert({ name: 'x', kind: 'template', durationMs: 1000, templateVersionId: a.templateVersion })],
      ['spot moved to A template version', () => b.spots.update(s.b.templateSpot, { templateVersionId: a.templateVersion })],
    ];
    for (const [name, call] of refused) await expect(call(), name).rejects.toBeInstanceOf(NotInOrgError);
    expect(await b.playlists.items(s.b.playlist)).toEqual([s.b.templateSpot, s.b.imageSpot]);
    expect(await b.screenGroups.members(s.b.group)).toEqual([s.b.screen]);
    expect(await s.a.scope.screenGroups.members(a.group)).toEqual([a.screen]);
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

  it('are staged the same way: stamped with its org, and changing nothing of another org', async () => {
    const { a } = s;
    const b = s.b.scope;
    const aScreen = (await s.a.scope.screens.get(a.screen))!;
    const aGroup = (await s.a.scope.screenGroups.get(a.group))!;
    const smuggled = b.screenGroups.stage.insert({ name: 'staged smuggled', orgId: 'org-a' } as never);
    expect(smuggled.row.orgId).toBe('org-b');
    await b.commit([
      ...smuggled.writes,
      ...b.screens.stage.update(aScreen, { name: 'hijacked' }).writes,
      ...b.screens.stage.setDesiredManifest(a.screen, 'f'.repeat(64)).writes,
      ...b.screenGroups.stage.delete(a.group).writes,
      ...b.assets.stage.delete(a.asset).writes,
      ...b.idempotency.stage({ key: 'k-iso', action: 'x', inputSha256: '0', outputJson: '{}' }).writes,
    ]);
    expect(await s.a.scope.screens.get(a.screen)).toEqual(aScreen);
    expect(await s.a.scope.screenGroups.get(a.group)).toEqual(aGroup);
    expect(await s.a.scope.assets.get(a.asset)).toBeDefined();
    expect(await b.screenGroups.get(smuggled.row.id)).toEqual(smuggled.row);
    expect(await s.a.scope.idempotency.get('k-iso')).toBeUndefined();
    expect(await b.idempotency.get('k-iso')).toMatchObject({ orgId: 'org-b', action: 'x' });
    const bGroup = (await b.screenGroups.get(s.b.group))!;
    for (const op of ['setMembers', 'addMembers', 'removeMembers'] as const) {
      await expect(b.screenGroups.stage[op](aGroup, [s.b.screen]), `stage.${op}: A group`).rejects.toBeInstanceOf(NotInOrgError);
    }
    await expect(b.screenGroups.stage.setMembers(bGroup, [a.screen]), 'stage.setMembers: A screen').rejects.toBeInstanceOf(NotInOrgError);
    await expect(b.screenGroups.stage.addMembers(bGroup, [a.screen]), 'stage.addMembers: A screen').rejects.toBeInstanceOf(NotInOrgError);
    await expect(b.spots.stage.insert({ name: 'x', kind: 'template', durationMs: 1000, templateVersionId: a.templateVersion })).rejects.toBeInstanceOf(
      NotInOrgError,
    );
  });

  it('commit atomically: one failing statement and none take effect', async () => {
    const b = s.b.scope;
    const before = await b.screenGroups.list();
    const ok = b.screenGroups.stage.insert({ name: 'never' });
    const dup = b.idempotency.stage({ key: 'k-iso', action: 'x', inputSha256: '0', outputJson: '{}' });
    await expect(b.commit([...ok.writes, ...dup.writes])).rejects.toThrow();
    expect(await b.screenGroups.list()).toEqual(before);
  });

  it('need ids matching ID_PATTERN', async () => {
    expect(() => scoped(env.DB, 'org/a')).toThrow(TypeError);
    await expect(s.b.scope.playlists.insert({ id: 'a.b', name: 'x', transitionJson: '{}' })).rejects.toThrow(TypeError);
  });
});

describe('ids', () => {
  // Content ids (spots, playlists, schedule entries, data sources) are named by content and
  // manifests, so a caller may choose them: they are keyed (org_id, id), and one org's choice
  // neither blocks nor reveals another's.
  it('let two orgs choose the same content id', async () => {
    const a = s.a.scope;
    const b = s.b.scope;
    const same = 'same-id';
    for (const o of [a, b]) {
      await o.spots.insert({ id: same, name: `${o.orgId} spot`, kind: 'url', durationMs: 1000, url: 'https://example.com/' });
      await o.playlists.insert({ id: same, name: `${o.orgId} list`, transitionJson: '{}' });
      await o.playlists.setItems(same, [same]);
      await o.scheduleEntries.insert({ id: same, playlistId: same, target: 'org', priority: 0 });
      await o.dataSources.insert({ id: same, name: `${o.orgId} feed`, format: 'json', urlEncrypted: 'enc:x', refreshS: 60 });
      await o.dataSources.putSnapshot(same, { version: o.orgId, fetchedAt: 1, checkedAt: 1, dataJson: '{}' });
    }
    for (const o of [a, b]) {
      expect(await o.spots.get(same)).toMatchObject({ name: `${o.orgId} spot` });
      expect(await o.playlists.items(same)).toEqual([same]);
      expect(await o.scheduleEntries.get(same)).toMatchObject({ orgId: o.orgId });
      expect(await o.dataSources.snapshot(same)).toMatchObject({ version: o.orgId });
    }
    // Deleting org A's leaves org B's.
    await a.playlists.setItems(same, []);
    expect(await a.spots.delete(same)).toBe(true);
    expect(await b.spots.get(same)).toBeDefined();
    expect(await b.playlists.items(same)).toEqual([same]);
  });

  // Everything else is made by a tool and named by the server: a caller's id is ignored, so no
  // id can collide across orgs. Screens must be unique globally: a credential and the screen's
  // Durable Object name the screen by id alone.
  it("are the server's for screens, groups, credentials, assets, renditions, publishes, audit rows and templates", async () => {
    const b = s.b.scope;
    const taken = s.a.screen;
    const rows = [
      await b.screens.insert({ id: taken, name: 'x', timezone: 'UTC', orientation: 'landscape' } as never),
      await b.screenGroups.insert({ id: s.a.group, name: 'x' } as never),
      await b.screens.credentials.insert({ id: s.a.credential, screenId: s.b.screen, secretHash: '1'.repeat(64) } as never),
      await b.assets.insert({ id: s.a.asset, kind: 'image', name: 'x', sha256: '2'.repeat(64), type: 'image/png', size: 1 } as never),
      await b.publishes.insert({ id: s.a.publish, status: 'published', actorKind: 'user', actorId: 'u' } as never),
      await b.templates.insert({ id: s.a.template, key: 'chosen', name: 'x' } as never),
      b.screens.stage.insert({ id: taken, name: 'y', timezone: 'UTC', orientation: 'landscape' } as never).row,
    ];
    for (const r of rows) expect(r.id).toMatch(/^[a-z]+_/);
    const asset = rows[3]!;
    const rendition = await b.assets.renditions.insert({
      id: 'chosen',
      assetId: asset.id,
      orientation: 'portrait',
      sha256: '2'.repeat(64),
      type: 'image/png',
      size: 1,
      width: 1,
      height: 1,
    } as never);
    expect(rendition.id).not.toBe('chosen');
    expect(await s.a.scope.screens.get(taken)).toMatchObject({ orgId: s.a.orgId });
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

  it("are written by platform(db), which never reaches an org's templates", async () => {
    const p = platform(env.DB);
    expect(await p.templates.get(s.a.template)).toBeUndefined();
    expect(await p.templates.ownByKey('menu')).toBeUndefined(); // org A's key
    expect(await p.templates.update(s.a.template, { name: 'hijacked' })).toBeUndefined();
    expect(await p.templates.versions.update(s.a.templateVersion, { status: 'retired' })).toBeUndefined();
    expect(await s.a.scope.templates.get(s.a.template)).toMatchObject({ name: 'Menu' });

    const t = await p.templates.insert({ key: 'banner', name: 'Banner', orgId: 'org-a' } as never);
    expect(t.orgId).toBeNull();
    const v = await p.templates.versions.insert({ templateId: t.id, version: '1.0.0', manifestJson: '{}', bundleSha256: 'f'.repeat(64) });
    expect(v).toMatchObject({ orgId: null, status: 'draft' });
    expect(await p.templates.versions.ownVersion(t.id, '1.0.0')).toMatchObject({ id: v.id });
    for (const o of [s.a.scope, s.b.scope]) {
      expect(await o.templates.get(t.id)).toMatchObject({ key: 'banner' });
      expect(await o.templates.ownByKey('banner')).toBeUndefined();
      expect(await o.templates.versions.ownVersion(t.id, '1.0.0')).toBeUndefined();
    }
    await p.auditLog.append({ actorKind: 'system', actorId: 'test', action: 'register_template_version' });
    expect(await p.auditLog.list()).toEqual([expect.objectContaining({ action: 'register_template_version' })]);
    expect(await s.a.scope.auditLog.list()).not.toContainEqual(expect.objectContaining({ actorId: 'test' }));
  });
});

describe('organizationExists', () => {
  it('is true for an org and false otherwise', async () => {
    expect(await organizationExists(env.DB, 'org-a')).toBe(true);
    expect(await organizationExists(env.DB, 'org-nobody')).toBe(false);
  });
});

describe('composite foreign keys', () => {
  // Proves local D1 enforces them; M3-00 verifies production. Isolation does not rely on it.
  it('stop a row pointing into another org, even written around the repository', async () => {
    const insert = env.DB.prepare('INSERT INTO playlist_items (org_id, playlist_id, position, spot_id) VALUES (?, ?, ?, ?)');
    await expect(insert.bind('org-b', s.b.playlist, 99, s.a.imageSpot).run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(insert.bind('org-b', s.a.playlist, 99, s.b.imageSpot).run()).rejects.toThrow(/FOREIGN KEY/);
  });

  it('stop a row for an org that does not exist', async () => {
    const insert = env.DB.prepare("INSERT INTO screen_groups (id, org_id, name, created_at, updated_at) VALUES ('g', 'org-nobody', 'x', 0, 0)");
    await expect(insert.run()).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('findMembership', () => {
  it("returns a member's role and nothing for anyone else", async () => {
    const at = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('usr-1', 'U', 'u@test', 1, ?, ?)").bind(at, at),
      env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('mem-1', 'org-a', 'usr-1', 'editor', ?)").bind(at),
    ]);
    expect(await findMembership(env.DB, 'org-a', 'usr-1')).toEqual({ role: 'editor' });
    expect(await findMembership(env.DB, 'org-b', 'usr-1')).toBeUndefined();
  });
});
