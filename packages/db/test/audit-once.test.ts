// `auditLog.appendOnce` (#77): one row per key however many calls race to write it, with an id of
// fixed length under the contract's ID_PATTERN, and no org's row standing in for another's.
import { ID_PATTERN } from '@signforge/contract';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { scoped } from '../src/index';
import { seedTwoOrgs, type Seeded } from '../src/testing';

let s: Seeded;
beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

// As the dispatcher keys an agent grant's refusal: grant id, window, window start.
const KEY = `rate_limited_agt_${'g'.repeat(40)}_minute_1795400000000`;
// Each test writes its own action, so their rows stay apart.
const entry = (action: string) => ({ actorKind: 'agent', actorId: `agt_${'g'.repeat(40)}`, clientId: 'agent-app', action }) as const;
const rows = async (orgId: string, action: string) => (await scoped(env.DB, orgId).auditLog.list({ limit: 100 })).filter((r) => r.action === action);

describe('auditLog.appendOnce', () => {
  it('writes one row for a key, however many calls race to write it', async () => {
    const a = scoped(env.DB, s.a.orgId);
    await Promise.all([1, 2, 3, 4].map(() => a.auditLog.appendOnce(`${KEY}_race`, entry('race'))));
    await a.auditLog.appendOnce(`${KEY}_race`, entry('race'));
    expect(await rows(s.a.orgId, 'race')).toHaveLength(1);
  });

  it('gives the row an id of fixed length that the contract accepts, whatever the key', async () => {
    const a = scoped(env.DB, s.a.orgId);
    await a.auditLog.appendOnce(`${KEY}_and_much_longer_${'x'.repeat(200)}`, entry('length'));
    await a.auditLog.appendOnce('k', entry('length'));
    const ids = (await rows(s.a.orgId, 'length')).map((r) => r.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
    expect(new Set(ids.map((id) => id.length)).size).toBe(1);
  });

  it("writes another org's row for the same key: one org's row never stands in for another's", async () => {
    await scoped(env.DB, s.a.orgId).auditLog.appendOnce(`${KEY}_orgs`, entry('orgs'));
    await scoped(env.DB, s.b.orgId).auditLog.appendOnce(`${KEY}_orgs`, entry('orgs'));
    expect(await rows(s.a.orgId, 'orgs')).toHaveLength(1);
    expect(await rows(s.b.orgId, 'orgs')).toHaveLength(1);
  });
});
