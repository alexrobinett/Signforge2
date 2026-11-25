// The dispatcher: role and scope checks, input validation, and the audit log.
import { seedOrg, seedTeam, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  describeTools,
  dispatch,
  effectiveScopes,
  grantOf,
  platformRegistry,
  redact,
  registry,
  ROLES,
  TOOLS,
  type AgentAllowance,
  type AgentLimiter,
  type AgentLimitWindow,
  type Caller,
  type Role,
  type Scope,
  type ScreenNotifier,
  ToolError,
  type ToolServices,
} from '../src';
import { racing } from './calls';
import { fakeServices } from './services';

let o: SeededOrg;
/** An agent's limiter that always allows: these tests are about something else. */
const unlimited: AgentLimiter = { take: async () => ({ ok: true }), audited: async () => {} };
const caller = (role: Role, scopes?: Scope[], actor: Caller['actor'] = { kind: 'user', id: 'user-1', clientId: 'cms' }): Caller => ({
  org: testScope(env.DB, o.orgId),
  role,
  scopes,
  actor,
  blobs: env.BLOBS,
  services: fakeServices,
  agentLimiter: unlimited,
});

beforeAll(async () => {
  o = await seedOrg(env.DB, 'disp-org');
});

describe('the registry', () => {
  it('has unique snake_case names, an agent description, and examples its schemas accept', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.input.safeParse(t.example).success, `${t.name} example`).toBe(true);
      // Reads never need more than content:read, but for the org's pending invitations (invitees' addresses,
      // owners' to see: M4 plan, Q6); changes always do, but for a member's own agent grants, which a
      // viewer manages too and no agent may (M4-07: the grant tools refuse agents themselves).
      const peoples = ['update_agent_grant_scopes', 'revoke_agent_grant'].includes(t.name);
      expect(t.mutates, t.name).toBe((t.scope !== 'content:read' || peoples) && t.name !== 'list_invitations');
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it('lists the first tools', () => {
    expect([...registry.keys()].sort()).toEqual([
      'add_group_members',
      'approve_publish_request',
      'assign_brand_kit',
      'cancel_invitation',
      'check_publish_request',
      'claim_screen',
      'count_drafts',
      'create_asset_upload',
      'create_brand_kit',
      'create_data_source',
      'create_group',
      'create_playlist',
      'create_schedule_entry',
      'create_spot',
      'create_video_upload',
      'decline_publish_request',
      'delete_asset',
      'delete_data_source',
      'delete_group',
      'delete_playlist',
      'delete_schedule_entry',
      'delete_spot',
      'describe',
      'disconnect',
      'end_takeover',
      'finalize_asset',
      'finalize_video_upload',
      'find_places',
      'finish_connection',
      'get_agent_draft',
      'get_agent_grant',
      'get_agent_grant_usage',
      'get_ai_provider',
      'get_alert_channels',
      'get_asset',
      'get_brand_kit',
      'get_data_source',
      'get_org_settings',
      'get_playlist',
      'get_publish',
      'get_publish_request',
      'get_screen',
      'get_spot',
      'get_spot_preview',
      'get_template',
      'identify_screen',
      'invite_member',
      'keep_playlist_draft',
      'keep_spot_draft',
      'list_agent_grants',
      'list_alert_deliveries',
      'list_assets',
      'list_audit_log',
      'list_brand_kits',
      'list_connections',
      'list_data_sources',
      'list_fonts',
      'list_groups',
      'list_invitations',
      'list_label_keys',
      'list_members',
      'list_playlists',
      'list_publish_requests',
      'list_publishes',
      'list_schedule_entries',
      'list_screen_status',
      'list_screens',
      'list_spots',
      'list_templates',
      'publish',
      'publish_manifest_to_screen',
      'publish_takeover',
      'read',
      'read_table',
      'register_template_version',
      'remove_ai_provider',
      'remove_alert_channel',
      'remove_group_members',
      'remove_member',
      'rename_group',
      'rename_screen',
      'renew_asset_upload',
      'reopen_publish_request',
      'request_publish',
      'restart_screen',
      'retry_alert_delivery',
      'revert_playlist_draft',
      'revert_spot_draft',
      'revoke_agent_grant',
      'revoke_screen_credential',
      'roll_back_publish',
      'save_ai_provider',
      'set_default_brand_kit',
      'set_default_playlist',
      'set_display_override',
      'set_group_members',
      'set_slack_alert_channel',
      'set_template_version_status',
      'set_webhook_alert_channel',
      'start_connection',
      'start_takeover',
      'test_ai_provider',
      'test_alert_channel',
      'update_agent_grant_scopes',
      'update_brand_kit',
      'update_data_source',
      'update_member_role',
      'update_org_settings',
      'update_playlist',
      'update_schedule_entry',
      'update_screen_labels',
      'update_screen_settings',
      'update_spot',
    ]);
  });

  it('gives every creating tool an idempotency key', () => {
    const keyed = TOOLS.filter((t) => t.idempotent)
      .map((t) => t.name)
      .sort();
    expect(keyed).toEqual([
      'claim_screen',
      'create_asset_upload',
      'create_brand_kit',
      'create_data_source',
      'create_group',
      'create_playlist',
      'create_schedule_entry',
      'create_spot',
      'create_video_upload',
      'request_publish',
      'start_takeover',
    ]);
    for (const t of TOOLS.filter((t) => t.name.startsWith('create_'))) expect(t.idempotent, t.name).toBe(true);
    for (const name of keyed) {
      const schema = describeTools(registry, { role: 'owner', editorsPublish: true }).find((t) => t.name === name)!.inputSchema;
      expect(schema.properties, name).toHaveProperty('idempotencyKey');
      expect(schema.required ?? [], name).not.toContain('idempotencyKey');
    }
    // register_template_version is idempotent by its natural key: a version is registered once (templates.test.ts).
  });

  it('keeps the platform tools apart: base templates only, never on /api', () => {
    expect([...platformRegistry.keys()].sort()).toEqual(['register_template_version', 'set_template_version_status']);
  });
});

