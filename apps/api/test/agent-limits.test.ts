// An agent grant's limits (#39): its calls and writes are counted in one Durable Object per grant,
// so every location shares one count, and its daily budget lives in the object's storage.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { dispatch, registry, type Caller } from '@signforge/tools';
import { abortAllDurableObjects } from 'cloudflare:test';
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
  services: {},
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

  // 2,000 writes through the grant's object: about 5 s on CI's runners, over vitest's default.
  it('refuses the 2,001st write in a UTC day, counted in one place for every location, until the next day', { timeout: 30_000 }, async () => {
    // Two limiters, as two Workers in two locations hold: each gets its own stub of the grant's object.
    const here = agentLimiter(env);
    const there = agentLimiter(env);
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
});

describe('a pause mid-minute', () => {
  // Real time: an object with nothing pending is hibernated after about 10 s without a call, and loses its memory.
  it("keeps the minute's calls and writes through 12 s without a call, and its writes through a restart", { timeout: 30_000 }, async () => {
    at(MIDNIGHT + 5 * DAY + 1000);
    const reader = agent('grant-pause-reads');
    const writer = agent('grant-pause-writes');
    for (let i = 0; i < 120; i++) expect((await read(reader)).ok, `call ${i + 1}`).toBe(true);
    for (let i = 0; i < 30; i++) expect((await write(writer, `Paused ${i}`)).ok, `write ${i + 1}`).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    expect(await read(reader)).toMatchObject({ ok: false, details: { limit: 'calls_per_minute' } });
    expect(await write(writer)).toMatchObject({ ok: false, details: { limit: 'writes_per_minute' } });
    // A restart (a deploy) forgets the minute's calls, never its writes: those are stored with the day's.
    await abortAllDurableObjects();
    expect(await write(writer)).toMatchObject({ ok: false, details: { limit: 'writes_per_minute' } });
  });
});
