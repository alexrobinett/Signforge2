// The daily storage sweep (#235) against R2, on an injected clock and deterministic fixtures: it deletes only the org's
// own objects that are due, inside its own prefixes; keeps a file a kept manifest names (read from R2 into the index
// first), one the org names again, another org's and the base templates'; deletes nothing once its lease is nearly out,
// nor while another run holds the org; takes up a run that failed; and a run after deletes nothing. Its cost is measured.
import { scoped, STORAGE_GRACE_MS, STORAGE_LEASE_MS } from '@signforge/db';
import { queueDeletedFiles, runSql, seedOrganization, testScope } from '@signforge/db/testing';
import { baseBlobKey, manifestKey, orgBlobKey, uploadKey } from '@signforge/tools';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { INDEX_PER_ORG, ORGS_PER_RUN, type SweptBlobs, sweepStorage } from '../src/storage';
import { counted } from './counting';

const T0 = Date.UTC(2026, 2, 1);
const DAY = 24 * 60 * 60_000;
const DUE = T0 + STORAGE_GRACE_MS;
const sha = (c: string) => c.repeat(64);
const run = (query: string, ...binds: unknown[]) => runSql(env.DB, query, ...binds);
const exists = async (key: string) => (await env.BLOBS.head(key)) !== null;
const at = (t: number) => () => t;

/** R2, recording every key the sweep deletes and counting its calls; `beforeDelete` runs before each delete. */
const recorded = (beforeDelete: () => Promise<unknown> = async () => {}) => {
  const keys: string[] = [];
  const calls = { get: 0, delete: 0 };
  const blobs: SweptBlobs = {
    get: (key) => (calls.get++, env.BLOBS.get(key)),
    delete: async (batch) => {
      calls.delete++;
      await beforeDelete();
      keys.push(...batch);
      await env.BLOBS.delete(batch);
    },
  };
  return { keys, calls, blobs };
};

/** An org with one screen, a deleted asset's file `file` queued at T0 and stored in R2: due at DUE. */
async function orgWithDueFile(orgId: string, file: string) {
  await seedOrganization(env.DB, orgId);
  const screen = (await testScope(env.DB, orgId).screens.insert({ name: 'Lobby', timezone: 'UTC', orientation: 'landscape' })).id;
  await queueDeletedFiles(env.DB, orgId, [file], T0);
  await env.BLOBS.put(orgBlobKey(orgId, file), 'bytes');
  return { screen, key: orgBlobKey(orgId, file) };
}

/** A publish made at `createdAt`, its manifest for `screenId` stored in R2 naming `files`, and the screen on it. */
async function published(orgId: string, id: string, revision: number, createdAt: number, screenId: string, manifestId: string, files: string[]) {
  await run(
    "INSERT INTO publishes (id, org_id, status, actor_kind, actor_id, revision, created_at) VALUES (?, ?, 'published', 'user', 'u', ?, ?)",
    id,
    orgId,
    revision,
    createdAt,
  );
  await run('INSERT INTO publish_screens (org_id, publish_id, screen_id, manifest_id) VALUES (?, ?, ?, ?)', orgId, id, screenId, manifestId);
  await run('UPDATE screens SET desired_manifest_id = ?, reported_manifest_id = ? WHERE id = ?', manifestId, manifestId, screenId);
  await env.BLOBS.put(
    manifestKey(orgId, screenId, manifestId),
    JSON.stringify({ files: Object.fromEntries(files.map((f) => [f, {}])), spots: {}, templates: {}, screen: {} }),
  );
}

const audits = async (orgId: string) =>
  (await scoped(env.DB, orgId).auditLog.list({ limit: 10 })).filter((e) => e.action === 'sweep_storage').map((e) => JSON.parse(e.detailJson!));

