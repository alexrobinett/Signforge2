// `list_screen_status`, the fleet poll: each screen's state without its settings or manifest, a page read in SQL.
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dispatch, registry, type Caller, type ScreenHeartbeat } from '../src';
import { fakeServices } from './services';

let o: SeededOrg;

/** D1, counting the rows its statements read (D1's own `rows_read`, the unit it bills reads in). */
function counting(db: D1Database) {
  const read = { rows: 0 };
  // `raw` and `first` return no meta: the statement runs once more through `all` to count it.
  const counted = async <T>(stmt: D1PreparedStatement, run: () => Promise<T>) => {
    const { meta } = await stmt.all();
    read.rows += meta.rows_read;
    return run();
  };
  const statement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, p) {
        if (p === 'bind') return (...values: unknown[]) => statement(target.bind(...values));
        if (p === 'all' || p === 'raw' || p === 'first' || p === 'run')
          return (...a: unknown[]) => counted(target, () => Reflect.apply(Reflect.get(target, p), target, a));
        return Reflect.get(target, p);
      },
    });
  const d1 = new Proxy(db, {
    get(target, p) {
      if (p === 'prepare') return (query: string) => statement(target.prepare(query));
      if (p === 'batch') throw new Error('the status poll reads; it has no batch');
      return Reflect.get(target, p);
    },
  });
  return { d1, read };
}

/** A bucket that fails any read: the poll must not load manifests. */
const noBlobs = new Proxy(env.BLOBS, {
  get: (target, p) => (p === 'get' || p === 'head' ? () => Promise.reject(new Error('the status poll read R2')) : Reflect.get(target, p)),
});

const callerOn = (db: D1Database): Caller => ({
  org: testScope(db, o.orgId),
  role: 'viewer',
  actor: { kind: 'user', id: 'user-1', clientId: 'cms' },
  blobs: noBlobs,
  services: fakeServices,
});

const call = async <T = any>(name: string, input: unknown, caller = callerOn(env.DB)): Promise<T> => {
  const r = await dispatch(registry, name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};

const MANIFEST = 'c'.repeat(64);
const beat = (at: number): ScreenHeartbeat => ({
  at,
  player: { version: '1.2.3', manifestSchemas: [2], protocols: [1, 2] },
  manifest: { active: MANIFEST, filesMissing: 0 },
  display: { on: true },
  clock: { offsetMs: 0, trusted: true },
  driftMs: 0,
  dataRejected: {},
});

let online: string;
let silent: string;
let revoked: string;

beforeAll(async () => {
  o = await seedOrg(env.DB, 'status-org');
  const org = testScope(env.DB, o.orgId);
  const now = Date.now();
  const synced = async (name: string, lastSeenAt: number) => {
    const s = await org.screens.insert({ name, timezone: 'UTC', orientation: 'landscape' });
    await org.screens.setDesiredManifest(s.id, MANIFEST);
    await org.screens.update(s.id, { reportedManifestId: MANIFEST, lastSeenAt, heartbeatJson: JSON.stringify(beat(lastSeenAt)) });
    await org.screens.credentials.insert({ screenId: s.id, secretHash: '1'.repeat(64) });
    return s.id;
  };
  online = await synced('Online', now);
  silent = await synced('Silent', now - 20 * 60_000);
  revoked = await synced('Revoked', now);
  const [cred] = await org.screens.credentials.forScreen(revoked);
  await org.screens.credentials.update(cred!.id, { revokedAt: now });
});

describe('list_screen_status', () => {
  it("gives each screen's state, last sync and manifests, as list_screens works them out", async () => {
    const { screens } = await call('list_screen_status', {});
    const byId = new Map(screens.map((s: { id: string }) => [s.id, s]));
    expect(byId.get(online)).toEqual({
      id: online,
      state: { kind: 'online', reason: null, wakesAt: null, filesMissing: null },
      lastSeenAt: expect.any(Number),
      desiredManifestId: MANIFEST,
      reportedManifestId: MANIFEST,
    });
    expect(byId.get(silent)).toMatchObject({ state: { kind: 'unreachable' } });
    expect(byId.get(revoked)).toMatchObject({ state: { kind: 'needs_you', reason: 'revoked' } });

    // The same states the full view gives, which also reads the manifests.
    const full = await call<{ screens: { id: string; state: unknown }[] }>('list_screens', {}, { ...callerOn(env.DB), blobs: env.BLOBS });
    expect(screens.map((s: { id: string; state: unknown }) => [s.id, s.state])).toEqual(full.screens.map((s) => [s.id, s.state]));
  });

  it("reads one page's rows from D1, however many screens the org has", async () => {
    // An org of paired screens, each with its one credential, that has changed its settings.
    const p = await seedOrg(env.DB, 'status-poll-org');
    const org = testScope(env.DB, p.orgId);
    await org.commit((await org.settings.stage.set({ unreachableAfterMs: 10 * 60_000 })).writes);
    const paired = async (n: number) => {
      for (let i = 0; i < n; i++) {
        const s = await org.screens.insert({ name: `Paired ${i}`, timezone: 'UTC', orientation: 'landscape' });
        await org.screens.credentials.insert({ screenId: s.id, secretHash: '2'.repeat(64) });
      }
    };
    const { d1, read } = counting(env.DB);
    let next = '';
    const rowsRead = async (name: string, limit: number, cursor?: string) => {
      read.rows = 0;
      const out = await dispatch(registry, name, { limit, cursor }, { ...callerOn(d1), org: testScope(d1, p.orgId) });
      if (!out.ok) throw new Error(out.message);
      ({ next } = z.object({ next: z.string() }).parse(out.output));
      return read.rows;
    };
    await paired(9);
    // Each row of the page and the one after it (the screen, and its credential looked at twice), and the settings row.
    expect(await rowsRead('list_screen_status', 2)).toBe(3 * (2 + 1) + 1);
    await paired(30);
    expect(await rowsRead('list_screen_status', 2)).toBe(3 * (2 + 1) + 1);
    expect(await rowsRead('list_screen_status', 20)).toBe(3 * (20 + 1) + 1);
    // A page after a cursor starts at it in the index (id > ?), past another org's screens between this org's.
    expect(await rowsRead('list_screen_status', 2, next)).toBe(3 * (2 + 1) + 1);
    // list_screens reads every screen and credential of the org (40 of each) and the settings, whatever the page.
    expect(await rowsRead('list_screens', 2)).toBe(81);
  });
});
