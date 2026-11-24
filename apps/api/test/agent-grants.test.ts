// Agent grants and the OAuth provider (M4-04, #109), against the real plugin through the API's routes:
// register, authorize with PKCE, consent with an org, token, refresh, revoke; the grant's org, its
// scopes capped by role and editorsPublish, a removed member's grants ending, and open registration
// kept to public clients. The per-call check is packages/db's agentGrantForToken, which /mcp uses (M4-06).
import { scoped } from '@signforge/db';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantStore } from '../src/auth/grant-store';
import { counted } from './counting';
import { Client, email, nextIp, ORIGIN, testApp } from './client';
import {
  type App,
  agentToken,
  ALL_SCOPES,
  check,
  authorize,
  consentPage,
  exchange,
  form,
  REDIRECT,
  RESOURCE,
  register,
  registration,
  sha256Base64Url,
  team,
} from './oauth';

afterEach(() => {
  vi.useRealTimers();
});

describe('the OAuth round trip', () => {
  it('registers, authorizes with PKCE, consents with an org, exchanges, refreshes and revokes', async () => {
    const { t, owner, ownerId, org } = await team();
    const clientId = await register(t);
    const { back, verifier } = await authorize(owner, clientId, { organizationId: org.id, scopes: ['content:read', 'content:draft'] });
    expect(back!.origin + back!.pathname).toBe(REDIRECT);
    expect(back!.searchParams.get('iss')).toBe(`${ORIGIN}/api/auth`);
    const tokens = await exchange(t, clientId, back!.searchParams.get('code')!, verifier);
    expect(tokens.refresh_token).toBeTruthy();

    const live = await check(tokens.access_token);
    expect(live).toMatchObject({ orgId: org.id, userId: ownerId, clientId, clientName: 'Test agent', role: 'owner' });
    expect(JSON.parse(live!.scopesJson)).toEqual(['content:read', 'content:draft']);
    // Created with its audit row, the person as the actor.
    const [created] = (await scoped(env.DB, org.id).auditLog.list({ limit: 50 })).filter((e) => e.action === 'create_agent_grant');
    expect(created).toMatchObject({ actorKind: 'user', actorId: ownerId, clientId: 'cms', targetKind: 'agent_grant', targetId: live!.grantId });
    expect(JSON.parse(created!.detailJson!)).toEqual({ clientId, clientName: 'Test agent', scopes: ['content:read', 'content:draft'] });

    const refreshed = await form(t, '/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json<{ access_token: string }>();
    expect(await check(next.access_token)).toMatchObject({ grantId: live!.grantId });

    const revoked = await form(t, '/api/auth/oauth2/revoke', { token: next.access_token, token_type_hint: 'access_token', client_id: clientId });
    expect(revoked.status).toBe(200);
    expect(await check(next.access_token)).toBeUndefined();
  });

  it('stores tokens only as hashes', async () => {
    const { t, owner, org } = await team();
    const clientId = await register(t);
    const { back, verifier } = await authorize(owner, clientId, { organizationId: org.id, scopes: ['content:read'] });
    const tokens = await exchange(t, clientId, back!.searchParams.get('code')!, verifier);
    const stored = (
      await env.DB.prepare('SELECT token FROM oauthAccessToken UNION ALL SELECT token FROM oauthRefreshToken').all<{ token: string }>()
    ).results.map((r) => r.token);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).toContain(await sha256Base64Url(tokens.access_token));
  });

  it('Cancel returns access_denied, and writes no grant', async () => {
    const { t, owner, org } = await team();
    const clientId = await register(t);
    const { back } = await authorize(owner, clientId, { accept: false });
    expect(back!.searchParams.get('error')).toBe('access_denied');
    expect(await scoped(env.DB, org.id).agentGrants.list()).toEqual([]);
  });
});

