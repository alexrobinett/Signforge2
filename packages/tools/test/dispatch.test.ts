// The dispatcher: role and scope checks, input validation, and the audit log.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineTool,
  describeTools,
  dispatch,
  effectiveScopes,
  platformRegistry,
  redact,
  registry,
  ROLES,
  TOOLS,
  type Caller,
  type Role,
  type Scope,
  type ScreenNotifier,
} from '../src';

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
      'add_group_members',
      'assign_brand_kit',
      'claim_screen',
      'create_asset_upload',
      'create_brand_kit',
      'create_group',
      'create_video_upload',
      'delete_asset',
      'delete_group',
      'finalize_asset',
      'finalize_video_upload',
      'get_asset',
      'get_brand_kit',
      'get_screen',
      'get_template',
      'identify_screen',
      'list_assets',
      'list_brand_kits',
      'list_fonts',
      'list_groups',
      'list_screens',
      'list_templates',
      'publish_manifest_to_screen',
      'register_template_version',
      'remove_group_members',
      'rename_group',
      'rename_screen',
      'restart_screen',
      'revoke_screen_credential',
      'set_default_brand_kit',
      'set_display_override',
      'set_group_members',
      'set_template_version_status',
      'update_brand_kit',
      'update_screen_settings',
    ]);
  });

  it('gives every creating tool an idempotency key', () => {
    const keyed = TOOLS.filter((t) => t.idempotent)
      .map((t) => t.name)
      .sort();
    expect(keyed).toEqual(['claim_screen', 'create_asset_upload', 'create_brand_kit', 'create_group', 'create_video_upload']);
    for (const t of TOOLS.filter((t) => t.name.startsWith('create_'))) expect(t.idempotent, t.name).toBe(true);
    for (const name of keyed) {
      const schema = describeTools(registry, { role: 'owner' }).find((t) => t.name === name)!.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
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
  it('cap a grant at what the role allows (Q7 default: editors publish)', () => {
    expect(effectiveScopes({ role: 'viewer' })).toEqual(['content:read']);
    expect(effectiveScopes({ role: 'editor' })).toContain('content:publish');
    expect(effectiveScopes({ role: 'viewer', scopes: ['content:read', 'content:publish'] })).toEqual(['content:read']);
    expect(effectiveScopes({ role: 'owner', scopes: ['content:draft'] })).toEqual(['content:draft']);
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
    const names = (role: Role, scopes?: Scope[]) => describeTools(registry, { role, scopes }).map((t) => t.name);
    expect(names('viewer').sort()).toEqual([
      'get_asset',
      'get_brand_kit',
      'get_screen',
      'get_template',
      'list_assets',
      'list_brand_kits',
      'list_fonts',
      'list_groups',
      'list_screens',
      'list_templates',
    ]);
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
      handler: async ({ org, input, write }) => {
        write(org.screens.stage.update((await org.screens.get(input.screenId))!, { name: 'Has a feed' }));
        return { done: true };
      },
    });
    const reg = new Map([[secretive.name, secretive]]);
    const input = { screenId: o.screen, apiKey: 'sk_live_123', nested: { token: 'tok_456', credentialId: 'crd_1' } };
    expect(await dispatch(reg, 'set_feed_secret', input, caller('owner'))).toMatchObject({ ok: true });
    const [entry] = await scoped(env.DB, o.orgId).auditLog.list({ limit: 1 });
    expect(entry!.detailJson).not.toMatch(/sk_live_123|tok_456/);
    expect(JSON.parse(entry!.detailJson!)).toEqual({
      input: { screenId: o.screen, apiKey: '[redacted]', nested: { token: '[redacted]', credentialId: 'crd_1' } },
    });
  });

  it('redact() knows the usual names', () => {
    expect(
      redact({ password: 'p', secret: 's', code: '123456', pairingCode: 'ABC', authorization: 'Bearer x', urlEncrypted: 'e', name: 'n', screenIds: ['a'] }),
    ).toEqual({
      password: '[redacted]',
      secret: '[redacted]',
      code: '[redacted]',
      pairingCode: '[redacted]',
      authorization: '[redacted]',
      urlEncrypted: '[redacted]',
      name: 'n',
      screenIds: ['a'],
    });
  });
});

