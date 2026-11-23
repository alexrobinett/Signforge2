/**
 * The round trip, in workerd with local D1: the MCP SDK's own client (`@modelcontextprotocol/client`)
 * discovers the server from a 401, registers by DCR, authorizes with S256 PKCE, and lists and calls
 * tools. Its "browser" is a cookie jar on the CMS origin that signs in by email code and consents
 * with an org picked. Then refresh, revocation (RFC 7009), a revoked grant, and the route guards.
 */
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { beforeAll, describe, expect, it } from 'vitest';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

const CMS = env.CMS_ORIGIN;
const MCP = `${env.MCP_ORIGIN}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';
/** Every request the tests send, with the D1 statements it ran, for RESULTS.md. */
const statements: string[] = [];
const worker = async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const res = await exports.default.fetch(request);
  const url = new URL(request.url);
  statements.push(`${request.method} ${url.host}${url.pathname} → ${res.status}, ${res.headers.get('x-spike-d1-statements')} D1 statements`);
  return res;
};

/** A browser on the CMS origin: keeps its cookies, follows redirects until one leaves the CMS. */
class Browser {
  jar = new Map<string, string>();
  async fetch(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await worker(url, { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, ...v] = pair!.split('=');
      this.jar.set(k!, v.join('='));
    }
    return res;
  }
  /** GET, following redirects on the CMS origin; returns the first URL off it, or the last response. */
  async navigate(url: string): Promise<{ left: URL } | { page: Response; url: string }> {
    for (let hops = 0; hops < 10; hops++) {
      if (!url.startsWith(CMS)) return { left: new URL(url) };
      const res = await this.fetch(url);
      const location = res.headers.get('location');
      if (!location) return { page: res, url };
      url = new URL(location, url).href;
    }
    throw new Error('too many redirects');
  }
  async json(path: string, body: unknown) {
    return this.fetch(`${CMS}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: CMS }, body: JSON.stringify(body) });
  }
  async signIn(email: string, oauthQuery?: string) {
    await this.json('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
    const { otp } = await (await worker(`${CMS}/dev/otp?email=${encodeURIComponent(email)}`)).json<{ otp: string }>();
    const res = await this.json('/api/auth/sign-in/email-otp', { email, otp, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    expect(res.status).toBe(200);
    return res.json<{ url?: string; redirect?: boolean }>();
  }
}

/** The client's side: what an MCP client keeps between runs, in memory. */
class MemoryProvider implements OAuthClientProvider {
  client?: Parameters<OAuthClientProvider['saveClientInformation'] & {}>[0];
  saved?: Parameters<OAuthClientProvider['saveTokens']>[0];
  verifier = '';
  authorizationUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata() {
    return {
      client_name: 'Spike test client',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(info: NonNullable<MemoryProvider['client']>) {
    this.client = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: NonNullable<MemoryProvider['saved']>) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const transportFor = (provider: OAuthClientProvider) => new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: worker });

/** Consent on the page the authorize URL leads to: pick the org by name, keep the given scopes. */
async function consent(browser: Browser, page: Response, pageUrl: string, orgName: string, scopes: string[], accept = true) {
  const text = await page.text();
  const oauthQuery = /name="oauth_query" value="([^"]*)"/.exec(text)![1]!.replace(/&#38;/g, '&');
  const org = new RegExp(`value="([^"]+)" required> ${orgName} `).exec(text)?.[1];
  const form = new URLSearchParams({ oauth_query: oauthQuery, accept: String(accept) });
  if (accept) {
    form.set('org', org!);
    for (const s of scopes) form.append('scope', s);
  }
  const res = await browser.fetch(pageUrl.split('?')[0]!, { method: 'POST', body: form, headers: { origin: CMS } });
  return new URL(res.headers.get('location')!);
}

const OWNER = 'owner@spike.test';
let orgA = '';
let orgB = '';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // The person owns Northside Market, and is an editor of Hearth Café.
  const b = new Browser();
  await b.signIn(OWNER);
  orgA = (await (await b.json('/api/auth/organization/create', { name: 'Northside Market', slug: 'northside' })).json<{ id: string }>()).id;
  orgB = (await (await b.json('/api/auth/organization/create', { name: 'Hearth Café', slug: 'hearth' })).json<{ id: string }>()).id;
  await env.DB.prepare("UPDATE member SET role = 'editor' WHERE organizationId = ?").bind(orgB).run();
});

