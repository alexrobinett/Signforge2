// Drafts and their published versions: editing changes the draft, only `stage.publish` the
// published version. See docs/backend-plan.md#publishing.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { draftChanged, findUnfinishedRollouts, NotInOrgError, published, type scoped, StaleVersionError } from '../src/index';
import { seedOrg, type SeededOrg, testScope } from '../src/testing';

let o: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'drafts-org');
});

describe('drafts', () => {
  it('starts unpublished, and publishing snapshots the draft as it was read', async () => {
    const org = testScope(env.DB, o.orgId);
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
    const org = testScope(env.DB, o.orgId);
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
    const org = testScope(env.DB, o.orgId);
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
    const org = testScope(env.DB, o.orgId);
    const row = (await org.scheduleEntries.get(o.scheduleEntry))!;
    await org.commit(org.scheduleEntries.stage.publish(row).writes);
    await org.scheduleEntries.update(o.scheduleEntry, { priority: 7 });
    expect(published((await org.scheduleEntries.get(o.scheduleEntry))!)).toMatchObject({ target: 'group', groupId: o.group, priority: 1 });
  });

  it('counts an asset a published spot still uses as in use, so it cannot be deleted from under a screen', async () => {
    const org = testScope(env.DB, o.orgId);
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
    const org = testScope(env.DB, o.orgId);
    expect(await org.settings.get()).toBeUndefined();
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: o.playlist })).writes);
    expect(await org.settings.get()).toMatchObject({ defaultPlaylistId: o.playlist });
    await org.commit((await org.settings.stage.set({ defaultPlaylistId: null })).writes);
    expect(await org.settings.get()).toMatchObject({ defaultPlaylistId: null });

    const elsewhere = await seedOrg(env.DB, 'drafts-other');
    await expect(org.settings.stage.set({ defaultPlaylistId: elsewhere.playlist })).rejects.toThrow(/playlist .* not found/);
  });

  it('lists every group membership at once', async () => {
    const org = testScope(env.DB, o.orgId);
    expect(await org.screenGroups.allMembers()).toEqual([{ groupId: o.group, screenId: o.screen }]);
  });
});

