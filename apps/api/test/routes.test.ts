// The guard: on `/api`, only Better Auth, the tool route and the agent's inline fill and its Keep
// change data, and the last three change it only through the dispatcher, which writes the audit log. The test enumerates the
// Worker's routes, so a new route fails here until it is either read-only or listed below.
import { seedBaseTemplate, testScope } from '@signforge/db/testing';
import { registry } from '@signforge/tools';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { orgBlobKey } from '../src/r2';
import { Client, email, testApp } from './client';
import { type Block, anthropicStream } from './model-streams';
import { agentToken, check } from './oauth';

/**
 * Every route that is not a GET, and why it may change data. `/api` allows exactly Better Auth,
 * the tool route, the agent's inline fill and its Keep, its drafts' save, and its drawer's presses. Other trees list each route with its reason; a screen reporting about
 * itself on `/v1/device` (M3-07's sync) goes here too, as a deliberate decision.
 */
const WRITERS: Record<string, string> = {
  'POST /api/auth/*': 'Better Auth: sign-in, organizations, members, invitations, and the OAuth consent for agents (#110)',
  'POST /api/tools/:name': 'the tool registry, through the dispatcher',
  'POST /api/agent/apply':
    "the drawer's drafts the person saved (#268): each a drafting tool through the dispatcher as the member via cms-agent (its writes and their audit row are checked below)",
  'POST /api/agent/chat':
    "a turn of the agent's drawer (#267): a question reads only, POST because the body is a conversation (it writes nothing of ours, checked below); a press of its confirmation card (#269) runs that one tool through the dispatcher as the member via cms-agent, once, its audit row carrying the card (agent-chat.test.ts)",
  'POST /api/agent/inline/keep':
    "Keep of the agent's update of a spot (#264): one update_spot through the dispatcher as the member via cms-agent, with ifVersion (its writes and their audit row are checked below)",
  'POST /api/agent/inline':
    "the agent's fill from a flyer, photo or link (#263): one create_spot through the dispatcher as the member via cms-agent (its writes and their audit row are checked below)",
  'POST /admin/screens/:screen/missing': 'reads only: POST because the body is a manifest',
  'PUT /admin/screens/:screen/blobs/:sha256': 'sf push: content-addressed bytes in R2, inert until a publish names them',
  'PUT /admin/base/blobs/:sha256': 'sf push: content-addressed bytes in R2, inert until a publish names them',
  'PUT /admin/screens/:screen/manifest': 'sf push: stores the manifest file, then publishes through the dispatcher (admin.test.ts checks the audit row)',
  'PUT /admin/orgs/:org/blobs/:sha256': 'sf template push: content-addressed bytes in R2, inert until a template version names them',
  'PUT /admin/base/templates': 'sf template push: registers a base template version through the dispatcher, audited in platform_audit_log (templates.test.ts)',
  'PUT /admin/orgs/:org/templates':
    "sf template push: registers an org's template version through the dispatcher, audited in its audit_log (templates.test.ts)",
  'POST /v1/device/pair/start': 'an unpaired screen asking for a code: a pairing_codes row, which belongs to no org (not audited: no actor yet)',
  'POST /v1/device/pair/poll':
    "an unpaired screen collecting its credential: once a member's audited claim_screen bound the code, its first screen_credentials row (packages/db/src/pairing.ts)",
  'POST /mcp':
    "agents (M4-06): each tool call through the dispatcher as the grant's member, the agent as the actor (mcp.test.ts checks the audit row); and the grant's last use, at most once an hour, not audited (bookkeeping, as M4-04 has it)",
  'DELETE /mcp': 'answers 405: no sessions to end',
  'POST /v1/device/sync':
    'a screen reporting about itself: its heartbeat, last-seen time and play counts, on its own screen row (not audited: the screen is the actor, every few minutes)',
};
/** Middleware each tree mounts on its whole prefix. A wildcard on any other path is a route and fails. */
const MIDDLEWARE = new Set(['ALL /api/*', 'ALL /v1/device/*', 'ALL /admin/*']);
/** Better Auth's own GETs may write its tables (OAuth callbacks, sign-out links). */
const AUTH_GET = 'GET /api/auth/*';
/**
 * The connectors' OAuth callback: a GET because a provider redirects the browser to it. It changes
 * data only by running finish_connection through the dispatcher (test/connections.test.ts), and
 * answers a redirect, never 200.
 */
const OAUTH_CALLBACK = 'GET /api/connections/callback';