describe("a grant's org and scopes", () => {
  it("works in the org chosen at consent only, not the session's active org", async () => {
    const { t, owner, org } = await team();
    // A second org, now the session's active one.
    const other = await owner.createOrg('Other Co');
    expect((await owner.session()).body.organization).toMatchObject({ id: other.id });
    const clientId = await register(t);
    const { back, verifier } = await authorize(owner, clientId, { organizationId: org.id, scopes: ['content:read'] });
    const tokens = await exchange(t, clientId, back!.searchParams.get('code')!, verifier);
    expect(await check(tokens.access_token)).toMatchObject({ orgId: org.id });
    expect(await scoped(env.DB, other.id).agentGrants.list()).toEqual([]);
  });

  it('is refused for an org the person is not a member of', async () => {
    const { t, editor } = await team();
    const stranger = new Client(t);
    await stranger.signIn(email('stranger'));
    const theirs = await stranger.createOrg('Not Yours');
    const clientId = await register(t);
    expect(await authorize(editor, clientId, { organizationId: theirs.id, scopes: ['content:read'] })).toMatchObject({ status: 403 });
    expect(await scoped(env.DB, theirs.id).agentGrants.list()).toEqual([]);
  });

  it("keeps an owner's content:publish, and stores an editor's without it while editors may not publish", async () => {
    const { t, owner, editor, org } = await team();
    expect((await owner.tool('update_org_settings', { editorsPublish: false })).status).toBe(200);
    const asked = ['content:read', 'content:draft', 'content:publish'];
    /** The grant's scopes, and the scope the provider's token response states: always the same. */
    const scopesOf = async (c: Client) => {
      const clientId = await register(t);
      const { back, verifier } = await authorize(c, clientId, { organizationId: org.id, scopes: asked });
      const tokens = await exchange(t, clientId, back!.searchParams.get('code')!, verifier);
      return { grant: JSON.parse((await check(tokens.access_token))!.scopesJson), token: tokens.scope.split(' ').sort() };
    };
    expect(await scopesOf(owner)).toEqual({ grant: asked, token: [...asked, 'offline_access'].sort() });
    expect(await scopesOf(editor)).toEqual({ grant: ['content:read', 'content:draft'], token: ['content:draft', 'content:read', 'offline_access'] });
  });

  it('keeps only the scopes the client asked for', async () => {
    const { t, owner, org } = await team();
    const clientId = await register(t);
    // The client asked for content:read only; a body naming more gets no more.
    const { back, verifier } = await authorize(
      owner,
      clientId,
      { organizationId: org.id, scopes: ['content:read', 'org:manage'] },
      'content:read offline_access',
    );
    const tokens = await exchange(t, clientId, back!.searchParams.get('code')!, verifier);
    expect(tokens.scope.split(' ').sort()).toEqual(['content:read', 'offline_access']);
    expect(JSON.parse((await check(tokens.access_token))!.scopesJson)).toEqual(['content:read']);
  });
});

describe('consent that grants nothing', () => {
  it('is refused with 400, writes no grant, and gives the client no code', async () => {
    const { t, owner, editor, org } = await team();
    expect((await owner.tool('update_org_settings', { editorsPublish: false })).status).toBe(200);
    const cases: [Client, string[], string][] = [
      // No scope chosen: the provider would otherwise fall back to everything the client asked for.
      [owner, [], ALL_SCOPES],
      // Only scopes the client did not ask for.
      [owner, ['org:manage'], 'content:read offline_access'],
      // Only one the role does not allow now.
      [editor, ['content:publish'], ALL_SCOPES],
    ];
    for (const [c, scopes, asked] of cases) {
      const clientId = await register(t);
      expect(await authorize(c, clientId, { organizationId: org.id, scopes }, asked), JSON.stringify(scopes)).toMatchObject({ status: 400, back: undefined });
    }
    expect(await scoped(env.DB, org.id).agentGrants.list()).toEqual([]);
  });
});

describe("the provider's own consent route", () => {
  it('is refused, and leaves no consent, code or token behind', async () => {
    const { t, owner } = await team();
    const clientId = await register(t);
    const { oauthQuery } = await consentPage(owner, clientId);
    const res = await owner.post('/api/auth/oauth2/consent', { accept: true, oauth_query: oauthQuery });
    expect(res.status).toBe(404);
    const rows = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM oauthConsent WHERE clientId = ?1) + (SELECT count(*) FROM oauthAccessToken WHERE clientId = ?1) + (SELECT count(*) FROM verification WHERE value LIKE '%authorization_code%' AND value LIKE '%' || ?1 || '%') AS n",
    )
      .bind(clientId)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});

