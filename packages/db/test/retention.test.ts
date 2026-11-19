// Audit retention (#41): each org's audit rows go once older than its retention, in bounded batches.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { expireAuditRows, scoped } from '../src/index';
import { seedTwoOrgs, type Seeded } from '../src/testing';

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