describe('the storage sweep', () => {
  it("deletes an org's due objects inside its own prefixes, keeps what may still be needed, and runs again to no effect", async () => {
    const [A, B] = ['sweep-a', 'sweep-b'];
    const { screen, key: due } = await orgWithDueFile(A, sha('1'));
    const a = testScope(env.DB, A);
    // Queued with it: one the org names again, and one the screen's manifest names, from a publish made before the
    // queueing that is still the screen's. The manifest predates the index: the sweep reads it from R2.
    await queueDeletedFiles(env.DB, A, [sha('2'), sha('4')], T0);
    await a.assets.insert({ kind: 'video', name: 'Again', sha256: sha('2'), type: 'video/mp4', size: 1, status: 'verified' });
    await published(A, 'pub_a1', 1, T0 - DAY, screen, 'man_a1', [sha('4')]);
    // The same bytes in another org, queued later and named there again; and the base templates' copy. Never this org's.
    await seedOrganization(env.DB, B);
    await queueDeletedFiles(env.DB, B, [sha('1')], T0 + 30 * DAY);
    await testScope(env.DB, B).assets.insert({ kind: 'video', name: 'Kept', sha256: sha('1'), type: 'video/mp4', size: 1, status: 'verified' });
    // An upload left pending.
    const left = await a.assets.insert({ kind: 'video', name: 'Left', sha256: sha('3'), type: 'video/mp4', size: 1 });
    await run('UPDATE assets SET created_at = ? WHERE id = ?', T0, left.id);
    const keys = {
      named: orgBlobKey(A, sha('2')),
      pinned: orgBlobKey(A, sha('4')),
      upload: uploadKey(A, left.id, sha('3')),
      manifest: manifestKey(A, screen, 'man_a1'),
      other: orgBlobKey(B, sha('1')),
      base: baseBlobKey(sha('1')),
    };
    for (const key of [keys.named, keys.pinned, keys.upload, keys.other, keys.base]) await env.BLOBS.put(key, 'bytes');

    const measured = counted();
    const first = recorded();
    expect(await sweepStorage(measured.bindings.DB, first.blobs, at(DUE))).toBe(2);
    expect(first.keys.toSorted()).toEqual([due, keys.upload].sort());
    for (const key of first.keys) expect(key.startsWith(`o/${A}/b/`) || key.startsWith(`up/${A}/`), key).toBe(true);
    for (const key of Object.values(keys).filter((k) => k !== keys.upload)) expect(await exists(key), key).toBe(true);
    expect(await a.assets.get(left.id)).toBeUndefined();
    // Measured: the orgs due, then the org's lease, its unindexed manifests, the index written, the claim's batch, the
    // pending uploads and the last batch; an image upload's renditions are one query more. Seven an org at most, so
    // ORGS_PER_RUN fit in Free D1's 50. A new query fails this on purpose: look at the budget, then raise it.
    expect(measured.result()).toEqual({ statements: 16, queries: 7, rpcs: [] });
    expect(1 + ORGS_PER_RUN * 7).toBeLessThanOrEqual(50);
    // R2: here a read (the manifest indexed) and a delete. At most INDEX_PER_ORG reads and two deletes an org: a sweep
    // claims at most 90 files, 90 uploads' 360 and 1,000 manifests, 1,000 keys a delete (review of #431).
    expect(first.calls).toEqual({ get: 1, delete: 1 });
    expect(Math.ceil((90 + 90 * 4 + 1000) / 1000)).toBe(2);
    expect(ORGS_PER_RUN * (INDEX_PER_ORG + 2)).toBeLessThanOrEqual(50);

    // A newer publish moves the screen on: the old manifest is still kept (its publish is the screen's newest before the
    // grace period), so its file stays, until a publish past the grace period replaces it there too.
    await published(A, 'pub_a2', 2, DUE + DAY, screen, 'man_a2', []);
    expect(await sweepStorage(env.DB, recorded().blobs, at(DUE + 2 * DAY))).toBe(0);
    expect(await exists(keys.pinned)).toBe(true);
    await published(A, 'pub_a3', 3, DUE + DAY + STORAGE_GRACE_MS, screen, 'man_a3', []);
    const later = recorded();
    // With it, the upload's hash, queued again as it went (a copy finalized meanwhile would be under the org's blobs), and
    // the old manifest itself, kept by no screen and no publish since. The two newer ones stay.
    expect(await sweepStorage(env.DB, later.blobs, at(DUE + 2 * DAY + STORAGE_GRACE_MS))).toBe(3);
    expect(later.keys.toSorted()).toEqual([keys.pinned, orgBlobKey(A, sha('3')), keys.manifest].sort());
    for (const id of ['man_a2', 'man_a3']) expect(await exists(manifestKey(A, screen, id)), id).toBe(true);
    // Once a3 is past the grace period too, a2 is left behind and goes; a3, the screen's own, stays.
    const last = recorded();
    expect(await sweepStorage(env.DB, last.blobs, at(DUE + 3 * STORAGE_GRACE_MS))).toBe(1);
    expect(last.keys).toEqual([manifestKey(A, screen, 'man_a2')]);
    expect(await exists(manifestKey(A, screen, 'man_a3'))).toBe(true);
    for (const key of [...later.keys, ...last.keys]) expect(key.startsWith(`o/${A}/b/`) || key.startsWith(`o/${A}/m/`), key).toBe(true);
    // Idempotent: nothing more is due, and nothing is deleted; the queued file named again is forgotten.
    expect(await sweepStorage(env.DB, recorded().blobs, at(DUE + 4 * STORAGE_GRACE_MS))).toBe(0);
    const queued = await env.DB.prepare('SELECT count(*) AS n FROM blob_deletes WHERE org_id = ?').bind(A).first<{ n: number }>();
    expect(queued?.n).toBe(0);
    expect(await audits(A)).toEqual([
      { files: 0, uploads: [], manifests: 1 },
      { files: 2, uploads: [], manifests: 1 },
      { files: 1, uploads: [left.id], manifests: 0 },
    ]);
  });

  it('claims no file until every kept manifest is indexed, reading INDEX_PER_ORG a run', async () => {
    const { screen, key } = await orgWithDueFile('sweep-index', sha('5'));
    const others = [];
    for (let i = 0; i < INDEX_PER_ORG; i++)
      others.push((await testScope(env.DB, 'sweep-index').screens.insert({ name: `S${i}`, timezone: 'UTC', orientation: 'landscape' })).id);
    for (const [i, s] of [screen, ...others].entries()) await published('sweep-index', `pub_i${i}`, i + 1, T0 + DAY, s, `man_i${i}`, [sha('6')]);
    const first = recorded();
    expect(await sweepStorage(env.DB, first.blobs, at(DUE))).toBe(0);
    expect(await exists(key)).toBe(true);
    const indexed = await env.DB.prepare("SELECT count(*) AS n FROM stored_manifests WHERE org_id = 'sweep-index'").first<{ n: number }>();
    expect(indexed?.n).toBe(INDEX_PER_ORG);
    expect(await sweepStorage(env.DB, recorded().blobs, at(DUE + DAY))).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('deletes no file when a screen reports a manifest not indexed while the run reads others (review of #429, round 2, 1)', async () => {
    const { screen, key } = await orgWithDueFile('sweep-race', sha('a'));
    const t = testScope(env.DB, 'sweep-race');
    const other = (await t.screens.insert({ name: 'Hall', timezone: 'UTC', orientation: 'landscape' })).id;
    await published('sweep-race', 'pub_r1', 1, T0 + DAY, screen, 'man_r1', []);
    // As the run reads man_r1 from R2, the other screen reports a manifest stored nowhere the sweep knows of.
    const racing = recorded();
    const blobs: SweptBlobs = {
      ...racing.blobs,
      get: async (k) => {
        await run("UPDATE screens SET heartbeat_json = json_object('manifest', json_object('lastGood', 'man_unknown')) WHERE id = ?", other);
        return env.BLOBS.get(k);
      },
    };
    expect(await sweepStorage(env.DB, blobs, at(DUE))).toBe(0);
    expect(await exists(key)).toBe(true);
    // Looked for on the next run and found in no object: the screen can fetch nothing through it, so the file goes
    // (review of #429, round 3).
    const next = recorded();
    await sweepStorage(env.DB, next.blobs, at(DUE + STORAGE_LEASE_MS));
    expect(next.keys).toEqual([key]);
  });

  it('deletes nothing once too little of its lease is left, and the next run takes the claim up', async () => {
    const { key } = await orgWithDueFile('sweep-late', sha('7'));
    // The run's start and the lease taken at DUE; by the check before the delete, the lease is nearly out.
    let reads = 0;
    const late = () => (reads++ < 2 ? DUE : DUE + STORAGE_LEASE_MS - 1);
    const first = recorded();
    expect(await sweepStorage(env.DB, first.blobs, late)).toBe(0);
    expect(first.keys).toEqual([]);
    expect(await exists(key)).toBe(true);
    // Claimed and not forgotten: held by the lease until it runs out, then due again.
    expect(await sweepStorage(env.DB, recorded().blobs, at(DUE + 1))).toBe(0);
    expect(await sweepStorage(env.DB, recorded().blobs, at(DUE + STORAGE_LEASE_MS))).toBe(1);
    expect(await exists(key)).toBe(false);
  });

  it('runs one sweep of an org at a time: an overlapping run leaves it to the one holding the lease', async () => {
    const { key } = await orgWithDueFile('sweep-overlap', sha('8'));
    let entered!: () => void;
    let resume!: () => void;
    const inDelete = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((r) => (resume = r));
    const first = recorded(() => (entered(), held));
    const running = sweepStorage(env.DB, first.blobs, at(DUE));
    await inDelete;
    const second = recorded();
    expect(await sweepStorage(env.DB, second.blobs, at(DUE + 1))).toBe(0);
    expect(second.keys).toEqual([]);
    resume();
    expect(await running).toBe(1);
    expect(first.keys).toEqual([key]);
    expect(await audits('sweep-overlap')).toEqual([{ files: 1, uploads: [], manifests: 0 }]);
  });

  it('takes up a run whose R2 delete failed, once its lease has run out', async () => {
    const { key } = await orgWithDueFile('sweep-fail', sha('9'));
    const failing = recorded(async () => {
      throw new Error('R2 is down');
    });
    await expect(sweepStorage(env.DB, failing.blobs, at(DUE))).rejects.toThrow('R2 is down');
    expect(await exists(key)).toBe(true);
    expect(await sweepStorage(env.DB, recorded().blobs, at(DUE + 1))).toBe(0);
    const retry = recorded();
    expect(await sweepStorage(env.DB, retry.blobs, at(DUE + STORAGE_LEASE_MS))).toBe(1);
    expect(retry.keys).toEqual([key]);
    expect(await exists(key)).toBe(false);
  });
});
