// An agent grant's limits (#39): its calls and writes are counted in one Durable Object per grant,
// so every location shares one count, and its daily budget lives in the object's storage.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { dispatch, registry, type Caller } from '@signforge/tools';
import { evictDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentLimiter } from '../src/agents/grant-object';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// A UTC midnight. Each test sets the object's clock (vi.setSystemTime: the object runs in the tests' isolate).
const MIDNIGHT = Date.UTC(2026, 10, 18);

let o: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'agent-limits');
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (ms: number) => vi.setSystemTime(ms);

const as = (actor: Caller['actor']): Caller => ({
  org: scoped(env.DB, o.orgId),
  role: 'editor',
  actor,
  blobs: env.BLOBS,
  agentLimiter: agentLimiter(env),
});
const agent = (grantId: string) => as({ kind: 'agent', id: grantId, clientId: 'agent-app' });

const read = (c: Caller) => dispatch(registry, 'get_org_settings', {}, c);
const write = (c: Caller, name = 'Lobby') => dispatch(registry, 'rename_group', { groupId: o.group, name }, c);

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

  it('refuses the 2,001st write in a UTC day, counted in one place for every location, until the next day', async () => {
    // Two limiters, as two Workers in two locations hold: each gets its own stub of the grant's object.
    const here = agentLimiter(env);
    const there = agentLimiter(env);
    for (let i = 0; i < 2000; i++) {
      // 30 a minute, the most the per-minute budget allows.
      at(MIDNIGHT + Math.floor(i / 30) * MINUTE);
      expect(await (i % 2 ? here : there).take('grant-day', true), `write ${i + 1}`).toEqual({ ok: true });
    }
    // The object is evicted, as one is when idle or redeployed: the day's count is in its storage.
    await evictDurableObject(env.AGENT_GRANTS.get(env.AGENT_GRANTS.idFromName('grant-day')));

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
    const limiter = agentLimiter(env);
    at(minute + 30_000);
    for (let i = 0; i < 30; i++) expect(await limiter.take('grant-clock', true), `write ${i + 1}`).toEqual({ ok: true });
    at(minute + 61_000);
    expect(await limiter.take('grant-clock', true)).toEqual({ ok: true });
    for (let i = 0; i < 29; i++) await limiter.take('grant-clock', true);
    expect(await limiter.take('grant-clock', true)).toMatchObject({ ok: false, limit: 'writes_per_minute', retryAfterSeconds: 59 });
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
