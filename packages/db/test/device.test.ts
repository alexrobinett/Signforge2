import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { findDeviceScreen, scoped } from '../src/index';
import { seedOrg, type SeededOrg } from '../src/testing';

let o: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'org-device');
});

describe('findDeviceScreen', () => {
  it('finds a screen by id alone, with its org and live credentials', async () => {
    expect(await findDeviceScreen(env.DB, o.screen)).toEqual({
      orgId: 'org-device',
      screenId: o.screen,
      desiredManifestId: null,
      previousManifestId: null,
      displayOverrideJson: null,
      credentials: [{ id: o.credential, secretHash: '0'.repeat(64), used: false }],
    });
  });

  it('leaves out revoked credentials, and every credential of a revoked screen', async () => {
    const hashes = async () => (await findDeviceScreen(env.DB, o.screen))?.credentials.map((c) => c.secretHash);
    const extra = await o.scope.screens.credentials.insert({ screenId: o.screen, secretHash: '1'.repeat(64) });
    expect((await hashes())?.sort()).toEqual(['0'.repeat(64), '1'.repeat(64)]);
    await o.scope.screens.credentials.update(extra.id, { revokedAt: Date.now() });
    expect(await hashes()).toEqual(['0'.repeat(64)]);
    await o.scope.screens.update(o.screen, { status: 'revoked' });
    expect(await hashes()).toEqual([]);
    await o.scope.screens.update(o.screen, { status: 'active' });
  });

  it('returns nothing for an unknown or malformed id', async () => {
    expect(await findDeviceScreen(env.DB, 'scr_nope')).toBeUndefined();
    expect(await findDeviceScreen(env.DB, "x' OR 1=1 --")).toBeUndefined();
  });
});

describe('screens.setDesiredManifest', () => {
  it('keeps the manifest it replaces as the previous one', async () => {
    const r = scoped(env.DB, o.orgId);
    const [m1, m2] = ['1'.repeat(64), '2'.repeat(64)];
    expect(await r.screens.setDesiredManifest(o.screen, m1)).toBe(true);
    expect(await r.screens.get(o.screen)).toMatchObject({ desiredManifestId: m1, previousManifestId: null });
    await r.screens.setDesiredManifest(o.screen, m2);
    expect(await r.screens.get(o.screen)).toMatchObject({ desiredManifestId: m2, previousManifestId: m1 });
    // Setting the current one again keeps the previous one.
    await r.screens.setDesiredManifest(o.screen, m2);
    expect(await findDeviceScreen(env.DB, o.screen)).toMatchObject({ desiredManifestId: m2, previousManifestId: m1 });
  });
});

