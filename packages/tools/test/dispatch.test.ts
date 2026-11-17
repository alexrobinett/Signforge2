// The dispatcher: role and scope checks, input validation, and the audit log.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, describeTools, dispatch, effectiveScopes, platformRegistry, redact, registry, ROLES, TOOLS, type Caller, type Role, type Scope } from '../src';

let o: SeededOrg;
const caller = (role: Role, scopes?: Scope[], actor: Caller['actor'] = { kind: 'user', id: 'user-1', clientId: 'cms' }): Caller => ({
  org: scoped(env.DB, o.orgId),
  role,
  scopes,
  actor,
  blobs: env.BLOBS,
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
      // Reads never need more than content:read; changes always do.
      expect(t.mutates, t.name).toBe(t.scope !== 'content:read');
    }
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
  });

  it('lists the first tools', () => {
    expect([...registry.keys()].sort()).toEqual([
      'create_asset_upload', 'create_group', 'delete_asset', 'delete_group', 'finalize_asset', 'get_asset', 'get_screen', 'get_template',
      'list_assets', 'list_groups', 'list_screens', 'list_templates', 'publish_manifest_to_screen',
      'register_template_version', 'rename_group', 'rename_screen', 'revoke_screen_credential', 'set_group_members', 'set_template_version_status',
      'update_screen_settings',
    ]);
  });

  it('keeps the platform tools apart: base templates only, never on /api', () => {
    expect([...platformRegistry.keys()].sort()).toEqual(['register_template_version', 'set_template_version_status']);
  });
});

describe('roles and scopes', () => {
  it('cap a grant at what the role allows (Q7 default: editors publish)', () => {
    expect(effectiveScopes({ role: 'viewer' })).toEqual(['content:read']);
    expect(effectiveScopes({ role: 'editor' })).toContain('content:publish');
    expect(effectiveScopes({ role: 'viewer', scopes: ['content:read', 'content:publish'] })).toEqual(['content:read']);
    expect(effectiveScopes({ role: 'owner', scopes: ['content:draft'] })).toEqual(['content:draft']);
  });

  it('let viewers read and nothing else', async () => {
    expect(await dispatch(registry, 'list_screens', {}, caller('viewer'))).toMatchObject({ ok: true });
    expect(await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'x' }, caller('viewer'))).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await dispatch(registry, 'publish_manifest_to_screen', { screenId: o.screen, manifestId: 'f'.repeat(64) }, caller('viewer'))).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('let editors publish and manage screens, and keep credential revocation for owners', async () => {
    expect(await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'Editor named' }, caller('editor'))).toMatchObject({ ok: true });
    // Forbidden on role, before the input is looked at.
    expect(await dispatch(registry, 'revoke_screen_credential', {}, caller('editor'))).toMatchObject({ ok: false, error: 'forbidden' });
    // Allowed past the check: the manifest was never uploaded, so it is not found.
    expect(await dispatch(registry, 'publish_manifest_to_screen', { screenId: o.screen, manifestId: 'f'.repeat(64) }, caller('editor'))).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('refuse a tool outside the grant even for an owner', async () => {
    const draftOnly = caller('owner', ['content:read', 'content:draft'], { kind: 'agent', id: 'grant-1', clientId: 'agent-app' });
    expect(await dispatch(registry, 'publish_manifest_to_screen', { screenId: o.screen, manifestId: 'f'.repeat(64) }, draftOnly)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await dispatch(registry, 'rename_screen', { screenId: o.screen, name: 'x' }, draftOnly)).toMatchObject({ ok: false, error: 'forbidden' });
  });

  it('decide what GET /api/tools lists', () => {
    const names = (role: Role, scopes?: Scope[]) => describeTools(registry, { role, scopes }).map((t) => t.name);
    expect(names('viewer').sort()).toEqual(['get_asset', 'get_screen', 'get_template', 'list_assets', 'list_groups', 'list_screens', 'list_templates']);
    expect(names('editor')).not.toContain('revoke_screen_credential');
    expect(names('editor')).not.toContain('set_template_version_status');
    expect(names('owner')).toHaveLength(TOOLS.length);
    const listed = describeTools(registry, { role: 'owner' }).find((t) => t.name === 'rename_screen')!;
    expect(listed).toMatchObject({ scope: 'screens:manage', minRole: 'editor', mutates: true });
    expect(listed.inputSchema).toMatchObject({ type: 'object', required: ['screenId', 'name'] });
    expect(ROLES).toEqual(['viewer', 'editor', 'owner']);
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
    const org = scoped(env.DB, o.orgId);
    const agent = caller('editor', undefined, { kind: 'agent', id: 'grant-9', clientId: 'oauth-client-9' });
    expect(await dispatch(registry, 'rename_group', { groupId: o.group, name: 'Audited' }, agent)).toMatchObject({ ok: true });
    const [entry] = await org.auditLog.list({ limit: 1 });
    expect(entry).toMatchObject({
      actorKind: 'agent', actorId: 'grant-9', clientId: 'oauth-client-9', action: 'rename_group', targetKind: 'group', targetId: o.group,
    });
    expect(JSON.parse(entry!.detailJson!)).toEqual({ input: { groupId: o.group, name: 'Audited' } });
  });

  it('does not record reads or refusals', async () => {
    const org = scoped(env.DB, o.orgId);
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
      handler: async () => ({ done: true }),
    });
    const reg = new Map([[secretive.name, secretive]]);
    const input = { screenId: o.screen, apiKey: 'sk_live_123', nested: { token: 'tok_456', credentialId: 'crd_1' } };
    expect(await dispatch(reg, 'set_feed_secret', input, caller('owner'))).toMatchObject({ ok: true });
    const [entry] = await scoped(env.DB, o.orgId).auditLog.list({ limit: 1 });
    expect(entry!.detailJson).not.toMatch(/sk_live_123|tok_456/);
    expect(JSON.parse(entry!.detailJson!)).toEqual({ input: { screenId: o.screen, apiKey: '[redacted]', nested: { token: '[redacted]', credentialId: 'crd_1' } } });
  });

  it('redact() knows the usual names', () => {
    expect(redact({ password: 'p', secret: 's', code: '123456', pairingCode: 'ABC', authorization: 'Bearer x', urlEncrypted: 'e', name: 'n', screenIds: ['a'] })).toEqual({
      password: '[redacted]', secret: '[redacted]', code: '[redacted]', pairingCode: '[redacted]', authorization: '[redacted]', urlEncrypted: '[redacted]', name: 'n', screenIds: ['a'],
    });
  });
});
