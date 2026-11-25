// Storage clean-up (#235, reworked after the review of #429): what each org keeps is explicit, and a deleted asset's file
// goes only outside it. On a fixed clock and deterministic fixtures, each scenario in orgs of its own: the grace period
// to the millisecond; the manifests kept (every screen pointer, the heartbeat's included, and every manifest effective at
// a publish of the last 90 days, one inherited from before them or re-stamped by a roll back included); files kept by
// those manifests through the index, and by the org's own rows; the lease and claims with their owner; the writers' and
// a publish's guards; and lists past D1's 100 bound values.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { orgsWithStorageDue, scoped, STORAGE_GRACE_MS, STORAGE_LEASE_MS, StaleVersionError } from '../src/index';
import { queueDeletedFiles, seedOrganization, testScope } from '../src/testing';

const T0 = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60_000;
/** The first moment something queued or published at T0 is past the grace period. */
const DUE = T0 + STORAGE_GRACE_MS;
const sha = (c: string) => c.repeat(64);

const run = (query: string, ...binds: unknown[]) =>
  env.DB.prepare(query)
    .bind(...binds)
    .run();
let orgs = 0;
/** An org of its own, with `screens` screens. */
async function fresh(screens = 0) {
  const orgId = `storage-${++orgs}`;
  await seedOrganization(env.DB, orgId);
  const ids: string[] = [];
  for (let i = 0; i < screens; i++) ids.push((await testScope(env.DB, orgId).screens.insert({ name: `S${i}`, timezone: 'UTC', orientation: 'landscape' })).id);
  return { orgId, org: scoped(env.DB, orgId), screens: ids };
}
async function publish(orgId: string, id: string, revision: number, at: number, rows: [string, string][]) {
  await run(
    "INSERT INTO publishes (id, org_id, status, actor_kind, actor_id, revision, created_at) VALUES (?, ?, 'published', 'user', 'u', ?, ?)",
    id,
    orgId,
    revision,
    at,
  );
  for (const [screenId, manifestId] of rows)
    await run('INSERT INTO publish_screens (org_id, publish_id, screen_id, manifest_id) VALUES (?, ?, ?, ?)', orgId, id, screenId, manifestId);
}
const index = async (orgId: string, manifests: { id: string; files: string[] }[]) => {
  const org = scoped(env.DB, orgId);
  await org.commit(org.storage.stage.index(manifests, T0).writes);
};
/** Leases the org for `owner` at `at` and claims what is due then. */
async function claimed(orgId: string, at: number, owner = 'sweep-a') {
  const org = scoped(env.DB, orgId);
  expect(await org.storage.lease(owner, at)).toBe(true);
  return org.storage.claim(owner, at, 90, true);
}
const queuedAt = async (orgId: string, hash: string) =>
  (await env.DB.prepare('SELECT queued_at AS q FROM blob_deletes WHERE org_id = ? AND sha256 = ?').bind(orgId, hash).first<{ q: number }>())?.q;
const m = (c: string) => `m${c.repeat(63)}`;

