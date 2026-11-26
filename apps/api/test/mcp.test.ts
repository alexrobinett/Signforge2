// `/mcp` (M4-06, #111) through its routes, with tokens from the real provider (./oauth.ts): the
// transport and its refusals, the token, grant and membership checked on every call, the grant's
// tools only, calls through the dispatcher as the agent, the grant's limit with tools/list counted,
// and an org reached only through the grant. The tool listing's every row is tested as a pure
// function in mcp-tools.test.ts.
import { scoped } from '@signforge/db';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcp } from '../src/mcp';
import { Client, clockLimits, ORIGIN } from './client';
import { measure } from './counting';
import { agentToken, check, team } from './oauth';

afterEach(() => {
  vi.useRealTimers();
});

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1' } };

/** One POST to /mcp as an MCP client sends it, after its own work has settled. */
async function post(token: string | undefined, body: unknown, { bindings = env, headers = {} }: { bindings?: Env; headers?: Record<string, string> } = {}) {
  const ctx = createExecutionContext();
  const res = await mcp.request(
    `${ORIGIN}/mcp`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': INIT.protocolVersion,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    },
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

let rpcId = 0;
/** A JSON-RPC request's answer: its result, or its error. */
async function rpc<T = any>(token: string, method: string, params: unknown = {}, bindings?: Env) {
  const res = await post(token, { jsonrpc: '2.0', id: ++rpcId, method, params }, { bindings });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json<{ result?: T; error?: { code: number; message: string; data?: any } }>();
}

const call = async (token: string, name: string, args: unknown = {}, bindings?: Env) =>
  (await rpc<{ isError?: boolean; structuredContent?: any }>(token, 'tools/call', { name, arguments: args }, bindings)).result;
const toolNames = async (token: string) => ((await rpc<{ tools: { name: string }[] }>(token, 'tools/list')).result?.tools ?? []).map((t) => t.name);

describe('the transport', () => {
  it('initializes with the instructions, and answers ping', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const init = await rpc<{ serverInfo: { name: string }; capabilities: object; instructions: string }>(access_token, 'initialize', INIT);
    expect(init.result).toMatchObject({ serverInfo: { name: 'signforge' }, capabilities: { tools: {} } });
    for (const words of ['drafts', 'ifVersion', 'idempotencyKey', '120 calls a minute', 'rate_limited']) expect(init.result?.instructions).toContain(words);
    expect((await rpc(access_token, 'ping')).result).toEqual({});
  });

  it('answers GET and DELETE with 405 before reading a token', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await mcp.request(`${ORIGIN}/mcp`, { method }, env, createExecutionContext());
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('refuses a body over its cap', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const res = await post(access_token, { jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(300 * 1024) } });
    expect(res.status).toBe(413);
    // A JSON-RPC error, as the batch refusal is, so a client that reads only those can read it (#323).
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32_000, message: expect.stringContaining('262144 bytes') } });
  });

  // The 2026-07-28 era: each request carries its version in its own envelope (_meta).
  const MODERN = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'mcp-test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  it("serves the 2026 era from one handler, each request its own grant's tools, without a warning a call (#323)", async () => {
    const { t, owner, org } = await team();
    const reader = (await agentToken(t, owner, org.id, ['content:read'])).access_token;
    const drafter = (await agentToken(t, owner, org.id, ['content:read', 'content:draft'])).access_token;
    const warn = vi.spyOn(console, 'warn');
    const listed = async (token: string) => {
      const res = await post(
        token,
        { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: { _meta: MODERN } },
        { headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' } },
      );
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json<{ result: { tools: { name: string }[] } }>()).result.tools ?? []).map((x) => x.name);
    };
    const [read, drafted] = await Promise.all([listed(reader), listed(drafter)]);
    expect(read).toContain('read');
    expect(read).not.toContain('save_spot');
    expect(drafted).toContain('save_spot');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('responseMode');
    warn.mockRestore();
  });
});

