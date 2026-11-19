// Connections (#83): an org's connected accounts, the OAuth authorizations its members started,
// and provider data sources naming a connection.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { NotInOrgError } from '../src/index';
import { seedTwoOrgs, type Seeded } from '../src/testing';

const NOW = Date.UTC(2026, 10, 18, 12);
let s: Seeded;

const pending = (stateHash: string, expiresAt = NOW + 600_000) => ({
  provider: 'fake',
  stateHash,
  verifierSealed: 'sealed-verifier',
  actorKind: 'user' as const,
  actorId: 'user-a',
  expiresAt,
});

beforeAll(async () => {
  s = await seedTwoOrgs(env.DB);
});

describe('an authorization', () => {
  it('is found by its state in its own org only, while it lasts', async () => {
    const a = s.a.scope.connections.authorizations;
    const row = await a.insert(pending('h-live'));
    await a.insert(pending('h-old', NOW - 1));
    expect(await a.byState('h-live', NOW)).toMatchObject({ id: row.id, orgId: s.a.orgId });
    expect(await a.byState('h-old', NOW)).toBeUndefined();
    expect(await s.b.scope.connections.authorizations.byState('h-live', NOW)).toBeUndefined();
  });

  it('is consumed once: a second finish of the same state fails its batch and writes nothing', async () => {
    const o = s.a.scope;
    const row = await o.connections.authorizations.insert(pending('h-once'));
    const first = o.connections.authorizations.stage.consume(row.id);
    const second = o.connections.authorizations.stage.consume(row.id);
    await o.commit(first.writes);
    const conn = o.connections.stage.insert({ provider: 'fake', account: 'x', scopesJson: '[]', status: 'active', createdBy: 'user-a' });
    await expect(o.commit([...second.writes, ...conn.writes])).rejects.toThrow();
    expect(await o.connections.get(conn.row.id)).toBeUndefined();
  });

  it('can only reconnect a connection of its own org', async () => {
    await expect(s.b.scope.connections.authorizations.insert({ ...pending('h-x'), connectionId: s.a.connection })).rejects.toThrow(NotInOrgError);
  });

  it('drops the expired ones', async () => {
    const a = s.b.scope.connections.authorizations;
    await a.insert(pending('h-b-old', NOW - 1));
    const live = await a.insert(pending('h-b-live'));
    await s.b.scope.commit(a.stage.deleteExpired(NOW).writes);
    expect(await a.byState('h-b-live', NOW)).toMatchObject({ id: live.id });
    expect((await a.list()).map((r) => r.stateHash)).toEqual(['h-b-live']);
  });
});

describe('a connection', () => {
  it('keeps a refreshed grant only over the one it was refreshed from', async () => {
    const c = s.a.scope.connections;
    const row = await c.insert({ provider: 'fake', account: 'x', scopesJson: '[]', status: 'active', credentialsSealed: 'g1', createdBy: 'user-a' });
    expect(await c.saveGrant(row.id, 'g1', { credentialsSealed: 'g2', expiresAt: NOW })).toBe(true);
    // A refresh from the old grant, finishing after another: it does not overwrite.
    expect(await c.saveGrant(row.id, 'g1', { credentialsSealed: 'g3', expiresAt: NOW })).toBe(false);
    expect(await c.markNeedsReconnect(row.id, 'g1', 'invalid_grant')).toBe(false);
    expect(await c.get(row.id)).toMatchObject({ credentialsSealed: 'g2', status: 'active' });
    expect(await c.markNeedsReconnect(row.id, 'g2', 'invalid_grant')).toBe(true);
    expect(await c.get(row.id)).toMatchObject({ status: 'needs_reconnect', lastError: 'invalid_grant' });
    // Another org cannot touch it.
    expect(await s.b.scope.connections.saveGrant(row.id, 'g2', { credentialsSealed: 'g9', expiresAt: NOW })).toBe(false);
  });

  it('is active again once a refreshed grant is saved over one a racing run marked refused', async () => {
    const c = s.a.scope.connections;
    const row = await c.insert({ provider: 'fake', account: 'x', scopesJson: '[]', status: 'active', credentialsSealed: 'r1', createdBy: 'user-a' });
    // The loser of a refresh race (its rotated-out token refused) marks it first; the winner then saves its grant.
    expect(await c.markNeedsReconnect(row.id, 'r1', 'invalid_grant')).toBe(true);
    expect(await c.saveGrant(row.id, 'r1', { credentialsSealed: 'r2', expiresAt: NOW })).toBe(true);
    expect(await c.get(row.id)).toMatchObject({ status: 'active', lastError: null, credentialsSealed: 'r2' });
  });

  it('is named by a data source of its own org only', async () => {
    const base = { name: 'Cal', format: 'provider' as const, urlEncrypted: 'sealed', refreshS: 300 };
    await expect(s.b.scope.dataSources.insert({ ...base, id: 'cal-b', connectionId: s.a.connection })).rejects.toThrow(NotInOrgError);
    await expect(s.b.scope.dataSources.stage.insert({ ...base, id: 'cal-b', connectionId: s.a.connection })).rejects.toThrow(NotInOrgError);
    const own = await s.b.scope.dataSources.insert({ ...base, id: 'cal-b', connectionId: s.b.connection });
    expect(own).toMatchObject({ connectionId: s.b.connection });
    expect((await s.b.scope.dataSources.usingConnection(s.b.connection)).map((d) => d.id)).toEqual(['cal-b']);
    expect(await s.a.scope.dataSources.usingConnection(s.b.connection)).toEqual([]);
  });
});
