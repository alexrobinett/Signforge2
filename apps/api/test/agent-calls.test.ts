// Agent call telemetry (M4-08, #113): each /mcp call is one Analytics Engine data point, never its
// input; `get_agent_grant_usage` reads them back per grant and per org, isolated; a grant refused
// `forbidden` three times in an hour alerts the org once; and each path's cost per call: D1 writes,
// data points and Durable Object requests. The SQL API cannot be reached from tests: its queries and
// answers are tested as text and rows here, with a stand-in fetch.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentCallLog, callOfRow, callSql, pointOf, rowsOf } from '../src/agents/calls';
import { emailSenderFor, RecordingEmailSender } from '../src/email';
import { mcp } from '../src/mcp';
import { Client, ORIGIN } from './client';
import { agentToken, check, team } from './oauth';

afterEach(() => {
  vi.useRealTimers();
});

const HOUR = 60 * 60_000;

/** The bindings /mcp sees, recording each data point, each D1 statement's SQL and each grant object request. */
function watched() {
  const points: AnalyticsEngineDataPoint[] = [];
  const sql: string[] = [];
  const objectCalls: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === 'prepare') return (query: string) => (sql.push(query), target.prepare(query));
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const grants = new Proxy(env.AGENT_GRANTS, {
    get(target, key) {
      if (key !== 'get') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (id: DurableObjectId) =>
        new Proxy(target.get(id), {
          get(stub, method) {
            const real = Reflect.get(stub, method);
            if (typeof method !== 'string' || typeof real !== 'function') return real;
            return (...args: unknown[]) => (objectCalls.push(method), Reflect.apply(real, stub, args));
          },
        });
    },
  });
  const bindings: Env = { ...env, DB: db, AGENT_GRANTS: grants, AGENT_CALLS: { writeDataPoint: (p) => p && points.push(p) } };
  const writes = () => sql.filter((q) => /^\s*(insert|update|delete|replace)\b/i.test(q));
  const reset = () => {
    points.length = 0;
    sql.length = 0;
    objectCalls.length = 0;
  };
  return { bindings, points, sql, writes, objectCalls, reset };
}

