// The registry as `/mcp` lists it, and what a call answers (M4-06): every tool, for every role and
// scope, as pure functions, with no request. mcp.test.ts runs a few through the route.
import { type DispatchResult, describeTools, type Grant, type Members, ROLES, registry, SCOPES, type ToolServices } from '@signforge/tools';
import { describe, expect, it } from 'vitest';
import { callResult, listedTools } from '../src/mcp/tools';

/** Every role with every scope, the org letting editors publish or not. */
const GRANTS: Grant[] = ROLES.flatMap((role) => [true, false].map((editorsPublish) => ({ role, scopes: [...SCOPES], editorsPublish })));
/** A caller with every service but the member tools' session, as `/mcp` builds it. */
const AGENT: ToolServices = {};
const members: Members = {
  invite: async () => {
    throw new Error('not called');
  },
  cancelInvitation: async () => {},
  updateRole: async () => {},
  remove: async () => {},
};

describe('tools/list', () => {
  it('lists exactly the tools the grant permits that need nothing this caller lacks, each with an object input', () => {
    for (const grant of GRANTS) {
      const permitted = describeTools(registry, grant).map((t) => t.name);
      const listed = listedTools(grant, AGENT);
      const lacking = permitted.filter((name) => (registry.get(name)?.needs ?? []).length > 0);
      expect(
        listed.map((t) => t.name),
        `${grant.role} ${grant.editorsPublish}`,
      ).toEqual(permitted.filter((name) => !lacking.includes(name)));
      for (const t of listed) expect(t.inputSchema.type, t.name).toBe('object');
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
