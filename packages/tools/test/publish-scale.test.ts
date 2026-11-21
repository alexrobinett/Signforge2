// A 1,000-screen org publishes inside a Worker invocation's limits (M3-18): the D1 queries, R2
// calls and screen notices one publish makes, counted through bindings that pass everything on.
// Limits: docs/backend-plan.md#publishing and spike/m3-platform/RESULTS.md.
import { seedOrganization, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { dispatch, registry, type Caller } from '../src';
import { ok } from './calls';

const SCREENS = 1000;
/** D1 queries per invocation on Workers Free; a `batch()` is one. Paid allows 1,000. */
const D1_QUERIES_FREE = 50;
/** Calls to Cloudflare services (D1, R2, Durable Objects, Queues) per invocation on Workers Paid, by default. */
const SUBREQUESTS_PAID = 10_000;

/** A D1 that counts queries: each statement run on its own, and each batch. */
function countingD1(real: D1Database) {
  const n = { queries: 0, batchStatements: 0 };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get: (target, key) => {
        if (key === 'bind') return (...v: unknown[]) => wrap(target.bind(...v));
        if (key === 'run' || key === 'all' || key === 'raw' || key === 'first') {
          return (...args: unknown[]) => {
            n.queries += 1;
            return (target[key] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (key === 'real') return target;
        return Reflect.get(target, key, target);
      },
    });
  const db = new Proxy(real, {
    get: (target, key) => {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (key === 'batch')
        return (stmts: D1PreparedStatement[]) => {
          n.queries += 1;
          n.batchStatements += stmts.length;
          return target.batch(stmts.map((s) => (s as unknown as { real: D1PreparedStatement }).real));
        };
      return Reflect.get(target, key, target);
    },
  });
  return { db, n };
}

/** An R2 bucket that counts calls. */
function countingR2(real: R2Bucket) {
  const n = { calls: 0 };
  const bucket = new Proxy(real, {
    get: (target, key) => {
      const v = Reflect.get(target, key, target);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        n.calls += 1;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { bucket, n };
}

async function seedFleet(orgId: string) {
  await seedOrganization(env.DB, orgId);
  const org = testScope(env.DB, orgId);
  await org.commit(
    Array.from({ length: SCREENS }, (_, i) =>
      org.screens.stage.insert({ name: `Screen ${i}`, timezone: 'Europe/London', orientation: i % 4 ? 'landscape' : 'portrait' }),
    ).flatMap((s) => s.writes),
  );
  const page = await org.spots.insert({ id: `${orgId}-page`, name: 'Menu page', kind: 'url', durationMs: 10_000, url: 'https://example.com/menu' });
  const main = await org.playlists.insert({ id: `${orgId}-main`, name: 'Main', transitionJson: JSON.stringify({ type: 'cut' }) });
  await org.playlists.setItems(main.id, [page.id]);
  await org.commit((await org.settings.stage.set({ defaultPlaylistId: main.id })).writes);
  return org;
}

describe('a 1,000-screen org', () => {
  // Seeding and publishing 1,000 screens take several seconds on a CI runner.
  it('publishes inside the Worker limits, and then publishes nothing when nothing changed', { timeout: 60_000 }, async () => {
    const orgId = 'scale-1000';
    await seedFleet(orgId);
    const d1 = countingD1(env.DB);
    const r2 = countingR2(env.BLOBS);
    const told: number[] = [];
    const caller: Caller = {
      org: testScope(d1.db, orgId),
      role: 'owner',
      actor: { kind: 'user', id: 'user-1', clientId: 'cms' },
      blobs: r2.bucket,
      services: {
        notify: { manifest: async () => {}, manifests: async (rows) => void told.push(rows.length), revoked: async () => {}, command: async () => {} },
      },
    };
    const started = performance.now();
    const out = await ok(dispatch(registry, 'publish', {}, caller));
    const ms = performance.now() - started;
    expect(out.publish).toMatchObject({ revision: 1, screens: SCREENS });

    // D1: loadOrg's reads, the audit read and one batch. Within the Free plan's 50.
    expect(d1.n.queries).toBeLessThanOrEqual(D1_QUERIES_FREE);
    // R2: one manifest each. Paid's subrequest limit; not Free's 1,000 (docs/backend-plan.md#publishing).
    expect(r2.n.calls).toBe(SCREENS);
    expect(d1.n.queries + r2.n.calls).toBeLessThan(SUBREQUESTS_PAID);
    // One notice for all: the API turns it into queue messages of 50 screens (apps/api src/publish.ts).
    expect(told).toEqual([SCREENS]);
    console.log(
      `[scale] ${SCREENS} screens: ${d1.n.queries} D1 queries (one batch of ${d1.n.batchStatements} statements), ${r2.n.calls} R2 calls, ${Math.round(ms)} ms wall in workerd`,
    );

    const before = { queries: d1.n.queries, r2: r2.n.calls };
    expect(await ok(dispatch(registry, 'publish', {}, caller))).toMatchObject({ publish: null });
    expect(r2.n.calls).toBe(before.r2);
    expect(told).toHaveLength(1);
    expect(d1.n.queries - before.queries).toBeLessThanOrEqual(D1_QUERIES_FREE);
  });
});