describe('promotion from an old read (R09)', () => {
  let r: SeededOrg;
  beforeAll(async () => {
    r = await seedOrg(env.DB, 'drafts-race');
  });

  it('refuses to publish a spot edited since it was read, and writes nothing', async () => {
    const org = testScope(env.DB, r.orgId);
    const read = (await org.spots.get(r.imageSpot))!;
    const edited = (await org.spots.update(r.imageSpot, { name: 'Edited meanwhile' }))!;

    const err = await org.commit(org.spots.stage.publish(read).writes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: r.imageSpot, version: edited.rowVersion });
    expect(await org.spots.get(r.imageSpot)).toEqual(edited);
  });

  it("refuses to publish a playlist whose items changed since it was read, and moves the playlist's version with them", async () => {
    const org = testScope(env.DB, r.orgId);
    const read = (await org.playlists.get(r.playlist))!;
    const items = await org.playlists.items(r.playlist);
    await org.playlists.setItems(r.playlist, [r.imageSpot]);
    const now = (await org.playlists.get(r.playlist))!;
    expect(now.rowVersion).toBe(read.rowVersion + 1);

    await expect(org.commit(org.playlists.stage.publish(read, items).writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect((await org.playlists.get(r.playlist))!.publishedJson).toBeNull();
  });

  it('refuses to publish a deleted spot into one made again with its id (review 4)', async () => {
    const org = testScope(env.DB, r.orgId);
    const values = { id: 'drafts-race-again', kind: 'image', durationMs: 5000, assetId: r.asset, fit: 'cover' } as const;
    const read = await org.spots.insert({ ...values, name: 'Deleted' });
    const promotion = org.spots.stage.publish(read);
    await org.spots.delete(read.id);
    const again = await org.spots.insert({ ...values, name: 'Made again' });
    expect(again.rowVersion).toBe(read.rowVersion + 1);

    await expect(org.commit(promotion.writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect(await org.spots.get(read.id)).toEqual(again);
  });

  it('reports a spot deleted since it was read as a conflict, not as missing, and writes nothing (re-check)', async () => {
    const org = testScope(env.DB, r.orgId);
    const read = await org.spots.insert({ id: 'drafts-race-gone', name: 'Gone', kind: 'image', durationMs: 5000, assetId: r.asset, fit: 'cover' });
    const revision = (await org.settings.get())?.publishRevision ?? 0;
    const writes = [...org.publishes.stage.advance(revision).writes, ...org.spots.stage.publish(read).writes];
    await org.spots.delete(read.id);

    const err = await org.commit(writes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: read.id, version: 0 });
    expect(await org.spots.get(read.id)).toBeUndefined();
    expect((await org.settings.get())?.publishRevision ?? 0).toBe(revision);
  });

  it("keeps the draft's edit time as stored, not as it was read", async () => {
    const org = testScope(env.DB, r.orgId);
    const read = (await org.spots.get(r.templateSpot))!;
    // Stands in for a write that leaves the version alone: the stored time is the one to keep.
    await env.DB.prepare('UPDATE spots SET updated_at = ? WHERE org_id = ? AND id = ?')
      .bind(read.updatedAt + 1000, r.orgId, r.templateSpot)
      .run();
    await org.commit(org.spots.stage.publish(read).writes);
    const stored = (await org.spots.get(r.templateSpot))!;
    expect(published(stored)).toBeDefined();
    expect(stored.updatedAt).toBe(read.updatedAt + 1000);
  });

  it('refuses to publish a schedule entry edited since it was read', async () => {
    const org = testScope(env.DB, r.orgId);
    const read = (await org.scheduleEntries.get(r.scheduleEntry))!;
    await org.scheduleEntries.update(r.scheduleEntry, { priority: 3 });
    await expect(org.commit(org.scheduleEntries.stage.publish(read).writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect((await org.scheduleEntries.get(r.scheduleEntry))!.publishedJson).toBeNull();
  });

  it('removes a schedule entry, draft and published version, only as it was read (M3-19)', async () => {
    const org = testScope(env.DB, r.orgId);
    const made = await org.scheduleEntries.insert({ id: 'drafts-race-remove', playlistId: r.playlist, target: 'org', priority: 0 });
    await org.commit(org.scheduleEntries.stage.publish(made).writes);
    const read = (await org.scheduleEntries.get(made.id))!;
    await org.scheduleEntries.update(made.id, { deletedAt: 1 });
    await expect(org.commit(org.scheduleEntries.stage.remove(read).writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect(await org.scheduleEntries.get(made.id)).toMatchObject({ deletedAt: 1 });

    await org.commit(org.scheduleEntries.stage.remove((await org.scheduleEntries.get(made.id))!).writes);
    expect(await org.scheduleEntries.get(made.id)).toBeUndefined();
  });
});

describe('publish order (R09)', () => {
  it('orders the publishes of an org with no settings row: the first makes it, at revision 1 (review 3)', async () => {
    const p = await seedOrg(env.DB, 'drafts-order-new');
    const org = testScope(env.DB, p.orgId);
    expect(await org.settings.get()).toBeUndefined();

    await org.commit(org.publishes.stage.advance(0).writes);
    await expect(org.commit(org.publishes.stage.advance(0).writes)).rejects.toMatchObject({ name: 'StaleVersionError', id: 'publish revision', version: 1 });
    // Every setting at its default, at version 1, as with no row.
    expect(await org.settings.get()).toMatchObject({ publishRevision: 1, rowVersion: 1, defaultPlaylistId: null, locale: null, alertsJson: null });
  });

  it('moves the publish revision on from the one read, and refuses a publish read before another committed', async () => {
    const p = await seedOrg(env.DB, 'drafts-order');
    const org = testScope(env.DB, p.orgId);
    await org.commit((await org.settings.stage.set({ locale: 'en-GB' })).writes);
    const before = (await org.settings.get())!;
    expect(before.publishRevision).toBe(0);

    await org.commit(org.publishes.stage.advance(0).writes);
    const err = await org.commit(org.publishes.stage.advance(0).writes).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleVersionError);
    expect(err).toMatchObject({ id: 'publish revision', version: 1 });
    // Not a setting: an open settings form still saves.
    expect(await org.settings.get()).toEqual({ ...before, publishRevision: 1 });
  });
});

describe('rollout history in the publish batch (review 5)', () => {
  it("stages a publish's row and its screens' rollout rows, which a failed guard rolls back with the switches", async () => {
    const p = await seedOrg(env.DB, 'drafts-rollout');
    const org = testScope(env.DB, p.orgId);
    const manifestId = 'a'.repeat(64);
    const stage = async (revision: number) => {
      const publish = org.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision: revision + 1 });
      const rollout = org.publishes.stage.addScreens(publish.row.id, [{ screenId: p.screen, manifestId }]);
      return {
        id: publish.row.id,
        writes: [
          ...org.publishes.stage.advance(revision).writes,
          ...publish.writes,
          ...rollout.writes,
          ...org.screens.stage.setDesiredManifest(p.screen, manifestId).writes,
        ],
      };
    };
    const before = (await org.screens.get(p.screen))!.desiredManifestId;

    const stale = await stage(1);
    await expect(org.commit(stale.writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect(await org.publishes.get(stale.id)).toBeUndefined();
    expect(await org.publishes.screens(stale.id)).toEqual([]);
    expect((await org.screens.get(p.screen))!.desiredManifestId).toBe(before);

    const fresh = await stage(0);
    await org.commit(fresh.writes);
    expect(await org.publishes.screens(fresh.id)).toEqual([{ screenId: p.screen, manifestId }]);
    expect((await org.screens.get(p.screen))!.desiredManifestId).toBe(manifestId);
  });

  it('refuses a rollout row for a screen the org does not have', async () => {
    const p = await seedOrg(env.DB, 'drafts-rollout-foreign');
    const org = testScope(env.DB, p.orgId);
    const other = await seedOrg(env.DB, 'drafts-rollout-other');
    const rollout = org.publishes.stage.addScreens(p.publish, [{ screenId: other.screen, manifestId: 'a'.repeat(64) }]);
    await expect(org.commit(rollout.writes)).rejects.toMatchObject({ name: 'StaleVersionError', id: 'screens', version: 0 });
    expect(await testScope(env.DB, other.orgId).publishes.screens(p.publish)).toEqual([]);
  });

  it('fails the batch as a stale read when a screen is deleted between the read and the commit (#52)', async () => {
    const p = await seedOrg(env.DB, 'drafts-rollout-deleted');
    const org = testScope(env.DB, p.orgId);
    const other = await org.screens.insert({ name: 'Other', timezone: 'UTC', orientation: 'landscape' });
    const publish = org.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision: 2 });
    const rollout = org.publishes.stage.addScreens(publish.row.id, [
      { screenId: p.screen, manifestId: 'a'.repeat(64) },
      { screenId: other.id, manifestId: 'b'.repeat(64) },
    ]);
    await org.screens.delete(other.id);
    await expect(org.commit([...publish.writes, ...rollout.writes])).rejects.toMatchObject({ name: 'StaleVersionError', id: 'screens' });
    expect(await org.publishes.get(publish.row.id)).toBeUndefined();
  });
});

describe('publish history', () => {
  /** Commit a publish at `revision` switching each screen to its manifest, as the publish tool does. */
  const publishAt = async (org: ReturnType<typeof scoped>, revision: number, rows: { screenId: string; manifestId: string }[], restoresId?: string) => {
    const publish = org.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-1', revision, restoresId });
    const rollout = org.publishes.stage.addScreens(publish.row.id, rows);
    await org.commit([...publish.writes, ...rollout.writes, ...rows.flatMap((r) => org.screens.stage.setDesiredManifest(r.screenId, r.manifestId).writes)]);
    return publish.row;
  };
  const m = (c: string) => c.repeat(64);
  /** A rollout's counts as [reports, current, revoked, screens], in a fixed order. */
  const facts = (rollout: readonly { reports: boolean; current: boolean; revoked: boolean; screens: number }[]) =>
    rollout.map((c) => [c.reports, c.current, c.revoked, c.screens]).sort((a, b) => String(a).localeCompare(String(b)));

  it('lists publishes newest first with how each rollout stands, and pages by revision', async () => {
    const p = await seedOrg(env.DB, 'history-list');
    const org = testScope(env.DB, p.orgId);
    const two = await org.screens.insert({ name: 'Two', timezone: 'UTC', orientation: 'landscape' });
    const v2 = await publishAt(org, 2, [
      { screenId: p.screen, manifestId: m('1') },
      { screenId: two.id, manifestId: m('2') },
    ]);
    await org.screens.reportManifest(p.screen, m('1'), { arrivedAt: Date.now() });
    expect(await org.publishes.history({ limit: 1 })).toEqual([expect.objectContaining({ id: v2.id, revision: 2, restoresId: null, actorName: null })]);
    expect(facts((await org.publishes.history({ limit: 1 }))[0]!.rollout)).toEqual([
      [false, true, false, 1],
      [true, true, false, 1],
    ]);
    const v3 = await publishAt(org, 3, [{ screenId: two.id, manifestId: m('3') }]);
    const all = await org.publishes.history({ limit: 10 });
    expect(all.map((h) => [h.id, facts(h.rollout)])).toEqual([
      [v3.id, [[false, true, false, 1]]],
      [
        v2.id,
        [
          [false, false, false, 1],
          [true, true, false, 1],
        ],
      ],
      [p.publish, [[false, false, false, 1]]],
    ]);
    expect((await org.publishes.history({ beforeRevision: 3, limit: 10 })).map((h) => h.id)).toEqual([v2.id, p.publish]);
    expect(await testScope(env.DB, 'drafts-org').publishes.history({ limit: 10 })).not.toContainEqual(expect.objectContaining({ id: v2.id }));
  });

  it('names a member with no name by their address before the @, never the whole address (#253)', async () => {
    const p = await seedOrg(env.DB, 'history-unnamed');
    const org = testScope(env.DB, p.orgId);
    const at = new Date().toISOString();
    await env.DB.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user-unnamed', '', 'sam.ortiz@example.com', 1, ?, ?)")
      .bind(at, at)
      .run();
    const publish = org.publishes.stage.insert({ status: 'published', actorKind: 'user', actorId: 'user-unnamed', revision: 2 });
    await org.commit(publish.writes);
    expect(await org.publishes.history({ limit: 1 })).toEqual([expect.objectContaining({ id: publish.row.id, actorName: 'sam.ortiz' })]);
  });

  it("reads a publish's rollout with each screen's state, and what each screen had as of a revision", async () => {
    const p = await seedOrg(env.DB, 'history-rollout');
    const org = testScope(env.DB, p.orgId);
    const late = await org.screens.insert({ name: 'Annex', timezone: 'UTC', orientation: 'landscape' });
    const v2 = await publishAt(org, 2, [{ screenId: p.screen, manifestId: m('1') }]);
    await publishAt(org, 3, [{ screenId: late.id, manifestId: m('2') }]);
    await publishAt(org, 4, [{ screenId: p.screen, manifestId: m('3') }]);
    expect(await org.publishes.rollout(v2.id)).toEqual([
      expect.objectContaining({
        id: p.screen,
        manifestId: m('1'),
        desiredManifestId: m('3'),
        reportedManifestId: null,
        credentialsRevoked: false,
        reports: false,
        current: false,
        revoked: false,
      }),
    ]);
    // Seeded at revision 0 with manifest d…d.
    expect(await org.publishes.asOf(1)).toEqual([{ screenId: p.screen, manifestId: m('d') }]);
    expect(await org.publishes.asOf(2)).toEqual([{ screenId: p.screen, manifestId: m('1') }]);
    expect(new Set(await org.publishes.asOf(3))).toEqual(
      new Set([
        { screenId: p.screen, manifestId: m('1') },
        { screenId: late.id, manifestId: m('2') },
      ]),
    );
    expect(await org.publishes.asOf(4)).toContainEqual({ screenId: p.screen, manifestId: m('3') });
  });

  it('finds every unfinished rollout with its facts, and marks one finished with its alert once', async () => {
    const p = await seedOrg(env.DB, 'history-finish');
    const org = testScope(env.DB, p.orgId);
    const two = await org.screens.insert({ name: 'Two', timezone: 'UTC', orientation: 'landscape' });
    await org.screens.reportManifest(p.screen, m('d'), { arrivedAt: 1 });
    const v2 = await publishAt(org, 2, [
      { screenId: p.screen, manifestId: m('1') },
      { screenId: two.id, manifestId: m('2') },
    ]);
    const found = async () => (await findUnfinishedRollouts(env.DB)).filter((f) => f.orgId === p.orgId).map((f) => [f.id, f.revision, facts(f.rollout)]);
    // The seeded publish's screen reported its manifest, then v2 moved it on.
    expect(await found()).toEqual([
      [p.publish, 0, [[true, false, false, 1]]],
      [v2.id, 2, [[false, true, false, 2]]],
    ]);
    expect(await org.publishes.finish(p.publish, 10, 1)).toBe(true);

    const alert = { event: { id: `evt_${v2.id}_finished`, type: 'publish.finished', json: '{}' }, channels: ['webhook' as const], giveUpAt: 99 };
    expect(await org.publishes.finish(v2.id, 30, 2, alert)).toBe(true);
    // A second check marks nothing, and the event is queued once.
    expect(await org.publishes.finish(v2.id, 40, 2, alert)).toBe(false);
    expect(await org.publishes.get(v2.id)).toMatchObject({ finishedAt: 30, reached: 2 });
    expect((await org.alertDeliveries.list({ take: 50 })).filter((d) => d.eventId === alert.event.id)).toHaveLength(1);
    expect(await found()).toEqual([]);
    // Another org's publish is not theirs to mark.
    expect(await testScope(env.DB, 'drafts-org').publishes.finish(v2.id, 50, 0)).toBe(false);

    // Revoked, as the screen's state reads it: every credential it had, or the screen itself.
    const cred = await org.screens.credentials.insert({ screenId: two.id, secretHash: '9'.repeat(64) });
    const v3 = await publishAt(org, 3, [
      { screenId: p.screen, manifestId: m('3') },
      { screenId: two.id, manifestId: m('4') },
    ]);
    expect(await found()).toEqual([[v3.id, 3, [[false, true, false, 2]]]]);
    await org.screens.credentials.update(cred.id, { revokedAt: 60 });
    await org.screens.update(p.screen, { status: 'revoked' });
    expect(await found()).toEqual([[v3.id, 3, [[false, true, true, 2]]]]);
    // A publish that switched no screen has no counts.
    const none = await publishAt(org, 4, []);
    expect((await found()).find(([id]) => id === none.id)).toEqual([none.id, 4, []]);
  });

  it('reads the unfinished rollouts through their partial index', async () => {
    // The statements findUnfinishedRollouts sends, with their values, captured on their way to D1.
    const sent: { sql: string; values: unknown[] }[] = [];
    const watching = new Proxy(env.DB, {
      get: (target, key) =>
        key === 'prepare'
          ? (query: string) => {
              const stmt = target.prepare(query);
              return new Proxy(stmt, {
                get: (t, k) => (k === 'bind' ? (...values: unknown[]) => (sent.push({ sql: query, values }), t.bind(...values)) : Reflect.get(t, k, t)),
              });
            }
          : Reflect.get(target, key, target),
    });
    await findUnfinishedRollouts(watching);
    expect(sent).toHaveLength(2);
    for (const { sql, values } of sent) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all();
      expect(JSON.stringify(plan.results)).toContain('USING INDEX publishes_unfinished_idx');
    }
  });
});

describe('playlist edits (M3-17)', () => {
  it('changes the fields and the items in one change, moving the version on once', async () => {
    const e = await seedOrg(env.DB, 'drafts-pl-edit');
    const org = testScope(env.DB, e.orgId);
    const read = (await org.playlists.get(e.playlist))!;
    const fade = JSON.stringify({ type: 'fade', ms: 600 });
    const s = await org.playlists.stage.update(read, { name: 'Lunch', transitionJson: fade }, read.rowVersion, [e.imageSpot, e.templateSpot, e.imageSpot]);
    await org.commit(s.writes);
    const now = (await org.playlists.get(e.playlist))!;
    expect(now).toMatchObject({ name: 'Lunch', transitionJson: fade, rowVersion: read.rowVersion + 1 });
    expect(s.row.rowVersion).toBe(now.rowVersion);
    expect(await org.playlists.items(e.playlist)).toEqual([e.imageSpot, e.templateSpot, e.imageSpot]);

    // Items alone move the version on too.
    await org.commit((await org.playlists.stage.update(now, {}, now.rowVersion, [])).writes);
    expect((await org.playlists.get(e.playlist))!.rowVersion).toBe(now.rowVersion + 1);
    expect(await org.playlists.items(e.playlist)).toEqual([]);
  });

  it('refuses an order made from an old read, in the batch, and leaves the items as they are', async () => {
    const e = await seedOrg(env.DB, 'drafts-pl-stale');
    const org = testScope(env.DB, e.orgId);
    const read = (await org.playlists.get(e.playlist))!;
    const mine = await org.playlists.stage.update(read, {}, read.rowVersion, [e.imageSpot]);
    await org.commit((await org.playlists.stage.update(read, { name: 'Theirs' }, read.rowVersion)).writes);
    await expect(org.commit(mine.writes)).rejects.toMatchObject({ name: 'StaleVersionError', version: read.rowVersion + 1 });
    expect(await org.playlists.items(e.playlist)).toEqual([e.templateSpot, e.imageSpot]);
  });

  it("refuses a spot the org does not have, and another org's spot", async () => {
    const e = await seedOrg(env.DB, 'drafts-pl-spots');
    const other = await seedOrg(env.DB, 'drafts-pl-spots-other');
    const org = testScope(env.DB, e.orgId);
    const read = (await org.playlists.get(e.playlist))!;
    for (const spot of ['spt_missing', other.imageSpot])
      await expect(org.playlists.stage.update(read, {}, read.rowVersion, [spot])).rejects.toBeInstanceOf(NotInOrgError);
  });
});

describe('versions across delete and make-again (#64)', () => {
  let t: SeededOrg;
  beforeAll(async () => {
    t = await seedOrg(env.DB, 'drafts-tomb');
  });

  // Each case reads a draft at version 2, deletes it, makes it again with its id, and then tries
  // the edit made from the old read, as an edit tool would: the row now, guarded by the version read.
  const cases = {
    spot: async () => {
      const org = testScope(env.DB, t.orgId);
      const values = { id: 'tomb-spot', name: 'Spot', kind: 'image', durationMs: 5000, assetId: t.asset, fit: 'cover' } as const;
      await org.spots.insert(values);
      const read = (await org.spots.update(values.id, { name: 'Spot, edited' }))!;
      await org.spots.delete(values.id);
      const again = await org.spots.insert(values);
      const edit = () => org.spots.stage.update(again, { name: 'From the old read' }, read.rowVersion);
      return { read, again, edit, now: () => org.spots.get(values.id) };
    },
    playlist: async () => {
      const org = testScope(env.DB, t.orgId);
      const values = { id: 'tomb-playlist', name: 'Playlist', transitionJson: JSON.stringify({ type: 'cut' }) };
      await org.playlists.insert(values);
      const read = (await org.playlists.update(values.id, { name: 'Playlist, edited' }))!;
      await org.commit(org.playlists.stage.delete(values.id).writes);
      const made = await org.playlists.stage.insert(values);
      await org.commit(made.writes);
      const again = made.row;
      const edit = async () => org.playlists.stage.update(again, { name: 'From the old read' }, read.rowVersion);
      return { read, again, edit, now: () => org.playlists.get(values.id) };
    },
    'schedule entry': async () => {
      const org = testScope(env.DB, t.orgId);
      const values = { id: 'tomb-entry', playlistId: t.playlist, target: 'group', groupId: t.group, priority: 1 } as const;
      await org.scheduleEntries.insert(values);
      const read = (await org.scheduleEntries.update(values.id, { priority: 2 }))!;
      await org.scheduleEntries.delete(values.id);
      const again = await org.scheduleEntries.insert(values);
      const edit = async () => org.scheduleEntries.stage.update(again, { priority: 9 }, read.rowVersion);
      return { read, again, edit, now: () => org.scheduleEntries.get(values.id) };
    },
  };

  for (const [kind, make] of Object.entries(cases)) {
    it(`continues a ${kind}'s versions, so an edit from before the delete is refused and writes nothing`, async () => {
      const { read, again, edit, now } = await make();
      expect(read.rowVersion).toBe(2);
      expect(again.rowVersion).toBe(3);
      expect(await now()).toEqual(again);
      const err = await edit().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StaleVersionError);
      expect(err).toMatchObject({ version: 3 });
      expect(await now()).toEqual(again);
    });
  }

  it('refuses in the batch an edit staged from the old row, made again after it was read', async () => {
    const org = testScope(env.DB, t.orgId);
    const values = { id: 'tomb-batch', name: 'Spot', kind: 'image', durationMs: 5000, assetId: t.asset, fit: 'cover' } as const;
    const read = await org.spots.insert(values);
    const edit = await org.spots.stage.update(read, { name: 'From the old read' }, read.rowVersion);
    await org.spots.delete(values.id);
    const again = await org.spots.insert(values);
    expect(again.rowVersion).toBe(2);

    await expect(org.commit(edit.writes)).rejects.toMatchObject({ name: 'StaleVersionError', version: 2 });
    expect(await org.spots.get(values.id)).toEqual(again);
  });

  it('continues the versions of a schedule entry deleted with its group', async () => {
    const c = await seedOrg(env.DB, 'drafts-tomb-cascade');
    const org = testScope(env.DB, c.orgId);
    const read = (await org.scheduleEntries.update(c.scheduleEntry, { priority: 5 }))!;
    expect(read.rowVersion).toBe(2);
    await org.screenGroups.delete(c.group);
    expect(await org.scheduleEntries.get(c.scheduleEntry)).toBeUndefined();

    const again = await org.scheduleEntries.insert({ id: c.scheduleEntry, playlistId: c.playlist, target: 'org', priority: 1 });
    expect(again.rowVersion).toBe(3);
  });

  it("starts another org's row with the same id at 1", async () => {
    const other = await seedOrg(env.DB, 'drafts-tomb-other');
    const org = testScope(env.DB, other.orgId);
    await testScope(env.DB, t.orgId).spots.delete('tomb-spot');
    const spot = await org.spots.insert({ id: 'tomb-spot', name: 'Theirs', kind: 'image', durationMs: 5000, assetId: other.asset, fit: 'cover' });
    expect(spot.rowVersion).toBe(1);
    expect((await org.playlists.stage.insert({ id: 'tomb-playlist', name: 'Theirs', transitionJson: '{"type":"cut"}' })).row.rowVersion).toBe(1);
  });
});
