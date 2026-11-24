// The agent security pass (M4-17, #122): every tool that would widen an agent's own power or hide its
// trail refuses an agent, over /mcp or the CMS's own drawer agent, even one whose member is an owner
// holding every scope; and nothing of the call is written. The threat model is docs/architecture.md
// (Agents); /mcp's own paths (tokens, grants, members) are apps/api/test/agent-security.test.ts.
import { scoped } from '@signforge/db';
import { seedOrg, seedTeam, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Caller, dispatch, registry, SCOPES } from '../src';
import { unlimited } from './calls';
import { fakeServices } from './services';

let o: SeededOrg;
beforeAll(async () => {
  o = await seedOrg(env.DB, 'agent-boundaries');
  await seedTeam(env.DB, o.orgId);
});

const owner = (): Caller => ({
  org: scoped(env.DB, o.orgId),
  role: 'owner',
  actor: { kind: 'user', id: `${o.orgId}-owner`, clientId: 'cms' },
  blobs: env.BLOBS,
  services: fakeServices,
  member: `${o.orgId}-owner`,
});
/** An owner's agent over /mcp, with every scope; and the CMS's own agent, which acts as the owner. */
const agents = (): Record<string, Caller> => ({
  mcp: { ...owner(), actor: { kind: 'agent', id: 'agt_boundaries', clientId: 'some-agent' }, scopes: [...SCOPES], agentLimiter: unlimited },
  drawer: { ...owner(), actor: { kind: 'user', id: `${o.orgId}-owner`, clientId: 'cms-agent' } },
});

/** Each tool, with an input it accepts, an agent is refused: who grants and approves, what runs on screens, what records it. */
const REFUSED: Record<string, Record<string, unknown>> = {
  // Its own grant, and every other: scopes, revocation and usage.
  list_agent_grants: {},
  get_agent_grant: { grantId: 'agt_boundaries' },
  update_agent_grant_scopes: { grantId: 'agt_boundaries', scopes: ['content:read', 'content:publish'] },
  revoke_agent_grant: { grantId: 'agt_other' },
  get_agent_grant_usage: { grantId: 'agt_boundaries' },
  // Approvals: deciding a request, its own included.
  approve_publish_request: { publishRequestId: 'prq_boundaries' },
  decline_publish_request: { publishRequestId: 'prq_boundaries' },
  reopen_publish_request: { publishRequestId: 'prq_boundaries' },
  // Template approval: code that runs on every screen showing it.
  set_template_version_status: { templateVersionId: 'tpv_boundaries', status: 'approved' },
  // Connections: an account at a provider is a person's choice.
  start_connection: { provider: 'fake' },
  // Who publishes, and how long the trail is kept.
  update_org_settings: { auditRetentionDays: 30 },
  // Members: role changes and removals.
  update_member_role: { memberId: 'mem_boundaries', role: 'owner' },
  remove_member: { memberId: 'mem_boundaries' },
  // The model key: who pays, and what data leaves SignForge.
  save_ai_provider: { provider: 'anthropic', apiKey: 'sk-ant-api03-example-key-0000000000000000' },
  test_ai_provider: {},
  remove_ai_provider: {},
};

describe("an agent, even an owner's with every scope", () => {
  it.each(Object.entries(REFUSED))('is refused %s, and nothing is written', async (name, input) => {
    expect(registry.get(name), name).toBeDefined();
    for (const [via, caller] of Object.entries(agents())) {
      const before = await caller.org.auditLog.list({ limit: 1000 });
      const settings = await caller.org.settings.get();
      expect(await dispatch(registry, name, input, caller), `${name} via ${via}`).toMatchObject({ ok: false, error: 'forbidden' });
      expect(await caller.org.auditLog.list({ limit: 1000 }), `${name} via ${via}`).toEqual(before);
      expect(await caller.org.settings.get(), `${name} via ${via}`).toEqual(settings);
    }
  });

  it('is refused editorsPublish and auditRetentionDays, alone or with another field, and may change the rest', async () => {
    for (const [via, caller] of Object.entries(agents())) {
      for (const input of [{ editorsPublish: false }, { auditRetentionDays: 3650 }, { timezone: 'UTC', editorsPublish: true }]) {
        expect(await dispatch(registry, 'update_org_settings', input, caller), via).toMatchObject({
          ok: false,
          error: 'forbidden',
          message: expect.stringContaining('ask an owner'),
        });
      }
      expect(await dispatch(registry, 'update_org_settings', { unreachableAfterMinutes: 20 }, caller), via).toMatchObject({ ok: true });
    }
    // A person may.
    expect(await dispatch(registry, 'update_org_settings', { editorsPublish: false, auditRetentionDays: 400 }, owner())).toMatchObject({
      ok: true,
      output: { settings: { editorsPublish: false, auditRetentionDays: 400 } },
    });
  });

  it('is refused every people-only tool, at the dispatcher, before its input is read', async () => {
    const people = [...registry.values()].filter((t) => t.people).map((t) => t.name);
    // The ones above, and the rest the registry marks: a new people-only tool is held to it here too.
    expect(people).toEqual(expect.arrayContaining(Object.keys(REFUSED).filter((n) => registry.get(n)?.people)));
    for (const name of people)
      for (const [via, caller] of Object.entries(agents()))
        expect(await dispatch(registry, name, {}, caller), `${name} via ${via}`).toMatchObject({
          ok: false,
          error: 'forbidden',
          message: expect.stringContaining('for people only'),
        });
  });
});