describe('screens.sync', () => {
  const HOUR = Date.UTC(2026, 10, 18, 9);
  const beat = (over: Partial<Parameters<ReturnType<typeof scoped>['screens']['sync']>[1]> = {}) => ({
    at: HOUR + 60_000,
    playerVersion: '1.0.0',
    heartbeatJson: '{"display":{"on":true}}',
    epoch: 'ep1',
    seq: 1,
    counts: [
      { hour: HOUR, spotId: 'menu', plays: 3, ms: 30_000 },
      { hour: HOUR, spotId: 'news', plays: 2, ms: 20_000 },
    ],
    ...over,
  });

  it('stores a batch once, records the heartbeat, and keeps the highest seq per epoch', async () => {
    const seeded = await seedOrg(env.DB, 'org-sync');
    const r = seeded.scope;
    const o = { screen: seeded.screen };
    const list = async () => (await r.playCounts.list({ from: HOUR, to: HOUR + 3_600_000, screenId: o.screen })).map((c) => [c.spotId, c.plays, c.ms]);

    expect(await r.screens.sync(o.screen, beat())).toMatchObject({ ackSeq: 1 });
    expect(await list()).toEqual([
      ['menu', 3, 30_000],
      ['news', 2, 20_000],
    ]);
    const row = await r.screens.get(o.screen);
    expect(row).toMatchObject({ lastSeenAt: HOUR + 60_000, playerVersion: '1.0.0', heartbeatJson: '{"display":{"on":true}}' });

    // A retry of the same seq, or an older one, adds nothing.
    expect(await r.screens.sync(o.screen, beat())).toMatchObject({ ackSeq: 1 });
    expect(await r.screens.sync(o.screen, beat({ seq: 0 }))).toMatchObject({ ackSeq: 1 });
    expect(await list()).toEqual([
      ['menu', 3, 30_000],
      ['news', 2, 20_000],
    ]);

    // The next seq adds to the hour.
    expect(await r.screens.sync(o.screen, beat({ seq: 2, counts: [{ hour: HOUR, spotId: 'menu', plays: 1, ms: 10_000 }] }))).toMatchObject({ ackSeq: 2 });
    expect(await list()).toEqual([
      ['menu', 4, 40_000],
      ['news', 2, 20_000],
    ]);

    // A screen that lost its counter starts a new epoch at seq 1, and is not taken for a repeat.
    expect(await r.screens.sync(o.screen, beat({ epoch: 'ep2', seq: 1, counts: [{ hour: HOUR, spotId: 'menu', plays: 1, ms: 10_000 }] }))).toMatchObject({
      ackSeq: 1,
    });
    expect(await list()).toEqual([
      ['menu', 5, 50_000],
      ['news', 2, 20_000],
    ]);
    // A sync with no counts acknowledges what is stored.
    expect(await r.screens.sync(o.screen, beat({ epoch: 'ep2', seq: 1, counts: [] }))).toMatchObject({ ackSeq: 1 });
  });

  it('counts each batch once when retries from an old and a new epoch interleave (a re-image)', async () => {
    const seeded = await seedOrg(env.DB, 'org-sync-epochs');
    const r = seeded.scope;
    const menu = async () => (await r.playCounts.list({ from: HOUR, to: HOUR + 3_600_000, screenId: seeded.screen }))[0]?.plays;
    const batch = (epoch: string, seq: number, plays: number) => beat({ epoch, seq, counts: [{ hour: HOUR, spotId: 'menu', plays, ms: plays * 1000 }] });

    expect(await r.screens.sync(seeded.screen, batch('old', 1, 1))).toMatchObject({ ackSeq: 1 });
    expect(await r.screens.sync(seeded.screen, batch('old', 2, 2))).toMatchObject({ ackSeq: 2 });
    expect(await r.screens.sync(seeded.screen, batch('new', 1, 10))).toMatchObject({ ackSeq: 1 });
    // A delayed retry from before the re-image, then one from after it: both already stored.
    expect(await r.screens.sync(seeded.screen, batch('old', 2, 2))).toMatchObject({ ackSeq: 2 });
    expect(await r.screens.sync(seeded.screen, batch('new', 1, 10))).toMatchObject({ ackSeq: 1 });
    expect(await r.screens.sync(seeded.screen, batch('old', 1, 1))).toMatchObject({ ackSeq: 2 });
    expect(await menu()).toBe(13);
    // Each epoch goes on from its own mark.
    expect(await r.screens.sync(seeded.screen, batch('new', 2, 20))).toMatchObject({ ackSeq: 2 });
    expect(await r.screens.sync(seeded.screen, batch('old', 3, 100))).toMatchObject({ ackSeq: 3 });
    expect(await r.screens.sync(seeded.screen, batch('new', 2, 20))).toMatchObject({ ackSeq: 2 });
    expect(await menu()).toBe(133);
  });

  it('writes one row for a heartbeat with no counts, and leaves the screen settings untouched', async () => {
    const seeded = await seedOrg(env.DB, 'org-sync-writes');
    const r = seeded.scope;
    const before = await r.screens.get(seeded.screen);
    const result = await r.screens.sync(seeded.screen, beat({ counts: [], seq: 0 }));
    expect(result?.rowsWritten).toBe(1);
    expect((await r.screens.get(seeded.screen))?.updatedAt).toBe(before?.updatedAt);
    // A new hourly row costs the row and its two index entries (the key and the org's hours);
    // adding to an existing one, only the row. The epoch's mark costs the row and its key when the
    // epoch is new, then the row.
    expect((await r.screens.sync(seeded.screen, beat()))?.rowsWritten).toBe(1 + 2 * 3 + 2);
    expect((await r.screens.sync(seeded.screen, beat({ seq: 2 })))?.rowsWritten).toBe(1 + 2 + 1);
    // An idle heartbeat repeats the acknowledged seq, and writes only the screen.
    expect((await r.screens.sync(seeded.screen, beat({ seq: 2, counts: [] })))?.rowsWritten).toBe(1);
  });

  it('returns nothing for a screen the org does not have', async () => {
    expect(await scoped(env.DB, 'org-device').screens.sync('scr_nope', beat())).toBeUndefined();
  });
});
