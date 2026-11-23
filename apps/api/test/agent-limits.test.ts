// An agent grant's limits (#39, #107): its calls are counted by the AGENT_CALL_LIMIT rate limit
// binding, per Cloudflare location, and its writes in one Durable Object per grant, so every
// location shares one count of them and the daily budget lives in the object's storage.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { AGENT_LIMITS, dispatch, registry, type Caller } from '@signforge/tools';
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AgentGrantObject, agentLimiter } from '../src/agents/grant-object';
import { clockLimits } from './client';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// A UTC midnight. Each test sets the clock (vi.setSystemTime): the object, the limiter and the
// binding's stand-in (`clockLimits`) all run in the tests' isolate.
const MIDNIGHT = Date.UTC(2026, 10, 18);

let o: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'agent-limits');
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (ms: number) => vi.setSystemTime(ms);

/** The grant objects' namespace, counting the requests made to them. */
function countedGrants() {
  const requests: string[] = [];
  const counted = (stub: DurableObjectStub<AgentGrantObject>) =>
    new Proxy(stub, {
      get: (target, key) => {
        const method = Reflect.get(target, key);
        if (key !== 'write' && key !== 'audited') return method;
        return (...args: unknown[]) => {
          requests.push(key);
          return Reflect.apply(method, target, args);
        };
      },
    });
  const namespace = new Proxy(env.AGENT_GRANTS, {
    get: (target, key) => {
      if (key === 'get') return (id: DurableObjectId) => counted(target.get(id));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { requests, namespace };
}

/** One location's limiter: its own count of calls, on the tests' clock; writes in the shared objects. */
const limiterAt = (grants = env.AGENT_GRANTS) => agentLimiter({ ...clockLimits(), AGENT_GRANTS: grants });

const as = (actor: Caller['actor'], limiter = limiterAt()): Caller => ({
  org: scoped(env.DB, o.orgId),
  role: 'editor',
  actor,
  blobs: env.BLOBS,
  services: {},
  agentLimiter: limiter,
});
const agent = (grantId: string, limiter = limiterAt()) => as({ kind: 'agent', id: grantId, clientId: 'agent-app' }, limiter);

const read = (c: Caller) => dispatch(registry, 'get_org_settings', {}, c);
const write = (c: Caller, name = 'Lobby') => dispatch(registry, 'rename_group', { groupId: o.group, name }, c);

describe('the call limit binding', () => {
  it("allows AGENT_LIMITS' calls a minute, in every environment", () => {
    const limits: Record<string, { limit: number; period: number }> = JSON.parse(env.RATE_LIMITS);
    expect(limits.AGENT_CALL_LIMIT).toEqual({ limit: AGENT_LIMITS.calls_per_minute, period: 60 });
  });
});

describe("an agent grant's calls", () => {
  it("refuses an agent grant's 121st call in a minute, not a person's, and allows it once the minute is over", async () => {
    at(MIDNIGHT + 1000);
    const a = agent('grant-calls');
    for (let i = 0; i < 120; i++) expect((await read(a)).ok, `call ${i + 1}`).toBe(true);
    expect(await read(a)).toMatchObject({ ok: false, error: 'rate_limited', details: { limit: 'calls_per_minute', retryAfterSeconds: 59 } });

    const person = as({ kind: 'user', id: 'user-limits', clientId: 'cms' });
    for (let i = 0; i < 121; i++) expect((await read(person)).ok, `person's call ${i + 1}`).toBe(true);

    at(MIDNIGHT + MINUTE);
    expect(await read(a)).toMatchObject({ ok: true });
  });

  it("counts calls per location: another location's limiter has its own 120", async () => {
    at(MIDNIGHT + 8 * DAY);
    const here = agent('grant-located');
    const there = agent('grant-located');
    for (let i = 0; i < 120; i++) await read(here);
    expect(await read(here)).toMatchObject({ ok: false, details: { limit: 'calls_per_minute' } });
    expect(await read(there)).toMatchObject({ ok: true });
  });

  it('makes no Durable Object request for a read, and one for a write', async () => {
    at(MIDNIGHT + 9 * DAY);
    const { requests, namespace } = countedGrants();
    const a = agent('grant-reads', limiterAt(namespace));
    for (let i = 0; i < 50; i++) expect((await read(a)).ok).toBe(true);
    expect(requests).toEqual([]);
    expect((await write(a, 'Counted')).ok).toBe(true);
    expect(requests).toEqual(['write']);
  });
});

describe("an agent grant's writes", () => {
  it('refuses the 31st write in a minute, and counts reads as calls only', async () => {
    at(MIDNIGHT + 30_000);
    const a = agent('grant-writes');
    for (let i = 0; i < 30; i++) expect((await write(a, `Lobby ${i}`)).ok, `write ${i + 1}`).toBe(true);
    expect(await write(a)).toMatchObject({ ok: false, error: 'rate_limited', details: { limit: 'writes_per_minute', retryAfterSeconds: 30 } });
    expect(await read(a)).toMatchObject({ ok: true });
  });

  it('counts a refused write as a call', async () => {
    at(MIDNIGHT + 3 * DAY);
    const a = agent('grant-mixed');
    for (let i = 0; i < 30; i++) expect((await write(a, `Mixed ${i}`)).ok, `write ${i + 1}`).toBe(true);
    for (let i = 0; i < 40; i++) expect(await write(a), `refused write ${i + 1}`).toMatchObject({ details: { limit: 'writes_per_minute' } });
    // 70 calls so far: 50 more reads, then the minute's calls are spent.
    for (let i = 0; i < 50; i++) expect((await read(a)).ok, `read ${i + 1}`).toBe(true);
    expect(await read(a)).toMatchObject({ ok: false, error: 'rate_limited', details: { limit: 'calls_per_minute' } });
  });

  // 2,000 writes through the grant's object: about 5 s on CI's runners, over vitest's default.
  it('refuses the 2,001st write in a UTC day, counted in one place for every location, until the next day', { timeout: 30_000 }, async () => {
    // Two limiters, as two Workers in two locations hold: each gets its own stub of the grant's object.
    const here = limiterAt();
    const there = limiterAt();
    for (let i = 0; i < 2000; i++) {
      // 30 a minute, the most the per-minute budget allows.
      at(MIDNIGHT + Math.floor(i / 30) * MINUTE);
      expect(await (i % 2 ? here : there).take('grant-day', true), `write ${i + 1}`).toEqual({ ok: true });
    }
    // The object restarts, as on a deploy: the day's count is in its storage.
    await abortAllDurableObjects();

    at(MIDNIGHT + 20 * 60 * MINUTE);
    const a = agent('grant-day');
    expect(await write(a)).toMatchObject({ ok: false, error: 'rate_limited', details: { limit: 'writes_per_day', retryAfterSeconds: 4 * 60 * 60 } });
    // Reads go on.
    expect(await read(a)).toMatchObject({ ok: true });

    at(MIDNIGHT + DAY);
    expect(await write(a)).toMatchObject({ ok: true });
  });

  it('decides the window and the wait by the clock of the object when the call reaches it', async () => {
    // The limiter sends no time: however long a call takes to reach the object, the object's clock places it.
    const minute = MIDNIGHT + 4 * DAY;
    const limiter = limiterAt();
    at(minute + 30_000);
    for (let i = 0; i < 30; i++) expect(await limiter.take('grant-clock', true), `write ${i + 1}`).toEqual({ ok: true });
    at(minute + 61_000);
    expect(await limiter.take('grant-clock', true)).toEqual({ ok: true });
    for (let i = 0; i < 29; i++) await limiter.take('grant-clock', true);
    expect(await limiter.take('grant-clock', true)).toMatchObject({ ok: false, limit: 'writes_per_minute', retryAfterSeconds: 59 });
  });

  it("keeps the minute's writes through a restart, as on a deploy", async () => {
    at(MIDNIGHT + 5 * DAY + 1000);
    const writer = agent('grant-restart');
    for (let i = 0; i < 30; i++) expect((await write(writer, `Restarted ${i}`)).ok, `write ${i + 1}`).toBe(true);
    await abortAllDurableObjects();
    expect(await write(writer)).toMatchObject({ ok: false, details: { limit: 'writes_per_minute' } });
  });

  it('records the first refusal of each window in the audit log, once', async () => {
    at(MIDNIGHT + 2 * DAY);
    const a = agent('grant-audited');
    const refusals = async () =>
      (await scoped(env.DB, o.orgId).auditLog.list({ limit: 1000 })).filter((e) => e.actorId === 'grant-audited' && e.detailJson?.includes('rate_limited'));
    for (let i = 0; i < 30; i++) await write(a, `Audited ${i}`);
    await write(a);
    await write(a);
    expect(await refusals()).toHaveLength(1);
    at(MIDNIGHT + 2 * DAY + MINUTE);
    for (let i = 0; i < 30; i++) await write(a, `Audited again ${i}`);
    await write(a);
    expect(await refusals()).toHaveLength(2);
  });
});

describe('the audit row of a refusal', () => {
  const refusals = async (grantId: string) =>
    (await scoped(env.DB, o.orgId).auditLog.list({ limit: 1000 })).filter((e) => e.actorId === grantId && e.action === 'rate_limited');

  it('is one per grant and minute, whichever minute limit refuses', async () => {
    at(MIDNIGHT + 6 * DAY);
    const a = agent('grant-both');
    for (let i = 0; i < 30; i++) await write(a, `Both ${i}`);
    expect(await write(a)).toMatchObject({ details: { limit: 'writes_per_minute' } });
    for (let i = 0; i < 89; i++) await read(a);
    expect(await read(a)).toMatchObject({ details: { limit: 'calls_per_minute' } });
    expect(await refusals('grant-both')).toHaveLength(1);
  });

  it('is written by a later refusal when the first one could not write it, once however many race', async () => {
    at(MIDNIGHT + 7 * DAY);
    const a = agent('grant-unaudited');
    for (let i = 0; i < 120; i++) await read(a);
    await env.DB.exec("CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    try {
      // Still a refusal, not an error: the row waits for the next one.
      const refused = await Promise.all([1, 2, 3].map(() => read(a)));
      for (const r of refused) expect(r).toMatchObject({ ok: false, error: 'rate_limited' });
    } finally {
      await env.DB.exec('DROP TRIGGER audit_down');
    }
    expect(await refusals('grant-unaudited')).toHaveLength(0);
    await Promise.all([1, 2, 3, 4, 5].map(() => read(a)));
    expect(await refusals('grant-unaudited')).toHaveLength(1);
    await read(a);
    expect(await refusals('grant-unaudited')).toHaveLength(1);
  });

  it('is not asked for again by the location that wrote it: its later call refusals reach no object', async () => {
    at(MIDNIGHT + 10 * DAY);
    const { requests, namespace } = countedGrants();
    const a = agent('grant-quiet', limiterAt(namespace));
    for (let i = 0; i < 120; i++) await read(a);
    expect(await read(a)).toMatchObject({ ok: false, details: { limit: 'calls_per_minute' } });
    expect(requests).toEqual(['audited']);
    for (let i = 0; i < 20; i++) await read(a);
    expect(requests).toEqual(['audited']);
    expect(await refusals('grant-quiet')).toHaveLength(1);
  });
});

describe("the grant's object", () => {
  it('stores nothing when it is told of a window already marked', async () => {
    at(MIDNIGHT + 11 * DAY);
    const stub = env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName('grant-marked'));
    const window = { window: 'day', start: MIDNIGHT + 11 * DAY } as const;
    await runInDurableObject(stub, async (object: AgentGrantObject, state) => {
      const put = vi.spyOn(state.storage.kv, 'put');
      object.audited(window);
      object.audited(window);
      object.audited(window);
      expect(put).toHaveBeenCalledTimes(1);
    });
  });
});
