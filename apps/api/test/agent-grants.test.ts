// Agent grants and the OAuth provider (M4-04, #109), against the real plugin through the API's routes:
// register, authorize with PKCE, consent with an org, token, refresh, revoke; the grant's org, its
// scopes capped by role and editorsPublish, a removed member's grants ending, and open registration
// kept to public clients. The per-call check is packages/db's agentGrantForToken, which /mcp uses (M4-06).
import { agentGrantForToken, scoped } from '@signforge/db';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, email, nextIp, ORIGIN, testApp } from './client';

type App = ReturnType<typeof testApp>;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';

afterEach(() => {
  vi.useRealTimers();
});

/** A form POST as an OAuth client sends one: no cookie, no origin. */
async function form(t: App, path: string, params: Record<string, string>, ip = nextIp()) {
  return t.app.request(
    `${ORIGIN}${path}`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip }, body: new URLSearchParams(params) },
    env,
    createExecutionContext(),
  );
}

async function sha256Base64Url(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
/** The per-call check, as /mcp will make it. */
const check = async (accessToken: string) => agentGrantForToken(env.DB, await sha256Base64Url(accessToken), RESOURCE, Date.now());

/** Registers a public client by open registration, as an MCP client does. */
/** An open registration as an MCP client sends it, with `metadata` over the defaults. */
const registration = (t: App, metadata: Record<string, unknown> = {}) =>
  t.app.request(
    `${ORIGIN}/api/auth/oauth2/register`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': nextIp() },
      body: JSON.stringify({
        client_name: 'Test agent',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...metadata,
      }),
    },
    env,
    createExecutionContext(),
  );

/** Registers a public client by open registration, as an MCP client does. */
async function register(t: App, metadata: Record<string, unknown> = {}) {
  const res = await registration(t, metadata);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<{ client_id: string }>()).client_id;
}

const ALL_SCOPES = 'content:read content:draft content:publish screens:manage org:manage offline_access';

/** The person, signed in as `c`, opens `clientId`'s authorize URL: the provider sends them to the consent page with its signed query. */
async function consentPage(c: Client, clientId: string, scope = ALL_SCOPES, redirect = REDIRECT) {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope,
    state: 'st',
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });
  const res = await c.get(`/api/auth/oauth2/authorize?${params}`, { accept: 'text/html' });
  const page = new URL(res.headers.get('location') ?? (await res.json<{ url: string }>()).url, ORIGIN);
  expect(page.pathname).toBe('/connect');
  return { oauthQuery: page.search.slice(1), verifier };
}

/** As `consentPage`, then the person consents with an org and scopes. Returns the code, or the error redirect. */
async function authorize(c: Client, clientId: string, consent: { organizationId?: string; scopes?: string[]; accept?: boolean }, scope = ALL_SCOPES) {
  const { oauthQuery, verifier } = await consentPage(c, clientId, scope);
  const decided = await c.post('/api/auth/agent-grants/consent', {
    oauth_query: oauthQuery,
    accept: consent.accept ?? true,
    ...(consent.organizationId ? { organizationId: consent.organizationId } : {}),
    ...(consent.scopes ? { scopes: consent.scopes } : {}),
  });
  const body = await decided.json<{ url?: string; message?: string }>();
  return { status: decided.status, back: body.url ? new URL(body.url) : undefined, message: body.message, verifier };
}

/** Exchanges a code for tokens. */
async function exchange(t: App, clientId: string, code: string, verifier: string) {
  const res = await form(t, '/api/auth/oauth2/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id: clientId,
    resource: RESOURCE,
  });
  expect(res.status).toBe(200);
  return res.json<{ access_token: string; refresh_token: string; scope: string }>();
}