describe('roles and scopes', () => {
  it('cap a grant at what the role allows, as the org has it', () => {
    const on = { editorsPublish: true };
    expect(effectiveScopes({ role: 'viewer', ...on })).toEqual(['content:read']);
    expect(effectiveScopes({ role: 'editor', ...on })).toContain('content:publish');
    expect(effectiveScopes({ role: 'editor', editorsPublish: false })).toEqual(['content:read', 'content:draft', 'screens:manage']);
    expect(effectiveScopes({ role: 'owner', editorsPublish: false })).toContain('content:publish');
    expect(effectiveScopes({ role: 'viewer', scopes: ['content:read', 'content:publish'], ...on })).toEqual(['content:read']);
    expect(effectiveScopes({ role: 'owner', scopes: ['content:draft'], ...on })).toEqual(['content:draft']);
  });

  it('let viewers read and nothing else', async () => {
    expect(await dispatch(registry, 'list_screens', {}, caller('viewer'))).toMatchObject({ ok: true });
    expect(await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'x' }, caller('viewer'))).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await dispatch(registry, 'publish_manifest_to_screen', { screenId: o.screen, manifestId: 'f'.repeat(64) }, caller('viewer'))).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
  });

  it('let editors publish and manage screens, and keep credential revocation for owners', async () => {
    expect(await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'Editor named' }, caller('editor'))).toMatchObject({ ok: true });
    // Forbidden on role, before the input is looked at.
    expect(await dispatch(registry, 'revoke_screen_credential', {}, caller('editor'))).toMatchObject({ ok: false, error: 'forbidden' });
    // Allowed past the check: the manifest was never uploaded, so it is not found.
    expect(await dispatch(registry, 'publish_manifest_to_screen', { screenId: o.screen, manifestId: 'f'.repeat(64) }, caller('editor'))).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });

  it('refuse a tool outside the grant even for an owner', async () => {
    const draftOnly = caller('owner', ['content:read', 'content:draft'], { kind: 'agent', id: 'grant-1', clientId: 'agent-app' });
    expect(await dispatch(registry, 'publish_manifest_to_screen', { screenId: o.screen, manifestId: 'f'.repeat(64) }, draftOnly)).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'x' }, draftOnly)).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('decide what GET /api/tools lists', () => {
    const names = (role: Role, scopes?: Scope[]) => describeTools(registry, { role, scopes, editorsPublish: true }).map((t) => t.name);
    expect(names('viewer').sort()).toEqual([
      'check_publish_request',
      'count_drafts',
      'describe',
      'find_places',
      'get_agent_draft',
      'get_agent_grant',
      'get_agent_grant_usage',
      'get_ai_provider',
      'get_alert_channels',
      'get_asset',
      'get_brand_kit',
      'get_data_source',
      'get_org_settings',
      'get_playlist',
      'get_publish',
      'get_publish_request',
      'get_screen',
      'get_spot',
      'get_spot_preview',
      'get_template',
      'list_agent_grants',
      'list_alert_deliveries',
      'list_assets',
      'list_audit_log',
      'list_brand_kits',
      'list_connections',
      'list_data_sources',
      'list_fonts',
      'list_groups',
      'list_label_keys',
      'list_members',
      'list_playlists',
      'list_publish_requests',
      'list_publishes',
      'list_schedule_entries',
      'list_screen_status',
      'list_screens',
      'list_spots',
      'list_templates',
      'read',
      'read_table',
      'revoke_agent_grant',
      'update_agent_grant_scopes',
    ]);
    expect(names('editor')).not.toContain('revoke_screen_credential');
    expect(names('editor')).not.toContain('set_template_version_status');
    expect(names('editor')).not.toContain('update_org_settings');
    expect(names('owner')).toHaveLength(TOOLS.length);
    const listed = describeTools(registry, { role: 'owner', editorsPublish: true }).find((t) => t.name === 'rename_screen')!;
    expect(listed).toMatchObject({ scope: 'screens:manage', minRole: 'editor', mutates: true });
    expect(listed.inputSchema).toMatchObject({ type: 'object', required: ['screenId', 'name'] });
    expect(ROLES).toEqual(['viewer', 'editor', 'owner']);
  });
});

