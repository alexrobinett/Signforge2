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
      credentials: [{ id: o.credential, secretHash: '0'.repeat(64) }],
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