let rpcId = 0;
/** One tools/* request to /mcp, after its own work (the alert's) has settled. */
async function rpc(token: string, method: string, params: unknown, bindings: Env = env) {
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
const call = (token: string, name: string, args: unknown = {}, bindings?: Env) => rpc(token, 'tools/call', { name, arguments: args }, bindings);

interface Usage {
  since: number;
  grants: { grantId: string; calls: number; changes: number; drafts: number; refusals: number }[];
  recent: { tool: string; result: string; change: boolean; needs: string | null; target: { kind: string; id: string } | null }[];
  lastRefusal: { tool: string; result: string; needs: string | null } | null;
}

describe('a data point per call', () => {
  it('records tools/list, reads, changes, refusals and unknown names, and never an input', async () => {
    const { t, owner, org } = await team();
    const { access_token, clientId } = await agentToken(t, owner, org.id, ['content:read', 'content:draft']);
    const { grantId } = (await check(access_token))!;
    const w = watched();
    const SECRET = 'sk-live-do-not-keep';
    await rpc(access_token, 'tools/list', {}, w.bindings);
    const made = await call(access_token, 'create_playlist', { name: `Menu ${SECRET}`, idempotencyKey: `key-${SECRET}` }, w.bindings);
    const playlistId: string = made.result?.structuredContent.playlist.id;
    await call(access_token, 'get_playlist', { playlistId }, w.bindings);
    await call(access_token, 'get_playlist', { playlistId: `pls_${SECRET}` }, w.bindings);
    await call(access_token, 'rename_screen', { screenId: 'scr_any', name: SECRET }, w.bindings);
    await call(access_token, `drop_${SECRET}`, { why: SECRET }, w.bindings);

    const tail = [org.id, grantId, clientId];
    expect(w.points).toEqual([
      { indexes: [grantId], blobs: [...tail, 'tools/list', 'ok', '', '', ''], doubles: [expect.any(Number), 0] },
      { indexes: [grantId], blobs: [...tail, 'create_playlist', 'ok', 'content:draft', 'playlist', playlistId], doubles: [expect.any(Number), 1] },
      { indexes: [grantId], blobs: [...tail, 'get_playlist', 'ok', 'content:read', '', ''], doubles: [expect.any(Number), 0] },
      { indexes: [grantId], blobs: [...tail, 'get_playlist', 'not_found', 'content:read', '', ''], doubles: [expect.any(Number), 0] },
      { indexes: [grantId], blobs: [...tail, 'rename_screen', 'forbidden', 'screens:manage', '', ''], doubles: [expect.any(Number), 1] },
      // A name that is no tool is the agent's text: recorded as unknown.
      { indexes: [grantId], blobs: [...tail, '(unknown)', 'unknown_tool', '', '', ''], doubles: [expect.any(Number), 0] },
    ]);
    expect(JSON.stringify(w.points)).not.toContain(SECRET);
  });

  it('records a call that fails unexpectedly as an error, with no message', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const w = watched();
    const SECRET = 'D1_ERROR: sk-live-in-a-message';
    const failing: Env = {
      ...w.bindings,
      AGENT_CALL_LIMIT: {
        limit: async () => {
          throw new Error(SECRET);
        },
      },
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await call(access_token, 'list_screens', {}, failing).catch(() => {});
    logged.mockRestore();
    expect(w.points.map((p) => p.blobs?.slice(3, 5))).toEqual([['list_screens', 'error']]);
    expect(JSON.stringify(w.points)).not.toContain('sk-live');
  });

  it('logs a refusal with its grant and client ids, never its input', async () => {
    const { t, owner, org } = await team();
    const { access_token, clientId } = await agentToken(t, owner, org.id, ['content:read']);
    const { grantId } = (await check(access_token))!;
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await call(access_token, 'get_playlist', { playlistId: 'pls_secret_input' });
    const lines = warned.mock.calls.map((args) => String(args[0]));
    warned.mockRestore();
    expect(lines.map((l) => JSON.parse(l))).toContainEqual({
      event: 'agent_call_refused',
      grant: grantId,
      client: clientId,
      tool: 'get_playlist',
      result: 'not_found',
    });
    expect(lines.join('\n')).not.toContain('pls_secret_input');
  });
});

describe('get_agent_grant_usage', () => {
  it("returns the week's calls per grant and per org, isolated; a member sees their own agents, an owner all", async () => {
    const a = await team();
    const ownerAgent = await agentToken(a.t, a.owner, a.org.id, ['content:read', 'content:draft']);
    const editorAgent = await agentToken(a.t, a.editor, a.org.id, ['content:read']);
    const ownerGrant = (await check(ownerAgent.access_token))!.grantId;
    const editorGrant = (await check(editorAgent.access_token))!.grantId;
    await rpc(ownerAgent.access_token, 'tools/list', {});
    const made = await call(ownerAgent.access_token, 'create_playlist', { name: 'Specials' });
    const playlistId: string = made.result?.structuredContent.playlist.id;
    await call(ownerAgent.access_token, 'rename_screen', { screenId: 'scr_any', name: 'x' });
    // Not found is a call, not a refusal: only forbidden and rate_limited are.
    await call(ownerAgent.access_token, 'get_playlist', { playlistId: 'pls_nowhere' });
    await call(editorAgent.access_token, 'list_playlists', {});

    // Another org's agent, whose calls are never this org's.
    const b = await team();
    const otherAgent = await agentToken(b.t, b.owner, b.org.id, ['content:read']);
    const otherGrant = (await check(otherAgent.access_token))!.grantId;
    await call(otherAgent.access_token, 'list_playlists', {});

    const all = await a.owner.ok<Usage>('/api/tools/get_agent_grant_usage', {});
    expect(all.grants.toSorted((x, y) => x.grantId.localeCompare(y.grantId))).toEqual(
      [
        { grantId: ownerGrant, calls: 4, changes: 1, drafts: 1, refusals: 1 },
        { grantId: editorGrant, calls: 1, changes: 0, drafts: 0, refusals: 0 },
      ].toSorted((x, y) => x.grantId.localeCompare(y.grantId)),
    );
    const one = await a.owner.ok<Usage>('/api/tools/get_agent_grant_usage', { grantId: ownerGrant });
    expect(one.recent).toEqual([
      { at: expect.any(Number), tool: 'get_playlist', result: 'not_found', change: false, needs: 'content:read', target: null },
      { at: expect.any(Number), tool: 'rename_screen', result: 'forbidden', change: true, needs: 'screens:manage', target: null },
      { at: expect.any(Number), tool: 'create_playlist', result: 'ok', change: true, needs: 'content:draft', target: { kind: 'playlist', id: playlistId } },
      { at: expect.any(Number), tool: 'tools/list', result: 'ok', change: false, needs: null, target: null },
    ]);
    expect(one.lastRefusal).toMatchObject({ tool: 'rename_screen', result: 'forbidden', needs: 'screens:manage' });

    // The editor sees only their own agent, not the owner's.
    const mine = await a.editor.ok<Usage>('/api/tools/get_agent_grant_usage', {});
    expect(mine.grants.map((g) => g.grantId)).toEqual([editorGrant]);
    expect((await a.editor.post('/api/tools/get_agent_grant_usage', { grantId: ownerGrant })).status).toBe(404);
    // Another org's owner sees their own, and never this org's.
    expect((await b.owner.ok<Usage>('/api/tools/get_agent_grant_usage', {})).grants).toEqual([
      { grantId: otherGrant, calls: 1, changes: 0, drafts: 0, refusals: 0 },
    ]);
    expect((await b.owner.post('/api/tools/get_agent_grant_usage', { grantId: ownerGrant })).status).toBe(404);
    expect((await a.owner.post('/api/tools/get_agent_grant_usage', { grantId: otherGrant })).status).toBe(404);
  });
});

const addressOf = async (c: Client) => (await (await c.get('/api/auth/get-session')).json<{ user: { email: string } }>()).user.email;

describe('the agent.refused alert', () => {
  it("emails the org's owners once at the third forbidden refusal in an hour, and once more the next hour", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // A minute before the hour turns, so the next hour is reached within the token's life.
    const now = Date.now();
    const start = now - (now % HOUR) + HOUR - 60_000;
    vi.setSystemTime(start);
    const { t, owner, org, editor } = await team();
    const { access_token } = await agentToken(t, editor, org.id, ['content:read']);
    const ownerAddress = await addressOf(owner);
    const outbox = emailSenderFor(env);
    if (!(outbox instanceof RecordingEmailSender)) throw new Error('dev sends to its outbox');
    const refusedMail = () => outbox.messages.filter((m) => m.to === ownerAddress && m.subject.includes('was refused'));

    const refuse = () => call(access_token, 'rename_screen', { screenId: 'scr_any', name: 'x' });
    await refuse();
    await refuse();
    expect(refusedMail()).toEqual([]);
    await refuse();
    expect(refusedMail()).toHaveLength(1);
    expect(refusedMail()[0]).toMatchObject({ subject: 'The agent “Test agent” was refused 3 times this hour' });
    expect(refusedMail()[0]!.text).toContain('rename_screen, which needs screens:manage');
    // Not a refusal for a missing scope: no count.
    await call(access_token, 'get_playlist', { playlistId: 'pls_nowhere' });
    await refuse();
    await refuse();
    expect(refusedMail()).toHaveLength(1);

    vi.setSystemTime(start + 90_000);
    for (let i = 0; i < 3; i++) await refuse();
    expect(refusedMail()).toHaveLength(2);
    // The editor is no owner: the rule's default sends to owners.
    const editorAddress = await addressOf(editor);
    expect(outbox.messages.filter((m) => m.to === editorAddress && m.subject.includes('was refused'))).toEqual([]);
  });
});