describe('whether editors publish (Q7, an org setting)', () => {
  let q: SeededOrg;
  const as = (role: Role, scopes?: Scope[], actor: Caller['actor'] = { kind: 'user', id: `q7-${role}`, clientId: 'cms' }): Caller => ({
    org: testScope(env.DB, q.orgId),
    role,
    scopes,
    actor,
    blobs: env.BLOBS,
    services: fakeServices,
    agentLimiter: unlimited,
  });
  const editorsAgent = () => as('editor', ['content:read', 'content:draft', 'content:publish'], { kind: 'agent', id: 'grant-q7', clientId: 'agent-app' });
  // Past the role and scope check, the manifest was never uploaded: not_found means the call was allowed.
  const publish = (c: Caller) => dispatch(registry, 'publish_manifest_to_screen', { screenId: q.screen, manifestId: 'f'.repeat(64) }, c);
  const setEditorsPublish = async (on: boolean) =>
    expect(await dispatch(registry, 'update_org_settings', { editorsPublish: on }, as('owner'))).toMatchObject({ ok: true });

  beforeAll(async () => {
    q = await seedOrg(env.DB, 'q7-org');
  });

  it('lets editors and their agents publish while it is on, the default', async () => {
    expect(await publish(as('editor'))).toMatchObject({ ok: false, error: 'not_found' });
    expect(await publish(editorsAgent())).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('keeps publishing for owners when it is off, and says why an editor and their agent are refused', async () => {
    await setEditorsPublish(false);
    const refused = { ok: false, error: 'forbidden', message: 'Only owners publish in this organization' };
    expect(await publish(as('editor'))).toMatchObject(refused);
    expect(await publish(editorsAgent())).toMatchObject(refused);
    expect(await publish(as('owner'))).toMatchObject({ ok: false, error: 'not_found' });
    // The editor keeps the rest of the role.
    expect(await dispatch(registry, 'rename_screen', { screenId: q.screen, name: 'Still mine' }, as('editor'))).toMatchObject({ ok: true });
    expect(await dispatch(registry, 'list_screens', {}, editorsAgent())).toMatchObject({ ok: true });
    await setEditorsPublish(true);
    expect(await publish(as('editor'))).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('decides what an editor is offered', async () => {
    const offered = async () => describeTools(registry, await grantOf(as('editor'))).map((t) => t.name);
    expect(await offered()).toContain('publish_manifest_to_screen');
    await setEditorsPublish(false);
    expect(await offered()).not.toContain('publish_manifest_to_screen');
    expect(await offered()).toContain('rename_screen');
    await setEditorsPublish(true);
  });
});

describe('input', () => {
  it('is validated before the handler runs', async () => {
    const r = await dispatch(registry, 'rename_screen', { screenId: 'not/an id', name: '' }, caller('owner'));
    expect(r).toMatchObject({ ok: false, error: 'invalid_input' });
    expect((r as { details: { path: string }[] }).details.map((d) => d.path).sort()).toEqual(['name', 'screenId']);
  });

  it('names an unknown tool', async () => {
    expect(await dispatch(registry, 'drop_tables', {}, caller('owner'))).toMatchObject({ ok: false, error: 'unknown_tool' });
  });
});

describe('the audit log', () => {
  it('records each change with actor kind and id, client, action, target and input', async () => {
    const org = testScope(env.DB, o.orgId);
    const agent = caller('editor', undefined, { kind: 'agent', id: 'grant-9', clientId: 'oauth-client-9' });
    expect(await dispatch(registry, 'rename_group', { groupId: o.group, name: 'Audited' }, agent)).toMatchObject({ ok: true });
    const [entry] = await org.auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({
      actorKind: 'agent',
      actorId: 'grant-9',
      clientId: 'oauth-client-9',
      action: 'rename_group',
      targetKind: 'group',
      targetId: o.group,
    });
    expect(JSON.parse(entry!.detailJson!)).toEqual({ input: { groupId: o.group, name: 'Audited' } });
  });

  it('does not record reads or refusals', async () => {
    const org = testScope(env.DB, o.orgId);
    const count = async () => (await org.auditLog.list({ limit: 1000 })).length;
    const n = await count();
    await dispatch(registry, 'list_screens', {}, caller('owner'));
    await dispatch(registry, 'get_screen', { screenId: o.screen }, caller('owner'));
    await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'x' }, caller('viewer'));
    await dispatch(registry, 'rename_screen', { screenId: 'nope', name: 'x' }, caller('owner'));
    await dispatch(registry, 'rename_screen', { screenId: o.screen, name: '' }, caller('owner'));
    expect(await count()).toBe(n);
  });

  it('redacts secrets in the detail', async () => {
    const secretive = defineTool({
      name: 'set_feed_secret',
      description: 'A test tool whose input carries secrets, to show they never reach the audit log.',
      scope: 'content:draft',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string(), apiKey: z.string(), nested: z.object({ token: z.string(), credentialId: z.string() }) }),
      output: z.object({ done: z.boolean() }),
      example: { screenId: 's', apiKey: 'k', nested: { token: 't', credentialId: 'c' } },
      handler: async ({ org, input, write }) => {
        write(org.screens.stage.update((await org.screens.get(input.screenId))!, { name: 'Has a feed' }));
        return { done: true };
      },
    });
    const reg = new Map([[secretive.name, secretive]]);
    const input = { screenId: o.screen, apiKey: 'sk_live_123', nested: { token: 'tok_456', credentialId: 'crd_1' } };
    expect(await dispatch(reg, 'set_feed_secret', input, caller('owner'))).toMatchObject({ ok: true });
    const [entry] = await testScope(env.DB, o.orgId).auditLog.list({ limit: 1 });
    expect(entry!.detailJson).not.toMatch(/sk_live_123|tok_456/);
    expect(JSON.parse(entry!.detailJson!)).toEqual({
      input: { screenId: o.screen, apiKey: '[redacted]', nested: { token: '[redacted]', credentialId: 'crd_1' } },
    });
  });

  it("records a tool's auditDetail under its own key, redacted, never over the input", async () => {
    const telling = defineTool({
      name: 'rename_and_tell',
      description: 'A test tool that adds to its audit row what its input does not name, with a secret and an input key in it.',
      scope: 'content:draft',
      minRole: 'editor',
      mutates: true,
      input: z.object({ screenId: z.string() }),
      output: z.object({ done: z.boolean() }),
      example: { screenId: 's' },
      auditDetail: () => ({ input: 'not the input', token: 'tok_789', made: 'pls_1' }),
      handler: async ({ org, input, write }) => {
        write(org.screens.stage.update((await org.screens.get(input.screenId))!, { name: 'Told' }));
        return { done: true };
      },
    });
    expect(await dispatch(new Map([[telling.name, telling]]), telling.name, { screenId: o.screen }, caller('owner'))).toMatchObject({ ok: true });
    const [entry] = await testScope(env.DB, o.orgId).auditLog.list({ limit: 1 });
    expect(entry!.detailJson).not.toContain('tok_789');
    expect(JSON.parse(entry!.detailJson!)).toEqual({
      input: { screenId: o.screen },
      detail: { input: 'not the input', token: '[redacted]', made: 'pls_1' },
    });
  });

  it('redact() knows the usual names', () => {
    expect(
      redact({
        password: 'p',
        secret: 's',
        code: '123456',
        pairingCode: 'ABC',
        authorization: 'Bearer x',
        urlEncrypted: 'e',
        oauthState: 'st',
        resource: 'sheet',
        name: 'n',
        screenIds: ['a'],
      }),
    ).toEqual({
      password: '[redacted]',
      secret: '[redacted]',
      code: '[redacted]',
      pairingCode: '[redacted]',
      authorization: '[redacted]',
      urlEncrypted: '[redacted]',
      oauthState: '[redacted]',
      resource: '[redacted]',
      name: 'n',
      screenIds: ['a'],
    });
  });
});

