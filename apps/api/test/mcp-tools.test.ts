// The registry as `/mcp` lists it, and what a call answers (M4-06): every tool, for every role and
// scope, as pure functions, with no request. mcp.test.ts runs a few through the route.
import { type DispatchResult, describeTools, type Grant, READ_TOOLS, ROLES, registry, SCOPES, type ToolServices } from '@signforge/tools';
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

/** `/mcp`'s services where a provider could be connected: none is, in this deployment. */
let CONNECTING: ToolServices = {};
beforeAll(() => {
  const connectors = AGENT.connectors;
  if (!connectors) throw new Error('no connectors');
  CONNECTING = { ...AGENT, connectors: { ...connectors, providers: ['example'] } };
});

/** Every service some tool needs. */
const NEEDED = [...new Set([...registry.values()].flatMap((t) => t.needs ?? []))];

describe("/mcp's services", () => {
  it('are every service a tool needs', () => {
    for (const need of NEEDED) expect(AGENT[need], need).toBeDefined();
  });
});

describe('tools/list', () => {
  it('lists exactly the tools the grant permits but the people-only ones, each with an object input', () => {
    for (const grant of GRANTS) {
      const permitted = describeTools(registry, grant).map((t) => t.name);
      const listed = listedTools(grant, AGENT);
      // Only the people-only ones drop out: a tool needing a service would be listed, so losing one fails here.
      // And each type's own read, listed as `read`, and the connection tools, as this deployment connects no provider (#345).
      const lacking = permitted.filter((name) => registry.get(name)?.needs?.includes('connectors') || registry.get(name)?.people || READ_TOOLS.has(name));
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

  it("offers an owner's agent cancel_invitation, and no member change: no tool makes one (#321, #345)", () => {
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    const listed = listedTools(owner, AGENT).map((t) => t.name);
    expect(listed).toContain('cancel_invitation');
    for (const name of ['invite_member', 'update_member_role', 'remove_member']) expect(registry.has(name), name).toBe(false);
  });

  it('hints from the registry: a read is read-only, a delete, revoke, roll back, takeover or disconnect destructive, a keyed creation idempotent', () => {
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    const destructive = /^(delete|revoke|cancel)_|^(delete|roll_back_publish|takeover|disconnect)$/;
    for (const t of listedTools(owner, CONNECTING)) {
      const tool = registry.get(t.name);
      expect(t.annotations, t.name).toEqual({
        readOnlyHint: !tool?.mutates,
        destructiveHint: tool?.mutates === true && destructive.test(t.name),
        idempotentHint: tool?.idempotent === true,
      });
    }
    for (const name of ['delete', 'roll_back_publish', 'takeover', 'disconnect'])
      expect(listedTools(owner, CONNECTING).find((t) => t.name === name)?.annotations?.destructiveHint, name).toBe(true);
    const hints = (name: string) => listedTools(owner, AGENT).find((t) => t.name === name)?.annotations;
    expect(hints('read')).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: false });
    expect(hints('revoke_screen_credential')).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(hints('cancel_invitation')).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(hints('save_spot')).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it("lists a type's own read as read only where read serves it (#345): an org:manage-only grant keeps its invitations", () => {
    const orgOnly: Grant = { role: 'owner', scopes: ['org:manage'], editorsPublish: true };
    const names = listedTools(orgOnly, AGENT).map((t) => t.name);
    expect(names).toContain('list_invitations');
    expect(names).not.toContain('read');
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    expect(listedTools(owner, AGENT).map((t) => t.name)).not.toContain('list_invitations');
  });

  it("lists read's types and their lines for the grant and its services: no connection without a provider's service, no invitation for a viewer", () => {
    const viewer: Grant = { role: 'viewer', scopes: [...SCOPES], editorsPublish: true };
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    const readOf = (grant: Grant, services: ToolServices) => listedTools(grant, services).find((t) => t.name === 'read');
    const types = (grant: Grant, services: ToolServices) => JSON.stringify(readOf(grant, services)?.inputSchema);
    expect(types(viewer, AGENT)).not.toContain('"invitation"');
    expect(readOf(viewer, AGENT)?.description).not.toContain('invitation:');
    expect(types(owner, CONNECTING)).toContain('"connection"');
    expect(types(owner, AGENT)).not.toContain('"connection"');
    expect(types(owner, { ...AGENT, connectors: undefined })).not.toContain('"connection"');
  });

  it('lists the connection tools only where a provider can be connected (#345), and no raw manifest push to any agent', () => {
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    expect(AGENT.connectors?.providers).toEqual([]);
    expect(listedTools(owner, AGENT).map((t) => t.name)).not.toContain('disconnect');
    expect(listedTools(owner, CONNECTING).map((t) => t.name)).toContain('disconnect');
    for (const services of [AGENT, CONNECTING]) expect(listedTools(owner, services).map((t) => t.name)).not.toContain('publish_manifest_to_screen');
  });

  it('lists each tool with a title and only what helps a call (#345): no $schema, id pattern or safe-integer bound (mcp.test.ts: a call still checks them)', () => {
    const owner: Grant = { role: 'owner', scopes: [...SCOPES], editorsPublish: true };
    const listed = listedTools(owner, AGENT);
    expect(listed.find((t) => t.name === 'check_publish_request')?.title).toBe('Check publish request');
    for (const t of listed) {
      expect(t.title, t.name).toMatch(/^[A-Z][a-z0-9 ]+$/);
      const json = JSON.stringify(t.inputSchema);
      expect(json, t.name).not.toContain('$schema');
      expect(json, t.name).not.toContain(JSON.stringify('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'));
      expect(json, t.name).not.toContain(String(Number.MAX_SAFE_INTEGER));
    }
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
    expect(callResult({ ok: true, output }, 'no_such_tool', {})).toEqual({ content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output });
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
      expect(callResult(result, 'no_such_tool', {}), error).toEqual({ isError: true, content: [{ type: 'text', text: JSON.stringify(refusal) }], structuredContent: refusal });
    }
  });
});