/** Better Auth's tables. Writes to any other table are ours and must come from the dispatcher. */
const AUTH_TABLES = new Set(['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation', 'rateLimit']);
const WRITE = /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`]?(\w+)/i;

/** A D1 binding that records the table of every write statement prepared through it. */
function recordingD1(db: D1Database, writes: string[]): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const m = WRITE.exec(sql);
          if (m) writes.push(m[1]!);
          return target.prepare(sql);
        };
      }
      if (prop === 'exec') throw new Error('exec is not expected on a request path');
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const routes = () => [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))];

describe('the route table', () => {
  it('has no route that changes data except those listed', () => {
    const unexpected = routes().filter((r) => !r.startsWith('GET ') && !MIDDLEWARE.has(r) && !(r in WRITERS));
    expect(unexpected, 'a new route that is not a GET: make it a tool, or list it in WRITERS with a reason').toEqual([]);
  });

  it("allows exactly Better Auth, the tool route, and the agent's routes to change data on /api, the drawer's only on a press", () => {
    expect(Object.keys(WRITERS).filter((r) => r.split(' ')[1]!.startsWith('/api/'))).toEqual([
      'POST /api/auth/*',
      'POST /api/tools/:name',
      'POST /api/agent/apply',
      'POST /api/agent/chat',
      'POST /api/agent/inline/keep',
      'POST /api/agent/inline',
    ]);
    // Every listed writer still exists, so the list cannot rot.
    for (const r of Object.keys(WRITERS)) expect(routes(), r).toContain(r);
  });
});

describe('requests', () => {
  const t = testApp();
  const writes: string[] = [];
  let owner: Client;
  let screenId: string;
  let assetId: string;
  let brandKitId: string;
  let spotId: string;
  let playlistId: string;
  let baseTemplate: string;
  let baseVersion: string;
  let grantId: string;
  let publishRequestId: string;

  beforeAll(async () => {
    ({ template: baseTemplate, templateVersion: baseVersion } = await seedBaseTemplate(env.DB));
    const setup = new Client(t);
    await setup.signIn(email('guard'));
    const org = await setup.createOrg('Guard');
    screenId = (await testScope(env.DB, org.id).screens.insert({ name: 'Guarded', timezone: 'UTC', orientation: 'landscape' })).id;
    assetId = (
      await testScope(env.DB, org.id).assets.insert({ kind: 'image', name: 'a.png', sha256: 'a'.repeat(64), type: 'image/png', size: 1, width: 1, height: 1 })
    ).id;
    await env.BLOBS.put(orgBlobKey(org.id, 'a'.repeat(64)), 'a');
    brandKitId = (
      await testScope(env.DB, org.id).brandKits.insert({
        name: 'House',
        colorsJson: JSON.stringify({ primary: '#000000', accent: '#ffffff', background: '#000000', surface: '#111111', text: '#ffffff', muted: '#aaaaaa' }),
        shape: 'soft',
      })
    ).id;
    spotId = (await testScope(env.DB, org.id).spots.insert({ name: 'Site', kind: 'url', durationMs: 10_000, url: 'https://example.com' })).id;
    playlistId = (await testScope(env.DB, org.id).playlists.insert({ name: 'Main', transitionJson: JSON.stringify({ type: 'cut' }) })).id;
    // get_data_source's example names `weather`.
    await testScope(env.DB, org.id).dataSources.insert({ id: 'weather', name: 'Weather', format: 'json', urlEncrypted: 'sealed', refreshS: 300 });
    // get_agent_grant's: an agent connected to this org by its owner.
    grantId = (await check((await agentToken(t, setup, org.id, ['content:read'])).access_token))!.grantId;
    // get_publish_request's: the agent's request to publish the spot.
    const asked = testScope(env.DB, org.id).publishRequests.stage.insert(
      {
        requestedByKind: 'agent',
        requestedBy: grantId,
        draftsJson: JSON.stringify([{ kind: 'spot', id: spotId, version: 1 }]),
        reason: 'Guarded',
        brandState: '',
        expiresAt: Date.UTC(2100, 0, 1),
      },
      Date.UTC(2026, 10, 24),
      10,
    );
    await testScope(env.DB, org.id).commit(asked.writes);
    publishRequestId = asked.row.id;
    // The same session, on a D1 binding that records writes.
    owner = new Client(t, setup.ip, { ...env, DB: recordingD1(env.DB, writes) });
    for (const [k, v] of setup.jar) owner.jar.set(k, v);
  });

  const ours = () => writes.filter((table) => !AUTH_TABLES.has(table));

  it('to every GET on /api, other than Better Auth, write nothing of ours', async () => {
    const gets = routes().filter((r) => r.startsWith('GET /api/') && r !== AUTH_GET && r !== OAUTH_CALLBACK);
    expect(gets.length).toBeGreaterThan(0);
    for (const r of gets) {
      writes.length = 0;
      // A hash names the org's one file; any other parameter is a placeholder.
      const path = r
        .slice('GET '.length)
        .replace(/:sha256/g, 'a'.repeat(64))
        .replace(/:\w+/g, 'x');
      const res = await owner.get(path);
      expect(res.status, r).toBe(200);
      expect(ours(), r).toEqual([]);
    }
  });

  it('writes through the dispatcher on the OAuth callback: a state that is not pending changes nothing', async () => {
    writes.length = 0;
    const res = await owner.get('/api/connections/callback?state=not-a-pending-state-at-all&code=x');
    expect(res.status).toBe(303);
    expect(ours()).toEqual([]);
  });

  it('to a read tool write nothing, and to a changing tool write the audit log with the change', async () => {
    for (const tool of registry.values()) {
      if (tool.mutates) continue;
      writes.length = 0;
      const example = tool.example as Record<string, unknown>;
      // Each id the example names, as one of this org's (or a base template's).
      const orgIds: Record<string, string> = {
        screenId,
        templateId: baseTemplate,
        templateVersionId: baseVersion,
        assetId,
        brandKitId,
        spotId,
        playlistId,
        grantId,
        publishRequestId,
      };
      const input = Object.fromEntries(Object.entries(example).map(([k, v]) => [k, orgIds[k] ?? v]));
      const res = await owner.tool(tool.name, input);
      // find_places and read_table ask a third party, here a closed port (vitest.config.ts): only that they write nothing counts.
      if (tool.name !== 'find_places' && tool.name !== 'read_table') expect(res.status, tool.name).toBe(200);
      expect(ours(), tool.name).toEqual([]);
    }

    writes.length = 0;
    expect((await owner.tool('rename_screen', { screenId, name: 'Renamed' })).status).toBe(200);
    expect(ours()).toEqual(['screens', 'audit_log']);

    // A change that finds nothing (its UPDATE matched no row) is not audited.
    writes.length = 0;
    expect((await owner.tool('rename_screen', { screenId: 'scr_nobody', name: 'x' })).status).toBe(404);
    expect(ours()).not.toContain('audit_log');
  });

  it('to the inline fill write the one spot with its audit row, through the dispatcher', async () => {
    const answer = JSON.stringify({ template: 'base/clock@1.0.0', name: 'Bake sale', data_json: JSON.stringify({ title: 'Bake sale' }), unsure: [] });
    const model: typeof fetch = async () => anthropicStream('msg_1', 'claude-haiku-5-5', [{ type: 'text', text: answer }], 'end_turn');
    const page: typeof fetch = async () => new Response('<p>Bake sale</p>');
    const filling = testApp({ agent: { reach: { fetch: model, guards: { fetch: page, resolve: async () => ['93.184.215.14'] } } } });
    const member = new Client(filling, owner.ip, { ...env, DB: recordingD1(env.DB, writes) });
    for (const [k, v] of owner.jar) member.jar.set(k, v);
    const saved = await owner.tool('save_ai_provider', { provider: 'anthropic', apiKey: 'sk-ant-api03-GUARDKEYGUARDKEY-0001', fastModel: 'claude-haiku-5-5' });
    expect(saved.status).toBe(200);
    writes.length = 0;
    const res = await member.post('/api/agent/inline', { source: { kind: 'link', url: 'https://bakery.example/' }, idempotencyKey: 'guard-fill-1' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(ours()).toEqual(['spots', 'idempotency_keys', 'audit_log']);

    // Keep of an update (#264): the spot and its audit row, and nothing for the review before it.
    const made = (await res.json()) as { spot: { id: string; version: number } };
    writes.length = 0;
    const kept = await member.post('/api/agent/inline/keep', { spotId: made.spot.id, ifVersion: made.spot.version, data: { title: 'Kept' } });
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect(ours()).toEqual(['spots', 'audit_log']);
  });

  it("to the drawer's turn write nothing of ours, its tools' reads included", async () => {
    // A read, then the answer's card as JSON (#350).
    const steps: [Block[], string][] = [
      [[{ type: 'tool_use', id: 'toolu_1', name: 'list_screens', input: {} }], 'tool_use'],
      [[{ type: 'text', text: JSON.stringify({ text: 'Fine.', groups: [], steps: [] }) }], 'end_turn'],
    ];
    let n = 0;
    const model: typeof fetch = async () => {
      const [blocks, stop] = steps[Math.min(n++, 1)]!;
      return anthropicStream(`msg_${n}`, 'm', blocks, stop);
    };
    const asking = testApp({ agent: { reach: { fetch: model, guards: { fetch, resolve: async () => ['93.184.215.14'] } } } });
    const member = new Client(asking, owner.ip, { ...env, DB: recordingD1(env.DB, writes) });
    for (const [k, v] of owner.jar) member.jar.set(k, v);
    expect((await owner.tool('save_ai_provider', { provider: 'anthropic', capableModel: 'claude-sonnet-5-5' })).status).toBe(200);
    writes.length = 0;
    const res = await member.post('/api/agent/chat', {
      threadId: 'thread-1',
      runId: 'run-1',
      messages: [{ id: 'm1', role: 'user', content: 'How are the screens?' }],
      forwardedProps: { history: [], page: { path: '/screens', ids: {} } },
    });
    expect(await res.text()).toContain('"name":"signforge.answer"');
    expect(ours()).toEqual([]);

    // Its drafts, saved (#268): the change and its audit row, and nothing else.
    const made = await owner.tool('create_spot', {
      name: 'Clock',
      kind: 'template',
      templateVersionId: baseVersion,
      data: { title: 'Now' },
      idempotencyKey: 'guard-draft-1',
    });
    const { spot } = (await made.json()) as { spot: { id: string; version: number } };
    writes.length = 0;
    const saved = await member.post('/api/agent/apply', {
      calls: [{ tool: 'update_spot', input: { spotId: spot.id, name: 'Clock, renamed', ifVersion: spot.version } }],
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(ours()).toEqual(['spots', 'audit_log']);
  });
});

describe('POST /api/tools/:name', () => {
  const t = testApp();
  const owner = new Client(t);
  const viewer = new Client(t);
  let screenId: string;

  beforeAll(async () => {
    await owner.signIn(email('owner'));
    await viewer.signIn(email('viewer'));
    const org = await owner.createOrg('Tools');
    screenId = (await testScope(env.DB, org.id).screens.insert({ name: 'Lobby', timezone: 'UTC', orientation: 'landscape' })).id;
    const invite = await owner.ok<{ id: string }>('/api/auth/organization/invite-member', {
      email: (await viewer.session()).body.user.email,
      role: 'viewer',
      organizationId: org.id,
    });
    await viewer.ok('/api/auth/organization/accept-invitation', { invitationId: invite.id });
    expect((await viewer.setActive(org.id)).status).toBe(200);
  });

  it('maps refusals to HTTP statuses', async () => {
    const cases: [Client, string, unknown, number, string][] = [
      [owner, 'no_such_tool', {}, 404, 'unknown_tool'],
      [owner, 'rename_screen', { screenId, name: '' }, 400, 'invalid_input'],
      [owner, 'rename_screen', { screenId: 'scr_nobody', name: 'x' }, 404, 'not_found'],
      [viewer, 'rename_screen', { screenId, name: 'x' }, 403, 'forbidden'],
    ];
    for (const [who, name, input, status, error] of cases) {
      const res = await who.tool(name, input);
      expect(res.status, name).toBe(status);
      expect(await res.json(), name).toMatchObject({ error, message: expect.any(String) });
    }
  });

  it('records the session user as the actor, through the cms client', async () => {
    const res = await owner.tool('rename_screen', { screenId, name: 'Front desk' });
    expect(await res.json()).toMatchObject({ screen: { id: screenId, name: 'Front desk' } });
    const { user, organization } = (await owner.session()).body;
    const [entry] = await testScope(env.DB, organization.id).auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({ actorKind: 'user', actorId: user.id, clientId: 'cms', action: 'rename_screen', targetKind: 'screen', targetId: screenId });
  });

  it('takes JSON only', async () => {
    const form = await owner.request('POST', '/api/tools/rename_screen', undefined, { 'content-type': 'text/plain' });
    expect(form.status).toBe(415);
    const broken = await owner.request('POST', '/api/tools/list_screens', undefined, { 'content-type': 'application/json' });
    expect(broken.status).toBe(200); // an empty body is an empty input
  });

  it('hands out presigned uploads to the local bucket in dev', async () => {
    const r = { sha256: '1'.repeat(64), type: 'image/jpeg', size: 1000, width: 1920, height: 1080 };
    const res = await owner.tool('create_asset_upload', {
      name: 'Photo',
      renditions: { landscape: r, portrait: { ...r, sha256: '2'.repeat(64), width: 1920 } },
    });
    expect(res.status).toBe(200);
    const { asset, uploads } = (await res.json()) as { asset: { id: string; status: string }; uploads: { url: string }[] };
    expect(asset.status).toBe('pending');
    expect(uploads).toHaveLength(2);
    const url = new URL(uploads[0]!.url);
    expect(url.pathname).toMatch(new RegExp(`^/cdn-cgi/local/r2/s3/signforge-dev/up/[^/]+/${asset.id}/[0-9a-f]{64}$`));
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^signforge-local\//);
  });

  it('lists what the caller may use', async () => {
    const names = async (c: Client) => ((await (await c.get('/api/tools')).json()) as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(await names(owner)).toHaveLength(registry.size);
    // A viewer gets the tools a viewer may run: the read tools (packages/tools test/dispatch.test.ts names them).
    const reads = [...registry.values()].filter((t) => t.minRole === 'viewer' && t.scope === 'content:read').map((t) => t.name);
    expect(reads.length).toBeGreaterThan(10);
    expect((await names(viewer)).sort()).toEqual(reads.sort());
  });
});
