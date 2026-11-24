// Publish requests' rows (M4-09, review of #386): the publish an approval names is the org's own
// (a composite foreign key), and decided or expired requests go with the org's audit retention.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { expirePublishRequests, scoped } from '../src';
import { type Seeded, seedTwoOrgs, testScope } from '../src/testing';

const DAY = 24 * 60 * 60_000;
let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

/** A pending request in org A, made at `at`, expiring a week later. */
async function requestAt(at: number) {
  const a = scoped(env.DB, s.a.orgId);
  const staged = a.publishRequests.stage.insert(
    { requestedByKind: 'user', requestedBy: 'user-a', draftsJson: '[]', reason: 'r', brandState: '', expiresAt: at + 7 * DAY },
    at,
  );
  await a.commit(staged.writes);
  return staged.row;
}

describe('publish_requests', () => {
  it("names only its own org's publish: another org's is refused by the foreign key", async () => {
    const a = scoped(env.DB, s.a.orgId);
    const row = await requestAt(Date.UTC(2026, 10, 24));
    const now = Date.UTC(2026, 10, 25);
    await expect(a.commit(a.publishRequests.stage.decide(row, { status: 'approved', by: 'u', now, publishId: s.b.publish }).writes)).rejects.toThrow(
      /FOREIGN KEY/,
    );
    await a.commit(a.publishRequests.stage.decide(row, { status: 'approved', by: 'u', now, publishId: s.a.publish }).writes);
    expect(await a.publishRequests.get(row.id)).toMatchObject({ status: 'approved', publishId: s.a.publish });
  });

  it("deletes decided and expired requests past the org's audit retention, never a pending one", async () => {
    const a = testScope(env.DB, s.a.orgId);
    const t0 = Date.UTC(2025, 0, 1);
    const old = await requestAt(t0);
    await a.commit(a.publishRequests.stage.decide(old, { status: 'declined', by: 'u', now: t0 + DAY }).writes);
    const expiredLongAgo = await requestAt(t0);
    const waiting = await requestAt(Date.UTC(2026, 10, 24));
    // 365 days, the default, after the decision and the expiry.
    const now = t0 + 7 * DAY + 366 * DAY;
    expect(await expirePublishRequests(env.DB, now)).toBe(2);
    expect(await a.publishRequests.get(old.id)).toBeUndefined();
    expect(await a.publishRequests.get(expiredLongAgo.id)).toBeUndefined();
    expect(await a.publishRequests.get(waiting.id)).toBeDefined();
  });
});