describe("the refusals' cost and the org's cap", () => {
  it('asks the grant object about at most three forbidden refusals a grant per isolate per clock hour, however many come', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    // A minute before the hour turns, so the next hour is reached within the token's life.
    const start = now - (now % HOUR) + HOUR - 60_000;
    vi.setSystemTime(start);
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
    const w = watched();
    const refuse = () => call(access_token, 'rename_screen', { screenId: 'scr_any', name: 'x' }, w.bindings);
    const asked = (method: string) => w.objectCalls.filter((m) => m === method).length;
    for (let i = 0; i < 10; i++) await refuse();
    expect(asked('refused')).toBe(3);
    expect(asked('orgAlertDue')).toBe(1);
    // The next clock hour counts again, as far as its alert.
    vi.setSystemTime(start + 2 * 60_000);
    for (let i = 0; i < 10; i++) await refuse();
    expect(asked('refused')).toBe(6);
    expect(asked('orgAlertDue')).toBe(2);
  });

  it('sends an org at most five agent.refused alerts a clock hour, however many of its agents are refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    vi.setSystemTime(now - (now % HOUR) + HOUR + 60_000);
    const { t, owner, org } = await team();
    const ownerAddress = await addressOf(owner);
    const outbox = emailSenderFor(env);
    if (!(outbox instanceof RecordingEmailSender)) throw new Error('dev sends to its outbox');
    const capped = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let agent = 0; agent < 6; agent++) {
      const { access_token } = await agentToken(t, owner, org.id, ['content:read']);
      for (let i = 0; i < 3; i++) await call(access_token, 'rename_screen', { screenId: 'scr_any', name: 'x' });
    }
    const lines = capped.mock.calls.map((args) => String(args[0]));
    capped.mockRestore();
    expect(outbox.messages.filter((m) => m.to === ownerAddress && m.subject.includes('was refused'))).toHaveLength(5);
    expect(lines.filter((l) => l.includes('agent_refused_alert_capped'))).toHaveLength(1);
  });
});