describe('write safety', () => {
  it('undoes what a handler did outside the batch when, and only when, the call does not succeed', async () => {
    const undone: string[] = [];
    const tool = (name: string, refuse: boolean) =>
      defineTool({
        name,
        description: 'A test tool that does something outside the batch, then succeeds or refuses.',
        scope: 'screens:manage',
        minRole: 'editor',
        mutates: true,
        input: z.object({ groupId: z.string() }),
        output: z.object({ ok: z.boolean() }),
        example: { groupId: 'grp_example' },
        handler: async ({ org, input, write, onDiscard }) => {
          onDiscard(async () => {
            undone.push(name);
          });
          if (refuse) throw new ToolError('conflict', 'refused after the outside effect');
          const group = await org.screenGroups.get(input.groupId);
          if (group) write(org.screenGroups.stage.update(group, { name: `${name} ran` }));
          return { ok: true };
        },
      });
    for (const [name, refuse] of [
      ['outside_then_ok', false],
      ['outside_then_refuse', true],
    ] as const) {
      const t = tool(name, refuse);
      await dispatch(new Map([[t.name, t]]), t.name, { groupId: o.group }, caller('owner'));
    }
    expect(undone).toEqual(['outside_then_refuse']);
  });

  it('rolls the change back when its audit row cannot be written', async () => {
    const org = testScope(env.DB, o.orgId);
    const before = await org.screenGroups.get(o.group);
    await env.DB.exec("CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    try {
      await expect(dispatch(registry, 'rename_group', { groupId: o.group, name: 'Never recorded' }, caller('owner'))).rejects.toThrow();
    } finally {
      await env.DB.exec('DROP TRIGGER audit_down');
    }
    expect(await org.screenGroups.get(o.group)).toEqual(before);
  });
  it('creates once for a retried key, returning the first result and writing nothing', async () => {
    const org = testScope(env.DB, o.orgId);
    const audits = async () => (await org.auditLog.list({ limit: 1000 })).length;
    const groups = async () => (await org.screenGroups.list()).filter((g) => g.name === 'Retried').length;
    const input = { name: 'Retried', screenIds: [o.screen], idempotencyKey: 'retry-key-1' };
    const first = await dispatch(registry, 'create_group', input, caller('editor'));
    expect(first).toMatchObject({ ok: true });
    const n = await audits();
    const again = await dispatch(registry, 'create_group', input, caller('editor'));
    expect(again).toEqual(first);
    expect(await groups()).toBe(1);
    expect(await audits()).toBe(n);
  });

  it('creates once when two calls with the same key race', async () => {
    const input = { name: 'Raced', idempotencyKey: 'retry-key-race' };
    const [x, y] = await Promise.all([1, 2].map(() => dispatch(registry, 'create_group', input, caller('editor'))));
    expect(x).toMatchObject({ ok: true });
    expect(y).toEqual(x);
    expect((await testScope(env.DB, o.orgId).screenGroups.list()).filter((g) => g.name === 'Raced')).toHaveLength(1);
  });

  it('refuses a key reused for a different input, and keeps keys apart between orgs', async () => {
    const input = { name: 'Keyed', idempotencyKey: 'retry-key-2' };
    expect(await dispatch(registry, 'create_group', input, caller('editor'))).toMatchObject({ ok: true });
    expect(await dispatch(registry, 'create_group', { ...input, name: 'Other' }, caller('editor'))).toMatchObject({ ok: false, error: 'conflict' });
    const other = await seedOrg(env.DB, 'disp-org-2');
    const r = await dispatch(registry, 'create_group', input, { ...caller('editor'), org: testScope(env.DB, other.orgId) });
    expect(r).toMatchObject({ ok: true });
    expect(await testScope(env.DB, other.orgId).screenGroups.list()).toContainEqual(expect.objectContaining({ name: 'Keyed' }));
  });
});