describe('write safety', () => {
  it('rolls the change back when its audit row cannot be written', async () => {
    const org = scoped(env.DB, o.orgId);
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
    const org = scoped(env.DB, o.orgId);
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
    expect((await scoped(env.DB, o.orgId).screenGroups.list()).filter((g) => g.name === 'Raced')).toHaveLength(1);
  });

  it('refuses a key reused for a different input, and keeps keys apart between orgs', async () => {
    const input = { name: 'Keyed', idempotencyKey: 'retry-key-2' };
    expect(await dispatch(registry, 'create_group', input, caller('editor'))).toMatchObject({ ok: true });
    expect(await dispatch(registry, 'create_group', { ...input, name: 'Other' }, caller('editor'))).toMatchObject({ ok: false, error: 'conflict' });
    const other = await seedOrg(env.DB, 'disp-org-2');
    const r = await dispatch(registry, 'create_group', input, { ...caller('editor'), org: scoped(env.DB, other.orgId) });
    expect(r).toMatchObject({ ok: true });
    expect(await scoped(env.DB, other.orgId).screenGroups.list()).toContainEqual(expect.objectContaining({ name: 'Keyed' }));
  });
});

describe('screen notices', () => {
  /** A notifier that records what it was told. */
  const recorder = () => {
    const told: unknown[] = [];
    const screens: ScreenNotifier = {
      manifest: async (screenId, manifestId) => void told.push({ manifest: { screenId, manifestId } }),
      revoked: async (screenId, credentialId) => void told.push({ revoked: { screenId, credentialId } }),
      command: async (screenId, command) => void told.push({ command: { screenId, command } }),
    };
    return { told, screens };
  };

  it('tell the screen about a revoked credential once the change is committed', async () => {
    const { told, screens } = recorder();
    const cred = await scoped(env.DB, o.orgId).screens.credentials.insert({ screenId: o.screen, secretHash: '9'.repeat(64) });
    const r = await dispatch(registry, 'revoke_screen_credential', { screenId: o.screen, credentialId: cred.id }, { ...caller('owner'), screens });
    expect(r.ok).toBe(true);
    expect(told).toEqual([{ revoked: { screenId: o.screen, credentialId: cred.id } }]);
    // Already revoked: nothing changed, nothing to tell.
    await dispatch(registry, 'revoke_screen_credential', { screenId: o.screen, credentialId: cred.id }, { ...caller('owner'), screens });
    expect(told).toHaveLength(1);
  });

  it('are not sent when the change is rolled back', async () => {
    const { told, screens } = recorder();
    const cred = await scoped(env.DB, o.orgId).screens.credentials.insert({ screenId: o.screen, secretHash: '8'.repeat(64) });
    await env.DB.exec("CREATE TRIGGER audit_down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit down'); END");
    try {
      await expect(
        dispatch(registry, 'revoke_screen_credential', { screenId: o.screen, credentialId: cred.id }, { ...caller('owner'), screens }),
      ).rejects.toThrow();
    } finally {
      await env.DB.exec('DROP TRIGGER audit_down');
    }
    expect(told).toEqual([]);
  });

  it('do not fail a committed change when the screen cannot be told', async () => {
    const screens: ScreenNotifier = { manifest: async () => {}, command: async () => {}, revoked: async () => Promise.reject(new Error('object unreachable')) };
    const cred = await scoped(env.DB, o.orgId).screens.credentials.insert({ screenId: o.screen, secretHash: '7'.repeat(64) });
    const r = await dispatch(registry, 'revoke_screen_credential', { screenId: o.screen, credentialId: cred.id }, { ...caller('owner'), screens });
    expect(r.ok).toBe(true);
  });
});

describe('claim_screen racing', () => {
  it('refuses the loser of two claims on one code cleanly, writing nothing', async () => {
    const { startPairing } = await import('@signforge/db');
    const code = 'RACE23';
    await startPairing(env.DB, { code, pollTokenHash: '9'.repeat(64), now: Date.now() });
    const other = await seedOrg(env.DB, 'disp-race');
    const input = { code, name: 'Lobby', timezone: 'UTC', orientation: 'landscape' };
    const winner = await dispatch(registry, 'claim_screen', input, { ...caller('editor'), org: scoped(env.DB, other.orgId), rateLimit: async () => true });
    expect(winner).toMatchObject({ ok: true });
    // The loser saw the code open just before the winner committed.
    const org = scoped(env.DB, o.orgId);
    const before = await org.screens.list();
    let checks = 0;
    const stale = { ...org, pairing: { ...org.pairing, open: async (c: string, now: number) => checks++ === 0 || org.pairing.open(c, now) } };
    const loser = await dispatch(registry, 'claim_screen', input, { ...caller('editor'), org: stale, rateLimit: async () => true });
    expect(loser).toMatchObject({ ok: false, error: 'not_found' });
    expect(await org.screens.list()).toEqual(before);
  });
});
