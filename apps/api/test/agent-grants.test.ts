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
async function register(t: App) {
  const res = await t.app.request(
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
      }),
    },
    env,
    createExecutionContext(),
  );
  expect(res.status).toBe(201);
  return (await res.json<{ client_id: string }>()).client_id;
}

const ALL_SCOPES = 'content:read content:draft content:publish screens:manage org:manage offline_access';

/** The person, signed in as `c`, authorizes `clientId` and consents with an org and scopes. Returns the code, or the error redirect. */
async function authorize(c: Client, clientId: string, consent: { organizationId?: string; scopes?: string[]; accept?: boolean }, scope = ALL_SCOPES) {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const challenge = await sha256Base64Url(verifier);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: 'st',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
  });
  const res = await c.get(`/api/auth/oauth2/authorize?${params}`, { accept: 'text/html' });
  const location = res.headers.get('location') ?? (await res.json<{ url: string }>()).url;
  const consentPage = new URL(location, ORIGIN);
  expect(consentPage.pathname).toBe('/connect');
  const decided = await c.post('/api/auth/agent-grants/consent', {
    oauth_query: consentPage.search.slice(1),
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
    const scopesOf = async (c: Client) => {
      const clientId = await register(t);
      const { back, verifier } = await authorize(c, clientId, { organizationId: org.id, scopes: asked });
      return JSON.parse((await check((await exchange(t, clientId, back!.searchParams.get('code')!, verifier)).access_token))!.scopesJson);
    };
    expect(await scopesOf(owner)).toEqual(asked);
    expect(await scopesOf(editor)).toEqual(['content:read', 'content:draft']);
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