describe("a deleted asset's file", () => {
  it('is due once queued for the grace period, not a millisecond before; another org’s queue is its own', async () => {
    const a = await fresh();
    const b = await fresh();
    await queueDeletedFiles(env.DB, a.orgId, [sha('1')], T0);
    await queueDeletedFiles(env.DB, b.orgId, [sha('1')], T0 + DAY);
    expect((await claimed(a.orgId, DUE - 1)).files).toEqual([]);
    await a.org.commit(a.org.storage.stage.release('sweep-a', DUE - 1).writes);
    expect((await claimed(a.orgId, DUE)).files).toEqual([sha('1')]);
    // B's, queued a day later, is not due yet; A's claim never touched it.
    expect((await claimed(b.orgId, DUE)).files).toEqual([]);
    expect(await queuedAt(b.orgId, sha('1'))).toBe(T0 + DAY);
  });

  it('keeps the later queued time when its bytes are queued again, never the earlier (review of #429, 8)', async () => {
    const { orgId } = await fresh();
    await queueDeletedFiles(env.DB, orgId, [sha('2')], T0);
    await queueDeletedFiles(env.DB, orgId, [sha('2')], T0 + 89 * DAY);
    expect(await queuedAt(orgId, sha('2'))).toBe(T0 + 89 * DAY);
    await queueDeletedFiles(env.DB, orgId, [sha('2')], T0 + DAY);
    expect(await queuedAt(orgId, sha('2'))).toBe(T0 + 89 * DAY);
    expect((await claimed(orgId, DUE)).files).toEqual([]);
  });

  it('is kept, and forgotten as a deleted asset’s, while the org names its bytes: an asset, a pending upload’s rendition, a sample, a template', async () => {
    const { orgId } = await fresh();
    await queueDeletedFiles(env.DB, orgId, [sha('3'), sha('4'), sha('5'), sha('6')], T0);
    const t = testScope(env.DB, orgId);
    await t.assets.insert({ kind: 'video', name: 'Again', sha256: sha('3'), type: 'video/mp4', size: 1, status: 'verified' });
    const pending = await t.assets.insert({ kind: 'image', name: 'Pending', sha256: sha('9'), type: 'image/png', size: 1, width: 1, height: 1 });
    await t.assets.renditions.insert({
      assetId: pending.id,
      orientation: 'landscape',
      sha256: sha('4'),
      type: 'image/png',
      size: 1,
      width: 1,
      height: 1,
      sampleSha256: sha('5'),
    });
    const template = await t.templates.insert({ key: 'card', name: 'Card' });
    await t.templates.versions.insert({ templateId: template.id, version: '1.0.0', manifestJson: '{}', bundleSha256: sha('6'), status: 'approved' });
    expect((await claimed(orgId, DUE)).files).toEqual([]);
    for (const c of ['3', '4', '5', '6']) expect(await queuedAt(orgId, sha(c)), c).toBeUndefined();
  });
});