describe('discovery', () => {
  it('answers an unauthenticated /mcp with 401 and the resource metadata', async () => {
    const res = await worker(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${env.MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const prm = await (await worker(`${env.MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json<{
      resource: string;
      authorization_servers: string[];
    }>();
    expect(prm).toMatchObject({ resource: MCP, authorization_servers: [`${CMS}/api/auth`] });
  });

  it('serves authorization server metadata on the CMS origin, at the RFC 8414 path for an issuer with a path', async () => {
    const res = await worker(`${CMS}/.well-known/oauth-authorization-server/api/auth`);
    const meta = await res.json<Record<string, unknown>>();
    console.log('D1 statements: authorization server metadata', res.headers.get('x-spike-d1-statements'));
    console.log('authorization server metadata', JSON.stringify(meta, null, 1));
    expect(meta).toMatchObject({
      issuer: `${CMS}/api/auth`,
      registration_endpoint: `${CMS}/api/auth/oauth2/register`,
      code_challenge_methods_supported: ['S256'],
    });
  });
});

describe('the MCP SDK client, end to end', () => {
  const provider = new MemoryProvider();
  const browser = new Browser();

  it('registers, signs in, consents with an org picked, lists and calls tools, refreshes, revokes, then 401', async () => {
    await expect(new Client({ name: 'spike-test', version: '0' }).connect(transportFor(provider))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.client?.client_id).toBeTruthy();
    const authorize = provider.authorizationUrl!;
    console.log('authorize URL', authorize.href);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('resource')).toBe(MCP);

    // Signed out: the plugin sends the browser to /sign-in with its signed query.
    const first = await browser.navigate(authorize.href);
    expect('url' in first && first.url).toContain(`${CMS}/sign-in?`);
    const signedQuery = new URL((first as { url: string }).url).search.slice(1);
    // Signing in with that query continues the authorization, to the consent page.
    const signedIn = await browser.signIn(OWNER, signedQuery);
    expect(signedIn.url).toContain('/consent?');
    const page = await browser.navigate(new URL(signedIn.url!, CMS).href);
    if (!('page' in page)) throw new Error('expected the consent page');
    const back = await consent(browser, page.page, page.url, 'Hearth Café', ['content:read', 'content:draft', 'content:publish']);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    const code = back.searchParams.get('code')!;
    const iss = back.searchParams.get('iss')!;
    expect(iss).toBe(`${CMS}/api/auth`);

    // The code for tokens, then tools/list and tools/call.
    const transport = transportFor(provider);
    await transport.finishAuth(code, iss);
    expect(provider.saved?.refresh_token).toBeTruthy();
    const client = new Client({ name: 'spike-test', version: '0' });
    await client.connect(transport);
    console.log('negotiated protocol version', client.getNegotiatedProtocolVersion());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['whoami', 'draft_note']);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.structuredContent).toMatchObject({ org: { id: orgB, name: 'Hearth Café' }, role: 'editor', clientId: provider.client!.client_id });
    // Asked for publish; an editor's role allows it in the spike's role map, so it is kept.
    expect((result.structuredContent as { scopes: string[] }).scopes).toEqual(['content:read', 'content:draft', 'content:publish']);
    await client.close();

    console.log(`requests of the first connection:\n${statements.join('\n')}`);

    // Tokens are stored only as hashes.
    const { access_token, refresh_token } = provider.saved!;
    const tokenRows = await env.DB.prepare('SELECT token FROM oauthAccessToken UNION ALL SELECT token FROM oauthRefreshToken').all<{ token: string }>();
    const stored = tokenRows.results.map((r) => r.token);
    expect(stored).not.toContain(access_token);
    expect(stored.some((t) => refresh_token!.includes(t))).toBe(false);
    const row = await env.DB.prepare('SELECT * FROM oauthAccessToken LIMIT 1').first();
    console.log('an access token row', JSON.stringify(row));

    // Refresh rotates the refresh token, and refuses the old one.
    const old = provider.saved!;
    const refresh = (token: string) =>
      worker(`${CMS}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: provider.client!.client_id, resource: MCP }),
      });
    const res = await refresh(old.refresh_token!);
    console.log('D1 statements: refresh', res.headers.get('x-spike-d1-statements'));
    const next = await res.json<{ access_token: string; refresh_token: string; scope: string }>();
    expect(res.status).toBe(200);
    expect(next.refresh_token).not.toBe(old.refresh_token);
    console.log('refreshed scope', next.scope);
    // Both work: the old access token lives until it expires (an hour), the new one from now.
    expect((await mcpCall(old.access_token, 'whoami')).status).toBe(200);
    const call = await mcpCall(next.access_token, 'whoami');
    expect(call.status).toBe(200);
    console.log('D1 statements: tools/call', call.headers.get('x-spike-d1-statements'));
    // Refresh again, so the revocation below has a live pair to revoke.
    const third = await (await refresh(next.refresh_token)).json<{ access_token: string; refresh_token: string }>();
    expect((await mcpCall(third.access_token, 'whoami')).status).toBe(200);

    // Revoking the access token (RFC 7009): the next call gets 401.
    const revoked = await worker(`${CMS}/api/auth/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: third.access_token, token_type_hint: 'access_token', client_id: provider.client!.client_id }),
    });
    expect(revoked.status).toBe(200);
    const after = await mcpCall(third.access_token, 'whoami');
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toContain('error="invalid_token"');
    // Its refresh token still refreshes: revoking an access token leaves the grant.
    const fourth = await refresh(third.refresh_token);
    console.log('refresh after the access token was revoked', fourth.status);
    const live = await fourth.json<{ access_token: string; refresh_token: string }>();

    // Replaying a rotated refresh token is refused, and revokes the whole family: the live pair too.
    const reuse = await refresh(next.refresh_token);
    console.log('replaying a rotated refresh token', reuse.status, await reuse.text());
    expect(reuse.status).toBe(400);
    expect((await mcpCall(live.access_token, 'whoami')).status).toBe(401);
    expect((await refresh(live.refresh_token)).status).toBe(400);
    const left = await env.DB.prepare('SELECT (SELECT count(*) FROM oauthAccessToken) + (SELECT count(*) FROM oauthRefreshToken) AS n').first<{ n: number }>();
    console.log('token rows left after the replay', left?.n);

    // Revoking a refresh token (RFC 7009) ends the grant's tokens too.
    const again = await connectAgain(browser, provider, 'Hearth Café', ['content:read']);
    const revokedRefresh = await worker(`${CMS}/api/auth/oauth2/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: again.tokens.refresh_token!, token_type_hint: 'refresh_token', client_id: provider.client!.client_id }),
    });
    expect(revokedRefresh.status).toBe(200);
    console.log('access token after its refresh token was revoked', (await mcpCall(again.tokens.access_token, 'whoami')).status);
    expect((await refresh(again.tokens.refresh_token!)).status).toBe(400);
  });

  it('a revoked grant stops its tokens at the next call', async () => {
    const { tokens, grantId } = await connectAgain(browser, provider, 'Northside Market', ['content:read']);
    expect((await mcpCall(tokens.access_token, 'whoami')).status).toBe(200);
    await worker(`${CMS}/dev/grants/revoke`, { method: 'POST', body: JSON.stringify({ grantId }) });
    expect((await mcpCall(tokens.access_token, 'whoami')).status).toBe(401);
  });

  it('a grant in one org reaches only that org, and lists only its scopes', async () => {
    const { tokens } = await connectAgain(browser, provider, 'Northside Market', ['content:read']);
    const res = await mcpCall(tokens.access_token, 'whoami');
    const body = await res.json<{ result: { structuredContent: { org: { id: string }; scopes: string[] } } }>();
    expect(body.result.structuredContent).toMatchObject({ org: { id: orgA }, scopes: ['content:read'] });
    const list = await mcpRpc(tokens.access_token, 'tools/list', {});
    expect((await list.json<{ result: { tools: { name: string }[] } }>()).result.tools.map((t: { name: string }) => t.name)).toEqual(['whoami']);
  });

  it('a removed member loses the grant at the next call', async () => {
    const { tokens } = await connectAgain(browser, provider, 'Hearth Café', ['content:read']);
    expect((await mcpCall(tokens.access_token, 'whoami')).status).toBe(200);
    const member = await env.DB.prepare('SELECT * FROM member WHERE organizationId = ?').bind(orgB).first<Record<string, unknown>>();
    await env.DB.prepare('DELETE FROM member WHERE organizationId = ?').bind(orgB).run();
    expect((await mcpCall(tokens.access_token, 'whoami')).status).toBe(401);
    await env.DB.prepare('INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)')
      .bind(member!.id, member!.organizationId, member!.userId, member!.role, member!.createdAt)
      .run();
  });

  it('Cancel on the consent page returns access_denied', async () => {
    const page = await authorizePage(browser, provider);
    const back = await consent(browser, page.page, page.url, '', [], false);
    expect(back.searchParams.get('error')).toBe('access_denied');
  });

  it('signing out of the CMS: do the agent tokens keep working?', async () => {
    const { tokens } = await connectAgain(browser, provider, 'Northside Market', ['content:read']);
    await browser.json('/api/auth/sign-out', {});
    const res = await mcpCall(tokens.access_token, 'whoami');
    console.log('after the person signs out, the agent call gets', res.status);
    const refreshed = await worker(`${CMS}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: provider.client!.client_id, resource: MCP }),
    });
    console.log('and its refresh gets', refreshed.status, refreshed.status === 200 ? '' : await refreshed.text());
  });
});

describe('guards on /mcp', () => {
  it('refuses a session cookie, even with a token', async () => {
    const res = await worker(MCP, { method: 'POST', headers: { cookie: 'better-auth.session_token=x', authorization: 'Bearer x' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session_not_accepted' });
  });

  it('refuses a request with an Origin header', async () => {
    const res = await worker(MCP, { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer x' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('refuses an authorization for another resource', async () => {
    const browser = new Browser();
    await browser.signIn(OWNER);
    const provider = new MemoryProvider();
    await expect(new Client({ name: 't', version: '0' }).connect(transportFor(provider))).rejects.toBeInstanceOf(UnauthorizedError);
    const url = new URL(provider.authorizationUrl!);
    url.searchParams.set('resource', 'https://other.example/mcp');
    const res = await browser.fetch(url.href);
    console.log('authorize for another resource', res.status, res.headers.get('location'));
    expect(res.headers.get('location') ?? '').toMatch(/error=invalid_target|error=invalid_request/);
  });
});

describe('registration', () => {
  it('lets anyone register a confidential client too, and returns its secret', async () => {
    const res = await worker(`${CMS}/api/auth/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'SignForge', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'client_secret_post' }),
    });
    const body = await res.json<Record<string, unknown>>();
    console.log('confidential DCR', res.status, JSON.stringify({ ...body, client_secret: body.client_secret ? '[present]' : undefined }));
  });
});