describe("an agent grant's limits", () => {
  const agent: Caller['actor'] = { kind: 'agent', id: 'grant-limits', clientId: 'agent-app' };
  /** A limiter that answers what the test says and records what it was asked and told. */
  const scripted = (answer: () => AgentAllowance) => {
    const asked: { grantId: string; write: boolean }[] = [];
    const audited: { grantId: string; window: AgentLimitWindow }[] = [];
    const agentLimiter: AgentLimiter = {
      take: async (grantId, write) => {
        asked.push({ grantId, write });
        return answer();
      },
      audited: async (grantId, window) => void audited.push({ grantId, window }),
    };
    return { asked, audited, agentLimiter };
  };
  const audits = () => testScope(env.DB, o.orgId).auditLog.list({ limit: 1000 });

  it('refuse a call over a limit before the handler runs, writing nothing and leaving its key unused', async () => {
    let over = true;
    const { agentLimiter } = scripted(() => (over ? { ok: false, limit: 'writes_per_minute', retryAfterSeconds: 12 } : { ok: true }));
    const input = { name: 'Limited', idempotencyKey: 'limited-key-1' };
    const n = (await audits()).length;
    const refused = await dispatch(registry, 'create_group', input, { ...caller('editor', undefined, agent), agentLimiter });
    expect(refused).toEqual({
      ok: false,
      error: 'rate_limited',
      message: 'this agent grant made 30 changes this minute, its limit; try again in 12 s',
      details: { limit: 'writes_per_minute', retryAfterSeconds: 12 },
    });
    expect((await testScope(env.DB, o.orgId).screenGroups.list()).filter((g) => g.name === 'Limited')).toHaveLength(0);
    expect(await audits()).toHaveLength(n);
    // After the reset, the same key creates.
    over = false;
    expect(await dispatch(registry, 'create_group', input, { ...caller('editor', undefined, agent), agentLimiter })).toMatchObject({ ok: true });
    expect((await testScope(env.DB, o.orgId).screenGroups.list()).filter((g) => g.name === 'Limited')).toHaveLength(1);
  });

  it("record a window's refusals in one row, however often the limiter asks for it", async () => {
    // A limiter that never hears it was written, as when concurrent refusals all ask for the row.
    const window: AgentLimitWindow = { window: 'day', start: 3 * 86_400_000 };
    const { agentLimiter, audited } = scripted(() => ({ ok: false, limit: 'writes_per_day', retryAfterSeconds: 3600, audit: window }));
    const before = (await audits()).length;
    for (let i = 0; i < 3; i++) {
      expect(
        await dispatch(registry, 'rename_group', { groupId: o.group, name: 'Over' }, { ...caller('editor', undefined, agent), agentLimiter }),
      ).toMatchObject({
        ok: false,
        error: 'rate_limited',
        message: 'this agent grant made 2000 changes today (UTC), its limit; try again in 3600 s',
      });
    }
    const all = await audits();
    expect(all).toHaveLength(before + 1);
    expect(audited).toEqual([1, 2, 3].map(() => ({ grantId: 'grant-limits', window })));
    expect(all[0]).toMatchObject({ actorKind: 'agent', actorId: 'grant-limits', clientId: 'agent-app', action: 'rate_limited', targetKind: null });
    expect(JSON.parse(all[0]!.detailJson!)).toEqual({
      tool: 'rename_group',
      refused: {
        error: 'rate_limited',
        message: 'this agent grant made 2000 changes today (UTC), its limit; try again in 3600 s',
        details: { limit: 'writes_per_day', retryAfterSeconds: 3600 },
      },
    });
  });

  it('count every call by its grant, and a changing tool as a write', async () => {
    const { asked, agentLimiter } = scripted(() => ({ ok: true }));
    const as = { ...caller('editor', undefined, agent), agentLimiter };
    await dispatch(registry, 'list_screens', {}, as);
    await dispatch(registry, 'rename_group', { groupId: o.group, name: 'Counted' }, as);
    await dispatch(registry, 'identify_screen', { screenId: o.screen }, as);
    expect(asked).toEqual([
      { grantId: 'grant-limits', write: false },
      { grantId: 'grant-limits', write: true },
      { grantId: 'grant-limits', write: true },
    ]);
  });

  it('never count a person', async () => {
    const { asked, agentLimiter } = scripted(() => ({ ok: false, limit: 'calls_per_minute', retryAfterSeconds: 1, audit: { window: 'minute', start: 0 } }));
    expect(await dispatch(registry, 'rename_group', { groupId: o.group, name: 'By a person' }, { ...caller('editor'), agentLimiter })).toMatchObject({
      ok: true,
    });
    expect(asked).toEqual([]);
  });

  it('refuse to run an agent without its limiter', async () => {
    const { agentLimiter: _, ...noLimiter } = caller('editor', undefined, agent);
    await expect(dispatch(registry, 'list_screens', {}, noLimiter)).rejects.toThrow(/limiter/);
    await expect(dispatch(registry, 'drop_tables', {}, noLimiter)).rejects.toThrow(/limiter/);
  });

  it('count a call to a tool that does not exist, and refuse it over the limit', async () => {
    let over = false;
    const { asked, agentLimiter } = scripted(() =>
      over ? { ok: false, limit: 'calls_per_minute', retryAfterSeconds: 5, audit: { window: 'minute', start: 60_000 } } : { ok: true },
    );
    const as = { ...caller('editor', undefined, agent), agentLimiter };
    expect(await dispatch(registry, 'drop_tables', {}, as)).toMatchObject({ ok: false, error: 'unknown_tool' });
    expect(asked).toEqual([{ grantId: 'grant-limits', write: false }]);
    over = true;
    expect(await dispatch(registry, 'drop_tables', {}, as)).toMatchObject({ ok: false, error: 'rate_limited', details: { limit: 'calls_per_minute' } });
    const [entry] = await audits();
    expect(entry).toMatchObject({ actorId: 'grant-limits', action: 'rate_limited' });
    expect(JSON.parse(entry!.detailJson!)).toMatchObject({ tool: 'drop_tables' });
  });
});

