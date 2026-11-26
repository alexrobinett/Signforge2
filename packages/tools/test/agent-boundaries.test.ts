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
  update_agent_grant_scopes: { grantId: 'agt_boundaries', scopes: ['content:read', 'content:publish'], ifVersion: 1 },
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
  finish_connection: { oauthState: 'state', code: 'code' },
  // Who publishes, how long the trail is kept, and who hears an agent was refused.
  update_org_settings: { auditRetentionDays: 30 },
  // Where alerts go: an agent could silence or redirect every one (review of #419).
  set_alert_channel: { kind: 'webhook', webhookUrl: 'https://evil.example/hook' },
  remove_alert_channel: { channel: 'webhook' },
  test_alert_channel: { channel: 'email' },
  retry_alert_delivery: { alertDeliveryId: 'dlv_boundaries' },
  // Pairing a screen: a code planted in a feed would pair a device that gets every publish (review of #419).
  claim_screen: { code: 'ABCDEF', name: 'Lobby', timezone: 'UTC', orientation: 'landscape' },
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

  it('is refused editorsPublish, auditRetentionDays and the agent_refused alert, alone or with another field, and may change the rest', async () => {
    for (const [via, caller] of Object.entries(agents())) {
      for (const input of [
        { editorsPublish: false },
        { auditRetentionDays: 3650 },
        { timezone: 'UTC', editorsPublish: true },
        { alerts: { agent_refused: { email: false } } },
        { alerts: { screen_offline: { email: false }, agent_refused: { who: 'owners' } } },
      ]) {
        expect(await dispatch(registry, 'update_org_settings', input, caller), via).toMatchObject({
          ok: false,
          error: 'forbidden',
          message: expect.stringContaining('ask an owner'),
        });
      }
      expect(await dispatch(registry, 'update_org_settings', { unreachableAfterMinutes: 20 }, caller), via).toMatchObject({ ok: true });
      expect(await dispatch(registry, 'update_org_settings', { alerts: { screen_offline: { slack: false } } }, caller), via).toMatchObject({ ok: true });
    }
    // A person may.
    expect(await dispatch(registry, 'update_org_settings', { editorsPublish: false, auditRetentionDays: 400 }, owner())).toMatchObject({
      ok: true,
      output: { settings: { editorsPublish: false, auditRetentionDays: 400 } },
    });
  });

  it('finds no tool that invites, changes a role or removes a member: a person does, in the CMS (#321, #345; agent-security.test.ts in apps/api checks Better Auth refuses its token)', async () => {
    for (const name of ['invite_member', 'update_member_role', 'remove_member'])
      for (const [via, caller] of Object.entries(agents()))
        expect(await dispatch(registry, name, {}, caller), `${name} via ${via}`).toMatchObject({ ok: false, error: 'unknown_tool' });
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

  it('treats an agent apart only in a tool that says why (`partialAgents`), or refuses it the whole tool (`people`) (reviews of #419)', () => {
    const tools = [...registry.values()];
    for (const tool of tools) {
      expect(tool.people && tool.partialAgents, `${tool.name}: people, or partial, not both`).toBeFalsy();
      if (tool.partialAgents !== undefined) expect(tool.partialAgents.trim(), tool.name).not.toBe('');
    }
    // A backstop, not the rule: a handler that names a check of agents (or a helper that makes one) must declare it.
    // A check in a helper not named here escapes it, so the declaration, read by people, is what holds.
    const AGENT_CHECKS = /isAgent|peopleAllowSample|keptFor/;
    for (const tool of tools) if (AGENT_CHECKS.test(String(tool.handler))) expect(tool.people || tool.partialAgents !== undefined, tool.name).toBe(true);
    // And every declaration is borne out by its handler, so none is left once the rule goes.
    for (const tool of tools) if (tool.partialAgents !== undefined) expect(AGENT_CHECKS.test(String(tool.handler)), tool.name).toBe(true);
  });
});
