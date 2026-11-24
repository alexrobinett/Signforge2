// Agent grant tools (M4-07): who sees a grant, who may change it and how far, that no agent may
// manage one, that each org's grants are its own, and that a client is named as /connect names it.
// That a revoked grant's next /mcp call is refused is apps/api/test/mcp.test.ts's.
import { AGENT_GRANT_IDLE_MS, scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, registry, type AgentLimiter, type Caller, type Role, type Scope } from '../src';
import { CMS_AGENT_CLIENT_ID } from '../src/outputs';
import { fakeServices } from './services';

const ORG = 'grant-tools';
let o: SeededOrg;
let other: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, ORG);
  other = await seedOrg(env.DB, 'grant-tools-other');
  for (const user of ['owner', 'editor', 'viewer']) {
    const at = new Date().toISOString();
    await env.DB.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
      .bind(`gt-${user}`, `Grant ${user}`, `gt-${user}@signforge.test`, at, at)
      .run();
  }
});

let n = 0;
/** A grant in `orgId` by `userId`, for a client registered as `name` with `redirect`, as consent writes it. */
async function grant(
  userId: string,
  scopes: Scope[],
  { orgId = ORG, name = 'Helper', redirect = 'http://127.0.0.1/callback', clientId = `gt-client-${++n}` } = {},
) {
  const at = new Date().toISOString();
  await env.DB.prepare('INSERT OR IGNORE INTO oauthClient (id, clientId, name, redirectUris, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(`oac-${clientId}`, clientId, name, JSON.stringify([redirect]), at, at)
    .run();
  const org = scoped(env.DB, orgId);
  const made = org.agentGrants.stage.insert({
    userId,
    clientId,
    clientName: name,
    scopesJson: JSON.stringify(scopes),
    expiresAt: Date.now() + AGENT_GRANT_IDLE_MS,
  });
  await org.commit(made.writes);
  return made.row.id;
}

const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };
/** A person in the org, through the CMS, as `gt-<role>`. */
const person = (role: Role): Caller => ({
  org: scoped(env.DB, ORG),
  role,
  actor: { kind: 'user', id: `gt-${role}`, clientId: 'cms' },
  blobs: env.BLOBS,
  services: fakeServices,
});
const call = (caller: Caller, name: string, input: unknown) => dispatch(registry, name, input, caller);
const listed = async (caller: Caller) => {
  const r = await call(caller, 'list_agent_grants', { limit: 200 });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return (r.output as { grants: { id: string }[] }).grants.map((g) => g.id);
};
const versionOf = async (grantId: string) => (await scoped(env.DB, ORG).agentGrants.get(grantId))?.rowVersion;

describe('who sees a grant', () => {
  it('an owner sees every grant in the org; an editor or a viewer their own; nobody another org’s', async () => {
    const owners = await grant('gt-owner', ['content:read']);
    const editors = await grant('gt-editor', ['content:read', 'content:draft']);
    const viewers = await grant('gt-viewer', ['content:read']);
    const elsewhere = await grant('gt-owner', ['content:read'], { orgId: other.orgId });
    expect(await listed(person('owner'))).toEqual(expect.arrayContaining([owners, editors, viewers, o.agentGrant]));
    expect(await listed(person('owner'))).not.toContain(elsewhere);
    expect(await listed(person('editor'))).toEqual([editors]);
    expect(await listed(person('viewer'))).toEqual([viewers]);
    expect(await call(person('editor'), 'get_agent_grant', { grantId: owners })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await call(person('owner'), 'get_agent_grant', { grantId: elsewhere })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await call(person('owner'), 'get_agent_grant', { grantId: editors })).toMatchObject({
      ok: true,
      output: { grant: { id: editors, scopes: ['content:read', 'content:draft'], grantedBy: 'gt-editor', lastUsedAt: null } },
    });
  });

  it('names a client as /connect does: an unverified name only when plain, else an unverified app at its host', async () => {
    const plain = await grant('gt-owner', ['content:read'], { name: 'Claude Code (signforge)', redirect: 'http://localhost:4242/cb' });
    const posing = await grant('gt-owner', ['content:read'], { name: 'SI6NFOR6E', redirect: 'https://agent.example/cb' });
    const app = await grant('gt-owner', ['content:read'], { name: 'Helper', redirect: 'signforge://SignForge-CLI/cb' });
    const cli = await grant('gt-owner', ['content:read'], { name: 'SignForge CLI', clientId: 'sf-cli' });
    const clientOf = async (grantId: string) => {
      const r = await call(person('owner'), 'get_agent_grant', { grantId });
      return r.ok ? (r.output as { grant: { client: unknown } }).grant.client : r;
    };
    expect(await clientOf(plain)).toMatchObject({ name: 'Claude Code (signforge)', verified: false, redirect: { kind: 'web', host: 'localhost:4242' } });
    expect(await clientOf(posing)).toMatchObject({ name: null, verified: false, redirect: { kind: 'web', host: 'agent.example' } });
    expect(await clientOf(app)).toMatchObject({ name: 'Helper', redirect: { kind: 'app', target: null } });
    expect(await clientOf(cli)).toMatchObject({ id: 'sf-cli', name: 'SignForge CLI', verified: true });
  });
});

