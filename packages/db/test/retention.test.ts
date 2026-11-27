// Audit retention (#41): each org's audit rows go once older than its retention, in bounded batches.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DELETE_LEASE_MS,
  expireAuditRows,
  expiredFeedImages,
  FEED_IMAGE_DELETE_GRACE_MS,
  FEED_IMAGE_TTL_MS,
  pendingFeedImageDeletes,
  scoped,
} from '../src/index';
import { seedTwoOrgs, type Seeded, testScope } from '../src/testing';

const DAY = 24 * 60 * 60_000;
const now = Date.UTC(2027, 5, 1);

let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

const append = (orgId: string, action: string, ageDays: number) =>
  scoped(env.DB, orgId).auditLog.append({ actorKind: 'system', actorId: 'test', action, at: now - ageDays * DAY });
const actions = async (orgId: string) => (await scoped(env.DB, orgId).auditLog.list({ limit: 100 })).map((r) => r.action);

describe('expireAuditRows', () => {
  it('keeps a row 364 days old and deletes one 366 days old, by default', async () => {
    await append(s.a.orgId, 'default-364', 364);
    await append(s.a.orgId, 'default-366', 366);
    await expireAuditRows(env.DB, now);
    const left = await actions(s.a.orgId);
    expect(left).toContain('default-364');
    expect(left).not.toContain('default-366');
  });

  it("deletes past an org's own retention and leaves another org's rows alone", async () => {
    const a = scoped(env.DB, s.a.orgId);
    await a.commit((await a.settings.stage.set({ auditRetentionDays: 30 })).writes);
    await append(s.a.orgId, 'short-29', 29);
    await append(s.a.orgId, 'short-31', 31);
    await append(s.b.orgId, 'other-31', 31);
    await expireAuditRows(env.DB, now);
    expect(await actions(s.a.orgId)).toContain('short-29');
    expect(await actions(s.a.orgId)).not.toContain('short-31');
    expect(await actions(s.b.orgId)).toContain('other-31');
  });

  it('deletes a large log over several runs, at most 10,000 rows a run', async () => {
    // 25,000 rows two years old, written in one statement.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 25000)
       INSERT INTO audit_log (id, org_id, at, actor_kind, actor_id, action) SELECT 'bulk-' || i, ?, ?, 'system', 'test', 'bulk' FROM n`,
    )
      .bind(s.b.orgId, now - 730 * DAY)
      .run();
    const bulkLeft = async () => (await env.DB.prepare(`SELECT count(*) AS n FROM audit_log WHERE action = 'bulk'`).first<{ n: number }>())?.n;

    expect(await expireAuditRows(env.DB, now)).toBe(10_000);
    expect(await bulkLeft()).toBe(15_000);
    expect(await expireAuditRows(env.DB, now)).toBe(10_000);
    expect(await expireAuditRows(env.DB, now)).toBe(5_000);
    expect(await bulkLeft()).toBe(0);
    expect(await expireAuditRows(env.DB, now)).toBe(0);
    expect(await actions(s.b.orgId)).toContain('other-31');
  });
});

describe('expiredFeedImages', () => {
  it("finds every org's photos no poll has named for a week past their check, the oldest first, at most the limit", async () => {
    const cutoff = now - FEED_IMAGE_TTL_MS;
    const put = (orgId: string, url: string, nextCheckAt: number) => testScope(env.DB, orgId).feedPhotos.put({ url, sourceId: 'news', nextCheckAt });
    await put(s.a.orgId, 'https://old.example/a.jpg', cutoff - 2);
    await put(s.b.orgId, 'https://old.example/b.jpg', cutoff - 1);
    await put(s.a.orgId, 'https://old.example/just-in-time.jpg', cutoff);
    await put(s.b.orgId, 'https://new.example/b.jpg', now);
    expect(await expiredFeedImages(env.DB, now, 10)).toEqual([
      { orgId: s.a.orgId, url: 'https://old.example/a.jpg' },
      { orgId: s.b.orgId, url: 'https://old.example/b.jpg' },
    ]);
    expect(await expiredFeedImages(env.DB, now, 1)).toEqual([{ orgId: s.a.orgId, url: 'https://old.example/a.jpg' }]);
  });
});

describe('pendingFeedImageDeletes', () => {
  it('returns queued feed photo deletes only after the grace window and when no delete lease is active', async () => {
    const a = testScope(env.DB, s.a.orgId).feedPhotos;
    const shaA = 'a'.repeat(64);
    const shaB = 'b'.repeat(64);
    await a.put({ url: 'https://del.example/a.jpg', sourceId: 'news', fileSha256: shaA, nextCheckAt: 1 });
    await a.put({ url: 'https://del.example/b.jpg', sourceId: 'news', fileSha256: shaB, nextCheckAt: 1 });
    await a.expire(['https://del.example/a.jpg'], now - FEED_IMAGE_DELETE_GRACE_MS);
    await a.expire(['https://del.example/b.jpg'], now - FEED_IMAGE_DELETE_GRACE_MS + 1);

    // Only shaA is past the grace window at `now`.
    expect(await pendingFeedImageDeletes(env.DB, now, 10)).toEqual([{ orgId: s.a.orgId, sha256: shaA }]);
    // A delete that fails leaves a lease on shaA, so it is skipped until the lease runs out.
    await expect(a.deleteBlobs([shaA], now, () => Promise.reject(new Error('R2 down')))).rejects.toThrow('R2 down');
    expect(await pendingFeedImageDeletes(env.DB, now + DELETE_LEASE_MS - 1, 10)).toEqual([{ orgId: s.a.orgId, sha256: shaB }]);
    expect(await pendingFeedImageDeletes(env.DB, now + DELETE_LEASE_MS, 10)).toEqual([
      { orgId: s.a.orgId, sha256: shaA },
      { orgId: s.a.orgId, sha256: shaB },
    ]);
    expect(await a.deleteBlobs([shaA, shaB], now + DELETE_LEASE_MS, async () => {})).toBe(2);
  });
});