describe('the cost of each path, per call', () => {
  it('a read, a change, tools/list and a refusal: no D1 write for telemetry, one data point each, and the grant object only on forbidden', async () => {
    const { t, owner, org } = await team();
    const { access_token } = await agentToken(t, owner, org.id, ['content:read', 'content:draft']);
    // Its first call writes its last use (once an hour); measured after it.
    await rpc(access_token, 'tools/list', {});
    const w = watched();
    const paths: [string, () => Promise<unknown>, { writes: number; objects: string[] }][] = [
      ['tools/list', () => rpc(access_token, 'tools/list', {}, w.bindings), { writes: 0, objects: [] }],
      ['a read', () => call(access_token, 'list_playlists', {}, w.bindings), { writes: 0, objects: [] }],
      ['a refusal not_found', () => call(access_token, 'get_playlist', { playlistId: 'pls_nowhere' }, w.bindings), { writes: 0, objects: [] }],
      // A change refused for its scope: the write limit counts it first (#107), then its refusal is counted.
      [
        'a refusal forbidden',
        () => call(access_token, 'rename_screen', { screenId: 'scr_any', name: 'x' }, w.bindings),
        { writes: 0, objects: ['write', 'refused'] },
      ],
      // The change's own writes: the playlist and its audit row, in one batch; the limit's object counts it.
      ['a change', () => call(access_token, 'create_playlist', { name: 'Budget' }, w.bindings), { writes: 2, objects: ['write'] }],
    ];
    for (const [path, run, cost] of paths) {
      w.reset();
      await run();
      expect(w.points, path).toHaveLength(1);
      expect(w.writes(), path).toHaveLength(cost.writes);
      expect(w.objectCalls, path).toEqual(cost.objects);
    }
  });
});

