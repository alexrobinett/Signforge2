// Agent grants (M4-04): the scoped repository, revocation with the provider's tokens, the per-call
// token check, and pruning clients nobody consented to. Times come from the tests, never the clock.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_GRANT_IDLE_MS,
  agentGrantForToken,
  NotInOrgError,
  pruneUnconsentedClients,
  scoped,
  StaleVersionError,
  UNCONSENTED_CLIENT_MS,
} from '../src/index';
import { seedOrganization, seedTeam } from '../src/testing';

const NOW = Date.UTC(2026, 10, 23, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const RESOURCE = 'https://cms.test/mcp';

let a: Awaited<ReturnType<typeof seedTeam>>;
let b: Awaited<ReturnType<typeof seedTeam>>;
beforeAll(async () => {
  await seedOrganization(env.DB, 'grants-a');
  await seedOrganization(env.DB, 'grants-b');
  a = await seedTeam(env.DB, 'grants-a');
  b = await seedTeam(env.DB, 'grants-b');
});

let n = 0;
/** A registered client, as the provider writes it. */
async function client(createdAt = NOW) {
  const clientId = `client-${++n}`;
  await env.DB.prepare('INSERT INTO oauthClient (id, clientId, name, redirectUris, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`oac-${n}`, clientId, 'Agent', '["http://127.0.0.1/callback"]', iso(createdAt), iso(createdAt))
    .run();
  return clientId;
}

/** A grant in `orgId`, as consent writes it. */
async function grant(orgId: string, userId: string, clientId: string) {
  const org = scoped(env.DB, orgId);
  const made = org.agentGrants.stage.insert({ userId, clientId, clientName: 'Agent', scopesJson: '["content:read"]', expiresAt: NOW + AGENT_GRANT_IDLE_MS });
  await org.commit(made.writes);
  return made.row;
}

/** The provider's token rows for a grant: an access token (its hash given), a refresh token and a consent. */
async function tokens(grantId: string, clientId: string, userId: string, hash: string, opts: { expiresAt?: number; resource?: string } = {}) {
  const at = iso(NOW);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO oauthRefreshToken (id, token, clientId, userId, referenceId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(`rt-${hash}`, `rt-hash-${hash}`, clientId, userId, grantId, iso(NOW + 30 * 86_400_000), at, '[]'),
    env.DB.prepare(
      'INSERT INTO oauthAccessToken (id, token, clientId, userId, referenceId, resources, refreshId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      `at-${hash}`,
      hash,
      clientId,
      userId,
      grantId,
      JSON.stringify([opts.resource ?? RESOURCE]),
      `rt-${hash}`,
      iso(opts.expiresAt ?? NOW + 3_600_000),
      at,
      '[]',
    ),
    env.DB.prepare('INSERT INTO oauthConsent (id, clientId, userId, referenceId, scopes, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      `cs-${hash}`,
      clientId,
      userId,
      grantId,
      '[]',
      at,
      at,
    ),
  ]);
}

const count = async (table: string, referenceId: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE referenceId = ?`).bind(referenceId).first<{ n: number }>())!.n;

describe('the scoped repository', () => {
  it("gives a grant an agt_ id, and keeps each org's grants to itself", async () => {
    const g = await grant('grants-a', a.userId, await client());
    expect(g.id).toMatch(/^agt_/);
    expect(await scoped(env.DB, 'grants-a').agentGrants.get(g.id)).toMatchObject({ orgId: 'grants-a', userId: a.userId, revokedAt: null, rowVersion: 1 });
    expect(await scoped(env.DB, 'grants-b').agentGrants.get(g.id)).toBeUndefined();
    expect((await scoped(env.DB, 'grants-b').agentGrants.list()).map((r) => r.id)).not.toContain(g.id);
  });

  it('lists a user’s unrevoked grants, expired ones included', async () => {
    const org = scoped(env.DB, 'grants-a');
    const live = await grant('grants-a', a.userId, await client());
    const revoked = await grant('grants-a', a.userId, await client());
    await org.commit(org.agentGrants.stage.revoke(revoked, a.userId, NOW).writes);
    const ids = (await org.agentGrants.unrevokedFor(a.userId)).map((g) => g.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(revoked.id);
    expect((await scoped(env.DB, 'grants-b').agentGrants.unrevokedFor(a.userId)).map((g) => g.id)).not.toContain(live.id);
  });
});

describe('connected grants', () => {
  it("lists the org's grants not revoked, each with its client's redirect URIs, one member's or one grant, and no other org's", async () => {
    const mine = await grant('grants-a', a.userId, await client());
    // Another user's grant here: the repository keeps grants by org and user, whatever the membership.
    const theirs = await grant('grants-a', b.userId, await client());
    const revoked = await grant('grants-a', a.userId, await client());
    const elsewhere = await grant('grants-b', b.userId, await client());
    const org = scoped(env.DB, 'grants-a');
    await org.commit(org.agentGrants.stage.revoke(revoked, a.userId, NOW).writes);
    const ids = async (filter?: { userId?: string; grantId?: string }) => (await org.agentGrants.connected(filter)).map((r) => r.grant.id);
    const all = await ids();
    expect(all).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(all).not.toContain(revoked.id);
    expect(all).not.toContain(elsewhere.id);
    expect(await ids({ userId: b.userId })).toEqual([theirs.id]);
    expect(await org.agentGrants.connected({ grantId: mine.id })).toEqual([
      { grant: expect.objectContaining({ id: mine.id }), redirectUrisJson: '["http://127.0.0.1/callback"]' },
    ]);
    expect(await scoped(env.DB, 'grants-b').agentGrants.connected({ grantId: mine.id })).toEqual([]);
  });
});

describe('revoking a grant', () => {
  it("marks it, and deletes the provider's tokens and consent for it, and no other grant's", async () => {
    const org = scoped(env.DB, 'grants-a');
    const clientId = await client();
    const g = await grant('grants-a', a.userId, clientId);
    const other = await grant('grants-a', a.userId, clientId);
    await tokens(g.id, clientId, a.userId, 'h-revoke');
    await tokens(other.id, clientId, a.userId, 'h-other');
    await org.commit(org.agentGrants.stage.revoke(g, a.userId, NOW).writes);
    expect(await org.agentGrants.get(g.id)).toMatchObject({ revokedAt: NOW, revokedBy: a.userId, rowVersion: 2 });
    for (const table of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) {
      expect(await count(table, g.id), table).toBe(0);
      expect(await count(table, other.id), table).toBe(1);
    }
    // Again: nothing more is staged.
    expect(org.agentGrants.stage.revoke((await org.agentGrants.get(g.id))!, a.userId, NOW + 1).writes).toEqual([]);
  });

  it("deletes the grant's authorization codes not yet exchanged, and no other verification row", async () => {
    const org = scoped(env.DB, 'grants-a');
    const clientId = await client();
    const g = await grant('grants-a', a.userId, clientId);
    const other = await grant('grants-a', a.userId, clientId);
    const code = (id: string, referenceId: string) =>
      env.DB.prepare('INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(
          id,
          `code-${id}`,
          JSON.stringify({ type: 'authorization_code', query: {}, userId: a.userId, referenceId }),
          iso(NOW + 600_000),
          iso(NOW),
          iso(NOW),
        )
        .run();
    await code('ver-revoked', g.id);
    await code('ver-other', other.id);
    // A sign-in code's row holds no JSON.
    await env.DB.prepare('INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('ver-otp', 'sign-in-otp-someone', '123456:0', iso(NOW + 600_000), iso(NOW), iso(NOW))
      .run();
    await org.commit(org.agentGrants.stage.revoke(g, a.userId, NOW).writes);
    const left = (await env.DB.prepare("SELECT id FROM verification WHERE id LIKE 'ver-%'").all<{ id: string }>()).results.map((r) => r.id).sort();
    expect(left).toEqual(['ver-other', 'ver-otp']);
  });

  it('commits only the first of two revokes made from one read', async () => {
    const g = await grant('grants-a', a.userId, await client());
    const org = scoped(env.DB, 'grants-a');
    const first = org.agentGrants.stage.revoke(g, 'first', NOW);
    const second = org.agentGrants.stage.revoke(g, 'second', NOW + 1);
    await org.commit(first.writes);
    await expect(org.commit(second.writes)).rejects.toBeInstanceOf(StaleVersionError);
    expect(await org.agentGrants.get(g.id)).toMatchObject({ revokedBy: 'first', revokedAt: NOW, rowVersion: 2 });
  });

  it("from another org's scope, deletes nothing of the grant's", async () => {
    const clientId = await client();
    const g = await grant('grants-a', a.userId, clientId);
    await tokens(g.id, clientId, a.userId, 'h-cross');
    const otherOrg = scoped(env.DB, 'grants-b');
    // B's scope never finds the row to revoke; given it anyway, its version guard finds none of B's,
    // so the batch is refused whole, its deletes with it.
    await expect(otherOrg.commit(otherOrg.agentGrants.stage.revoke(g, b.userId, NOW).writes)).rejects.toBeInstanceOf(NotInOrgError);
    expect(await scoped(env.DB, 'grants-a').agentGrants.get(g.id)).toMatchObject({ revokedAt: null });
    expect(await count('oauthAccessToken', g.id)).toBe(1);
  });
});

describe("revoking all of a member's grants as their membership ends (#328, review of #422)", () => {
  it("revokes theirs here, each with one audit row, and nothing of another member's or another org's; again, nothing more", async () => {
    const clientId = await client();
    const theirs = [await grant('grants-a', a.userId, clientId), await grant('grants-a', a.userId, clientId)];
    const someoneElse = await grant('grants-a', b.userId, clientId);
    const elsewhere = await grant('grants-b', a.userId, clientId);
    for (const [g, h] of [
      [theirs[0]!, 'h-all-0'],
      [someoneElse, 'h-all-else'],
      [elsewhere, 'h-all-elsewhere'],
    ] as const)
      await tokens(g.id, clientId, g.userId, h);
    const org = scoped(env.DB, 'grants-a');
    const end = () => org.commit(org.agentGrants.stage.revokeAllOf(a.userId, 'remover', 'cms', NOW, '{"reason":"membership_ended"}').writes);
    await end();
    for (const g of theirs) expect(await org.agentGrants.get(g.id)).toMatchObject({ revokedAt: NOW, revokedBy: 'remover', rowVersion: g.rowVersion + 1 });
    expect(await count('oauthAccessToken', theirs[0]!.id)).toBe(0);
    // Another member's grant in the org, and the member's grant in another org: untouched, tokens and all.
    expect(await org.agentGrants.get(someoneElse.id)).toMatchObject({ revokedAt: null });
    expect(await count('oauthAccessToken', someoneElse.id)).toBe(1);
    expect(await scoped(env.DB, 'grants-b').agentGrants.get(elsewhere.id)).toMatchObject({ revokedAt: null });
    expect(await count('oauthAccessToken', elsewhere.id)).toBe(1);
    const rows = async () =>
      (await org.auditLog.list({ limit: 100 })).filter((e) => e.action === 'revoke_agent_grant' && theirs.some((g) => g.id === e.targetId));
    expect(await rows()).toHaveLength(2);
    expect(await rows()).toEqual(
      expect.arrayContaining(
        theirs.map((g) => expect.objectContaining({ actorKind: 'user', actorId: 'remover', clientId: 'cms', targetKind: 'agent_grant', targetId: g.id })),
      ),
    );
    // Idempotent: none is connected now, so nothing is written.
    await end();
    expect(await rows()).toHaveLength(2);
  });
});

describe('the token check', () => {
  it("finds a live token's grant, with the member's role now and the grant's own org", async () => {
    const clientId = await client();
    const g = await grant('grants-a', a.userId, clientId);
    await tokens(g.id, clientId, a.userId, 'h-live');
    expect(await agentGrantForToken(env.DB, 'h-live', RESOURCE, NOW)).toEqual({
      grantId: g.id,
      orgId: 'grants-a',
      userId: a.userId,
      clientId,
      clientName: 'Agent',
      scopesJson: '["content:read"]',
      lastUsedAt: null,
      role: 'owner',
    });
  });

  it('finds nothing for an unknown, expired, revoked or other-resource token, or an expired or revoked grant', async () => {
    const clientId = await client();
    const g = await grant('grants-a', a.userId, clientId);
    await tokens(g.id, clientId, a.userId, 'h-expiring', { expiresAt: NOW + 1000 });
    await tokens(g.id, clientId, a.userId, 'h-elsewhere', { resource: 'https://other.test/mcp' });
    await tokens(g.id, clientId, a.userId, 'h-revoked-token');
    await env.DB.prepare("UPDATE oauthAccessToken SET revoked = ? WHERE token = 'h-revoked-token'").bind(iso(NOW)).run();
    expect(await agentGrantForToken(env.DB, 'h-unknown', RESOURCE, NOW)).toBeUndefined();
    expect(await agentGrantForToken(env.DB, 'h-expiring', RESOURCE, NOW)).toBeDefined();
    expect(await agentGrantForToken(env.DB, 'h-expiring', RESOURCE, NOW + 1000)).toBeUndefined();
    expect(await agentGrantForToken(env.DB, 'h-elsewhere', RESOURCE, NOW)).toBeUndefined();
    expect(await agentGrantForToken(env.DB, 'h-revoked-token', RESOURCE, NOW)).toBeUndefined();

    const idle = await grant('grants-a', a.userId, clientId);
    await tokens(idle.id, clientId, a.userId, 'h-idle', { expiresAt: NOW + AGENT_GRANT_IDLE_MS + 60_000 });
    expect(await agentGrantForToken(env.DB, 'h-idle', RESOURCE, NOW + AGENT_GRANT_IDLE_MS)).toBeUndefined();

    const revoked = await grant('grants-a', a.userId, clientId);
    await tokens(revoked.id, clientId, a.userId, 'h-grant-revoked');
    await env.DB.prepare('UPDATE agent_grants SET revoked_at = ? WHERE id = ?').bind(NOW, revoked.id).run();
    expect(await agentGrantForToken(env.DB, 'h-grant-revoked', RESOURCE, NOW)).toBeUndefined();
  });

  it('finds nothing once the member has left the org, and a token with no grant row is not live', async () => {
    await seedOrganization(env.DB, 'grants-c');
    const c = await seedTeam(env.DB, 'grants-c');
    const clientId = await client();
    const g = await grant('grants-c', c.userId, clientId);
    await tokens(g.id, clientId, c.userId, 'h-member');
    expect(await agentGrantForToken(env.DB, 'h-member', RESOURCE, NOW)).toBeDefined();
    // Another owner stays, as one always does (#292).
    await env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('grants-c-other', 'grants-c', ?, 'owner', ?)")
      .bind(a.userId, iso(NOW))
      .run();
    await env.DB.prepare('DELETE FROM member WHERE id = ?').bind(c.member).run();
    expect(await agentGrantForToken(env.DB, 'h-member', RESOURCE, NOW)).toBeUndefined();

    await tokens('agt_never_written', clientId, a.userId, 'h-orphan');
    expect(await agentGrantForToken(env.DB, 'h-orphan', RESOURCE, NOW)).toBeUndefined();
  });

  it('keeps a used grant 90 days from its last use, and leaves a revoked one revoked', async () => {
    const clientId = await client();
    const org = scoped(env.DB, 'grants-a');
    const g = await grant('grants-a', a.userId, clientId);
    await tokens(g.id, clientId, a.userId, 'h-touched', { expiresAt: NOW + 2 * AGENT_GRANT_IDLE_MS });
    await org.agentGrants.touch(g.id, NOW + 60 * 86_400_000);
    expect(await org.agentGrants.get(g.id)).toMatchObject({ lastUsedAt: NOW + 60 * 86_400_000, expiresAt: NOW + 60 * 86_400_000 + AGENT_GRANT_IDLE_MS });
    expect(await agentGrantForToken(env.DB, 'h-touched', RESOURCE, NOW + AGENT_GRANT_IDLE_MS + 1)).toBeDefined();

    const revoked = await grant('grants-a', a.userId, clientId);
    await org.commit(org.agentGrants.stage.revoke(revoked, a.userId, NOW).writes);
    await org.agentGrants.touch(revoked.id, NOW + 1);
    expect(await org.agentGrants.get(revoked.id)).toMatchObject({ revokedAt: NOW, lastUsedAt: null });
  });
});

describe('pruning unconsented clients', () => {
  it('deletes a client registered over a day ago that nobody consented to, and keeps the rest and sf-cli', async () => {
    const stale = await client(NOW - UNCONSENTED_CLIENT_MS - 1);
    const recent = await client(NOW - UNCONSENTED_CLIENT_MS + 60_000);
    const consented = await client(NOW - 10 * UNCONSENTED_CLIENT_MS);
    await tokens('agt_some_grant', consented, a.userId, 'h-consented');
    expect(await pruneUnconsentedClients(env.DB, NOW)).toBeGreaterThanOrEqual(1);
    const left = (await env.DB.prepare('SELECT clientId FROM oauthClient').all<{ clientId: string }>()).results.map((r) => r.clientId);
    expect(left).not.toContain(stale);
    expect(left).toContain(recent);
    expect(left).toContain(consented);
    // The first-party CLI, seeded by the migration, is never pruned, however old.
    await pruneUnconsentedClients(env.DB, NOW + 365 * UNCONSENTED_CLIENT_MS);
    expect(await env.DB.prepare("SELECT clientId FROM oauthClient WHERE clientId = 'sf-cli'").first()).toEqual({ clientId: 'sf-cli' });
  });
});
