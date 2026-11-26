// The agent security pass (M4-17, #122) over /mcp, with tokens from the real provider: a token is
// for /mcp alone and only while it and its grant live, and a grant's publish follows the org's
// editors-publish setting on its next call. The threat model is docs/architecture.md (Agents); the
// tools refused to agents are packages/tools/test/agent-boundaries.test.ts. The paths tested before
// this pass are named there with their tests.
import { scoped } from '@signforge/db';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcp } from '../src/mcp';
import { Client, ORIGIN } from './client';
import { as, measure } from './counting';
import { CLIENT_SAYS, plant, reads, SAYS, SOURCES_SAY } from './planted';
import { agentToken, authorize, check, form, mcpRpc, mcpTool, REDIRECT, RESOURCE, register, sha256Base64Url, team } from './oauth';

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'security-test', version: '1' } };

/** The status of a tools/list to /mcp with `token`, and its challenge. */
async function listed(token: string) {
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, challenge: res.headers.get('www-authenticate') ?? '', body: await res.text() };
}

describe('a token for another resource', () => {
  it('is not issued: the provider knows /mcp alone', async () => {
    const { t, owner, org } = await team();
    const clientId = await register(t);
    const { back, verifier } = await authorize(owner, clientId, { organizationId: org.id, scopes: ['content:read'] });
    const res = await form(t, '/api/auth/oauth2/token', {
      grant_type: 'authorization_code',
      code: back!.searchParams.get('code')!,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
      resource: 'https://elsewhere.example/mcp',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain('access_token');
  });

  it('is refused at /mcp, as one not issued for it is (audience binding)', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    expect((await listed(access_token)).status).toBe(200);
    const hash = await sha256Base64Url(access_token);
    await env.DB.prepare('UPDATE oauthAccessToken SET resources = ? WHERE token = ?')
      .bind(JSON.stringify(['https://elsewhere.example/mcp']), hash)
      .run();
    const refused = await listed(access_token);
    expect(refused.status).toBe(401);
    expect(refused.challenge).toContain('error="invalid_token"');
  });
});

describe('an expired token or grant', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is refused once the access token has expired, an hour on, though its grant lives', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    expect((await listed(access_token)).status).toBe(200);
    vi.setSystemTime(Date.now() + HOUR + 1000);
    const refused = await listed(access_token);
    expect(refused.status).toBe(401);
    expect(refused.challenge).toContain('error="invalid_token"');
  });

  it('is refused once the grant has gone 90 days unused, though the client kept its token fresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { t, owner, org } = await team();
    const { clientId, access_token, refresh_token } = await agentToken(t, owner, org.id, ['content:read']);
    expect((await listed(access_token)).status).toBe(200);
    const start = Date.now();
    // Refreshing is not using the grant: a new token every 29 days, the last a little before the 90th day ends.
    let tokens = { access_token, refresh_token };
    for (const day of [29, 58, 87, 90 - 1 / 48]) {
      vi.setSystemTime(start + day * DAY);
      const res = await form(t, '/api/auth/oauth2/token', {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        resource: RESOURCE,
      });
      expect(res.status, await res.clone().text()).toBe(200);
      tokens = await res.json();
    }
    vi.setSystemTime(start + 90 * DAY + 10 * 60_000);
    // The token itself is live (issued 20 minutes ago); the grant is not.
    const hash = await sha256Base64Url(tokens.access_token);
    const row = await env.DB.prepare('SELECT expiresAt FROM oauthAccessToken WHERE token = ?').bind(hash).first<{ expiresAt: string }>();
    expect(Date.parse(row!.expiresAt)).toBeGreaterThan(Date.now());
    const refused = await listed(tokens.access_token);
    expect(refused.status).toBe(401);
    expect(refused.challenge).toContain('error="invalid_token"');
  });
});