/** An owner with an org, and an editor in it. */
async function team() {
  const t = testApp();
  const owner = new Client(t);
  const { user } = await owner.signIn(email('owner'));
  const org = await owner.createOrg('Grants Co');
  const addr = email('editor');
  const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: addr, role: 'editor' });
  const editor = new Client(t);
  const signedIn = await editor.signIn(addr);
  const { member } = await editor.ok<{ member: { id: string } }>('/api/auth/organization/accept-invitation', { invitationId: invite.id });
  return { t, owner, ownerId: user.id, org, editor, editorId: signedIn.user.id, editorMemberId: member.id };
}

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

  it("names an app's own scheme as where its code goes, not as a web host", async () => {
    const { t, owner } = await team();
    for (const [redirect, target] of [
      ['com.example.app:/oauth/callback', 'com.example.app:'],
      ['cursor://anysphere.cursor-retrieval/oauth/callback', 'cursor://anysphere.cursor-retrieval'],
    ] as const) {
      const clientId = await register(t, { redirect_uris: [redirect] });
      const { oauthQuery } = await consentPage(owner, clientId, ALL_SCOPES, redirect);
      const body = await (await owner.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).json<{
        client: { redirect: unknown };
      }>();
      expect(body.client.redirect, redirect).toEqual({ kind: 'app', target });
    }
  });

  it("withholds an unverified app's scheme that reads as SignForge's: the page says an app on this device", async () => {
    const { t, owner } = await team();
    for (const redirect of [
      'signforge://SignForge-CLI/callback',
      'com.signforge.cli:/callback',
      'com.example.app://SignForge/callback',
      // Scheme and host as they read together (the provider wants a path after a custom scheme's host).
      'sign://forge/cb',
      'sf://cli/cb',
      'sign://Forge-CLI/cb',
    ]) {
      const clientId = await register(t, { client_name: 'SignForge CLI', redirect_uris: [redirect] });
      const { oauthQuery } = await consentPage(owner, clientId, ALL_SCOPES, redirect);
      const body = await (await owner.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).json<{
        client: { name: string | null; redirect: unknown };
      }>();
      expect(body.client, redirect).toMatchObject({ name: null, redirect: { kind: 'app', target: null } });
    }
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

  it('refuses only a blank name, one too long for the heading, and characters that hide or reorder text', async () => {
    const t = testApp();
    for (const [name, why] of [
      ['Claude‮edoc', 'hides'],
      ['Claude⁦x⁩', 'hides'],
      ['Clau​de', 'hides'],
      ['Claude\nCode', 'hides'],
      ['Claude\u0000', 'hides'],
      ['Claude­Code', 'hides'],
      ['Claude⁠Code', 'hides'],
      ['Claude\u{E0041}Code', 'hides'],
      // The Hangul fillers are letters, but blank (the second re-check of #299).
      ['SignㅤForge', 'hides'],
      ['SignᅟForge', 'hides'],
      ['SignᅠForge', 'hides'],
      ['SignﾠForge', 'hides'],
      ['', 'blank'],
      ['   ', 'blank'],
      [' ', 'blank'],
      ['   ', 'blank'],
      ['　', 'blank'],
      ['ㅤ', 'blank'],
      ['​', 'blank'],
      ['A'.repeat(81), 'long'],
    ] as const) {
      expect(await refusalOf(t, name), JSON.stringify(name)).toBe(why);
    }
  });

  it("registers a name that reads as SignForge's, or any other the page will not show: registration is not the place", async () => {
    const t = testApp();
    for (const name of ['SignForge CLI', 'Claude Code (signforge)', '🆂🅸🅶🅽🅵🅾🆁🅶🅴', 'Ελληνικός βοηθός', 'Sign\u2800Forge', 'Bot 🤖']) {
      expect(await refusalOf(t, name), name).toBe(201);
    }
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
  /**
   * The name the consent page gets for a client registered under each of `names`: null where it gets
   * none, and shows an unverified app.
   */
  const shownAs = async (names: readonly string[]) => {
    const t = testApp();
    const shown: Record<string, string | null> = {};
    let person = new Client(t);
    for (const [i, name] of names.entries()) {
      // Another person every 20, from another address: authorize is rate-limited per address.
      if (i % 20 === 0) {
        person = new Client(t);
        await person.signIn(email('namer'));
      }
      const { oauthQuery } = await consentPage(person, await register(t, { client_name: name }));
      const body = await (await person.get(`/api/auth/agent-grants/request?${new URLSearchParams({ oauth_query: oauthQuery })}`)).json<{
        client: { name: string | null; verified: boolean };
      }>();
      expect(body.client.verified, name).toBe(false);
      shown[name] = body.client.name;
    }
    return shown;
  };
  const withheld = (names: string[]) => Object.fromEntries(names.map((name) => [name, null]));
  const kept = (names: string[]) => Object.fromEntries(names.map((name) => [name, name]));

  it('withholds every name from the reviews of #299 that reads as SignForge, so the page shows an unverified app', async () => {
    const names = [
      // The first review, and the tests written for it.
      'SignForge CLI',
      'signforge',
      'SIGNFORGE',
      'My SignForge helper',
      'TheSignForge',
      'Sign Forge',
      'S-I-G-N-F-O-R-G-E',
      'ＳｉｇｎＦｏｒｇｅ',
      'S1gnF0rge',
      'SIGNF0RGE',
      '5ignForge',
      'ѕignforge',
      'Ѕіgnfоrgе',
      'sf-cli',
      'SF CLI',
      'SF-CL1',
      'sf_cli tools',
      '(SignForge)',
      'SignForge CLI (helper)',
      // The second: accents, small capitals, Greek, Cyrillic and Cherokee letters.
      'SIGΝFORGE',
      'SIԌNFORGE',
      'SIGNϜORGE',
      'SígnForge',
      'SignForgé',
      'ꜱɪɢɴꜰᴏʀɢᴇ',
      'ᏚᎥᏀΝFᎾᏒᏀᎬ',
      '𝐒𝐢𝐠𝐧𝐅𝐨𝐫𝐠𝐞',
      'ˢⁱᵍⁿᶠᵒʳᵍᵉ',
      'ꜱғ-ᴄʟɪ',
      'ΣignForge',
      'ᏚIGNFORGE',
      'SᎥgnForge',
      'Signհorge',
      // The third: enclosed letters and regional indicators, Hangul and Han letters, CJK dashes,
      // modifier letters, digits and signs, letters with strokes, and spaced and dotted forms.
      '🆂🅸🅶🅽🅵🅾🆁🅶🅴',
      '🅢🅘🅖🅝🅕🅞🅡🅖🅔',
      '🇸🇮🇬🇳🇫🇴🇷🇬🇪',
      '🆂🅵 🅲🅻🅸',
      'SㅣGNFORGE',
      'S丨GNFORGE',
      'SIGNF口RGE',
      'SIGNFロRGE',
      'Sign一Forge',
      'SignーForge',
      'SignㅡForge',
      'SF一CLI',
      'SignʼForge',
      'SignˈForge',
      'SignˌForge',
      'SignˍForge',
      'S!gnForge',
      'SI6NFOR6E',
      'SignForg€',
      'Sign Forg£',
      'SF CL!',
      'SignFørge',
      'SIGNFØRGE',
      'SigƞForge',
      'SiǥnForǥe',
      'SignForɠe',
      'S.i.g.n Forge',
      'Sign-Forge',
      'Sign_Forge',
      'S·F CLI',
      'Sign\u2800Forge',
      // The final re-check: a label that is not after a name, or that a reserved word starts before,
      // and 9, q, () and ( read as letters.
      'SignForg(e)',
      'Sign(Forge)',
      'S(ignForge)',
      'SF (CLI)',
      'SF(CLI)',
      'SF CL(I)',
      '- (SignForge CLI)',
      '. (SignForge)',
      "' (SignForge CLI)",
      'Si9nForge',
      'SI9NFOR9E',
      'SiqnForqe',
      'SignF()rge',
      'SF (LI',
      // The fifth: a word starting after a dropped sign or at a capital, or after a lookalike letter.
      'Docs-Sign Forge',
      'My.Sign Forge',
      'A&Sign Forge',
      "It's.Sign Forge",
      'Get_SF CLI',
      'Use.SF CLI',
      'MySign Forge',
      'OpenSign Forge',
      'GetSF CLI',
      'GETSign Forge',
      '7Sign Forge',
      '1Sign Forge',
      'lSign Forge',
      '5Sign Forge',
      'qSign Forge',
      '0SF CLI',
    ];
    expect(await shownAs(names)).toEqual(withheld(names));
  });

  it('withholds a name that is not plain ASCII, international ones and a non-plain label included', async () => {
    const names = ['Café Assistant', 'Ελληνικός βοηθός', '東京 Screens', 'Bot 🤖', 'Claude Code (сервер)', 'Agent #1', 'Agent: two'];
    expect(await shownAs(names)).toEqual(withheld(names));
  });

  it("shows the major clients' names, a label after them, and names that only run into a reserved word", async () => {
    const names = [
      'Claude Code (signforge)',
      'Claude Code (SignForge)',
      'Claude Code (screens)',
      'Cursor',
      'Visual Studio Code',
      'Visual Studio Code - Insiders',
      'ChatGPT',
      'Windsurf',
      'Codex',
      'MCP Inspector',
      'Gemini CLI MCP Client',
      'Zed',
      'Goose',
      'Cline',
      'mcp-remote',
      'VS Code',
      'Design Forge',
      'DesignForge',
      'Docs FC Lite',
      'Mrs F. Clive',
      "O'Brien's helper",
      'Signs & forms',
      'W'.repeat(80),
    ];
    expect(await shownAs(names)).toEqual(kept(names));
  });
});