/** One JSON-RPC call; the legacy (2025) leg answers as one SSE event, read back as a JSON response. */
async function mcpRpc(token: string, method: string, params: unknown) {
  const res = await worker(MCP, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return res;
  const data = /^data: (.*)$/m.exec(await res.text())![1]!;
  return new Response(data, { status: res.status, headers: { 'content-type': 'application/json' } });
}
const mcpCall = (token: string, name: string) => mcpRpc(token, 'tools/call', { name, arguments: {} });

async function authorizePage(browser: Browser, provider: MemoryProvider) {
  provider.saved = undefined;
  await expect(new Client({ name: 't', version: '0' }).connect(transportFor(provider))).rejects.toBeInstanceOf(UnauthorizedError);
  const page = await browser.navigate(provider.authorizationUrl!.href);
  if (!('page' in page)) throw new Error(`expected the consent page, left for ${page.left}`);
  return page;
}

/** A second authorization by the same client, consenting to another org (or the same): a new grant. */
async function connectAgain(browser: Browser, provider: MemoryProvider, orgName: string, scopes: string[]) {
  if (!browser.jar.size || !(await (await browser.fetch(`${CMS}/api/auth/get-session`)).json())) await browser.signIn(OWNER);
  const page = await authorizePage(browser, provider);
  const back = await consent(browser, page.page, page.url, orgName, scopes);
  const transport = transportFor(provider);
  await transport.finishAuth(back.searchParams.get('code')!, back.searchParams.get('iss')!);
  const grant = await env.DB.prepare('SELECT id FROM spike_grants ORDER BY created_at DESC LIMIT 1').first<{ id: string }>();
  return { tokens: provider.saved!, grantId: grant!.id };
}
