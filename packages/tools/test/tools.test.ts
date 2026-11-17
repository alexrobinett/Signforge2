// What each tool does in its own org.
import { scoped } from '@signforge/db';
import { seedOrg, type SeededOrg } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch, manifestKey, registry, type Caller } from '../src';

let o: SeededOrg;
let owner: Caller;

const call = async <T = any>(name: string, input: unknown): Promise<T> => {
  const r = await dispatch(registry, name, input, owner);
  if (!r.ok) throw new Error(`${name}: ${r.error}: ${r.message}`);
  return r.output as T;
};
const refusal = (name: string, input: unknown) => dispatch(registry, name, input, owner);

beforeAll(async () => {
  o = await seedOrg(env.DB, 'tools-org');
  owner = { org: scoped(env.DB, o.orgId), role: 'owner', actor: { kind: 'user', id: 'user-1', clientId: 'cms' }, blobs: env.BLOBS };
});

describe('screens', () => {
  it('lists and gets, without credential hashes', async () => {
    const { screens } = await call('list_screens', {});
    expect(screens).toEqual([expect.objectContaining({ id: o.screen, name: 'tools-org lobby', displayHours: null, status: 'active' })]);
    const got = await call('get_screen', { screenId: o.screen });
    expect(got.groupIds).toEqual([o.group]);
    expect(got.credentials).toEqual([{ id: o.credential, createdAt: expect.any(Number), lastUsedAt: null, revokedAt: null }]);
    expect(JSON.stringify(got)).not.toContain('secret');
  });

  it('renames', async () => {
    expect((await call('rename_screen', { screenId: o.screen, name: '  Counter  ' })).screen.name).toBe('Counter');
  });

  it('updates settings, validating display hours as the player does', async () => {
    const hours = { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }], exceptions: [{ date: '2026-12-25', on: [] }] };
    const { screen } = await call('update_screen_settings', { screenId: o.screen, timezone: 'America/New_York', locale: 'en-US', orientation: 'portrait', displayHours: hours });
    expect(screen).toMatchObject({ timezone: 'America/New_York', locale: 'en-US', orientation: 'portrait', displayHours: hours });

    // Only what is given changes; null clears.
    const cleared = (await call('update_screen_settings', { screenId: o.screen, locale: null, displayHours: null })).screen;
    expect(cleared).toMatchObject({ timezone: 'America/New_York', locale: null, displayHours: null, orientation: 'portrait' });

    const bad = await refusal('update_screen_settings', { screenId: o.screen, displayHours: { weekly: [{ days: [9], from: '25:00', to: '22:00' }] } });
    expect(bad).toMatchObject({ ok: false, error: 'invalid_input' });
    expect((bad as { message: string }).message).toMatch(/days must be 0-6/);
    expect(await refusal('update_screen_settings', { screenId: o.screen, displayHours: { weekly: [], exceptions: [{ date: '2026-12-24', on: [{ from: '18:00', to: '09:00' }] }] } }))
      .toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('update_screen_settings', { screenId: o.screen, timezone: 'Mars/Olympus' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('update_screen_settings', { screenId: o.screen, locale: 'not a locale!' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('update_screen_settings', { screenId: o.screen })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('revokes a credential once, and only one of the named screen', async () => {
    const other = await scoped(env.DB, o.orgId).screens.insert({ name: 'Other', timezone: 'UTC', orientation: 'landscape' });
    expect(await refusal('revoke_screen_credential', { screenId: other.id, credentialId: o.credential })).toMatchObject({ ok: false, error: 'not_found' });
    const first = (await call('revoke_screen_credential', { screenId: o.screen, credentialId: o.credential })).credential;
    expect(first.revokedAt).toEqual(expect.any(Number));
    const again = (await call('revoke_screen_credential', { screenId: o.screen, credentialId: o.credential })).credential;
    expect(again.revokedAt).toBe(first.revokedAt);
  });
});

describe('groups', () => {
  it('creates, renames, sets members and deletes', async () => {
    const extra = await scoped(env.DB, o.orgId).screens.insert({ name: 'Extra', timezone: 'UTC', orientation: 'landscape' });
    const { group } = await call('create_group', { name: 'Windows', screenIds: [o.screen, o.screen] });
    expect(group).toMatchObject({ name: 'Windows', screenIds: [o.screen] });
    expect((await call('rename_group', { groupId: group.id, name: 'Shop windows' })).group.name).toBe('Shop windows');
    expect((await call('set_group_members', { groupId: group.id, screenIds: [extra.id, o.screen] })).group.screenIds).toEqual([extra.id, o.screen].sort());
    expect((await call('set_group_members', { groupId: group.id, screenIds: [] })).group.screenIds).toEqual([]);
    expect((await call('list_groups', {})).groups.map((g: { id: string }) => g.id)).toContain(group.id);
    expect(await call('delete_group', { groupId: group.id })).toEqual({ deleted: group.id });
    expect(await refusal('rename_group', { groupId: group.id, name: 'x' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('creates nothing when a screen is unknown', async () => {
    const before = (await call('list_groups', {})).groups.length;
    expect(await refusal('create_group', { name: 'Bad', screenIds: ['scr_nope'] })).toMatchObject({ ok: false, error: 'not_found' });
    expect((await call('list_groups', {})).groups.length).toBe(before);
  });

  it('will not set members it cannot find, and changes nothing then', async () => {
    expect(await refusal('set_group_members', { groupId: o.group, screenIds: [o.screen, 'scr_nope'] })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await scoped(env.DB, o.orgId).screenGroups.members(o.group)).toEqual([o.screen]);
  });

  it('refuses to delete a group a schedule entry targets', async () => {
    const r = await refusal('delete_group', { groupId: o.group });
    expect(r).toMatchObject({ ok: false, error: 'conflict', details: { scheduleEntryIds: [o.scheduleEntry] } });
    expect(await scoped(env.DB, o.orgId).screenGroups.get(o.group)).toBeDefined();
  });
});

describe('publish_manifest_to_screen', () => {
  it('makes an uploaded manifest desired, keeping the one it replaces', async () => {
    const [m1, m2] = ['1'.repeat(64), '2'.repeat(64)];
    expect(await refusal('publish_manifest_to_screen', { screenId: o.screen, manifestId: m1 })).toMatchObject({ ok: false, error: 'not_found' });
    await env.BLOBS.put(manifestKey(o.orgId, o.screen, m1), '{}');
    await env.BLOBS.put(manifestKey(o.orgId, o.screen, m2), '{}');
    expect(await call('publish_manifest_to_screen', { screenId: o.screen, manifestId: m1 })).toEqual({ screenId: o.screen, manifestId: m1, changed: true });
    expect(await call('publish_manifest_to_screen', { screenId: o.screen, manifestId: m2 })).toMatchObject({ changed: true });
    expect(await call('publish_manifest_to_screen', { screenId: o.screen, manifestId: m2 })).toMatchObject({ changed: false });
    expect((await call('get_screen', { screenId: o.screen })).screen).toMatchObject({ desiredManifestId: m2, previousManifestId: m1 });
  });

  it("will not publish a manifest uploaded for another screen", async () => {
    const other = await scoped(env.DB, o.orgId).screens.insert({ name: 'Elsewhere', timezone: 'UTC', orientation: 'landscape' });
    expect(await refusal('publish_manifest_to_screen', { screenId: other.id, manifestId: '1'.repeat(64) })).toMatchObject({ ok: false, error: 'not_found' });
  });
});
