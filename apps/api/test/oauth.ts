// The OAuth provider as an MCP client and a person meet it, through the API's routes: register,
// authorize with S256 PKCE, consent with an org and scopes, exchange the code. Shared by the agent
// grant tests (agent-grants.test.ts) and /mcp's (mcp.test.ts, publish-requests.test.ts).
import { agentGrantForToken } from '@signforge/db';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { mcp } from '../src/mcp';
import { Client, email, nextIp, ORIGIN, testApp } from './client';

export type App = ReturnType<typeof testApp>;
export const RESOURCE = `${ORIGIN}/mcp`;
export const REDIRECT = 'http://127.0.0.1:33418/callback';

/** A form POST as an OAuth client sends one: no cookie, no origin. */
export async function form(t: App, path: string, params: Record<string, string>, ip = nextIp()) {
  return t.app.request(
    `${ORIGIN}${path}`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip }, body: new URLSearchParams(params) },
    env,
    createExecutionContext(),
  );
}

export async function sha256Base64Url(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** The per-call check, as /mcp makes it. */
export const check = async (accessToken: string) => agentGrantForToken(env.DB, await sha256Base64Url(accessToken), RESOURCE, Date.now());

/** Registers a public client by open registration, as an MCP client does. */
/** An open registration as an MCP client sends it, with `metadata` over the defaults. */
export const registration = (t: App, metadata: Record<string, unknown> = {}) =>
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
export async function register(t: App, metadata: Record<string, unknown> = {}) {
  const res = await registration(t, metadata);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<{ client_id: string }>()).client_id;
}

export const ALL_SCOPES = 'content:read content:draft content:publish screens:manage org:manage offline_access';

/** The person, signed in as `c`, opens `clientId`'s authorize URL: the provider sends them to the consent page with its signed query. */
export async function consentPage(c: Client, clientId: string, scope = ALL_SCOPES, redirect = REDIRECT) {
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
export async function authorize(c: Client, clientId: string, consent: { organizationId?: string; scopes?: string[]; accept?: boolean }, scope = ALL_SCOPES) {
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
export async function exchange(t: App, clientId: string, code: string, verifier: string) {
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
export async function team() {
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

/** An access token for /mcp: a client registered, authorized by `c` in `organizationId` with `scopes`, and its code exchanged. */
export async function agentToken(t: App, c: Client, organizationId: string, scopes: string[]) {
  const clientId = await register(t);
  const { back, verifier } = await authorize(c, clientId, { organizationId, scopes });
  const code = back?.searchParams.get('code');
  if (!code) throw new Error('the consent gave no code');
  return { clientId, ...(await exchange(t, clientId, code, verifier)) };
}

let rpcId = 0;
/** One JSON-RPC request to /mcp with an agent's access token, as an MCP client sends it, after the work it left running has settled. */
export async function mcpRpc(token: string, method: string, params: unknown, bindings: Env = env) {
  const ctx = createExecutionContext();
  const res = await mcp.request(
    `${ORIGIN}/mcp`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    },
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json<{ result?: { isError?: boolean; structuredContent?: any } }>();
}

/** One `tools/call`'s result: a refusal is one with `isError` and its code. */
export const mcpTool = async (token: string, name: string, args: unknown = {}, bindings?: Env) =>
  (await mcpRpc(token, 'tools/call', { name, arguments: args }, bindings)).result!;
