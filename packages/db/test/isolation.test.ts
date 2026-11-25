import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DeleteInFlightError,
  FEED_IMAGE_DELETE_GRACE_MS,
  FEED_IMAGE_TTL_MS,
  findMembership,
  NEW_PER_ORG_PER_DAY,
  NEW_PER_SOURCE_PER_DAY,
  NotInOrgError,
  organizationExists,
  platform,
  scoped,
} from '../src/index';
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
      expect(await r.screens.labels.list()).toEqual([{ screenId: o.screen, key: 'region', value: o.orgId }]);
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
      ['screens.labels.list', () => b.screens.labels.list(a.screen)],
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
      ['publishes.rollout', () => b.publishes.rollout(a.publish)],
      ['dataSources.get', () => b.dataSources.get(a.dataSource)],
      ['dataSources.snapshot', () => b.dataSources.snapshot(a.dataSource)],
      ['dataSources.usingConnection', () => b.dataSources.usingConnection(a.connection)],
      ['connections.get', () => b.connections.get(a.connection)],
      ['dataSources.snapshots', () => b.dataSources.snapshots([a.dataSource])],
      ['dataSources.checkedTimes', () => b.dataSources.checkedTimes([a.dataSource])],
      ['playCounts.list', () => b.playCounts.list({ from: a.hour, to: a.hour + 3_600_000, screenId: a.screen })],
      ['brandKits.get', () => b.brandKits.get(a.brandKit)],
    ];
    for (const [name, read] of reads) {
      const got = await read();
      expect(got === undefined || (Array.isArray(got) && got.length === 0), `${name} returned ${JSON.stringify(got)}`).toBe(true);
    }
  });

  it("reads only org B's publishes for a screen's manifest as of a revision", async () => {
    expect((await s.b.scope.publishes.asOf(Number.MAX_SAFE_INTEGER)).map((r) => r.screenId)).toEqual([s.b.screen]);
  });

  it("pages only org B's screens for the fleet poll", async () => {
    // Its rows carry no org, so compare ids.
    const ids = (await s.b.scope.screens.statusPage({ limit: 200 })).map((r) => r.id);
    expect(ids).toEqual([s.b.screen]);
  });

  it("lists only the locales of org B's screens", async () => {
    // Its rows carry no org: org A has a screen in a locale org B's screens do not use.
    await s.a.scope.screens.insert({ name: 'Montreal', timezone: 'America/Toronto', orientation: 'landscape', locale: 'fr-CA' });
    expect(await s.a.scope.screens.locales()).toContain('fr-CA');
    expect(await s.b.scope.screens.locales()).toEqual([null]);
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
      publishHistory: await b.publishes.history({ limit: 200 }),
      dataSources: await b.dataSources.list(),
      connections: await b.connections.list(),
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
    const ra = s.a.scope;
    // Org B handed rows as org A read them: its staged changes and deletes still write only org B's rows.
    await b.commit([
      ...b.screens.stage.update((await ra.screens.get(a.screen))!, { name: 'hijacked' }).writes,
      ...b.screens.credentials.stage.update((await ra.screens.credentials.get(a.credential))!, { revokedAt: 1 }).writes,
      ...(await b.spots.stage.update((await ra.spots.get(a.imageSpot))!, { name: 'hijacked' })).writes,
      ...b.connections.stage.update((await ra.connections.get(a.connection))!, { status: 'disconnected', credentialsSealed: null }).writes,
      ...b.templates.stage.update((await ra.templates.get(a.template))!, { name: 'hijacked' }).writes,
      ...b.screens.stage.delete(a.screen).writes,
      ...b.screens.credentials.stage.delete(a.credential).writes,
      ...b.screenGroups.stage.delete(a.group).writes,
      ...b.assets.stage.delete(a.asset).writes,
      ...b.assets.renditions.stage.delete(a.rendition).writes,
      ...b.templates.stage.delete(a.template).writes,
      ...b.templates.versions.stage.delete(a.templateVersion).writes,
      ...b.spots.stage.delete(a.imageSpot).writes,
      ...b.playlists.stage.delete(a.playlist).writes,
      ...b.scheduleEntries.stage.delete(a.scheduleEntry).writes,
      ...b.publishes.stage.delete(a.publish).writes,
      ...b.dataSources.stage.delete(a.dataSource).writes,
      ...b.connections.stage.delete(a.connection).writes,
      ...b.brandKits.stage.delete(a.brandKit).writes,
    ]);
    expect(await b.screens.setDesiredManifest(a.screen, 'f'.repeat(64))).toBe(false);
    await b.screens.reportManifest(a.screen, 'f'.repeat(64), { arrivedAt: 1 });
    expect(
      await b.screens.sync(a.screen, {
        at: 1,
        playerVersion: 'x',
        fallbackFrom: null,
        heartbeatJson: '{}',
        epoch: 'e',
        seq: 1,
        counts: [{ hour: a.hour, spotId: a.templateSpot, plays: 100, ms: 1 }],
      }),
    ).toBeUndefined();
    expect(await b.screenGroups.removeMember(a.group, a.screen)).toBe(false);

    for (const [name, read] of [
      ['screenGroups', () => ra.screenGroups.get(a.group)],
      ['assets', () => ra.assets.get(a.asset)],
      ['renditions', () => ra.assets.renditions.get(a.rendition)],
      ['templates', () => ra.templates.get(a.template)],
      ['templateVersions', () => ra.templates.versions.get(a.templateVersion)],
      ['playlists', () => ra.playlists.get(a.playlist)],
      ['scheduleEntries', () => ra.scheduleEntries.get(a.scheduleEntry)],
      ['publishes', () => ra.publishes.get(a.publish)],
      ['dataSources', () => ra.dataSources.get(a.dataSource)],
      ['brandKits', () => ra.brandKits.get(a.brandKit)],
    ] as const)
      expect(await read(), name).toBeDefined();
    expect(await ra.templates.get(a.template)).toMatchObject({ name: 'Menu' });
    expect(await ra.connections.get(a.connection)).toMatchObject({ status: 'active', credentialsSealed: 'sealed:grant' });
    expect(await ra.screens.get(a.screen)).toMatchObject({
      name: 'org-a lobby',
      desiredManifestId: null,
      reportedManifestId: null,
      lastSeenAt: null,
    });
    expect((await ra.playCounts.list({ from: a.hour, to: a.hour + 3_600_000 })).map((c) => c.plays)).toEqual([3]);
    expect((await ra.screens.credentials.get(a.credential))?.revokedAt).toBeNull();
    expect(await ra.spots.get(a.imageSpot)).toMatchObject({ name: 'Logo' });
    expect(await ra.screenGroups.members(a.group)).toEqual([a.screen]);
    expect(await ra.playlists.items(a.playlist)).toHaveLength(2);
  });

  it("lists only org B's labels, and changes none of org A's", async () => {
    const { a } = s;
    const b = s.b.scope;
    expect((await b.screens.labels.list()).map((l) => l.screenId)).toEqual([s.b.screen]);
    await expect(b.screens.labels.stage.update([a.screen], { set: { region: 'hijacked' }, remove: [] })).rejects.toThrow(NotInOrgError);
    // Past the read's check too: the statements themselves reach only org B's screens and labels.
    await b.commit((await b.screens.labels.stage.update([a.screen], { set: { region: 'hijacked' }, remove: ['region'] }, { newScreen: true })).writes);
    expect(await s.a.scope.screens.labels.list(a.screen)).toEqual([{ screenId: a.screen, key: 'region', value: 'org-a' }]);
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
      ['spot on A template version', () => b.spots.stage.insert({ name: 'x', kind: 'template', durationMs: 1000, templateVersionId: a.templateVersion })],
      ['spot moved to A template version', async () => b.spots.stage.update((await b.spots.get(s.b.templateSpot))!, { templateVersionId: a.templateVersion })],
      [
        'spot image field on A asset',
        async () => b.spots.stage.update((await b.spots.get(s.b.templateSpot))!, { assetMapJson: JSON.stringify({ photo: a.asset }) }),
      ],
      ['spot staged with A asset', async () => b.spots.stage.update((await b.spots.get(s.b.imageSpot))!, { assetId: a.asset })],
      [
        'spot bound to A data source',
        async () =>
          b.spots.stage.update((await b.spots.get(s.b.templateSpot))!, { bindingsJson: JSON.stringify({ title: { source: a.dataSource, path: 't' } }) }),
      ],
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

  // Each repository that upserts or updates from a caller's values, handed a row whose org, key or
  // id point elsewhere (as a row read back from `get` does): nothing moves out of org B.
  it('stay in its org when an upsert or update is handed another org, key or id', async () => {
    const { a } = s;
    const b = s.b.scope;
    const ra = s.a.scope;

    const channel = { host: 'hooks.slack.test', urlEncrypted: 'sealed:url', secretEncrypted: null, secretSetAt: null, connectedBy: 'u' };
    await b.commit((await b.alertChannels.stage.put('slack', channel)).writes);
    // A full row, retargeted: the conflict update must not move org B's channel to org A's webhook.
    const retargeted = { ...(await b.alertChannels.get('slack'))!, orgId: a.orgId, kind: 'webhook' as const, host: 'moved.test' };
    const put = await b.alertChannels.stage.put('slack', retargeted);
    expect(put.row).toMatchObject({ orgId: 'org-b', kind: 'slack', host: 'moved.test' });
    await b.commit(put.writes);
    expect(await b.alertChannels.get('slack')).toMatchObject({ orgId: 'org-b', kind: 'slack', host: 'moved.test', rowVersion: 2 });
    expect(await ra.alertChannels.get('webhook')).toBeUndefined();

    const key = { provider: 'anthropic' as const, keySealed: 'sealed:key', keyLast4: 'abcd', keySavedBy: 'u', keySavedAt: 1 };
    await b.commit((await b.aiProvider.stage.put(key)).writes);
    await b.commit((await b.aiProvider.stage.put({ ...key, fastModel: 'moved', orgId: a.orgId } as never)).writes);
    expect(await b.aiProvider.get()).toMatchObject({ orgId: 'org-b', fastModel: 'moved', rowVersion: 2 });
    expect(await ra.aiProvider.get()).toBeUndefined();
    // Removing one org's provider leaves another's.
    await ra.commit((await ra.aiProvider.stage.put(key)).writes);
    await b.commit(b.aiProvider.stage.remove().writes);
    expect(await b.aiProvider.get()).toBeUndefined();
    expect(await ra.aiProvider.get()).toMatchObject({ orgId: a.orgId });

    await b.commit((await b.settings.stage.set({ locale: 'en-GB', orgId: a.orgId, publishRevision: 99 } as never)).writes);
    expect(await b.settings.get()).toMatchObject({ orgId: 'org-b', locale: 'en-GB', publishRevision: 0 });
    expect(await ra.settings.get()).toBeUndefined();

    const elsewhere = { orgId: a.orgId, dataSourceId: a.dataSource };
    await b.dataSources.putSnapshot(s.b.dataSource, { version: 'put', fetchedAt: 2, checkedAt: 2, dataJson: '{}', ...elsewhere } as never);
    await b.dataSources.savePoll(s.b.dataSource, {
      source: { nextPollAt: 0, ...elsewhere, id: a.dataSource } as never,
      snapshot: { version: 'poll', fetchedAt: 3, checkedAt: 3, dataJson: '{}', ...elsewhere } as never,
    });
    expect(await ra.dataSources.snapshot(a.dataSource)).toMatchObject({ version: 'v1' });
    expect(await b.dataSources.snapshot(s.b.dataSource)).toMatchObject({ orgId: 'org-b', version: 'poll' });
    expect(await b.dataSources.get(s.b.dataSource)).toMatchObject({ orgId: 'org-b' });

    await b.playCounts.add(s.b.screen, [{ hour: a.hour, spotId: a.templateSpot, plays: 1, ms: 1, orgId: a.orgId, screenId: a.screen } as never]);
    expect((await ra.playCounts.list({ from: a.hour, to: a.hour + 3_600_000 })).map((c) => c.plays)).toEqual([3]);

    await b.connections.saveGrant(s.b.connection, 'sealed:grant', { credentialsSealed: 'sealed:new', expiresAt: null, orgId: a.orgId, id: 'stolen' } as never);
    expect(await b.connections.get(s.b.connection)).toMatchObject({ orgId: 'org-b', credentialsSealed: 'sealed:new' });
    expect(await ra.connections.get(s.b.connection)).toBeUndefined();
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
      await b.publishes.insert({ id: s.a.publish, status: 'published', actorKind: 'user', actorId: 'u', revision: 9 } as never),
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
      const base = (await o.templates.get(s.base.template))!;
      await o.commit([...o.templates.stage.update(base, { name: 'hijacked' }).writes, ...o.templates.versions.stage.delete(s.base.templateVersion).writes]);
      expect(await o.templates.get(s.base.template)).toEqual(base);
      expect(await o.templates.versions.get(s.base.templateVersion)).toBeDefined();
      // A test's direct writes (testScope) refuse them too.
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

describe('kept drafts (#116, draft_snapshots)', () => {
  it("are read, cleared and written by org B's scope for org B alone, whatever ids or fields it is handed", async () => {
    const [a, b] = [s.a.scope, s.b.scope];
    const spotA = (await a.spots.get(s.a.templateSpot))!;
    await a.commit(a.draftSnapshots.stage.keep('spot', spotA, 'person', { contentJson: '{"name":"A"}', sampleFieldsJson: null }).writes);
    // Read and cleared with org A's id: nothing of org A's.
    expect(await b.draftSnapshots.get('spot', s.a.templateSpot)).toBeUndefined();
    expect(await b.draftSnapshots.kept()).toEqual([]);
    await b.commit(b.draftSnapshots.stage.clear('spot', s.a.templateSpot).writes);
    expect(await a.draftSnapshots.get('spot', s.a.templateSpot)).toMatchObject({ orgId: s.a.orgId, holds: 'person' });
    // Kept or proposed for org A's spot: refused, as org B has no such draft at that version, and org A's is untouched.
    await expect(b.commit(b.draftSnapshots.stage.keep('spot', spotA, 'agent', { contentJson: '{}', sampleFieldsJson: null }).writes)).rejects.toThrow();
    await expect(b.commit(b.draftSnapshots.stage.propose('spot', spotA, { contentJson: '{}', sampleFieldsJson: null }).writes)).rejects.toThrow();
    expect(await a.draftSnapshots.get('spot', s.a.templateSpot)).toMatchObject({ contentJson: '{"name":"A"}' });
    // Handed another org's id and keys among its content, org B's own draft is still the one written: its org and keys come last.
    const spotB = (await b.spots.get(s.b.templateSpot))!;
    const sneaky = {
      contentJson: '{"name":"B"}',
      sampleFieldsJson: null,
      orgId: s.a.orgId,
      spotId: s.a.templateSpot,
      playlistId: s.a.playlist,
      holds: 'agent',
    };
    await b.commit(b.draftSnapshots.stage.propose('spot', spotB, sneaky).writes);
    expect(await b.draftSnapshots.get('spot', s.b.templateSpot)).toMatchObject({
      orgId: s.b.orgId,
      spotId: s.b.templateSpot,
      playlistId: null,
      holds: 'person',
    });
    expect(await a.draftSnapshots.get('spot', s.a.templateSpot)).toMatchObject({ contentJson: '{"name":"A"}' });
    await b.commit(b.draftSnapshots.stage.keep('spot', spotB, 'person', sneaky).writes);
    expect(await b.draftSnapshots.get('spot', s.b.templateSpot)).toMatchObject({ orgId: s.b.orgId, holds: 'person', contentJson: '{"name":"B"}' });
    await a.commit(a.draftSnapshots.stage.clear('spot', s.a.templateSpot).writes);
    await b.commit(b.draftSnapshots.stage.clear('spot', s.b.templateSpot).writes);
  });

  it('cannot point into another org, even written around the repository', async () => {
    const insert = env.DB.prepare(
      "INSERT INTO draft_snapshots (org_id, spot_id, playlist_id, holds, content_json, created_at) VALUES (?, ?, ?, 'person', '{}', 0)",
    );
    await expect(insert.bind(s.b.orgId, s.a.templateSpot, null).run()).rejects.toThrow(/FOREIGN KEY/);
    await expect(insert.bind(s.b.orgId, null, s.a.playlist).run()).rejects.toThrow(/FOREIGN KEY/);
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

describe('the audit log', () => {
  it('lists rows written in the same millisecond newest first', async () => {
    const at = Date.UTC(2100, 0, 1);
    const actions = Array.from({ length: 10 }, (_, i) => `same-ms-${i}`);
    const target = { kind: 'screen', id: s.a.screen };
    for (const action of actions) {
      await s.a.scope.auditLog.append({ actorKind: 'system', actorId: 'test', action, at, targetKind: target.kind, targetId: target.id });
      await platform(env.DB).auditLog.append({ actorKind: 'system', actorId: 'test', action, at });
    }
    const newestFirst = actions.toReversed();
    expect((await s.a.scope.auditLog.list({ target })).map((a) => a.action)).toEqual(newestFirst);
    expect((await platform(env.DB).auditLog.list({ limit: 10 })).map((a) => a.action)).toEqual(newestFirst);
  });
});

describe('feed photos', () => {
  const sha = (c: string) => c.repeat(64);
  const copy = (c: string) => ({ file: sha(c), thumb: sha(c) });
  const validators = { etag: null, lastModified: null };
  const hold = async (org: Seeded['a'], sourceId: string, urls: { again: readonly string[]; fresh: readonly string[] }, now: number) => {
    const row = (await org.scope.dataSources.get(sourceId))!;
    const { held } = await org.scope.dataSources.savePoll(sourceId, {
      source: { nextPollAt: now + 300_000, failures: 0, lastError: null },
      photos: { read: { rowVersion: row.rowVersion, generation: row.photoGeneration, now, readWhole: false, lastSeen: [] }, hold: urls },
    });
    return held;
  };
  const ensureSource = async (org: Seeded['a'], id: string) => {
    if (!(await org.scope.dataSources.get(id))) {
      await org.scope.dataSources.insert({ id, name: id, format: 'rss', urlEncrypted: 'enc', refreshS: 300 });
    }
  };

  it("keep each org's copy of a URL both name apart", async () => {
    const url = 'https://news.example/photo.jpg';
    const a = s.a.scope.feedPhotos;
    const b = s.b.scope.feedPhotos;
    await ensureSource(s.b, 'news');
    await a.put({ url, sourceId: 'news', fileSha256: sha('a'), thumbSha256: sha('b'), etag: '"a"', nextCheckAt: 20 });
    expect(await b.get([url])).toEqual([]);
    // Org B's own fetch of it, and its failures, touch only its own row.
    expect(await hold(s.b, 'news', { again: [], fresh: [url] }, 1)).toEqual([url]);
    const [held] = await b.get([url]);
    await b.delivered(url, { result: 'failed', now: 2, checked: held!, error: 'timeout', passing: true });
    expect(await a.get([url])).toEqual([expect.objectContaining({ orgId: 'org-a', fileSha256: sha('a'), etag: '"a"', nextCheckAt: 20, lastError: null })]);
    expect(await b.get([url])).toEqual([expect.objectContaining({ orgId: 'org-b', fileSha256: null, lastError: 'timeout', failures: 1 })]);
  });

  it('holds a URL it already has without losing its copy', async () => {
    const url = 'https://news.example/kept.jpg';
    const a = s.a.scope.feedPhotos;
    await ensureSource(s.a, 'other');
    await a.put({ url, sourceId: 'news', fileSha256: sha('a'), thumbSha256: sha('b'), nextCheckAt: 20 });
    expect(await hold(s.a, 'other', { again: [url], fresh: ['https://news.example/new.jpg'] }, 20)).toEqual([url, 'https://news.example/new.jpg']);
    expect((await a.get([url, 'https://news.example/new.jpg'])).map((r) => [r.url, r.fileSha256])).toEqual(
      expect.arrayContaining([
        [url, sha('a')],
        ['https://news.example/new.jpg', null],
      ]),
    );
  });

  it('holds a fresh URL only once, including when two polls both planned it as fresh', async () => {
    const photos = s.a.scope.feedPhotos;
    const url = 'https://news.example/hold-once.jpg';
    await ensureSource(s.a, 'news');
    await ensureSource(s.a, 'other');
    expect(await hold(s.a, 'news', { again: [], fresh: [url] }, 20)).toEqual([url]);
    expect(await hold(s.a, 'other', { again: [], fresh: [url] }, 21)).toEqual([]);
    expect(await photos.get([url])).toEqual([expect.objectContaining({ sourceId: 'news', createdAt: 20 })]);
  });

  it("counts the day's new photos against the source and the org that named them, in its own org only", async () => {
    const t = 1_000_000_000;
    const urls = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `https://budget.example/${tag}-${i}.jpg`);
    for (const id of ['one', 'two', 'three']) await ensureSource(s.a, id);
    await ensureSource(s.b, 'one');
    expect(await hold(s.a, 'one', { again: [], fresh: urls('one', NEW_PER_SOURCE_PER_DAY + 2) }, t)).toEqual(urls('one', NEW_PER_SOURCE_PER_DAY));
    expect(await hold(s.a, 'two', { again: [], fresh: urls('two', NEW_PER_SOURCE_PER_DAY) }, t)).toHaveLength(NEW_PER_ORG_PER_DAY - NEW_PER_SOURCE_PER_DAY);
    expect(await hold(s.a, 'three', { again: [], fresh: urls('three', 1) }, t)).toEqual([]);
    // Org B's day is its own.
    expect(await hold(s.b, 'one', { again: [], fresh: urls('one', 1) }, t)).toEqual(urls('one', 1));
  });

  it('finds the copies of the same bytes within the same org only', async () => {
    const a = s.a.scope.feedPhotos;
    const b = s.b.scope.feedPhotos;
    await a.put({
      url: 'https://dedupe.example/one.jpg',
      sourceId: 'news',
      sourceSha256: sha('a'),
      fileSha256: sha('f'),
      thumbSha256: sha('t'),
      nextCheckAt: 20,
    });
    // A row with sourceSha256 but no stored copies is ignored.
    await a.put({ url: 'https://dedupe.example/pending.jpg', sourceId: 'news', sourceSha256: sha('p'), nextCheckAt: 20 });
    expect(await a.copyOf(sha('a'))).toEqual({ file: sha('f'), thumb: sha('t') });
    expect(await a.copyOf(sha('p'))).toBeUndefined();
    expect(await b.copyOf(sha('a'))).toBeUndefined();
  });

  it('expires rows, queues their hashes, guards deliveries with leases, and stays isolated per org', async () => {
    const a = s.a.scope.feedPhotos;
    const b = s.b.scope.feedPhotos;
    const urls = ['https://gc.example/alone.jpg', 'https://gc.example/shared.jpg', 'https://gc.example/twin.jpg', 'https://gc.example/shown.jpg'];
    await a.put({ url: urls[0]!, sourceId: 'news', fileSha256: sha('1'), thumbSha256: sha('2'), nextCheckAt: 1 });
    // Its file is a distinct hash not held by other rows, and its thumbnail is shared with twin.
    await a.put({ url: urls[1]!, sourceId: 'news', fileSha256: sha('d'), thumbSha256: sha('5'), nextCheckAt: 1 });
    await a.put({ url: urls[2]!, sourceId: 'news', fileSha256: sha('6'), thumbSha256: sha('5'), nextCheckAt: 1 });
    // The source's latest snapshot still names this one.
    await a.put({ url: urls[3]!, sourceId: 'news', fileSha256: sha('7'), thumbSha256: sha('8'), nextCheckAt: 1 });
    await s.a.scope.dataSources.putSnapshot(s.a.dataSource, {
      version: 'gc',
      fetchedAt: 1,
      checkedAt: 1,
      dataJson: JSON.stringify({ items: [{ image: { file: sha('7') } }] }),
    });
    // Org B holds the same hash: not org A's to keep or delete.
    await b.put({ url: urls[0]!, sourceId: 'news', fileSha256: sha('1'), nextCheckAt: 1 });

    // Expiring alone, shared, and shown removes alone + shared (shown stays), queueing their hashes.
    const expireAt = 100 + FEED_IMAGE_TTL_MS;
    expect(await a.expire(urls.slice(0, 2).concat(urls[3]!), expireAt)).toBe(2);
    expect((await a.get(urls)).map((r) => r.url).sort()).toEqual([urls[2], urls[3]].sort());
    expect(await b.get([urls[0]!])).toHaveLength(1);
    expect((await a.deletes()).map((d) => d.sha256)).toEqual([sha('1'), sha('2'), sha('5'), sha('d')].sort());
    expect(await b.deletes()).toEqual([]);

    // Deleting drops sha('5') from the queue (twin names it) and leases sha('1'), sha('2'), sha('d').
    const deleteAt = expireAt + FEED_IMAGE_DELETE_GRACE_MS;
    const removed: string[] = [];
    const leased = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const deleting = a.deleteBlobs([sha('1'), sha('2'), sha('5'), sha('d')], deleteAt, async (shas) => {
      removed.push(...shas);
      leased.resolve();
      await finish.promise;
    });
    await leased.promise;
    expect(removed.sort()).toEqual([sha('1'), sha('2'), sha('d')].sort());
    // While leased, a delivery naming one of them is refused, so it is tried again rather than racing the delete.
    const reuse = { result: 'reused', now: deleteAt + 300, sourceId: 'news', sourceSha256: sha('s'), copy: copy('1'), validators } as const;
    await expect(a.delivered('https://gc.example/again.jpg', reuse)).rejects.toThrow(DeleteInFlightError);
    // Org B's delivery is unaffected by org A's lease.
    await b.delivered('https://gc.example/again.jpg', reuse);
    finish.resolve();
    expect(await deleting).toBe(3);
    expect(await a.deletes()).toEqual([]);

    // Replacing the copies at a URL queues the old hashes, and naming a queued hash again takes it off the queue.
    await a.delivered(urls[2]!, { result: 'reused', now: 300, sourceId: 'news', sourceSha256: sha('s'), copy: copy('9'), validators });
    expect((await a.deletes()).map((d) => d.sha256)).toEqual([sha('5'), sha('6')]);
    await a.delivered(urls[3]!, {
      result: 'reused',
      now: 300,
      sourceId: 'news',
      sourceSha256: sha('s'),
      copy: { file: sha('6'), thumb: sha('8') },
      validators,
    });
    expect((await a.deletes()).map((d) => d.sha256)).toEqual([sha('5'), sha('7')]);
  });
});