describe('failures and batches', () => {
  it('answers an unexpected failure as a bare internal error, for tools/list and tools/call, and logs it here', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const secret = 'sk-live-123 D1_ERROR: select * from secrets';
    const failing: Env = {
      ...env,
      AGENT_CALL_LIMIT: {
        limit: async () => {
          throw new Error(secret);
        },
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [method, params] of [
      ['tools/list', {}],
      ['tools/call', { name: 'list_screens', arguments: {} }],
    ] as const) {
      const res = await post(access_token, { jsonrpc: '2.0', id: 1, method, params }, { bindings: failing });
      const text = await res.text();
      expect(text, method).not.toContain('sk-live');
      expect(text, method).not.toContain('D1_ERROR');
      expect(JSON.parse(text).error, method).toEqual({ code: -32603, message: 'Internal error' });
    }
    expect(logged).toHaveBeenCalledTimes(2);
    expect(String(logged.mock.calls[0]?.[1])).toContain(secret);
    logged.mockRestore();
  });

  it('refuses a batch with 400 before any of it runs', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft']);
    const create = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'save_playlist', arguments: { name: `Batched ${id}` } } });
    const res = await post(access_token, [create(1), create(2)]);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    expect((await scoped(env.DB, org.id).playlists.list()).filter((p) => p.name.startsWith('Batched'))).toEqual([]);
  });
});