describe('who changes a grant', () => {
  it('the member who granted it raises or lowers it within what they may do, content:read always on', async () => {
    const mine = await grant('gt-editor', ['content:read']);
    const editor = person('editor');
    const set = async (scopes: Scope[]) => call(editor, 'update_agent_grant_scopes', { grantId: mine, scopes, ifVersion: await versionOf(mine) });
    expect(await set(['content:read', 'content:draft', 'screens:manage'])).toMatchObject({
      ok: true,
      output: { grant: { scopes: ['content:read', 'content:draft', 'screens:manage'] } },
    });
    expect(await set(['content:read', 'org:manage'])).toMatchObject({ ok: false, error: 'forbidden', message: expect.stringContaining('org:manage') });
    expect(await set(['content:draft'])).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await set(['content:read'])).toMatchObject({ ok: true, output: { grant: { scopes: ['content:read'] } } });
    const viewers = await grant('gt-viewer', ['content:read']);
    expect(await call(person('viewer'), 'update_agent_grant_scopes', { grantId: viewers, scopes: ['content:read', 'content:draft'] })).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
  });

  it("an owner lowers another member's grant, never raises it; and nobody else touches it", async () => {
    const editors = await grant('gt-editor', ['content:read', 'content:draft']);
    const owner = person('owner');
    expect(await call(owner, 'update_agent_grant_scopes', { grantId: editors, scopes: ['content:read', 'content:draft', 'screens:manage'] })).toMatchObject({
      ok: false,
      error: 'forbidden',
      message: expect.stringContaining('screens:manage'),
    });
    expect(await call(owner, 'update_agent_grant_scopes', { grantId: editors, scopes: ['content:read'] })).toMatchObject({
      ok: true,
      output: { grant: { scopes: ['content:read'] } },
    });
    expect(await call(person('viewer'), 'update_agent_grant_scopes', { grantId: editors, scopes: ['content:read'] })).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect(await call(person('viewer'), 'revoke_agent_grant', { grantId: editors })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('refuses a change made from an old version, and audits a change as the person, with the grant as its target', async () => {
    const mine = await grant('gt-editor', ['content:read']);
    const version = await versionOf(mine);
    const editor = person('editor');
    expect(await call(editor, 'update_agent_grant_scopes', { grantId: mine, scopes: ['content:read', 'content:draft'], ifVersion: version })).toMatchObject({
      ok: true,
    });
    expect(await call(editor, 'update_agent_grant_scopes', { grantId: mine, scopes: ['content:read'], ifVersion: version })).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    const audit = (await scoped(env.DB, ORG).auditLog.list({ limit: 1000 })).filter((e) => e.targetId === mine);
    expect(audit).toEqual([
      expect.objectContaining({ actorKind: 'user', actorId: 'gt-editor', clientId: 'cms', action: 'update_agent_grant_scopes', targetKind: 'agent_grant' }),
    ]);
  });

  it('revokes: an owner any grant, a member their own; a revoked grant is no longer listed or changed', async () => {
    const editors = await grant('gt-editor', ['content:read']);
    const viewers = await grant('gt-viewer', ['content:read']);
    expect(await call(person('owner'), 'revoke_agent_grant', { grantId: editors })).toMatchObject({ ok: true, output: { revoked: editors } });
    expect(await call(person('viewer'), 'revoke_agent_grant', { grantId: viewers })).toMatchObject({ ok: true, output: { revoked: viewers } });
    expect(await scoped(env.DB, ORG).agentGrants.get(editors)).toMatchObject({ revokedBy: 'gt-owner', revokedAt: expect.any(Number) });
    expect(await listed(person('owner'))).not.toContain(editors);
    expect(await call(person('owner'), 'update_agent_grant_scopes', { grantId: editors, scopes: ['content:read'] })).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect(await call(person('owner'), 'revoke_agent_grant', { grantId: editors })).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('agents', () => {
  it('never manage grants, a grant’s or the in-CMS agent, whatever their scopes', async () => {
    const owners = await grant('gt-owner', ['content:read']);
    const viaGrant: Caller = {
      ...person('owner'),
      actor: { kind: 'agent', id: owners, clientId: 'agent-app' },
      scopes: ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage'],
      agentLimiter: unlimited,
    };
    const inCms: Caller = { ...person('owner'), actor: { kind: 'user', id: 'gt-owner', clientId: CMS_AGENT_CLIENT_ID } };
    for (const agent of [viaGrant, inCms]) {
      for (const [name, input] of [
        ['list_agent_grants', {}],
        ['get_agent_grant', { grantId: owners }],
        ['update_agent_grant_scopes', { grantId: owners, scopes: ['content:read', 'org:manage'] }],
        ['revoke_agent_grant', { grantId: owners }],
      ] as const) {
        expect(await call(agent, name, input), `${agent.actor.kind} ${name}`).toMatchObject({ ok: false, error: 'forbidden' });
      }
    }
    expect(await scoped(env.DB, ORG).agentGrants.get(owners)).toMatchObject({ revokedAt: null, scopesJson: '["content:read"]' });
  });
});