describe('editors-publish turned off mid-session', () => {
  it("takes an editor's agent's publish away on its next call, and gives it back when turned on; the grant itself keeps the scope", async () => {
    const { t, owner, org, editor } = await team();
    const { access_token } = await agentToken(t, editor, org.id, ['content:read', 'content:draft', 'content:publish']);
    const { grantId } = (await check(access_token))!;
    const names = async () => JSON.parse((await listed(access_token)).body).result.tools.map((x: { name: string }) => x.name);
    expect(await names()).toContain('publish');

    expect((await owner.tool('update_org_settings', { editorsPublish: false })).status).toBe(200);
    expect(await names()).not.toContain('publish');
    expect(await mcpTool(access_token, 'publish', {})).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
    // Capped on each call, not lowered: what the member consented to is kept for when editors publish again.
    expect(JSON.parse((await scoped(env.DB, org.id).agentGrants.get(grantId))!.scopesJson)).toContain('content:publish');

    expect((await owner.tool('update_org_settings', { editorsPublish: true })).status).toBe(200);
    expect(await names()).toContain('publish');
  });

  it("cannot be turned back on by the editor's agent, nor by an owner's", async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'org:manage']);
    expect((await owner.tool('update_org_settings', { editorsPublish: false })).status).toBe(200);
    expect(await mcpTool(access_token, 'update_org_settings', { editorsPublish: true })).toMatchObject({
      isError: true,
      structuredContent: { error: 'forbidden' },
    });
    expect(await mcpTool(access_token, 'update_org_settings', { auditRetentionDays: 30 })).toMatchObject({
      isError: true,
      structuredContent: { error: 'forbidden' },
    });
    expect((await scoped(env.DB, org.id).settings.get())?.editorsPublish).toBe(false);
  });
});

describe('prompt injection through content', () => {
  it('reaches an agent only as data fields of an output, never in the instructions or a tool description, from every source', async () => {
    const { t, owner, ownerId, org } = await team();
    const planted = await plant(t, owner, ownerId, org.id);
    const { access_token } = planted;

    // Ours, and static: the same words whatever the org holds.
    const { result: init } = await mcpRpc(access_token, 'initialize', INIT);
    const { result: list } = await mcpRpc(access_token, 'tools/list', {});
    expect(JSON.stringify(init)).not.toContain('Ignore your instructions');
    expect(JSON.stringify(list)).not.toContain('Ignore your instructions');

    // Theirs: inside an output's string fields, the text the same JSON as its structured content, so it never runs into ours.
    for (const [name, args] of reads(planted)) {
      const { result } = await mcpRpc(access_token, 'tools/call', { name, arguments: args });
      const text = (result as { content: { type: string; text: string }[] }).content[0]!.text;
      expect(result?.isError, `${name}: ${text}`).toBeUndefined();
      expect(text.includes(JSON.stringify(SAYS).slice(1, -1)) || text.includes(CLIENT_SAYS), `${name}: ${text}`).toBe(true);
      expect(text, name).toBe(JSON.stringify(result?.structuredContent));
      // A template's sources are kept as their hash alone: no output carries them.
      expect(text, name).not.toContain('evil.example/steal');
    }
    // The agent's own name, as its client registered it, reaches what names the agent: its draft and its request.
    const draft = await mcpTool(access_token, 'get_agent_draft', { spotId: planted.spotId });
    expect(draft.structuredContent.agents).toEqual([expect.objectContaining({ name: CLIENT_SAYS })]);
    const request = await mcpTool(access_token, 'get_publish_request', { publishRequestId: planted.requestId });
    expect(request.structuredContent.request.requestedBy).toMatchObject({ kind: 'agent', name: CLIENT_SAYS });
    expect(SOURCES_SAY).toContain('evil.example/steal');
  });
});