describe('who may call', () => {
  it('without a token: 401 naming where to get one, with the metadata at both addresses', async () => {
    const res = await post(undefined, { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="content:read content:draft content:publish screens:manage org:manage offline_access"`,
    );
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const meta = await (await mcp.request(`${ORIGIN}${path}`, {}, env, createExecutionContext())).json();
      expect(meta, path).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [`${ORIGIN}/api/auth`], bearer_methods_supported: ['header'] });
    }
    const issuer = await (await mcp.request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`, {}, env, createExecutionContext())).json();
    expect(issuer).toMatchObject({ issuer: `${ORIGIN}/api/auth`, code_challenge_methods_supported: ['S256'] });
  });

  it('refuses a token that is not live as invalid_token', async () => {
    const res = await post('not-a-token', { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer error="invalid_token", resource_metadata=/);
  });

  it('refuses a session cookie, and any Origin; and /api refuses the agent token', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const withCookie = await post(access_token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { cookie: owner.cookie } });
    expect(withCookie.status).toBe(401);
    expect(await withCookie.json()).toEqual({ error: 'session_not_accepted' });
    const withOrigin = await post(access_token, { jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { origin: 'https://evil.test' } });
    expect(withOrigin.status).toBe(403);
    const agentOnApi = await new Client(t).get('/api/tools', { authorization: `Bearer ${access_token}` });
    expect(agentOnApi.status).toBe(401);
  });

  it('gives a revoked grant 401 on its next call', async () => {
    const { t, owner, ownerId, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    expect(await toolNames(access_token)).toContain('read');
    const { grantId } = (await check(access_token))!;
    const scope = scoped(env.DB, org.id);
    await scope.commit(scope.agentGrants.stage.revoke((await scope.agentGrants.get(grantId))!, ownerId, Date.now()).writes);
    const res = await post(access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('gives a grant revoked in the CMS 401 on its very next call, and a scope change applies on the next call', async () => {
    const { t, owner, org, editor } = await team();
    const { access_token } = await agentToken(t, editor, org.id, ['content:read', 'content:draft', 'screens:manage']);
    const { grantId } = (await check(access_token))!;
    expect(await toolNames(access_token)).toContain('update_screen');
    // The member turns screens:manage off: the next call has it no more.
    const { grant } = await editor.ok<{ grant: { version: number } }>('/api/tools/get_agent_grant', { grantId });
    await editor.ok('/api/tools/update_agent_grant_scopes', { grantId, scopes: ['content:read', 'content:draft'], ifVersion: grant.version });
    expect(await toolNames(access_token)).not.toContain('update_screen');
    expect(await call(access_token, 'update_screen', { screenId: 'scr_any', name: 'x' })).toMatchObject({
      isError: true,
      structuredContent: { error: 'forbidden' },
    });
    // An owner disconnects it: the very next call is refused.
    await owner.ok('/api/tools/revoke_agent_grant', { grantId });
    const res = await post(access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it("takes a downgraded member's publish away on the grant's next call", async () => {
    const { t, owner, org, editor, editorMemberId } = await team();
    const { access_token } = await agentToken(t, editor, org.id, ['content:read', 'content:draft', 'content:publish']);
    expect(await toolNames(access_token)).toContain('publish');
    await owner.ok('/api/auth/organization/update-member-role', { memberId: editorMemberId, role: 'viewer', organizationId: org.id });
    const names = await toolNames(access_token);
    expect(names).not.toContain('publish');
    expect(names).not.toContain('save_playlist');
    expect(names).toContain('read');
    expect(await call(access_token, 'publish', {})).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
  });
});

describe('tools', () => {
  it("lists only the grant's tools, without the member tools that need a session, with hints", async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft', 'org:manage']);
    const { tools } = (await rpc<{ tools: { name: string; annotations: object }[] }>(access_token, 'tools/list')).result!;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['read', 'describe', 'save_playlist', 'delete']));
    expect(names).not.toContain('list_playlists');
    expect(names).not.toContain('publish');
    expect(names).not.toContain('invite_member');
    expect(names).toContain('cancel_invitation');
    expect(tools.find((tool) => tool.name === 'save_playlist')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(tools.find((tool) => tool.name === 'delete')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    // Its link stops working for good: only a person invites again (review of #414).
    expect(tools.find((tool) => tool.name === 'cancel_invitation')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });

  it("lists each type's own read as read (#345), and still answers it called by name, with the same rows", async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft']);
    await call(access_token, 'save_playlist', { name: 'Lobby', idempotencyKey: 'read-same-1' });
    expect(await toolNames(access_token)).not.toContain('list_playlists');
    const old = await call(access_token, 'list_playlists');
    const read = await call(access_token, 'read', { type: 'playlist', detail: 'full' });
    expect(old?.isError).toBeUndefined();
    expect(read?.structuredContent.items).toEqual(old?.structuredContent.playlists);
  });

  it('refuses an id or a version the listing no longer spells out (#345): the call checks the input, as invalid_input', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'screens:manage']);
    const listed = (await rpc<{ tools: { name: string; inputSchema: object }[] }>(access_token, 'tools/list')).result!.tools;
    const schema = JSON.stringify(listed.find((tool) => tool.name === 'update_screen')?.inputSchema);
    expect(schema).not.toContain('pattern');
    expect(schema).not.toContain(String(Number.MAX_SAFE_INTEGER));
    for (const input of [
      { screenId: 'not an id!', name: 'Lobby' },
      { screenId: 'scr_1', name: 'Lobby', ifVersion: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      const refused = await call(access_token, 'update_screen', input);
      expect(refused?.isError, JSON.stringify(input)).toBe(true);
      expect(refused?.structuredContent, JSON.stringify(input)).toMatchObject({ error: 'invalid_input' });
    }
  });

  it('runs a read and a write through the dispatcher, audited as the agent with its client', async () => {
    const { t, owner, org } = await team();
    const { access_token, clientId } = await agentToken(t, owner, org.id, ['content:read', 'content:draft']);
    const { grantId } = (await check(access_token))!;
    const made = await call(access_token, 'save_playlist', { name: 'Agent made', idempotencyKey: 'agent-made-1' });
    expect(made?.isError).toBeUndefined();
    const playlistId: string = made?.structuredContent.playlist.id;
    const read = await call(access_token, 'get_playlist', { playlistId });
    expect(read?.structuredContent.playlist).toMatchObject({ id: playlistId, name: 'Agent made' });
    const audit = (await scoped(env.DB, org.id).auditLog.list({ limit: 100 })).filter((e) => e.action === 'save_playlist');
    expect(audit).toEqual([expect.objectContaining({ actorKind: 'agent', actorId: grantId, clientId, targetId: playlistId })]);
  });

  it("lets an owner's agent cancel a pending invitation as its member, never invite, and no longer once its member is not an owner (#321)", async () => {
    const { t, owner, org, editor, editorMemberId } = await team();
    const { access_token, clientId } = await agentToken(t, owner, org.id, ['content:read', 'org:manage']);
    const { grantId } = (await check(access_token))!;
    const invited = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: 'pending-321@signforge.test', role: 'viewer' });
    // Inviting is a person's, in the CMS: no tool does it (#345).
    expect(await call(access_token, 'invite_member', { email: 'sam-321@signforge.test', role: 'viewer' })).toMatchObject({
      isError: true,
      structuredContent: { error: 'unknown_tool' },
    });
    expect(await call(access_token, 'cancel_invitation', { invitationId: invited.id })).toMatchObject({ structuredContent: { canceled: invited.id } });
    const org_ = scoped(env.DB, org.id);
    expect(await org_.invitations.get(invited.id)).toMatchObject({ status: 'canceled' });
    expect((await org_.auditLog.list({ limit: 20 })).filter((e) => e.action === 'cancel_invitation')).toEqual([
      expect.objectContaining({ actorKind: 'agent', actorId: grantId, clientId, targetKind: 'invitation', targetId: invited.id }),
    ]);
    // A member made an owner grants an agent; demoted, their agent cancels nothing.
    await owner.ok('/api/auth/organization/update-member-role', { memberId: editorMemberId, role: 'owner' });
    const theirs = (await agentToken(t, editor, org.id, ['content:read', 'org:manage'])).access_token;
    const next = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: 'next-321@signforge.test', role: 'viewer' });
    await owner.ok('/api/auth/organization/update-member-role', { memberId: editorMemberId, role: 'editor' });
    expect(await call(theirs, 'cancel_invitation', { invitationId: next.id })).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
    expect(await org_.invitations.get(next.id)).toMatchObject({ status: 'pending' });
  });

  it('cancels an invitation over /mcp within the budget (the Free plan: 50 D1 queries an invocation, #321)', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'org:manage']);
    const invited = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', { email: 'budget-321@signforge.test', role: 'viewer' });
    let out: unknown;
    const cost = await measure(async (b) => {
      out = await call(access_token, 'cancel_invitation', { invitationId: invited.id }, b);
    });
    expect(out).toMatchObject({ structuredContent: { canceled: invited.id } });
    // Measured, as the most it may take: the token with its grant and member, the invitation, then the guard that it is still
    // pending, the guard that its member is still an owner (review of #414), the cancel and the audit row in one batch; and
    // the grant's write limit, its one RPC (#107). A new statement fails this on purpose: look at the budget, then raise it.
    expect(cost).toEqual({ statements: 7, queries: 4, rpcs: ['write'] });
    expect(cost.queries).toBeLessThan(50);
  });

  it('answers a refusal as a result with isError, its code and its message', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    expect(await call(access_token, 'get_playlist', { playlistId: 'pls_nowhere' })).toMatchObject({ isError: true, structuredContent: { error: 'not_found' } });
    expect(await call(access_token, 'get_playlist', {})).toMatchObject({ isError: true, structuredContent: { error: 'invalid_input' } });
    expect(await call(access_token, 'no_such_tool')).toMatchObject({ isError: true, structuredContent: { error: 'unknown_tool' } });
  });

  it('never reaches another org: the org comes only from the grant', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft']);
    const other = await owner.createOrg('Other Co');
    await owner.setActive(other.id);
    const theirs = await owner.ok<{ playlist: { id: string } }>('/api/tools/save_playlist', { name: 'Not the agent’s' });
    expect(await call(access_token, 'get_playlist', { playlistId: theirs.playlist.id })).toMatchObject({
      isError: true,
      structuredContent: { error: 'not_found' },
    });
    const listed = await call(access_token, 'list_playlists');
    expect(listed?.structuredContent.playlists.map((p: { id: string }) => p.id)).not.toContain(theirs.playlist.id);
    // The session's active org is the other one now; the agent still works in its grant's.
    const made = await call(access_token, 'save_playlist', { name: 'In the grant’s org' });
    expect(await scoped(env.DB, org.id).playlists.get(made?.structuredContent.playlist.id)).toBeDefined();
  });
});