describe("the warning when a refusal's audit row is not settled", () => {
  const agent: Caller['actor'] = { kind: 'agent', id: 'grant-warned', clientId: 'agent-app' };
  const over = (window: AgentLimitWindow, audited: AgentLimiter['audited']): AgentLimiter => ({
    take: async () => ({ ok: false, limit: 'writes_per_minute', retryAfterSeconds: 7, audit: window }),
    audited,
  });
  const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says the refusal was not recorded when its row could not be written', async () => {
    const warn = warnings();
    await env.DB.exec("CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    try {
      const r = await dispatch(
        registry,
        'rename_group',
        { groupId: o.group, name: 'Warned' },
        {
          ...caller('editor', undefined, agent),
          agentLimiter: over({ window: 'minute', start: 5 * 60_000 }, async () => {}),
        },
      );
      expect(r).toMatchObject({ ok: false, error: 'rate_limited' });
    } finally {
      await env.DB.exec('DROP TRIGGER audit_down');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toBe('[tools] could not record that agent grant grant-warned was refused');
  });

  it('says only that the window was not marked when the row was written', async () => {
    const warn = warnings();
    const r = await dispatch(
      registry,
      'rename_group',
      { groupId: o.group, name: 'Warned' },
      {
        ...caller('editor', undefined, agent),
        agentLimiter: over({ window: 'minute', start: 6 * 60_000 }, async () => Promise.reject(new Error('object unreachable'))),
      },
    );
    expect(r).toMatchObject({ ok: false, error: 'rate_limited' });
    expect((await testScope(env.DB, o.orgId).auditLog.list({ limit: 1000 })).filter((e) => e.actorId === 'grant-warned')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toBe(
      "[tools] recorded that agent grant grant-warned was refused, but could not tell its limiter: the window's next refusal tries again and writes nothing",
    );
  });
});