describe('the manifests an org keeps, and the files they name (review of #429, 1, 3, 4)', () => {
  it("keeps a file a screen's pointer names: desired, previous, reported, and the heartbeat's active, fallback and last good", async () => {
    const { orgId, screens } = await fresh(1);
    const [screen] = screens as [string];
    await queueDeletedFiles(env.DB, orgId, [sha('a')], T0);
    await index(orgId, [{ id: m('1'), files: [sha('a')] }]);
    const columns: [string, string][] = [
      ['desired_manifest_id', '?'],
      ['previous_manifest_id', '?'],
      ['reported_manifest_id', '?'],
      ['heartbeat_json', `json_object('manifest', json_object('active', ?))`],
      ['heartbeat_json', `json_object('manifest', json_object('fallbackFrom', ?))`],
      ['heartbeat_json', `json_object('manifest', json_object('lastGood', ?))`],
    ];
    for (const [column, value] of columns) {
      await run(`UPDATE screens SET ${column} = ${value} WHERE id = ?`, m('1'), screen);
      const org = scoped(env.DB, orgId);
      expect((await claimed(orgId, DUE)).files, `${column} ${value}`).toEqual([]);
      await org.commit(org.storage.stage.release('sweep-a', DUE).writes);
      await run(`UPDATE screens SET ${column} = NULL WHERE id = ?`, screen);
    }
    expect((await claimed(orgId, DUE)).files).toEqual([sha('a')]);
  });

  it('keeps a file a roll back put back on a screen, though the asset was deleted after the manifest was first published (1)', async () => {
    const { orgId, screens } = await fresh(1);
    const [screen] = screens as [string];
    // Published on day -10, the asset deleted on day 0; a roll back on day 50 re-stamps the old manifest with a new publish.
    await publish(orgId, 'pub_r1', 1, T0 - 10 * DAY, [[screen, m('2')]]);
    await index(orgId, [{ id: m('2'), files: [sha('b')] }]);
    await queueDeletedFiles(env.DB, orgId, [sha('b')], T0);
    await publish(orgId, 'pub_r2', 2, T0 + 20 * DAY, [[screen, m('3')]]);
    await publish(orgId, 'pub_r3', 3, T0 + 50 * DAY, [[screen, m('2')]]);
    await run('UPDATE screens SET desired_manifest_id = ?, previous_manifest_id = ? WHERE id = ?', m('2'), m('3'), screen);
    await index(orgId, [{ id: m('3'), files: [] }]);
    expect((await claimed(orgId, DUE)).files).toEqual([]);
  });

  it('keeps a manifest a screen inherited into a recent publish that did not switch it, with its files (3)', async () => {
    const { orgId, screens } = await fresh(2);
    const [lobby, hall] = screens as [string, string];
    const now = DUE + 10 * DAY;
    // Day 0 switches both; day 95 only the lobby, the hall inheriting day 0's; days 96 and 97 move the hall on twice.
    await publish(orgId, 'pub_i1', 1, T0, [
      [lobby, m('4')],
      [hall, m('5')],
    ]);
    await publish(orgId, 'pub_i2', 2, now - 5 * DAY, [[lobby, m('6')]]);
    await publish(orgId, 'pub_i3', 3, now - 4 * DAY, [[hall, m('7')]]);
    await publish(orgId, 'pub_i4', 4, now - 3 * DAY, [[hall, m('8')]]);
    await run('UPDATE screens SET desired_manifest_id = ?, previous_manifest_id = ? WHERE id = ?', m('8'), m('7'), hall);
    await run('UPDATE screens SET desired_manifest_id = ? WHERE id = ?', m('6'), lobby);
    await index(orgId, [
      { id: m('4'), files: [] },
      { id: m('5'), files: [sha('c')] },
      { id: m('6'), files: [] },
      { id: m('7'), files: [] },
      { id: m('8'), files: [] },
    ]);
    // Rolling back to day 95 would put day 0's back on the hall: its file stays.
    await queueDeletedFiles(env.DB, orgId, [sha('c')], T0);
    expect((await claimed(orgId, now)).files).toEqual([]);
    expect(await scoped(env.DB, orgId).storage.unindexed(now, 10)).toEqual([]);
  });

  it('names a kept manifest not indexed yet, with a screen it is stored for: the sweep indexes it before any file is judged', async () => {
    const { orgId, screens } = await fresh(1);
    const [screen] = screens as [string];
    await run('UPDATE screens SET reported_manifest_id = ? WHERE id = ?', m('9'), screen);
    expect(await scoped(env.DB, orgId).storage.unindexed(DUE, 10)).toEqual([{ screenId: screen, manifestId: m('9') }]);
    await index(orgId, [{ id: m('9'), files: [sha('d')] }]);
    // Indexed once: again with other files changes nothing.
    await index(orgId, [{ id: m('9'), files: [] }]);
    expect(await scoped(env.DB, orgId).storage.unindexed(DUE, 10)).toEqual([]);
    expect(await env.DB.prepare('SELECT files_json AS f FROM stored_manifests WHERE org_id = ?').bind(orgId).first<{ f: string }>()).toEqual({
      f: JSON.stringify([sha('d')]),
    });
  });

  it('indexes a thousand manifests in parts under D1’s limits', async () => {
    const { orgId } = await fresh();
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `n${String(i).padStart(63, '0')}`, files: [sha('e'), sha('f'), `${i}`.padStart(64, '0')] }));
    await index(orgId, many);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM stored_manifests WHERE org_id = ?').bind(orgId).first<{ n: number }>()).toEqual({ n: 1000 });
  });
});