describe("the grant's limit", () => {
  it('refuses the 121st call in a minute, tools/list included, with rate_limited and retryAfterSeconds', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const { grantId } = (await check(access_token))!;
    // One minute, held still: the limit's stand-in counts in windows of the clock (`clockLimits`).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    const bindings = clockLimits();
    for (let i = 0; i < 119; i++) await bindings.AGENT_CALL_LIMIT.limit({ key: grantId });
    const listed = await rpc(access_token, 'tools/list', {}, bindings);
    expect(listed.result).toBeDefined();
    const refused = await rpc(access_token, 'tools/list', {}, bindings);
    expect(refused.error).toMatchObject({ code: -32000, data: { error: 'rate_limited', limit: 'calls_per_minute', retryAfterSeconds: expect.any(Number) } });
    expect(await call(access_token, 'list_screens', {}, bindings)).toMatchObject({
      isError: true,
      structuredContent: { error: 'rate_limited', details: { limit: 'calls_per_minute', retryAfterSeconds: expect.any(Number) } },
    });
  });
});

describe("the grant's last use", () => {
  it('is written at most once an hour, not on every call', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const { grantId } = (await check(access_token))!;
    const scope = scoped(env.DB, org.id);
    const lastUsed = async () => (await scope.agentGrants.get(grantId))?.lastUsedAt;
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    vi.setSystemTime(start);
    await toolNames(access_token);
    expect(await lastUsed()).toBe(start);
    vi.setSystemTime(start + 59 * 60_000);
    await toolNames(access_token);
    expect(await lastUsed()).toBe(start);
    // Its last use an hour back: the next call writes it again.
    await scope.agentGrants.touch(grantId, start - 60 * 60_000);
    await toolNames(access_token);
    expect(await lastUsed()).toBe(start + 59 * 60_000);
  });
});
