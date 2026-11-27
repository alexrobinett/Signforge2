import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { findDeviceScreen, platform, scoped } from '../src/index';
import { CANARY_SCREENS_SQL, NEXT_RELEASE_SQL, promoteReleaseSql, registerReleaseSql } from '../src/player-release';
import { seedOrg, signedRelease, type SeededOrg } from '../src/testing';

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
      lastGoodManifestId: null,
      lastPhotos: null,
      displayOverrideJson: null,
      // Every screen follows the stable player releases until it is made a canary (#628).
      playerChannel: 'stable',
      kind: 'device',
      release: { running: null, since: null, failed: [] },
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

  it("reads the last sync's photos, and a #514 heartbeat's one fingerprint of what it sent as no keys (#531)", async () => {
    const photos = { held: 3, missing: 21, retried: true, ask: ['a'.repeat(16)] };
    const lastPhotos = async (heartbeat: unknown) => {
      await o.scope.screens.update(o.screen, { heartbeatJson: JSON.stringify({ photos: heartbeat }) });
      return (await findDeviceScreen(env.DB, o.screen))?.lastPhotos;
    };
    expect(await lastPhotos({ ...photos, sent: ['b'.repeat(16)], repeat: [] })).toEqual({
      missing: 21,
      retried: true,
      ask: ['a'.repeat(16)],
      sent: ['b'.repeat(16)],
      repeat: [],
    });
    expect(await lastPhotos({ ...photos, sent: 'c'.repeat(16) })).toEqual({ missing: 21, retried: true, ask: ['a'.repeat(16)] });
    await o.scope.screens.update(o.screen, { heartbeatJson: null });
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

describe('screens.reportManifest', () => {
  const [m1, m2] = ['1'.repeat(64), '2'.repeat(64)];

  it('lets a report without a time replace one stored at or before its arrival, and counts it at its arrival', async () => {
    const r = await seedOrg(env.DB, 'org-report');
    await r.scope.screens.reportManifest(r.screen, m2, { observedAt: 200, arrivedAt: 300 });
    // A player before gh-44 (or an untrusted clock): ordered by arrival.
    await r.scope.screens.reportManifest(r.screen, m1, { arrivedAt: 250 });
    expect(await r.scope.screens.get(r.screen)).toMatchObject({ reportedManifestId: m1, reportedManifestAt: 250 });
    // Two at one arrival time: the later write replaces.
    await r.scope.screens.reportManifest(r.screen, m2, { arrivedAt: 250 });
    expect(await r.scope.screens.get(r.screen)).toMatchObject({ reportedManifestId: m2, reportedManifestAt: 250 });
  });

  it('does not let a report without a time land over one that arrived after it (#519)', async () => {
    const r = await seedOrg(env.DB, 'org-report-late');
    // Arrived at 100, but its write hung: one that arrived at 200 was written first.
    await r.scope.screens.reportManifest(r.screen, m2, { arrivedAt: 200 });
    await r.scope.screens.reportManifest(r.screen, m1, { arrivedAt: 100 });
    expect(await r.scope.screens.get(r.screen)).toMatchObject({ reportedManifestId: m2, reportedManifestAt: 200 });
    // The same over sync, which shares the rule: an untrusted clock's sync is ordered by arrival too.
    const untimed = (at: number, active: string) =>
      r.scope.screens.sync(r.screen, { at, active, playerVersion: '1', heartbeatJson: '{}', fallbackFrom: null, epoch: 'e', seq: 0, counts: [] });
    await untimed(150, m1);
    expect(await r.scope.screens.get(r.screen)).toMatchObject({ reportedManifestId: m2, reportedManifestAt: 200 });
    await untimed(300, m1);
    expect(await r.scope.screens.get(r.screen)).toMatchObject({ reportedManifestId: m1, reportedManifestAt: 300 });
  });
});

describe('screens.sync', () => {
  const HOUR = Date.UTC(2026, 10, 18, 9);
  const beat = (over: Partial<Parameters<ReturnType<typeof scoped>['screens']['sync']>[1]> = {}) => ({
    at: HOUR + 60_000,
    playerVersion: '1.0.0',
    heartbeatJson: '{"display":{"on":true}}',
    fallbackFrom: null as string | null,
    epoch: 'ep1',
    seq: 1,
    counts: [
      { hour: HOUR, spotId: 'menu', plays: 3, ms: 30_000 },
      { hour: HOUR, spotId: 'news', plays: 2, ms: 20_000 },
    ],
    ...over,
  });

  it('keeps when a screen first said it fell back from a manifest, while it says the same (#367)', async () => {
    const seeded = await seedOrg(env.DB, 'org-fallback-since');
    const r = seeded.scope;
    const said = (at: number, fallbackFrom: string | null) =>
      r.screens.sync(seeded.screen, beat({ at, seq: 0, counts: [], fallbackFrom, heartbeatJson: JSON.stringify({ manifest: { fallbackFrom } }) }));
    const since = async () => (await r.screens.get(seeded.screen))!.fallbackSince;
    await said(HOUR, null);
    expect(await since()).toBeNull();
    await said(HOUR + 1000, 'm7');
    expect(await since()).toBe(HOUR + 1000);
    // Said again, later: kept from the first time.
    await said(HOUR + 5000, 'm7');
    expect(await since()).toBe(HOUR + 1000);
    // Another manifest: from then.
    await said(HOUR + 9000, 'm8');
    expect(await since()).toBe(HOUR + 9000);
    await said(HOUR + 12_000, null);
    expect(await since()).toBeNull();
  });

  it('dates a fallback from before migration 0046 from the stored heartbeat, not the next one (#474)', async () => {
    const seeded = await seedOrg(env.DB, 'org-fallback-0046');
    const r = seeded.scope;
    const said = (at: number) =>
      r.screens.sync(
        seeded.screen,
        beat({ at, seq: 0, counts: [], fallbackFrom: 'm7', heartbeatJson: JSON.stringify({ at, manifest: { fallbackFrom: 'm7' } }) }),
      );
    await said(HOUR + 1000);
    // What 0046 left: the column added, null, beside a heartbeat that already fell back.
    await env.DB.prepare('UPDATE screens SET fallback_since = NULL WHERE id = ?').bind(seeded.screen).run();
    await said(HOUR + 5000);
    expect((await r.screens.get(seeded.screen))!.fallbackSince).toBe(HOUR + 1000);
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

// #628: CI registers a release through `platform(db)`, and the row's version, hash and size come from the signed text.
describe('platform(db).playerReleases.register', () => {
  it('takes the version, hash and size from the text CI signed, and keeps the text and signature as they came', async () => {
    const { manifest, signature } = await signedRelease({ version: 300, sha256: 'e'.repeat(64), size: 2048 });
    const row = await platform(env.DB).playerReleases.register(manifest, signature);
    expect(row).toMatchObject({ version: 300, sha256: 'e'.repeat(64), size: 2048, manifest, signature, channel: 'canary', promotedAt: null });
  });

  it('refuses text that is not a release manifest, and a signature not in Ed25519 form, writing nothing', async () => {
    const good = await signedRelease({ version: 301, sha256: 'f'.repeat(64) });
    const register = (manifest: string, signature = good.signature) => platform(env.DB).playerReleases.register(manifest, signature);
    await expect(register('not json')).rejects.toThrow('not a player release: the manifest text is not JSON');
    await expect(register(JSON.stringify({ ...JSON.parse(good.manifest), version: 0 }))).rejects.toThrow(/version must be a whole number from 1/);
    await expect(register(good.manifest, 'c2ln')).rejects.toThrow('the signature is not an Ed25519 signature in base64');
    await expect(register(`${good.manifest}${' '.repeat(1_048_576)}`)).rejects.toThrow('the manifest text is too long');
    expect(await platform(env.DB).playerReleases.offered('canary')).not.toMatchObject({ version: 301 });
  });
});

describe("the release workflows' SQL (#628)", () => {
  const first = async (sql: string) => (await env.DB.prepare(sql).all()).results;

  it('registers on canary exactly as register does, byte for byte, and the next release is one above it', async () => {
    // Text with a quote and characters past ASCII, in a field a later format may add: the literal must neither end early
    // nor change a byte. Only the device checks the signature, so it need not cover the extra field here.
    const signed = await signedRelease({ version: 400, sha256: '4'.repeat(64) });
    const manifest = signed.manifest.replace(/}$/, ',"note":"it\'s é ✓ \\u0000"}');
    const { signature } = signed;
    await env.DB.prepare(registerReleaseSql(manifest, signature, 1_000)).run();
    expect(await platform(env.DB).playerReleases.offered('canary')).toEqual({
      version: 400,
      sha256: '4'.repeat(64),
      size: 1024,
      manifest,
      signature,
      channel: 'canary',
      createdAt: 1_000,
      promotedAt: null,
    });
    expect(await first(NEXT_RELEASE_SQL)).toEqual([{ next: 401 }]);
  });

  it('refuses what register refuses before any SQL is written', async () => {
    const good = await signedRelease({ version: 402, sha256: '5'.repeat(64) });
    expect(() => registerReleaseSql('not json', good.signature, 1)).toThrow('not a player release: the manifest text is not JSON');
    expect(() => registerReleaseSql(good.manifest, "x'); DROP TABLE player_releases; --", 1)).toThrow('the signature is not an Ed25519');
  });

  it('promotes only a canary release, once', async () => {
    const { manifest, signature } = await signedRelease({ version: 403, sha256: '6'.repeat(64) });
    await env.DB.prepare(registerReleaseSql(manifest, signature, 1_000)).run();
    expect(await first(promoteReleaseSql(403, 2_000))).toEqual([{ version: 403 }]);
    expect(await platform(env.DB).playerReleases.offered('stable')).toMatchObject({ version: 403, channel: 'stable', promotedAt: 2_000 });
    expect(await first(promoteReleaseSql(403, 3_000))).toEqual([]);
    expect(await first(promoteReleaseSql(9_999, 3_000))).toEqual([]);
  });

  it("lists every canary with its heartbeat's release, since when, rollbacks and last sight", async () => {
    const heartbeat = { player: { release: 403 }, releaseSince: 5_000, failedReleases: [{ version: 402, reason: 'not-alive' }] };
    await o.scope.screens.update(o.screen, { playerChannel: 'canary', heartbeatJson: JSON.stringify(heartbeat), lastSeenAt: 6_000 });
    const other = await seedOrg(env.DB, 'org-device-canary');
    await other.scope.screens.update(other.screen, { playerChannel: 'canary' });
    const canaries = await first(CANARY_SCREENS_SQL);
    expect(canaries).toHaveLength(2);
    expect(canaries).toEqual(
      expect.arrayContaining([
        { id: other.screen, lastSeenAt: null, release: null, releaseSince: null, failedReleases: null },
        { id: o.screen, lastSeenAt: 6_000, release: 403, releaseSince: 5_000, failedReleases: JSON.stringify(heartbeat.failedReleases) },
      ]),
    );
    await o.scope.screens.update(o.screen, { playerChannel: 'stable', heartbeatJson: null, lastSeenAt: null });
  });
});
