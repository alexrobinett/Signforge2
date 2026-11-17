// Pairing (M3-08): a code exists before any org claims it, so it is found by code or poll token
// alone; the claim is staged in the claiming org's scope, and collecting mints the credential once.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { collectPairing, findDeviceScreen, scoped, startPairing, PAIRING_TTL_MS } from '../src/index';
import { seedOrganization } from '../src/testing';

const T0 = Date.parse('2026-11-17T10:00:00Z');
let n = 0;
/** A fresh code and poll-token hash per test, so tests do not share rows. */
const fresh = () => {
  n++;
  return { code: `T${String(n).padStart(5, '0')}`, pollTokenHash: n.toString(16).padStart(64, '0') };
};
const mint = (screenId: string) => Promise.resolve({ credential: `sfd_${screenId}.secret`, secretHash: 'c'.repeat(64) });

beforeAll(async () => {
  await seedOrganization(env.DB, 'org-pa');
  await seedOrganization(env.DB, 'org-pb');
});

/** Stage the screen and the claim, as the claim tool does, and commit them. */
async function claim(orgId: string, code: string, at = T0) {
  const org = scoped(env.DB, orgId);
  const screen = org.screens.stage.insert({ name: 'Lobby', timezone: 'UTC', orientation: 'landscape' });
  await org.commit([...screen.writes, ...org.pairing.stage.claim(code, screen.row.id, at).writes]);
  return screen.row.id;
}

describe('pairing', () => {
  it('waits until claimed, then hands over the credential once', async () => {
    const p = fresh();
    expect(await startPairing(env.DB, { ...p, now: T0 })).toBe(true);
    expect(await collectPairing(env.DB, p.pollTokenHash, T0 + 5000, mint)).toEqual({ status: 'waiting' });

    expect(await scoped(env.DB, 'org-pa').pairing.open(p.code, T0 + 6000)).toBe(true);
    const screenId = await claim('org-pa', p.code, T0 + 6000);

    expect(await collectPairing(env.DB, p.pollTokenHash, T0 + 10_000, mint)).toEqual({ status: 'paired', screenId, credential: `sfd_${screenId}.secret` });
    const screen = await findDeviceScreen(env.DB, screenId);
    expect(screen?.orgId).toBe('org-pa');
    expect(screen?.credentials.map((c) => c.secretHash)).toEqual(['c'.repeat(64)]);

    // Once only: the code is gone, and a second poll mints nothing.
    expect(await collectPairing(env.DB, p.pollTokenHash, T0 + 15_000, mint)).toEqual({ status: 'expired' });
    expect((await findDeviceScreen(env.DB, screenId))?.credentials).toHaveLength(1);
    expect(await scoped(env.DB, 'org-pb').pairing.open(p.code, T0 + 15_000)).toBe(false);
  });

  it('expires an unclaimed code after 15 minutes, for the screen and for a claim', async () => {
    const p = fresh();
    await startPairing(env.DB, { ...p, now: T0 });
    const late = T0 + PAIRING_TTL_MS;
    expect(PAIRING_TTL_MS).toBe(15 * 60_000);
    expect(await scoped(env.DB, 'org-pa').pairing.open(p.code, late)).toBe(false);
    await expect(claim('org-pa', p.code, late)).rejects.toThrow();
    expect(await collectPairing(env.DB, p.pollTokenHash, late, mint)).toEqual({ status: 'expired' });
  });

  it('lets only one org claim a code: the second claim commits nothing, its screen included', async () => {
    const p = fresh();
    await startPairing(env.DB, { ...p, now: T0 });
    const first = await claim('org-pa', p.code);
    const before = await scoped(env.DB, 'org-pb').screens.list();
    await expect(claim('org-pb', p.code)).rejects.toThrow();
    expect(await scoped(env.DB, 'org-pb').screens.list()).toEqual(before);
    expect(await collectPairing(env.DB, p.pollTokenHash, T0 + 1000, mint)).toMatchObject({ status: 'paired', screenId: first });
  });

  it('refuses a code already in use, and reuses one whose time is up', async () => {
    const p = fresh();
    expect(await startPairing(env.DB, { ...p, now: T0 })).toBe(true);
    expect(await startPairing(env.DB, { code: p.code, pollTokenHash: 'e'.repeat(64), now: T0 + 1000 })).toBe(false);
    // Expired and unclaimed: swept by the next start, so the code is free again.
    expect(await startPairing(env.DB, { code: p.code, pollTokenHash: 'f'.repeat(64), now: T0 + PAIRING_TTL_MS + 1 })).toBe(true);
    expect(await collectPairing(env.DB, p.pollTokenHash, T0 + PAIRING_TTL_MS + 2, mint)).toEqual({ status: 'expired' });
  });

  it('answers an unknown poll token as expired', async () => {
    expect(await collectPairing(env.DB, 'd'.repeat(64), T0, mint)).toEqual({ status: 'expired' });
  });
});
