// The registry as `/mcp` lists it, and what a call answers (M4-06): every tool, for every role and
// scope, as pure functions, with no request. mcp.test.ts runs a few through the route.
import { type DispatchResult, describeTools, type Grant, type Members, ROLES, registry, SCOPES, type ToolServices } from '@signforge/tools';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { agentServices } from '../src/mcp';
import { callResult, listedTools } from '../src/mcp/tools';

/** Every role with every scope, the org letting editors publish or not. */
const GRANTS: Grant[] = ROLES.flatMap((role) => [true, false].map((editorsPublish) => ({ role, scopes: [...SCOPES], editorsPublish })));

/** The services `/mcp` gives an agent, from its own constructor (none is used here: each is built lazily). */
let AGENT: ToolServices = {};
beforeAll(async () => {
  const app = new Hono<{ Bindings: Env }>().get('/', (c) => {
    AGENT = agentServices(c, { orgId: 'org_listing', userId: 'user_listing' });
    return c.body(null, 204);
  });
  expect((await app.request('https://api.test/', {}, env, createExecutionContext())).status).toBe(204);
});

/** Every service some tool needs. */
const NEEDED = [...new Set([...registry.values()].flatMap((t) => t.needs ?? []))];

const members: Members = {
  invite: async () => {
    throw new Error('not called');
  },
  cancelInvitation: async () => {},
  updateRole: async () => {},
  remove: async () => {},
};

describe("/mcp's services", () => {
  it('are every service a tool needs but the member tools’ session', () => {
    expect(NEEDED).toContain('members');
    for (const need of NEEDED) expect(AGENT[need] === undefined, need).toBe(need === 'members');
  });
});

describe('tools/list', () => {
  it('lists exactly the tools the grant permits but the member tools and the people-only ones, each with an object input', () => {
    for (const grant of GRANTS) {
      const permitted = describeTools(registry, grant).map((t) => t.name);
      const listed = listedTools(grant, AGENT);
      // Only the member tools and the people-only ones drop out: a tool needing any other service would be listed, so losing one fails here.
      const lacking = permitted.filter((name) => registry.get(name)?.needs?.includes('members') || registry.get(name)?.people);
      expect(
        listed.map((t) => t.name),
        `${grant.role} ${grant.editorsPublish}`,
      ).toEqual(permitted.filter((name) => !lacking.includes(name)));
      for (const t of listed) expect(t.inputSchema.type, t.name).toBe('object');
    }
  });

  it('never lists the agent grant tools: an agent does not manage grants', () => {
    const people = [...registry.values()].filter((t) => t.people).map((t) => t.name);
    expect(people).toEqual(expect.arrayContaining(['list_agent_grants', 'get_agent_grant', 'update_agent_grant_scopes', 'revoke_agent_grant']));
    for (const grant of GRANTS) {
      const listed = listedTools(grant, AGENT).map((t) => t.name);
      for (const name of people) expect(listed, name).not.toContain(name);
    }
  });

  it('offers the member tools that act through a session only to a caller that has one', () => {
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    const needing = [...registry.values()].filter((t) => t.needs?.includes('members')).map((t) => t.name);
    expect(needing.length).toBeGreaterThan(0);
    const without = listedTools(owner, AGENT).map((t) => t.name);
    const withSession = listedTools(owner, { members }).map((t) => t.name);
    for (const name of needing) {
      expect(without, name).not.toContain(name);
      expect(withSession, name).toContain(name);
    }
  });

  it('hints from the registry: a read is read-only, a delete or revoke destructive, a keyed creation idempotent', () => {
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    for (const t of listedTools(owner, AGENT)) {
      const tool = registry.get(t.name);
      expect(t.annotations, t.name).toEqual({
        readOnlyHint: !tool?.mutates,
        destructiveHint: tool?.mutates === true && /^(delete|revoke)_/.test(t.name),
        idempotentHint: tool?.idempotent === true,
      });
    }
    const hints = (name: string) => listedTools(owner, AGENT).find((t) => t.name === name)?.annotations;
    expect(hints('list_screens')).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false });
    expect(hints('revoke_screen_credential')).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(hints('create_spot')).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it('lists nothing that needs content:publish without it, or a role above the grant', () => {
    for (const grant of GRANTS) {
      const scopes = SCOPES.filter((s) => s !== 'content:publish');
      for (const t of listedTools({ ...grant, scopes }, AGENT)) {
        const tool = registry.get(t.name);
        expect(tool?.scope, t.name).not.toBe('content:publish');
        expect(ROLES.indexOf(grant.role), t.name).toBeGreaterThanOrEqual(ROLES.indexOf(tool?.minRole ?? 'owner'));
      }
    }
  });
});

describe('tools/call', () => {
  it('answers an output as structured content and as JSON text', () => {
    const output = { playlist: { id: 'pls_1', name: 'Lobby' } };
    expect(callResult({ ok: true, output })).toEqual({ content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output });
  });

  it('answers a refusal as a result with isError, its code, message and details', () => {
    const refusals: DispatchResult[] = [
      { ok: false, error: 'forbidden', message: 'publish needs the content:publish scope' },
      { ok: false, error: 'rate_limited', message: 'try again in 12 s', details: { limit: 'calls_per_minute', retryAfterSeconds: 12 } },
    ];
    for (const result of refusals) {
      if (result.ok) continue;
      const { error, message, details } = result;
      const refusal = { error, message, ...(details === undefined ? {} : { details }) };
      expect(callResult(result), error).toEqual({ isError: true, content: [{ type: 'text', text: JSON.stringify(refusal) }], structuredContent: refusal });
    }
  });
});