describe('screen notices', () => {
  /** A notifier that records what it was told. */
  const recorder = () => {
    const told: unknown[] = [];
    const screens: ScreenNotifier = {
      manifest: async (screenId, manifestId) => void told.push({ manifest: { screenId, manifestId } }),
      manifests: async (changes) => void told.push({ manifests: changes }),
      revoked: async (screenId, credentialId) => void told.push({ revoked: { screenId, credentialId } }),
      command: async (screenId, command) => void told.push({ command: { screenId, command } }),
    };
    return { told, screens };
  };
  /** Revoke the credential as an owner whose screens are reached through `screens`. */
  const revoke = (credentialId: string, screens: ScreenNotifier) =>
    dispatch(registry, 'revoke_screen_credential', { screenId: o.screen, credentialId }, { ...caller('owner'), services: { notify: screens } });

  it('tell the screen about a revoked credential once the change is committed', async () => {
    const { told, screens } = recorder();
    const cred = await testScope(env.DB, o.orgId).screens.credentials.insert({ screenId: o.screen, secretHash: '9'.repeat(64) });
    const r = await revoke(cred.id, screens);
    expect(r.ok).toBe(true);
    expect(told).toEqual([{ revoked: { screenId: o.screen, credentialId: cred.id } }]);
    // Already revoked: nothing changes, but the screen is told again, in case the first notice never arrived.
    await revoke(cred.id, screens);
    expect(told).toEqual([{ revoked: { screenId: o.screen, credentialId: cred.id } }, { revoked: { screenId: o.screen, credentialId: cred.id } }]);
  });

  it('are not sent, nor audited, for a credential revoked already when its owner was demoted between the read and the batch (#417)', async () => {
    const { told, screens } = recorder();
    const cred = await testScope(env.DB, o.orgId).screens.credentials.insert({ screenId: o.screen, secretHash: '7'.repeat(64) });
    expect((await revoke(cred.id, screens)).ok).toBe(true);
    // The owner a member, beside another owner, as the org must keep one.
    const { userId } = await seedTeam(env.DB, o.orgId);
    const now = new Date(0).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)').bind(
        `${o.orgId}-other`,
        'Other',
        `${o.orgId}-other@signforge.test`,
        now,
        now,
      ),
      env.DB.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)").bind(
        `${o.orgId}-other-member`,
        o.orgId,
        `${o.orgId}-other`,
        now,
      ),
    ]);
    const audited = await testScope(env.DB, o.orgId).auditLog.list({ limit: 1000 });
    const demoted = racing({ ...caller('owner'), member: userId, services: { notify: screens } }, () =>
      env.DB.prepare("UPDATE member SET role = 'editor' WHERE userId = ? AND organizationId = ?").bind(userId, o.orgId).run(),
    );
    // Nothing changes, so the batch is its audit row alone: held to the role all the same.
    expect(await dispatch(registry, 'revoke_screen_credential', { screenId: o.screen, credentialId: cred.id }, demoted)).toMatchObject({
      ok: false,
      error: 'forbidden',
    });
    expect(told).toHaveLength(1);
    expect(await testScope(env.DB, o.orgId).auditLog.list({ limit: 1000 })).toEqual(audited);
  });

  it('are not sent when the change is rolled back', async () => {
    const { told, screens } = recorder();
    const cred = await testScope(env.DB, o.orgId).screens.credentials.insert({ screenId: o.screen, secretHash: '8'.repeat(64) });
    await env.DB.exec("CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    try {
      await expect(revoke(cred.id, screens)).rejects.toThrow();
    } finally {
      await env.DB.exec('DROP TRIGGER audit_down');
    }
    expect(told).toEqual([]);
  });

  it('do not fail a committed change when the screen cannot be told', async () => {
    const screens: ScreenNotifier = {
      manifest: async () => {},
      manifests: async () => {},
      command: async () => {},
      revoked: async () => Promise.reject(new Error('object unreachable')),
    };
    const cred = await testScope(env.DB, o.orgId).screens.credentials.insert({ screenId: o.screen, secretHash: '7'.repeat(64) });
    const r = await revoke(cred.id, screens);
    expect(r.ok).toBe(true);
  });
});