describe("the provider's routes around the grant", () => {
  it("refuses a signed-in person's client management, so no confidential client exists, and writes nothing", async () => {
    const { owner } = await team();
    const clients = async () => (await env.DB.prepare('SELECT count(*) AS n FROM oauthClient').first<{ n: number }>())!.n;
    const before = await clients();
    const confidential = { client_name: 'Secretive', redirect_uris: ['https://evil.test/cb'], token_endpoint_auth_method: 'client_secret_post' };
    for (const [path, body] of [
      ['/api/auth/oauth2/create-client', confidential],
      ['/api/auth/oauth2/update-client', { client_id: 'sf-cli', update: { token_endpoint_auth_method: 'client_secret_post' } }],
      ['/api/auth/oauth2/client/rotate-secret', { client_id: 'sf-cli' }],
      ['/api/auth/oauth2/delete-client', { client_id: 'sf-cli' }],
    ] as const) {
      expect((await owner.post(path, body)).status, path).toBe(404);
    }
    expect(await clients()).toBe(before);
    expect(await env.DB.prepare("SELECT tokenEndpointAuthMethod FROM oauthClient WHERE clientId = 'sf-cli'").first()).toEqual({
      tokenEndpointAuthMethod: 'none',
    });
  });

  it('refuses a person widening their consent past the grant', async () => {
    const { t, owner, org } = await team();
    const clientId = await register(t);
    await authorize(owner, clientId, { organizationId: org.id, scopes: ['content:read'] });
    const consent = await env.DB.prepare('SELECT id, scopes FROM oauthConsent WHERE clientId = ?').bind(clientId).first<{ id: string; scopes: string }>();
    const res = await owner.post('/api/auth/oauth2/update-consent', { id: consent!.id, update: { scopes: ['content:read', 'content:publish', 'org:manage'] } });
    expect(res.status).toBe(404);
    expect(await env.DB.prepare('SELECT scopes FROM oauthConsent WHERE id = ?').bind(consent!.id).first()).toEqual({ scopes: consent!.scopes });
  });
});

describe('a consent the provider gives no code for', () => {
  it('revokes the grant it wrote, so no grant without tokens is left (prompt=login, signed in before the query)', async () => {
    const { t, owner, ownerId, org } = await team();
    const clientId = await register(t);
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: ALL_SCOPES,
      state: 'st',
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: 'S256',
      resource: RESOURCE,
      prompt: 'login',
    });
    const res = await owner.get(`/api/auth/oauth2/authorize?${params}`, { accept: 'text/html' });
    const signIn = new URL(res.headers.get('location') ?? (await res.json<{ url: string }>()).url, ORIGIN);
    // The provider's login page is the consent page, which sends a signed-out person through sign-in.
    expect(signIn.pathname).toBe('/connect');
    // The page is skipped and the signed query consented to with the old session.
    const decided = await owner.post('/api/auth/agent-grants/consent', {
      oauth_query: signIn.search.slice(1),
      accept: true,
      organizationId: org.id,
      scopes: ['content:read'],
    });
    const answer = new URL((await decided.json<{ url: string }>()).url, ORIGIN);
    expect(answer.searchParams.has('code')).toBe(false);
    const grants = await scoped(env.DB, org.id).agentGrants.list();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ revokedBy: ownerId, revokedAt: expect.any(Number) });
    const [audit] = (await scoped(env.DB, org.id).auditLog.list({ limit: 50 })).filter((e) => e.action === 'revoke_agent_grant');
    expect(JSON.parse(audit!.detailJson!)).toEqual({ reason: 'no_code_issued' });
  });
});