describe("the sweep's lease and claims (review of #429, 7)", () => {
  it('lets one sweep lease an org at a time, until the lease runs out, and claims only for the holder', async () => {
    const { orgId, org } = await fresh();
    await queueDeletedFiles(env.DB, orgId, [sha('1')], T0);
    expect(await org.storage.lease('sweep-a', DUE)).toBe(true);
    expect(await org.storage.lease('sweep-b', DUE + STORAGE_LEASE_MS - 1)).toBe(false);
    // A claim made by one that does not hold the lease takes nothing.
    expect((await org.storage.claim('sweep-b', DUE, 90, true)).files).toEqual([]);
    expect((await org.storage.claim('sweep-a', DUE, 90, true)).files).toEqual([sha('1')]);
    // Past the lease, another may take over, and A's claims have expired with it.
    expect(await org.storage.lease('sweep-b', DUE + STORAGE_LEASE_MS)).toBe(true);
    expect((await org.storage.claim('sweep-b', DUE + STORAGE_LEASE_MS, 90, true)).files).toEqual([sha('1')]);
    // A's last batch is refused: it no longer holds the lease, and B's claim stands.
    await expect(org.commit(org.storage.stage.forget({ files: [sha('1')], uploads: [] }, 'sweep-a', DUE + STORAGE_LEASE_MS).writes)).rejects.toBeInstanceOf(
      StaleVersionError,
    );
    expect(await queuedAt(orgId, sha('1'))).toBe(T0);
    await org.commit(org.storage.stage.forget({ files: [sha('1')], uploads: [] }, 'sweep-b', DUE + STORAGE_LEASE_MS).writes);
    expect(await queuedAt(orgId, sha('1'))).toBeUndefined();
    const [row] = (await org.auditLog.list({ limit: 5 })).filter((e) => e.action === 'sweep_storage');
    expect(row).toMatchObject({ actorKind: 'system', actorId: 'storage-sweep', clientId: null, at: DUE + STORAGE_LEASE_MS });
  });

  it('claims nothing while a kept manifest is not indexed', async () => {
    const { orgId, org } = await fresh();
    await queueDeletedFiles(env.DB, orgId, [sha('2')], T0);
    expect(await org.storage.lease('sweep-a', DUE)).toBe(true);
    expect((await org.storage.claim('sweep-a', DUE, 90, false)).files).toEqual([]);
  });

  it('lists the orgs due, the least recently swept first, so none waits behind another’s backlog (9)', async () => {
    const first = await fresh();
    const second = await fresh();
    for (const o of [first, second]) await queueDeletedFiles(env.DB, o.orgId, [sha('3')], T0);
    const late = DUE + 400 * DAY;
    const due = async () => (await orgsWithStorageDue(env.DB, late, 1000)).filter((id) => id === first.orgId || id === second.orgId);
    expect(await due()).toEqual([first.orgId, second.orgId]);
    // The first is swept (its file pinned, say): it goes behind the second.
    expect(await first.org.storage.lease('sweep-a', late - DAY)).toBe(true);
    await first.org.commit(first.org.storage.stage.release('sweep-a', late - DAY).writes);
    expect(await due()).toEqual([second.orgId, first.orgId]);
  });
});