describe('tool services', () => {
  /** A tool that needs two services, and records each run and the services it was given. */
  const ran: unknown[] = [];
  const nearby = defineTool({
    name: 'find_nearby',
    description: 'A test tool that needs a place finder and a rate limit, to show dispatch checks its needs.',
    scope: 'content:read',
    minRole: 'viewer',
    mutates: false,
    needs: ['places', 'rateLimit'],
    input: z.object({ query: z.string() }),
    output: z.object({ found: z.number() }),
    example: { query: 'Atlanta' },
    handler: async ({ input, services }) => {
      ran.push(services);
      await services.rateLimit('place_search');
      return { found: (await services.places.search(input.query)).length };
    },
  });
  const reg = new Map([[nearby.name, nearby]]);
  const places: ToolServices['places'] = { search: async () => [] };
  const rateLimit: ToolServices['rateLimit'] = async () => true;

  it('refuse a call that lacks a needed service, before the handler runs', async () => {
    ran.length = 0;
    expect(await dispatch(reg, 'find_nearby', { query: 'Atlanta' }, { ...caller('viewer'), services: {} })).toEqual({
      ok: false,
      error: 'forbidden',
      message: 'find_nearby needs a place finder and a rate limit, and this caller has none',
    });
    expect(await dispatch(reg, 'find_nearby', { query: 'Atlanta' }, { ...caller('viewer'), services: { places } })).toEqual({
      ok: false,
      error: 'forbidden',
      message: 'find_nearby needs a rate limit, and this caller has none',
    });
    expect(ran).toEqual([]);
  });

  it("reach the handler as the caller's own object", async () => {
    ran.length = 0;
    const services: ToolServices = { places, rateLimit };
    expect(await dispatch(reg, 'find_nearby', { query: 'Atlanta' }, { ...caller('viewer'), services })).toEqual({ ok: true, output: { found: 0 } });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toBe(services);
  });
});

describe('claim_screen', () => {
  it('makes a screen of the kind the screen said it is at pair start', async () => {
    const { startPairing } = await import('@signforge/db');
    await startPairing(env.DB, { code: 'TAB234', pollTokenHash: '8'.repeat(64), kind: 'browser', now: Date.now() });
    const r = await dispatch(registry, 'claim_screen', { code: 'TAB234', name: 'Test screen', timezone: 'UTC', orientation: 'landscape' }, caller('editor'));
    expect(r).toMatchObject({ ok: true, output: { screen: { name: 'Test screen', kind: 'browser' } } });
  });
});

describe('claim_screen racing', () => {
  it('refuses the loser of two claims on one code cleanly, writing nothing', async () => {
    const { startPairing } = await import('@signforge/db');
    const code = 'RACE23';
    await startPairing(env.DB, { code, pollTokenHash: '9'.repeat(64), now: Date.now() });
    const other = await seedOrg(env.DB, 'disp-race');
    const input = { code, name: 'Lobby', timezone: 'UTC', orientation: 'landscape' };
    const winner = await dispatch(registry, 'claim_screen', input, { ...caller('editor'), org: testScope(env.DB, other.orgId) });
    expect(winner).toMatchObject({ ok: true });
    // The loser saw the code open just before the winner committed.
    const org = testScope(env.DB, o.orgId);
    const before = await org.screens.list();
    let checks = 0;
    const stale = { ...org, pairing: { ...org.pairing, open: async (c: string, now: number) => (checks++ === 0 ? 'device' : org.pairing.open(c, now)) } };
    const loser = await dispatch(registry, 'claim_screen', input, { ...caller('editor'), org: stale });
    expect(loser).toMatchObject({ ok: false, error: 'not_found' });
    expect(await org.screens.list()).toEqual(before);
  });
});