describe('consent from another site', () => {
  it('is refused with a foreign Origin or none, and writes no grant (CSRF, limitation 15)', async () => {
    const { t, owner, org } = await team();
    const clientId = await register(t);
    const { oauthQuery } = await consentPage(owner, clientId);
    const body = JSON.stringify({ oauth_query: oauthQuery, accept: true, organizationId: org.id, scopes: ['content:read'] });
    for (const origin of ['https://evil.test', undefined]) {
      const res = await t.app.request(
        `${ORIGIN}/api/auth/agent-grants/consent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: owner.cookie, 'cf-connecting-ip': owner.ip, ...(origin ? { origin } : {}) },
          body,
        },
        env,
        createExecutionContext(),
      );
      expect(res.status, String(origin)).toBe(403);
    }
    expect(await scoped(env.DB, org.id).agentGrants.list()).toEqual([]);
  });
});

describe("the consent page's request", () => {
  it("names the client, the host its code goes to, and each of the person's orgs with the scopes it may offer there", async () => {
    const { t, owner, editor, org } = await team();
    expect((await owner.tool('update_org_settings', { editorsPublish: false })).status).toBe(200);
    const own = await editor.createOrg('Editor Owns This');
    const clientId = await register(t);
    const { oauthQuery } = await consentPage(editor, clientId);
    const res = await editor.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ client: unknown; user: { email: string }; orgs: { orgId: string; name: string; role: string; scopes: string[] }[] }>();
    expect(body.client).toEqual({ id: clientId, name: 'Test agent', verified: false, redirect: { kind: 'web', host: '127.0.0.1:33418' } });
    // By name. An editor while editors may not publish: no content:publish, and no org:manage.
    expect(body.orgs).toEqual([
      { orgId: own.id, name: 'Editor Owns This', role: 'owner', scopes: ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage'] },
      { orgId: org.id, name: 'Grants Co', role: 'editor', scopes: ['content:read', 'content:draft', 'screens:manage'] },
    ]);
  });

  it("withholds an unverified app's scheme that reads as SignForge's (the lists: client-names.test.ts)", async () => {
    const { t, owner } = await team();
    const redirect = 'signforge://SignForge-CLI/callback';
    const clientId = await register(t, { client_name: 'Test agent', redirect_uris: [redirect] });
    const { oauthQuery } = await consentPage(owner, clientId, ALL_SCOPES, redirect);
    const body = await (await owner.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).json<{
      client: { name: string | null; redirect: unknown };
    }>();
    expect(body.client).toMatchObject({ name: 'Test agent', redirect: { kind: 'app', target: null } });
  });

  it('marks the first-party CLI as verified', async () => {
    const { owner } = await team();
    // sf-cli's registered loopback callback, on the port this run picked (RFC 8252).
    const { oauthQuery } = await consentPage(owner, 'sf-cli', ALL_SCOPES, 'http://127.0.0.1:40123/callback');
    const body = await (await owner.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).json<{ client: unknown }>();
    expect(body.client).toEqual({ id: 'sf-cli', name: 'SignForge CLI', verified: true, redirect: { kind: 'web', host: '127.0.0.1:40123' } });
  });

  it('offers only what the client asked for', async () => {
    const { t, owner, org } = await team();
    const clientId = await register(t);
    const { oauthQuery } = await consentPage(owner, clientId, 'content:read offline_access');
    const body = await (await owner.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).json<{
      orgs: { orgId: string; scopes: string[] }[];
    }>();
    expect(body.orgs).toEqual([expect.objectContaining({ orgId: org.id, scopes: ['content:read'] })]);
  });

  it('is refused for a query that is not signed, or signed for other parameters, and for no session', async () => {
    const { t, owner } = await team();
    const clientId = await register(t);
    const { oauthQuery } = await consentPage(owner, clientId);
    const forged = new URLSearchParams(oauthQuery);
    forged.set('redirect_uri', 'https://evil.test/cb');
    for (const q of [forged.toString(), `client_id=${clientId}&scope=content%3Aread`]) {
      expect((await owner.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: q })}`)).status, q).toBe(400);
    }
    expect((await new Client(t).get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).status).toBe(401);
  });
});

describe("a consent's audit row", () => {
  it('names the client only as a page may: a withheld name is null, with where its code goes', async () => {
    const { t, owner, org } = await team();
    for (const name of ['SI6NFOR6E', 'Claude Code (signforge)']) {
      const clientId = await register(t, { client_name: name });
      expect((await authorize(owner, clientId, { organizationId: org.id, scopes: ['content:read'] })).back?.searchParams.get('code')).toBeTruthy();
    }
    const rows = (await scoped(env.DB, org.id).auditLog.list({ limit: 100 })).filter((e) => e.action === 'create_agent_grant');
    const details = rows.map((e) => JSON.parse(e.detailJson ?? '{}'));
    expect(details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientName: null, redirect: { kind: 'web', host: '127.0.0.1:33418' } }),
        expect.objectContaining({ clientName: 'Claude Code (signforge)' }),
      ]),
    );
    expect(rows.map((e) => e.detailJson).join()).not.toContain('SI6NFOR6E');
  });
});

