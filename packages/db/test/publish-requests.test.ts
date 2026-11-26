// Publish requests' rows (M4-09, review of #386): the publish an approval names is the org's own
// (a composite foreign key), and decided or expired requests go with the org's audit retention.
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { brandStateOf, expirePublishRequests, scoped, StaleVersionError } from '../src';
import { type Seeded, seedTwoOrgs, testScope } from '../src/testing';

const DAY = 24 * 60 * 60_000;
let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

/** A pending request in org A, made at `at`, expiring a week later, its pins its own. */
let asked = 0;
async function requestAt(at: number) {
  const a = scoped(env.DB, s.a.orgId);
  const staged = a.publishRequests.stage.insert(
    { requestedByKind: 'user', requestedBy: 'user-a', draftsJson: JSON.stringify([at, ++asked]), reason: 'r', brandState: '', expiresAt: at + 7 * DAY },
    at,
    10,
  );
  await a.commit(staged.writes);
  return staged.row;
}

describe('publish_requests', () => {
  it("names only its own org's publish: another org's is refused by the foreign key", async () => {
    const a = scoped(env.DB, s.a.orgId);
    // Ahead of the database's own clock, which a decision past its expiry is refused by too.
    const row = await requestAt(Date.UTC(2101, 0, 1));
    const now = Date.UTC(2101, 0, 2);
    await expect(a.commit(a.publishRequests.stage.decide(row, { status: 'approved', by: 'u', now, publishId: s.b.publish }).writes)).rejects.toThrow(
      /FOREIGN KEY/,
    );
    await a.commit(a.publishRequests.stage.decide(row, { status: 'approved', by: 'u', now, publishId: s.a.publish }).writes);
    expect(await a.publishRequests.get(row.id)).toMatchObject({ status: 'approved', publishId: s.a.publish });
  });

  it("deletes decided and expired requests past the org's audit retention, never a pending one", async () => {
    const a = testScope(env.DB, s.a.orgId);
    // In 2100: a decision is refused past its expiry by the database's own clock too, which these dates are ahead of.
    const t0 = Date.UTC(2100, 0, 1);
    const old = await requestAt(t0);
    await a.commit(a.publishRequests.stage.decide(old, { status: 'declined', by: 'u', now: t0 + DAY }).writes);
    const expiredLongAgo = await requestAt(t0);
    const waiting = await requestAt(t0 + 380 * DAY);
    // 365 days, the default, after the decision and the expiry.
    const now = t0 + 7 * DAY + 366 * DAY;
    expect(await expirePublishRequests(env.DB, now)).toBeGreaterThanOrEqual(2);
    expect(await a.publishRequests.get(old.id)).toBeUndefined();
    expect(await a.publishRequests.get(expiredLongAgo.id)).toBeUndefined();
    expect(await a.publishRequests.get(waiting.id)).toBeDefined();
  });
});

describe('the guards a request batch holds (re-check of #386)', () => {
  it("refuses a decision once the database's own clock is past the expiry, whatever time it was staged with", async () => {
    const a = scoped(env.DB, s.a.orgId);
    // Expired long before the database's clock, which no test can move: the staged time says otherwise.
    const row = await requestAt(Date.UTC(2020, 0, 1));
    await expect(a.commit(a.publishRequests.stage.decide(row, { status: 'approved', by: 'u', now: row.createdAt + 1 }).writes)).rejects.toBeInstanceOf(
      StaleVersionError,
    );
    expect((await a.publishRequests.get(row.id))?.status).toBe('pending');
  });

  describe("with the Worker's clock behind the database's at the expiry (#396)", () => {
    // The Worker in 2020, the request expiring in 2021: past it by the database's clock, which no test can move, not by the Worker's.
    afterEach(() => vi.useRealTimers());
    const behind = () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.UTC(2020, 0, 1));
    };

    it('refuses a decision as a conflict naming the request, never a fault', async () => {
      const a = scoped(env.DB, s.a.orgId);
      const row = await requestAt(Date.UTC(2021, 0, 1) - 7 * DAY);
      behind();
      const refused = a.commit(a.publishRequests.stage.decide(row, { status: 'declined', by: 'u', now: Date.now() }).writes);
      await expect(refused).rejects.toBeInstanceOf(StaleVersionError);
      await expect(refused).rejects.toMatchObject({ id: row.id, version: row.rowVersion });
      expect((await a.publishRequests.get(row.id))?.status).toBe('pending');
    });

    it('refuses putting a declined one back the same way', async () => {
      const a = scoped(env.DB, s.a.orgId);
      const pending = await requestAt(Date.UTC(2021, 0, 1) - 7 * DAY);
      await env.DB.prepare("UPDATE publish_requests SET status = 'declined', decided_by = 'u', decided_at = ? WHERE id = ?")
        .bind(pending.createdAt, pending.id)
        .run();
      const row = (await a.publishRequests.get(pending.id))!;
      behind();
      const refused = a.commit(a.publishRequests.stage.reopen(row, Date.now(), 10).writes);
      await expect(refused).rejects.toMatchObject({ name: 'StaleVersionError', id: row.id, version: row.rowVersion });
      expect((await a.publishRequests.get(row.id))?.status).toBe('declined');
    });
  });

  it('refuses, as it inserts, the same pins waiting from the same asker, and an asker at the cap', async () => {
    const a = scoped(env.DB, s.a.orgId);
    const at = Date.UTC(2102, 0, 1);
    const ask = (draftsJson: string, max = 10) =>
      a.publishRequests.stage.insert(
        { requestedByKind: 'user', requestedBy: 'asker-g', draftsJson, reason: 'r', brandState: '', expiresAt: at + 7 * DAY },
        at,
        max,
      );
    // Two staged from one read, as two calls at once would: the second batch is refused.
    const [first, twin] = [ask('["x"]'), ask('["x"]')];
    await a.commit(first.writes);
    await expect(a.commit(twin.writes)).rejects.toBeInstanceOf(StaleVersionError);
    // One waits; a cap of 1 refuses another.
    await expect(a.commit(ask('["y"]', 1).writes)).rejects.toBeInstanceOf(StaleVersionError);
    await a.commit(ask('["y"]', 2).writes);
  });

  it('reads the brand state from rows as the SQL does', async () => {
    const a = scoped(env.DB, s.a.orgId);
    const [kits, assignments] = await Promise.all([a.brandKits.list(), a.brandKits.assignments.list()]);
    expect(brandStateOf(kits, assignments)).toBe(await a.brandKits.state());
  });
});
