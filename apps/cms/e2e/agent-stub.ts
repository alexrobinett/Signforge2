// An MCP client as the e2e plays one (M4-05, M4-06): it registers by open registration with a loopback
// callback, builds an authorize URL with S256 PKCE, exchanges its code, and calls /mcp on the CMS's host.
// Used by connect.spec.ts and agents.spec.ts, each from its own address.
import { createHash, randomBytes } from 'node:crypto';
import { expect, request as playwrightRequest, type Page } from '@playwright/test';
import { CMS_URL } from './servers';

/** The stub's loopback callback, as a native MCP client registers one. */
const CALLBACK = 'http://127.0.0.1:33418/callback';
export const RESOURCE = `${CMS_URL}/mcp`;
const ALL_SCOPES = 'content:read content:draft content:publish screens:manage org:manage offline_access';

export const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const challengeOf = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());

/** An MCP client stub: registers by open registration, and builds an authorize URL with S256 PKCE. */
export async function stubClient(name: string, address: string) {
  const request = await playwrightRequest.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': address } });
  const registered = await request.post(`${CMS_URL}/api/auth/oauth2/register`, {
    data: {
      client_name: name,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = base64url(randomBytes(32));
  const authorizeUrl = `${CMS_URL}/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: ALL_SCOPES,
    state: 'stub-state',
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    resource: RESOURCE,
  })}`;
  /** The stub's token request for a code: what it gets back. */
  const exchange = async (code: string) => {
    const res = await request.post(`${CMS_URL}/api/auth/oauth2/token`, {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: clientId, resource: RESOURCE },
    });
    return { status: res.status(), body: (await res.json()) as { scope?: string; access_token?: string } };
  };
  /** One JSON-RPC request to /mcp on this host (M4-06), with the stub's access token: its result or its error. */
  let rpcId = 0;
  const mcp = async (accessToken: string, method: string, params: unknown = {}) => {
    const res = await request.post(`${CMS_URL}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      data: { jsonrpc: '2.0', id: ++rpcId, method, params },
    });
    expect(res.status(), await res.text()).toBe(200);
    return (await res.json()) as { result?: any; error?: unknown };
  };
  /** The status a tools/list gets with `accessToken`: 401 once its grant is gone. */
  const mcpStatus = async (accessToken: string) =>
    (
      await request.post(`${CMS_URL}/mcp`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        data: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} },
      })
    ).status();
  return { clientId, authorizeUrl, exchange, mcp, mcpStatus, dispose: () => request.dispose() };
}

/** The URL the page sends the browser to at the stub's callback, answered by the stub. */
export async function callbackOf(page: Page, act: () => Promise<void>): Promise<URL> {
  let reached: URL | undefined;
  await page.route(`${CALLBACK}**`, async (route) => {
    reached = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'You can close this window.' });
  });
  await act();
  await expect.poll(() => reached?.href).toBeTruthy();
  await page.unroute(`${CALLBACK}**`);
  return reached!;
}