describe('a membership ending', () => {
  it("revokes the member's grants in that org, with their tokens, audited as the person who removed them", async () => {
    const { t, owner, ownerId, editor, editorMemberId, org } = await team();
    const clientId = await register(t);
    const { back, verifier } = await authorize(editor, clientId, { organizationId: org.id, scopes: ['content:read'] });
    const tokens = await exchange(t, clientId, back!.searchParams.get('code')!, verifier);
    const live = await check(tokens.access_token);
    expect(live).toBeDefined();

    await owner.ok('/api/auth/organization/remove-member', { memberIdOrEmail: editorMemberId });
    expect(await check(tokens.access_token)).toBeUndefined();
    expect(await scoped(env.DB, org.id).agentGrants.get(live!.grantId)).toMatchObject({ revokedBy: ownerId });
    // The refresh token went with it: the client must ask a person again.
    const refreshed = await form(t, '/api/auth/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(refreshed.status).toBe(400);
    const [audit] = (await scoped(env.DB, org.id).auditLog.list({ limit: 50 })).filter((e) => e.action === 'revoke_agent_grant');
    expect(audit).toMatchObject({ actorKind: 'user', actorId: ownerId, targetKind: 'agent_grant', targetId: live!.grantId });
  });

  it('refuses a code the member was given before the removal, once removed', async () => {
    const { t, owner, editor, editorMemberId, org } = await team();
    const clientId = await register(t);
    const { back, verifier } = await authorize(editor, clientId, { organizationId: org.id, scopes: ['content:read'] });
    await owner.ok('/api/auth/organization/remove-member', { memberIdOrEmail: editorMemberId });
    const res = await form(t, '/api/auth/oauth2/token', {
      grant_type: 'authorization_code',
      code: back!.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(res.status).toBe(400);
  });

  it('revokes them when the member leaves, too', async () => {
    const { t, editor, editorId, org } = await team();
    const clientId = await register(t);
    const { back, verifier } = await authorize(editor, clientId, { organizationId: org.id, scopes: ['content:read'] });
    const tokens = await exchange(t, clientId, back!.searchParams.get('code')!, verifier);
    const { grantId } = (await check(tokens.access_token))!;
    await editor.ok('/api/auth/organization/leave', { organizationId: org.id });
    expect(await check(tokens.access_token)).toBeUndefined();
    expect(await scoped(env.DB, org.id).agentGrants.get(grantId)).toMatchObject({ revokedBy: editorId, revokedAt: expect.any(Number) });
  });
});

describe('a membership ending while one of its grants changes (#328)', () => {
  /** Two grants of the editor's, each with a live token. */
  async function twoGrants() {
    const { t, owner, ownerId, editor, editorId, org } = await team();
    const tokens = [await agentToken(t, editor, org.id, ['content:read']), await agentToken(t, editor, org.id, ['content:read', 'content:draft'])];
    const grantIds = await Promise.all(tokens.map(async ({ access_token }) => (await check(access_token))!.grantId));
    return { owner, ownerId, editorId, org, tokens, grantIds };
  }

  it('revokes every grant though one was changed between the read and the batch, with one audit row each', async () => {
    const { ownerId, editorId, org, tokens, grantIds } = await twoGrants();
    const scope = scoped(env.DB, org.id);
    // A scope change commits first: the first batch's revoke of that grant is at its old version.
    const changed = counted(async () => {
      const grant = (await scope.agentGrants.get(grantIds[0]!))!;
      await scope.commit(scope.agentGrants.stage.update(grant, { scopesJson: JSON.stringify(['content:read', 'content:draft']) }, grant.rowVersion).writes);
    });
    await grantStore(changed.bindings.DB).revokeMember(org.id, editorId, ownerId);
    // The first batch lost to the change; the second, from a fresh read, revoked both. Measured, as the most it may take:
    // each attempt the member's connected grants, then one batch of each one's revoke (its token, refresh token, consent
    // and code deletes) and audit row. A new statement fails this on purpose: look at the budget, then raise it.
    expect(changed.result()).toEqual({ statements: 32, queries: 6, rpcs: [] });
    for (const id of grantIds) expect(await scope.agentGrants.get(id)).toMatchObject({ revokedAt: expect.any(Number), revokedBy: ownerId });
    for (const { access_token } of tokens) expect(await check(access_token)).toBeUndefined();
    const audit = (await scope.auditLog.list({ limit: 50 })).filter((e) => e.action === 'revoke_agent_grant');
    expect(audit.map((e) => e.targetId).toSorted()).toEqual([...grantIds].sort());
  });

  it('revokes them in one read and one batch when nothing changes meanwhile', async () => {
    const { ownerId, editorId, org, grantIds } = await twoGrants();
    const quiet = counted();
    await grantStore(quiet.bindings.DB).revokeMember(org.id, editorId, ownerId);
    for (const id of grantIds) expect(await scoped(env.DB, org.id).agentGrants.get(id)).toMatchObject({ revokedAt: expect.any(Number) });
    // Seven statements a grant in the one batch (the guard and revoke, four deletes, the audit row) and the read: two queries
    // however many grants. A change meanwhile costs a few queries more (above), at most three reads in all.
    expect(quiet.result()).toEqual({ statements: 15, queries: 2, rpcs: [] });
  });

  it('leaves out a grant revoked meanwhile, and revokes the rest', async () => {
    const { owner, ownerId, editorId, org, tokens, grantIds } = await twoGrants();
    const scope = scoped(env.DB, org.id);
    const revokedFirst = counted(() => owner.ok('/api/tools/revoke_agent_grant', { grantId: grantIds[0] }));
    await grantStore(revokedFirst.bindings.DB).revokeMember(org.id, editorId, ownerId);
    expect(revokedFirst.result()).toEqual({ statements: 25, queries: 6, rpcs: [] });
    expect(await scope.agentGrants.get(grantIds[1]!)).toMatchObject({ revokedAt: expect.any(Number), revokedBy: ownerId });
    for (const { access_token } of tokens) expect(await check(access_token)).toBeUndefined();
    // The one the owner revoked keeps its own row; no second.
    const audit = (await scope.auditLog.list({ limit: 50 })).filter((e) => e.action === 'revoke_agent_grant');
    expect(audit.map((e) => e.targetId).toSorted()).toEqual([...grantIds].sort());
  });
});

describe('client registration', () => {
  /** Each refusal's words, by why the name is refused. */
  const REFUSED = {
    hides: 'client_name must not contain control, format, bidirectional or invisible characters',
    blank: 'client_name must not be blank',
    long: 'client_name must be at most 80 characters',
  };
  /** What registering under `name` is refused for, or its status if it is not refused. */
  const refusalOf = async (t: App, name: string) => {
    const res = await registration(t, { client_name: name });
    if (res.status !== 400) return res.status;
    const { error, error_description: why } = (await res.json()) as { error: string; error_description: string };
    expect(error, JSON.stringify(name)).toBe('invalid_client_metadata');
    return Object.entries(REFUSED).find(([, words]) => words === why)?.[0] ?? why;
  };

  it('refuses a blank name, one too long for the heading, and characters that hide text (the lists: client-names.test.ts)', async () => {
    const t = testApp();
    for (const [name, why] of [
      ['\u00A0', 'blank'],
      ['A'.repeat(81), 'long'],
      ['Sign\u3164Forge', 'hides'],
    ] as const) {
      expect(await refusalOf(t, name), JSON.stringify(name)).toBe(why);
    }
  });

  it("registers a name that reads as SignForge's: registration is not the place", async () => {
    expect(await refusalOf(testApp(), 'SignForge CLI')).toBe(201);
  });

  it('refuses a confidential client, or one that names no method', async () => {
    const t = testApp();
    for (const method of ['client_secret_post', 'client_secret_basic', undefined]) {
      const res = await t.app.request(
        `${ORIGIN}/api/auth/oauth2/register`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
          body: JSON.stringify({
            client_name: 'Secretive',
            redirect_uris: ['https://evil.test/cb'],
            ...(method ? { token_endpoint_auth_method: method } : {}),
          }),
        },
        env,
        createExecutionContext(),
      );
      expect(res.status, String(method)).toBe(400);
    }
  });

  it('offers no client_credentials grant, and S256 PKCE only', async () => {
    const t = testApp();
    const meta = await (await t.app.request(`${ORIGIN}/api/auth/.well-known/oauth-authorization-server`, {}, env, createExecutionContext())).json<{
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
    }>();
    expect(meta.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('is rate-limited per address', async () => {
    // Better Auth's limiter counts on Date.now: a fixed clock keeps every attempt in one window.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 23, 12) });
    const t = testApp();
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await t.app.request(
        `${ORIGIN}/api/auth/oauth2/register`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
          body: JSON.stringify({ client_name: `Flood ${i}`, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
        },
        env,
        createExecutionContext(),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("the consent page's name for a client", () => {
  it('withholds a name that reads as SignForge, and shows Claude Code with its server named after it (the lists: client-names.test.ts)', async () => {
    const { t, owner } = await team();
    for (const [name, shown] of [
      ['SI6NFOR6E', null],
      ['Claude Code (signforge)', 'Claude Code (signforge)'],
    ] as const) {
      const { oauthQuery } = await consentPage(owner, await register(t, { client_name: name }));
      const body = await (await owner.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).json<{
        client: { name: string | null; verified: boolean };
      }>();
      expect(body.client, name).toMatchObject({ name: shown, verified: false });
    }
  });
});