describe('unfinished uploads', () => {
  it('are due once pending for the grace period, with their files; a finished one stays; their hashes are queued again (8)', async () => {
    const { orgId, org } = await fresh();
    const t = testScope(env.DB, orgId);
    const left = await t.assets.insert({ kind: 'image', name: 'Left', sha256: sha('a'), type: 'image/png', size: 1, width: 1, height: 1 });
    await t.assets.renditions.insert({
      assetId: left.id,
      orientation: 'portrait',
      sha256: sha('b'),
      type: 'image/png',
      size: 1,
      width: 1,
      height: 1,
      sampleSha256: sha('c'),
    });
    const done = await t.assets.insert({ kind: 'image', name: 'Done', sha256: sha('d'), type: 'image/png', size: 1, width: 1, height: 1, status: 'verified' });
    await run('UPDATE assets SET created_at = ? WHERE id IN (?, ?)', T0, left.id, done.id);
    expect((await claimed(orgId, DUE - 1)).uploads).toEqual([]);
    await org.commit(org.storage.stage.release('sweep-a', DUE - 1).writes);
    const due = await claimed(orgId, DUE);
    expect(due.uploads).toEqual([{ assetId: left.id, files: [sha('b'), sha('c')] }]);
    await org.commit(org.storage.stage.forget(due, 'sweep-a', DUE).writes);
    expect(await t.assets.get(left.id)).toBeUndefined();
    expect(await t.assets.get(done.id)).toBeDefined();
    // A stored copy it was reusing is not left unqueued: its hashes wait their own grace period.
    expect(await queuedAt(orgId, sha('b'))).toBe(DUE);
    expect(await queuedAt(orgId, sha('c'))).toBe(DUE);
  });

  it('claims and forgets 90 uploads with 180 files and 90 files, past D1’s 100 bound values (9)', async () => {
    const { orgId, org } = await fresh();
    const t = testScope(env.DB, orgId);
    const hex = (i: number, p: string) => `${p}${i.toString(16).padStart(63, '0')}`;
    for (let i = 0; i < 90; i++) {
      const asset = await t.assets.insert({ kind: 'image', name: `U${i}`, sha256: hex(i, 'a'), type: 'image/png', size: 1, width: 1, height: 1 });
      await t.assets.renditions.insert({
        assetId: asset.id,
        orientation: 'landscape',
        sha256: hex(i, 'b'),
        type: 'image/png',
        size: 1,
        width: 1,
        height: 1,
        sampleSha256: hex(i, 'c'),
      });
    }
    await run('UPDATE assets SET created_at = ? WHERE org_id = ?', T0, orgId);
    await queueDeletedFiles(
      env.DB,
      orgId,
      Array.from({ length: 90 }, (_, i) => hex(i, 'd')),
      T0,
    );
    const due = await claimed(orgId, DUE);
    expect({ files: due.files.length, uploads: due.uploads.length, uploadFiles: due.uploads.flatMap((u) => u.files).length }).toEqual({
      files: 90,
      uploads: 90,
      uploadFiles: 180,
    });
    await org.commit(org.storage.stage.forget(due, 'sweep-a', DUE).writes);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM assets WHERE org_id = ?').bind(orgId).first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe('the guards writers and a publish hold to their commits (review of #429, 5, 6)', () => {
  it('refuses a writer while a sweep claims its bytes, and lets it once the claim has run out', async () => {
    const { orgId, org } = await fresh();
    await queueDeletedFiles(env.DB, orgId, [sha('1')], T0);
    expect((await claimed(orgId, DUE)).files).toEqual([sha('1')]);
    expect(await org.storage.claimed([sha('2'), sha('1')], DUE)).toBe(true);
    await expect(org.commit(org.storage.stage.unclaimed([sha('1')], DUE + 1))).rejects.toBeInstanceOf(StaleVersionError);
    expect(await org.storage.claimed([sha('1')], DUE + STORAGE_LEASE_MS)).toBe(false);
    await org.commit(org.storage.stage.unclaimed([sha('1')], DUE + STORAGE_LEASE_MS));
  });

  it("refuses a publish whose manifests name a deleted asset's file nothing names, and lets one whose bytes a live asset names", async () => {
    const { orgId, org } = await fresh();
    await queueDeletedFiles(env.DB, orgId, [sha('3'), sha('4')], T0);
    await expect(org.commit(org.storage.stage.filesLive([sha('3')]))).rejects.toBeInstanceOf(StaleVersionError);
    await testScope(env.DB, orgId).assets.insert({ kind: 'video', name: 'Live', sha256: sha('4'), type: 'video/mp4', size: 1, status: 'verified' });
    await org.commit(org.storage.stage.filesLive([sha('4'), sha('5')]));
  });

  it("refuses an asset's deletion while a spot's draft or published version, or a brand kit, names it", async () => {
    const { orgId, org } = await fresh();
    const t = testScope(env.DB, orgId);
    const asset = await t.assets.insert({ kind: 'image', name: 'Logo', sha256: sha('6'), type: 'image/png', size: 1, width: 1, height: 1, status: 'verified' });
    await org.commit([org.assets.stage.unused(asset.id)]);
    const spot = await t.spots.insert({ name: 'Uses it', kind: 'image', durationMs: 10_000, assetId: asset.id });
    await expect(org.commit([org.assets.stage.unused(asset.id)])).rejects.toBeInstanceOf(StaleVersionError);
    await run('UPDATE spots SET asset_id = NULL, published_json = ? WHERE id = ?', JSON.stringify({ assetId: asset.id }), spot.id);
    await expect(org.commit([org.assets.stage.unused(asset.id)])).rejects.toBeInstanceOf(StaleVersionError);
    await run('UPDATE spots SET published_json = NULL WHERE id = ?', spot.id);
    await org.commit([org.assets.stage.unused(asset.id)]);
  });
});