describe('the SQL API log', () => {
  const ORG = 'org_a';
  const settings = { ...env, ENVIRONMENT: 'prod', ANALYTICS_ACCOUNT_ID: 'acct', ANALYTICS_TOKEN: 'token-value' } satisfies Env;

  /** A stand-in for the SQL API: the queries asked, answered with `rows`. */
  function sqlApi(rows: Record<string, unknown>[], status = 200) {
    const asked: { url: string; auth: string | null; sql: string }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      asked.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), sql: String(init?.body) });
      return status === 200 ? Response.json({ meta: [], data: rows, rows: rows.length }) : new Response('nope', { status });
    };
    return { asked, fetcher };
  }

  it('asks for one org and its grants over the last seconds, and tallies the rows by grant', async () => {
    const api = sqlApi([
      { grant: 'agr_1', result: 'ok', change: 0, needs: 'content:read', n: '7' },
      { grant: 'agr_1', result: 'ok', change: 1, needs: 'content:draft', n: '2' },
      { grant: 'agr_1', result: 'ok', change: 1, needs: 'content:publish', n: '1' },
      { grant: 'agr_1', result: 'forbidden', change: 1, needs: 'screens:manage', n: '3' },
      { grant: 'agr_1', result: 'rate_limited', change: 0, needs: 'content:read', n: '2' },
      // Calls, not refusals: the agent's own mistakes, and faults.
      { grant: 'agr_1', result: 'not_found', change: 0, needs: 'content:read', n: '4' },
      { grant: 'agr_1', result: 'error', change: 1, needs: 'content:draft', n: '1' },
    ]);
    const log = agentCallLog(settings, ORG, api.fetcher)!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 23, 12));
    expect(await log.usage(['agr_1', 'agr_2'], Date.UTC(2026, 10, 16, 12))).toEqual([{ grantId: 'agr_1', calls: 20, changes: 3, drafts: 2, refusals: 5 }]);
    expect(api.asked).toEqual([
      {
        url: 'https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql',
        auth: 'Bearer token-value',
        sql: callSql.usage('signforge_agent_calls_dev', ORG, ['agr_1', 'agr_2'], 7 * 24 * 3600),
      },
    ]);
    expect(api.asked[0]!.sql).toContain("WHERE blob1 = 'org_a' AND index1 IN ('agr_1', 'agr_2') AND timestamp > NOW() - INTERVAL '604800' SECOND");
  });

  it('reads recent calls and the last refusal as calls, their timestamps in UTC', async () => {
    const api = sqlApi([
      { timestamp: '2026-11-23 10:15:00', tool: 'create_playlist', result: 'ok', change: 1, needs: 'content:draft', targetKind: 'playlist', targetId: 'pls_1' },
    ]);
    const log = agentCallLog(settings, ORG, api.fetcher)!;
    const call = {
      at: Date.UTC(2026, 10, 23, 10, 15),
      tool: 'create_playlist',
      result: 'ok',
      change: true,
      needs: 'content:draft',
      target: { kind: 'playlist', id: 'pls_1' },
    };
    expect(await log.recent('agr_1', 0, 20)).toEqual([call]);
    expect(await log.lastRefusal('agr_1', 0)).toEqual(call);
    expect(api.asked[0]!.sql).toMatch(/ORDER BY timestamp DESC LIMIT 20 FORMAT JSON$/);
    expect(api.asked[1]!.sql).toContain("AND blob5 IN ('forbidden', 'rate_limited') ORDER BY timestamp DESC LIMIT 1");
    expect(callOfRow({ timestamp: '2026-11-23 10:15:00', tool: 'tools/list', result: 'ok', change: 0, needs: '', targetKind: '', targetId: '' })).toEqual({
      at: Date.UTC(2026, 10, 23, 10, 15),
      tool: 'tools/list',
      result: 'ok',
      change: false,
      needs: null,
      target: null,
    });
  });

  it('is unavailable, never a fault, whatever goes wrong reading it: an error status, the network, a timeout, a body not JSON or without data', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const failing: Record<string, typeof fetch> = {
      'an error status': async () => new Response('nope', { status: 500 }),
      'the network': async () => {
        throw new TypeError('Network connection lost.');
      },
      // As AbortSignal.timeout ends a fetch: the stand-in does not wait out the real seconds.
      'a timeout': async (_input, init) => {
        signals.push(init?.signal);
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      'a body not JSON': async () => new Response('<html>Bad gateway</html>', { status: 200 }),
      'a body without data': async () => Response.json({ errors: [{ message: 'bad' }] }),
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [what, fetcher] of Object.entries(failing)) {
      const log = agentCallLog(settings, ORG, fetcher)!;
      for (const read of [() => log.usage(['agr_1'], 0), () => log.recent('agr_1', 0, 20), () => log.lastRefusal('agr_1', 0)]) {
        await expect(read(), what).rejects.toMatchObject({ name: 'ToolError', code: 'unavailable' });
      }
    }
    logged.mockRestore();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(() => rowsOf({ errors: ['bad'] })).toThrow('without data');
  });

  it('answers the usage tool 503 while the SQL API is down, and the grants still list', async () => {
    const { t, owner, org } = await team();
    await agentToken(t, owner, org.id, ['content:read']);
    const deployed = new Client(t, owner.ip, { ...env, ANALYTICS_ACCOUNT_ID: 'acct', ANALYTICS_TOKEN: 'token-value' });
    for (const [k, v] of owner.jar) deployed.jar.set(k, v);
    const down = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost.'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const usage = await deployed.post('/api/tools/get_agent_grant_usage', {});
    down.mockRestore();
    logged.mockRestore();
    expect(usage.status).toBe(503);
    expect(await usage.json()).toMatchObject({ error: 'unavailable' });
    expect((await deployed.ok<{ grants: unknown[] }>('/api/tools/list_agent_grants', {})).grants).toHaveLength(1);
  });

  it('puts only ids in its SQL', () => {
    for (const bad of ["org' OR '1'='1", 'org a', '', 'x'.repeat(101)]) {
      expect(() => callSql.usage('ds', bad, ['agr_1'], 60), bad).toThrow('not an id');
      expect(() => callSql.recent('ds', 'org_a', bad, 60, 20, false), bad).toThrow('not an id');
    }
  });

  it('is none in a deployed environment without its token, and dev’s own in dev', () => {
    expect(agentCallLog({ ...env, ENVIRONMENT: 'prod', ANALYTICS_ACCOUNT_ID: undefined, ANALYTICS_TOKEN: undefined }, ORG)).toBeUndefined();
    expect(agentCallLog({ ...env, ANALYTICS_ACCOUNT_ID: undefined, ANALYTICS_TOKEN: undefined }, ORG)).toBeDefined();
  });

  it('writes the data point layout the queries read', () => {
    expect(
      pointOf({
        orgId: 'org_a',
        grantId: 'agr_1',
        clientId: 'cli_1',
        tool: 'create_playlist',
        result: 'ok',
        change: true,
        needs: 'content:draft',
        target: { kind: 'playlist', id: 'pls_1' },
        ms: 12,
      }),
    ).toEqual({ indexes: ['agr_1'], blobs: ['org_a', 'agr_1', 'cli_1', 'create_playlist', 'ok', 'content:draft', 'playlist', 'pls_1'], doubles: [12, 1] });
  });
});
