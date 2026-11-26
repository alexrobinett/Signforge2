// Connection tools (#83): start an OAuth authorization, finish it once with its state, list the
// org's connections, disconnect; and provider data sources reading through a connection. The
// API's OAuth is stubbed here (`Connectors`); apps/api/test/connections.test.ts runs the real one
// against a fake provider.
import { seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { dispatch, registry, type Caller, type Connectors, ToolError } from '../src';
import { fakeServices } from './services';

let o: SeededOrg;
let other: SeededOrg;
let owner: Caller;
let editor: Caller;
let viewer: Caller;
let stranger: Caller;

const revoked: string[] = [];
let refuseCode = false;

/** A broker whose authorize URL carries the state, and whose sealed grant names what it was sealed for. */
const connectors: Connectors = {
  providers: ['fake'],
  begin: async (provider, authorization, state) => ({
    authorizeUrl: `https://${provider}.test/authorize?state=${state}`,
    verifierSealed: `verifier-for:${authorization.orgId}/${authorization.stateHash}`,
  }),
  finish: async (_provider, authorization, code, connection) => {
    if (refuseCode) throw new ToolError('invalid_input', 'the provider refused the code (invalid_grant)');
    expect(authorization.verifierSealed).toBe(`verifier-for:${authorization.orgId}/${authorization.stateHash}`);
    return { credentialsSealed: `grant:${connection.orgId}/${connection.id}:${code}`, account: 'facilities@example.test', scopes: ['read'], expiresAt: 1_000 };
  },
  revoke: async (_provider, connection, credentialsSealed) => {
    revoked.push(`${connection.id}:${credentialsSealed}`);
  },
};

const callerOf = (org: SeededOrg, role: Caller['role'], userId: string): Caller => ({
  org: testScope(env.DB, org.orgId),
  role,
  actor: { kind: 'user', id: userId, clientId: 'cms' },
  blobs: env.BLOBS,
  services: { ...fakeServices, connectors, feedUrls: { seal: async (source, value) => `sealed:${source.orgId}/${source.id}:${value}` } },
});

const call = async <T = any>(name: string, input: unknown, caller = owner): Promise<T> => {
  const r = await dispatch(registry, name, input, caller);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const result = (name: string, input: unknown, caller = owner) => dispatch(registry, name, input, caller);
const stateOf = (url: string) => new URL(url).searchParams.get('state') ?? '';

/** Start and finish one authorization; returns the connection. */
async function connect(caller = owner, extra: { connectionId?: string } = {}) {
  const { authorizeUrl } = await call('start_connection', { provider: 'fake', ...extra }, caller);
  return (await call('finish_connection', { oauthState: stateOf(authorizeUrl), code: 'code-1' }, caller)).connection;
}

beforeAll(async () => {
  o = await seedOrg(env.DB, 'connect-org');
  other = await seedOrg(env.DB, 'connect-other');
  owner = callerOf(o, 'owner', 'user-owner');
  editor = callerOf(o, 'editor', 'user-editor');
  viewer = callerOf(o, 'viewer', 'user-viewer');
  stranger = callerOf(other, 'owner', 'user-owner');
});

describe('connecting an account', () => {
  it('starts with an authorize URL whose state is stored only as its hash', async () => {
    vi.setSystemTime('2026-11-20T12:00:00Z');
    onTestFinished(() => void vi.useRealTimers());
    const { authorizeUrl, expiresAt } = await call('start_connection', { provider: 'fake' });
    const state = stateOf(authorizeUrl);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(Date.parse('2026-11-20T12:10:00Z'));
    const rows = await owner.org.connections.authorizations.list();
    expect(JSON.stringify(rows)).not.toContain(state);
  });

  it('finishes once, for the member who started it, into an active connection with no credentials shown', async () => {
    const { authorizeUrl } = await call('start_connection', { provider: 'fake' }, editor);
    const oauthState = stateOf(authorizeUrl);
    // Another member, another org: no such authorization for them.
    expect(await result('finish_connection', { oauthState, code: 'c' }, owner)).toMatchObject({ ok: false, error: 'not_found' });
    expect(await result('finish_connection', { oauthState, code: 'c' }, stranger)).toMatchObject({ ok: false, error: 'not_found' });

    const { connection } = await call('finish_connection', { oauthState, code: 'the-code' }, editor);
    expect(connection).toMatchObject({
      provider: 'fake',
      account: 'facilities@example.test',
      scopes: ['read'],
      status: 'active',
      expiresAt: 1_000,
      createdBy: 'user-editor',
    });
    expect(JSON.stringify(connection)).not.toContain('grant:');
    expect(await owner.org.connections.get(connection.id)).toMatchObject({ credentialsSealed: `grant:${o.orgId}/${connection.id}:the-code` });

    // A replay of the same state.
    expect(await result('finish_connection', { oauthState, code: 'the-code' }, editor)).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('refuses an authorization that ran out', async () => {
    // Started on a test clock an hour back, so the real clock is past the expiry it was given.
    // Back, not forward: rows written on a clock ahead would read as the newest to later tests.
    vi.setSystemTime(Date.now() - 3_600_000);
    onTestFinished(() => void vi.useRealTimers());
    const { authorizeUrl, expiresAt } = await call('start_connection', { provider: 'fake' });
    vi.useRealTimers();
    expect(expiresAt).toBeLessThan(Date.now());
    expect(await result('finish_connection', { oauthState: stateOf(authorizeUrl), code: 'c' })).toMatchObject({ ok: false, error: 'not_found' });
    // The next start clears the ones that ran out.
    await call('start_connection', { provider: 'fake' });
    expect((await owner.org.connections.authorizations.list()).every((r) => r.expiresAt > Date.now())).toBe(true);
  });

  it('uses the authorization up when the provider refuses the code, creating nothing and auditing the refusal', async () => {
    const { authorizeUrl } = await call('start_connection', { provider: 'fake' });
    const oauthState = stateOf(authorizeUrl);
    const before = (await owner.org.connections.list()).length;
    refuseCode = true;
    try {
      expect(await result('finish_connection', { oauthState, code: 'bad' })).toMatchObject({ ok: false, error: 'invalid_input' });
    } finally {
      refuseCode = false;
    }
    expect((await owner.org.connections.list()).length).toBe(before);
    // Works once, refused or not.
    expect(await result('finish_connection', { oauthState, code: 'good' })).toMatchObject({ ok: false, error: 'not_found' });
    const [entry] = await owner.org.auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({ action: 'finish_connection', targetKind: null });
    expect(JSON.parse(entry?.detailJson ?? '{}')).toMatchObject({
      refused: { error: 'invalid_input' },
      input: { oauthState: '[redacted]', code: '[redacted]' },
    });
  });

  it('reconnects a connection in place, keeping its id', async () => {
    const first = await connect();
    await o.scope.connections.update(first.id, { status: 'needs_reconnect', lastError: 'invalid_grant' });
    const again = await connect(owner, { connectionId: first.id });
    expect(again).toMatchObject({ id: first.id, status: 'active', lastError: null });
    expect(await result('start_connection', { provider: 'fake', connectionId: other.connection })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('refuses an agent, which could start an authorization but never finish it', async () => {
    const agent: Caller = {
      ...owner,
      actor: { kind: 'agent', id: 'grant-1', clientId: 'some-agent' },
      agentLimiter: { take: async () => ({ ok: true }), audited: async () => undefined },
    };
    const before = (await owner.org.connections.authorizations.list()).length;
    expect(await result('start_connection', { provider: 'fake' }, agent)).toMatchObject({
      ok: false,
      error: 'forbidden',
      message: expect.stringContaining('for people only'),
    });
    expect((await owner.org.connections.authorizations.list()).length).toBe(before);
  });

  it('refuses the in-CMS agent, which acts as the member but must not choose a connection for them (#258)', async () => {
    const cmsAgent: Caller = { ...owner, actor: { ...owner.actor, clientId: 'cms-agent' } };
    const before = (await owner.org.connections.authorizations.list()).length;
    expect(await result('start_connection', { provider: 'fake' }, cmsAgent)).toMatchObject({ ok: false, error: 'forbidden' });
    expect((await owner.org.connections.authorizations.list()).length).toBe(before);
  });

  it('refuses a provider this deployment cannot connect, and viewers', async () => {
    expect(await result('start_connection', { provider: 'nope' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await result('start_connection', { provider: 'fake' }, viewer)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await result('disconnect', { connectionId: o.connection }, viewer)).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('lets viewers list the connections, without their credentials, and the providers this deployment connects', async () => {
    const { connections, providers } = await call('list_connections', {}, viewer);
    expect(providers).toEqual(['fake']);
    expect(connections.length).toBeGreaterThan(1);
    expect(JSON.stringify(connections)).not.toMatch(/grant:|sealed:/);
  });

  it('never writes a state or a code to the audit log', async () => {
    const { authorizeUrl } = await call('start_connection', { provider: 'fake' });
    await call('finish_connection', { oauthState: stateOf(authorizeUrl), code: 'secret-code-xyz' });
    const audit = JSON.stringify(await owner.org.auditLog.list({ limit: 100 }));
    expect(audit).toContain('finish_connection');
    expect(audit).not.toContain(stateOf(authorizeUrl));
    expect(audit).not.toContain('secret-code-xyz');
    expect(audit).not.toContain('grant:');
  });
});

describe('disconnecting', () => {
  it('revokes the grant and deletes a connection no source reads through', async () => {
    const c = await connect();
    const sealed = (await owner.org.connections.get(c.id))?.credentialsSealed;
    expect(await call('disconnect', { connectionId: c.id }, editor)).toEqual({ deleted: true, dataSourceIds: [] });
    expect(revoked).toContain(`${c.id}:${sealed}`);
    expect(await owner.org.connections.get(c.id)).toBeUndefined();
  });

  it('keeps a connection a source reads through, disconnected and without credentials', async () => {
    const c = await connect();
    await call('save_data_source', { id: 'rooms', name: 'Rooms', format: 'provider', connectionId: c.id, resource: 'calendar-1' });
    expect(await call('disconnect', { connectionId: c.id })).toEqual({ deleted: false, dataSourceIds: ['rooms'] });
    expect(await owner.org.connections.get(c.id)).toMatchObject({ status: 'disconnected', credentialsSealed: null });
    // Nothing left to revoke the second time; deleted once its source is.
    await call('delete', { type: 'data_source', id: 'rooms' });
    const before = revoked.length;
    expect(await call('disconnect', { connectionId: c.id })).toEqual({ deleted: true, dataSourceIds: [] });
    expect(revoked.length).toBe(before);
  });
});

describe('a provider data source', () => {
  it('names a connection of the org and a resource, sealed and never shown', async () => {
    const { dataSource } = await call('save_data_source', {
      id: 'sheet',
      name: 'Prices',
      format: 'provider',
      connectionId: o.connection,
      resource: 'sheet-abc!A1:C20',
    });
    expect(dataSource).toMatchObject({ id: 'sheet', format: 'provider', connectionId: o.connection });
    expect(JSON.stringify(dataSource)).not.toContain('sheet-abc');
    expect(await owner.org.dataSources.get('sheet')).toMatchObject({ urlEncrypted: `sealed:${o.orgId}/sheet:sheet-abc!A1:C20` });
    expect(JSON.stringify(await owner.org.auditLog.list({ limit: 100 }))).not.toContain('sheet-abc');

    const { dataSource: moved } = await call('save_data_source', { dataSourceId: 'sheet', resource: 'sheet-abc!A1:C40' });
    expect(moved).toMatchObject({ failures: 0, nextPollAt: 0 });
    expect(await owner.org.dataSources.get('sheet')).toMatchObject({ urlEncrypted: `sealed:${o.orgId}/sheet:sheet-abc!A1:C40` });
  });

  it('takes a connection and a resource, and no feed URL; a feed takes the opposite', async () => {
    const bad = [
      { id: 'x1', name: 'x', format: 'provider', connectionId: o.connection },
      { id: 'x2', name: 'x', format: 'provider', resource: 'r' },
      { id: 'x3', name: 'x', format: 'provider', connectionId: o.connection, resource: 'r', feedUrl: 'https://example.com/a' },
      { id: 'x4', name: 'x', format: 'json', feedUrl: 'https://example.com/a', connectionId: o.connection, resource: 'r' },
    ];
    for (const input of bad) expect(await result('save_data_source', input), input.id).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await result('save_data_source', { dataSourceId: o.dataSource, resource: 'r' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await result('save_data_source', { dataSourceId: 'sheet', feedUrl: 'https://example.com/a' })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it("cannot read through another org's connection", async () => {
    expect(await result('save_data_source', { name: 'x', format: 'provider', connectionId: other.connection, resource: 'r' })).toMatchObject({
      ok: false,
      error: 'not_found',
      message: expect.stringContaining(other.connection),
    });
  });
});