describe('what a person keeps, over /mcp (review of #419)', () => {
  it("lists none of the tools only a person may run, even to an owner's agent with every scope", async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage']);
    const names = JSON.parse((await listed(access_token)).body).result.tools.map((x: { name: string }) => x.name);
    for (const name of [
      'claim_screen',
      'set_alert_channel',
      'remove_alert_channel',
      'test_alert_channel',
      'retry_alert_delivery',
      'save_ai_provider',
      'test_ai_provider',
      'remove_ai_provider',
      'start_connection',
      'finish_connection',
      'set_template_version_status',
    ])
      expect(names, name).not.toContain(name);
    // A pairing code read from a feed pairs nothing.
    expect(await mcpTool(access_token, 'claim_screen', { code: 'ABCDEF', name: 'Lobby', timezone: 'UTC', orientation: 'landscape' })).toMatchObject({
      isError: true,
      structuredContent: { error: 'forbidden' },
    });
  });

  it("gets no member change from Better Auth's endpoints with its /mcp token: no tool makes one, and they take a session alone (#345)", async () => {
    const { t, owner, org, editorMemberId } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft', 'content:publish', 'screens:manage', 'org:manage']);
    const agent = new Client(t);
    const bearer = { authorization: `Bearer ${access_token}` };
    for (const [path, body] of [
      ['/api/auth/organization/invite-member', { email: 'agent-345@signforge.test', role: 'owner', organizationId: org.id }],
      ['/api/auth/organization/update-member-role', { memberId: editorMemberId, role: 'owner', organizationId: org.id }],
      ['/api/auth/organization/remove-member', { memberIdOrEmail: editorMemberId, organizationId: org.id }],
    ] as const)
      expect((await agent.post(path, body, bearer)).status, path).toBeGreaterThanOrEqual(400);
    const members = await scoped(env.DB, org.id).members.list();
    expect(members.map((m) => m.role).sort()).toEqual(['editor', 'owner']);
    expect(await scoped(env.DB, org.id).invitations.pending()).toEqual([]);
  });

  it("refuses a draft-only agent a feed's address, which screens follow with no publish, and keeps the sealed one", async () => {
    const { t, owner, org } = await team();
    expect((await owner.tool('save_data_source', { id: 'menu', name: 'Menu', format: 'json', feedUrl: 'https://menu.example.com/today.json' })).status).toBe(
      200,
    );
    const before = (await scoped(env.DB, org.id).dataSources.get('menu'))?.urlEncrypted;
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft']);
    expect(await mcpTool(access_token, 'save_data_source', { dataSourceId: 'menu', feedUrl: 'https://evil.example.com/menu.json' })).toMatchObject({
      isError: true,
      structuredContent: { error: 'forbidden', message: expect.stringContaining('needs the right to publish') },
    });
    expect((await scoped(env.DB, org.id).dataSources.get('menu'))?.urlEncrypted).toBe(before);
    // With the right to publish, it may.
    const publisher = (await agentToken(t, owner, org.id, ['content:read', 'content:draft', 'content:publish'])).access_token;
    expect(await mcpTool(publisher, 'save_data_source', { dataSourceId: 'menu', feedUrl: 'https://menu.example.com/tomorrow.json' })).toMatchObject({
      structuredContent: { dataSource: { id: 'menu' } },
    });
  });

  it('changes a feed within the budget (the Free plan: 50 D1 queries an invocation)', async () => {
    const { t, owner, org } = await team();
    expect((await owner.tool('save_data_source', { id: 'menu', name: 'Menu', format: 'json', feedUrl: 'https://menu.example.com/today.json' })).status).toBe(
      200,
    );
    const publisher = (await agentToken(t, owner, org.id, ['content:read', 'content:draft', 'content:publish'])).access_token;
    const drafter = (await agentToken(t, owner, org.id, ['content:read', 'content:draft'])).access_token;
    // Each grant's first call writes its last use (hourly): made before any is measured.
    for (const token of [publisher, drafter]) expect((await listed(token)).status).toBe(200);
    const measured = (token: string, input: Record<string, unknown>) =>
      measure(async (b) => {
        expect(await mcpTool(token, 'save_data_source', { dataSourceId: 'menu', ...input }, b)).toMatchObject({
          structuredContent: { dataSource: { id: 'menu' } },
        });
      });
    const address = await measured(publisher, { feedUrl: 'https://menu.example.com/later.json' });
    const refresh = await measured(publisher, { refreshS: 600 });
    const name = await measured(drafter, { name: 'Menu board' });
    // Measured, as the most each may take, the grant's write limit the one RPC of each: the token with its grant and member,
    // the source, then one batch. Any change but the name holds the right to publish to that batch, one statement more than
    // a name alone (review of #419); no read of what shows the source decides any more. Far inside 50. A new statement fails
    // this on purpose: look at the budget, then raise it.
    expect({ address, refresh, name }).toEqual({
      address: { statements: 5, queries: 3, rpcs: ['write'] },
      refresh: { statements: 5, queries: 3, rpcs: ['write'] },
      name: { statements: 4, queries: 3, rpcs: ['write'] },
    });
  });

  it("changes a feed as a person within the budget, the right to publish held to the batch as an agent's is (#424)", async () => {
    const { owner } = await team();
    expect((await owner.tool('save_data_source', { id: 'menu', name: 'Menu', format: 'json', feedUrl: 'https://menu.example.com/today.json' })).status).toBe(
      200,
    );
    const measured = (input: Record<string, unknown>) =>
      measure(async (b) => {
        expect((await as(owner, b).tool('save_data_source', { dataSourceId: 'menu', ...input })).status).toBe(200);
      });
    const refresh = await measured({ refreshS: 600 });
    const name = await measured({ name: 'Menu board' });
    // Measured, as the most each may take: the session and its member's role, the source, then one batch; a change but the
    // name holds the right to publish to that batch, one statement more than a name alone. A new statement fails this on
    // purpose: look at the budget, then raise it.
    expect({ refresh, name }).toEqual({
      refresh: { statements: 6, queries: 4, rpcs: [] },
      name: { statements: 5, queries: 4, rpcs: [] },
    });
  });
});
