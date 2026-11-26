// What each tool does in its own org.
import { scoped, STORAGE_GRACE_MS } from '@signforge/db';
import { queueDeletedFiles, seedOrg, type SeededOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatch, manifestKey, registry, type Caller } from '../src';
import { racing } from './calls';
import { memberOf } from './member';

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
  owner = memberOf(testScope(env.DB, o.orgId), 'owner');
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
    expect((await call('update_screen', { screenId: o.screen, name: '  Counter  ' })).screen.name).toBe('Counter');
  });

  it('updates settings, validating display hours as the player does', async () => {
    const hours = { weekly: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '22:00' }], exceptions: [{ date: '2026-12-25', on: [] }] };
    const { screen } = await call('update_screen', {
      screenId: o.screen,
      timezone: 'America/New_York',
      locale: 'en-US',
      orientation: 'portrait',
      displayHours: hours,
    });
    expect(screen).toMatchObject({ timezone: 'America/New_York', locale: 'en-US', orientation: 'portrait', displayHours: hours });

    // Only what is given changes; null clears.
    const cleared = (await call('update_screen', { screenId: o.screen, locale: null, displayHours: null })).screen;
    expect(cleared).toMatchObject({ timezone: 'America/New_York', locale: null, displayHours: null, orientation: 'portrait' });

    const bad = await refusal('update_screen', { screenId: o.screen, displayHours: { weekly: [{ days: [9], from: '25:00', to: '22:00' }] } });
    expect(bad).toMatchObject({ ok: false, error: 'invalid_input' });
    expect((bad as { message: string }).message).toMatch(/days must be 0-6/);
    expect(
      await refusal('update_screen', {
        screenId: o.screen,
        displayHours: { weekly: [], exceptions: [{ date: '2026-12-24', on: [{ from: '18:00', to: '09:00' }] }] },
      }),
    ).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('update_screen', { screenId: o.screen, timezone: 'Mars/Olympus' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('update_screen', { screenId: o.screen, locale: 'not a locale!' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await refusal('update_screen', { screenId: o.screen })).toMatchObject({ ok: false, error: 'invalid_input' });
  });

  it('revokes a credential once, and only one of the named screen', async () => {
    const other = await testScope(env.DB, o.orgId).screens.insert({ name: 'Other', timezone: 'UTC', orientation: 'landscape' });
    expect(await refusal('revoke_screen_credential', { screenId: other.id, credentialId: o.credential })).toMatchObject({ ok: false, error: 'not_found' });
    const first = (await call('revoke_screen_credential', { screenId: o.screen, credentialId: o.credential })).credential;
    expect(first.revokedAt).toEqual(expect.any(Number));
    const again = (await call('revoke_screen_credential', { screenId: o.screen, credentialId: o.credential })).credential;
    expect(again.revokedAt).toBe(first.revokedAt);
  });
});

describe('content saves (#345 PR 4): one tool creates or changes each kind', () => {
  const refused = async (name: string, input: Record<string, unknown>) => {
    const r = await refusal(name, input);
    expect(r, `${name} ${JSON.stringify(input)}`).toMatchObject({ ok: false, error: 'invalid_input' });
    return r.ok ? '' : r.message;
  };

  it('refuses a new one missing what it needs, and a change to what is fixed once made, saying what to send', async () => {
    expect(await refused('save_spot', { kind: 'url', url: 'https://example.com' })).toMatch(/a new spot needs a name and a kind; give spotId/);
    expect(await refused('save_spot', { spotId: o.imageSpot, kind: 'url' })).toMatch(/a spot's kind is fixed once made/);
    expect(await refused('save_playlist', { spotIds: [] })).toMatch(/a new playlist needs a name; give playlistId/);
    expect(await refused('save_schedule_entry', { target: 'org' })).toMatch(/a new entry needs a playlistId and a target/);
    expect(await refused('save_schedule_entry', { playlistId: o.playlist, target: 'org', endsAt: '2026-11-17T20:00:00Z' })).toMatch(/use start_takeover/);
    expect(await refused('save_brand_kit', { name: 'Half', colors: { primary: '#000000' } })).toMatch(/\(missing accent, background, surface, text, muted\)/);
    expect(await refused('save_data_source', { name: 'No format', feedUrl: 'https://example.com/feed' })).toMatch(
      /a new data source needs a name and a format/,
    );
    expect(await refused('save_data_source', { dataSourceId: o.dataSource, format: 'rss' })).toMatch(/a data source's format is fixed once made/);
  });

  it('refuses a field it does not take by name, and ifVersion on a new one, as save_group does (review of #499)', async () => {
    expect(await refused('save_spot', { spotId: o.imageSpot, name: 'X', colour: 'red' })).toMatch(/colour/);
    expect(await refused('save_playlist', { playlistId: o.playlist, name: 'X', isDefault: true })).toMatch(/isDefault/);
    expect(await refused('save_brand_kit', { brandKitId: o.brandKit, isDefault: true })).toMatch(/isDefault/);
    for (const [name, input] of [
      ['save_spot', { name: 'New', kind: 'url', url: 'https://example.com', ifVersion: 1 }],
      ['save_playlist', { name: 'New', ifVersion: 1 }],
      ['save_schedule_entry', { playlistId: o.playlist, target: 'org', ifVersion: 1 }],
      ['save_data_source', { name: 'New', format: 'json', feedUrl: 'https://example.com/data.json', ifVersion: 1 }],
    ] as const)
      expect(await refused(name, input), name).toMatch(/has no version yet: ifVersion is for a change/);
  });

  it('refuses a change that changes nothing, which would write nothing to guard', async () => {
    expect(await refused('save_spot', { spotId: o.imageSpot })).toMatch(/nothing to change/);
    expect(await refused('save_playlist', { playlistId: o.playlist })).toMatch(/nothing to change/);
  });

  it('creates without an id and changes with one, the version moving on', async () => {
    const { playlist } = await call('save_playlist', { name: 'Lunch', spotIds: [o.imageSpot] });
    const renamed = (await call('save_playlist', { playlistId: playlist.id, name: 'Lunch specials', ifVersion: playlist.version })).playlist;
    expect(renamed).toMatchObject({ id: playlist.id, name: 'Lunch specials', version: playlist.version + 1 });
    expect(await refusal('save_playlist', { playlistId: playlist.id, name: 'Late', ifVersion: playlist.version })).toMatchObject({
      ok: false,
      error: 'conflict',
    });
  });

  it('makes a kit the default with a change, as set_default_brand_kit did, and with a new kit', async () => {
    const colors = { primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' };
    const made = (await call('save_brand_kit', { name: 'Second', colors })).brandKit;
    expect(made.isDefault).toBe(false);
    expect((await call('save_brand_kit', { brandKitId: made.id, makeDefault: true })).brandKit.isDefault).toBe(true);
    expect((await call('save_brand_kit', { name: 'Third', colors, makeDefault: true })).brandKit.isDefault).toBe(true);
    expect((await call('get_brand_kit', { brandKitId: made.id })).brandKit.isDefault).toBe(false);
  });
});

describe('groups', () => {
  it('creates, renames, sets members and deletes', async () => {
    const extra = await testScope(env.DB, o.orgId).screens.insert({ name: 'Extra', timezone: 'UTC', orientation: 'landscape' });
    const { group } = await call('save_group', { name: 'Windows', screenIds: [o.screen, o.screen] });
    expect(group).toMatchObject({ name: 'Windows', screenIds: [o.screen] });
    expect((await call('save_group', { groupId: group.id, name: 'Shop windows' })).group.name).toBe('Shop windows');
    expect((await call('save_group', { groupId: group.id, screenIds: [extra.id, o.screen], membership: 'set' })).group.screenIds).toEqual(
      [extra.id, o.screen].sort(),
    );
    expect((await call('save_group', { groupId: group.id, screenIds: [], membership: 'set' })).group.screenIds).toEqual([]);
    expect((await call('list_groups', {})).groups.map((g: { id: string }) => g.id)).toContain(group.id);
    expect(await call('delete_group', { groupId: group.id })).toEqual({ deleted: group.id });
    expect(await refusal('save_group', { groupId: group.id, name: 'x' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('renames and changes screens in one call, at the version read, its first change guarded and the rest following', async () => {
    const extra = await testScope(env.DB, o.orgId).screens.insert({ name: 'Extra', timezone: 'UTC', orientation: 'landscape' });
    const { group } = await call('save_group', { name: 'Doors', screenIds: [o.screen] });
    const both = (await call('save_group', { groupId: group.id, name: 'Front doors', screenIds: [extra.id], membership: 'add', ifVersion: group.version }))
      .group;
    expect(both).toMatchObject({ name: 'Front doors', screenIds: [extra.id, o.screen].sort() });
    expect((await call('list_groups', {})).groups.find((g: { id: string }) => g.id === group.id)).toEqual(both);
    // At the version read before: refused, and nothing of it written.
    expect(
      await refusal('save_group', { groupId: group.id, name: 'Late', screenIds: [o.screen], membership: 'remove', ifVersion: group.version }),
    ).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    const removed = (await call('save_group', { groupId: group.id, screenIds: [o.screen, 'scr_notmember'], membership: 'remove' })).group;
    expect(removed).toMatchObject({ name: 'Front doors', screenIds: [extra.id] });
  });

  it('refuses a call that does not say what to do, with what to send instead', async () => {
    const said = async (input: Record<string, unknown>) => {
      const r = await refusal('save_group', input);
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, error: 'invalid_input' });
      return r.ok ? '' : r.message;
    };
    expect(await said({ screenIds: [o.screen] })).toMatch(/a new group needs a name/);
    expect(await said({ name: 'New', screenIds: [o.screen], membership: 'remove' })).toMatch(/no screens to remove/);
    expect(await said({ groupId: o.group, screenIds: [o.screen] })).toMatch(/give membership with screenIds: add, remove or set/);
    expect(await said({ groupId: o.group, membership: 'add' })).toMatch(/membership needs the screenIds/);
    expect(await said({ groupId: o.group })).toMatch(/give a name or screenIds/);
  });

  it('refuses what it does not take by name, ifVersion on a new group, and add or remove of no screens, writing nothing', async () => {
    const said = async (name: string, input: Record<string, unknown>) => {
      const r = await refusal(name, input);
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, error: 'invalid_input' });
      return r.ok ? '' : r.message;
    };
    expect(await said('save_group', { groupId: o.group, name: 'Door', add: [o.screen] })).toMatch(/add/);
    expect(await said('screen_command', { screenId: o.screen, command: 'display_on', state: 'on' })).toMatch(/state/);
    expect(await said('update_screen', { screenId: o.screen, name: 'Door', mode: 'x' })).toMatch(/mode/);
    expect(await said('save_group', { name: 'New', ifVersion: 1 })).toMatch(/ifVersion is for a change/);
    for (const membership of ['add', 'remove'])
      expect(await said('save_group', { groupId: o.group, screenIds: [], membership })).toMatch(/an empty list changes nothing/);
    const { group } = await call('save_group', { name: 'Stale', screenIds: [o.screen] });
    await call('save_group', { groupId: group.id, name: 'Moved on', ifVersion: group.version });
    expect(await refusal('save_group', { groupId: group.id, screenIds: [o.screen], membership: 'remove', ifVersion: group.version })).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    expect((await call('list_groups', {})).groups.find((g: { id: string }) => g.id === group.id).screenIds).toEqual([o.screen]);
  });

  it('creates nothing when a screen is unknown', async () => {
    const before = (await call('list_groups', {})).groups.length;
    expect(await refusal('save_group', { name: 'Bad', screenIds: ['scr_nope'] })).toMatchObject({ ok: false, error: 'not_found' });
    expect((await call('list_groups', {})).groups.length).toBe(before);
  });

  it('will not set members it cannot find, and changes nothing then', async () => {
    expect(await refusal('save_group', { groupId: o.group, screenIds: [o.screen, 'scr_nope'], membership: 'set' })).toMatchObject({
      ok: false,
      error: 'not_found',
    });
    expect(await testScope(env.DB, o.orgId).screenGroups.members(o.group)).toEqual([o.screen]);
  });

  it('refuses to delete a group a schedule entry targets', async () => {
    const r = await refusal('delete_group', { groupId: o.group });
    expect(r).toMatchObject({ ok: false, error: 'conflict', details: { scheduleEntryIds: [o.scheduleEntry] } });
    expect(await testScope(env.DB, o.orgId).screenGroups.get(o.group)).toBeDefined();
  });
});

describe('publish_manifest_to_screen', () => {
  it('makes an uploaded manifest desired, keeping the one it replaces', async () => {
    const [m1, m2] = ['1'.repeat(64), '2'.repeat(64)];
    expect(await refusal('publish_manifest_to_screen', { screenId: o.screen, manifestId: m1 })).toMatchObject({ ok: false, error: 'not_found' });
    await env.BLOBS.put(manifestKey(o.orgId, o.screen, m1), JSON.stringify({ files: {} }));
    await env.BLOBS.put(manifestKey(o.orgId, o.screen, m2), JSON.stringify({ files: {} }));
    expect(await call('publish_manifest_to_screen', { screenId: o.screen, manifestId: m1 })).toEqual({ screenId: o.screen, manifestId: m1, changed: true });
    expect(await call('publish_manifest_to_screen', { screenId: o.screen, manifestId: m2 })).toMatchObject({ changed: true });
    expect(await call('publish_manifest_to_screen', { screenId: o.screen, manifestId: m2 })).toMatchObject({ changed: false });
    expect((await call('get_screen', { screenId: o.screen })).screen).toMatchObject({ desiredManifestId: m2, previousManifestId: m1 });
  });

  it('refuses a manifest naming a file the storage sweep deleted after the push checked it, until the push uploads it again (#432)', async () => {
    const AT = Date.UTC(2026, 4, 1, 9);
    vi.useFakeTimers({ toFake: ['Date'], now: AT });
    try {
      const file = '7'.repeat(64);
      const manifestId = '3'.repeat(64);
      await env.BLOBS.put(manifestKey(o.orgId, o.screen, manifestId), JSON.stringify({ files: { [file]: {} } }));
      await queueDeletedFiles(env.DB, o.orgId, [file], AT - STORAGE_GRACE_MS);
      const sweep = scoped(env.DB, o.orgId);
      // The seeded org's kept manifests looked for, as the sweep does first: stored nowhere here.
      const unindexed = await sweep.storage.unindexed(AT, 100);
      await sweep.commit(
        sweep.storage.stage.index(
          unindexed.map((k) => ({ screenId: k.screenId, id: k.manifestId, files: null })),
          AT,
        ).writes,
      );
      // Between the tool's reads and its batch, the sweep claims the file, deletes it and forgets its claim.
      const raced = racing(owner, async () => {
        expect(await sweep.storage.lease('sweep', AT)).toBe(true);
        const due = await sweep.storage.claim('sweep', AT, 90);
        expect(due.files).toEqual([file]);
        await sweep.commit(sweep.storage.stage.forget(due, 'sweep', AT).writes);
      });
      const input = { screenId: o.screen, manifestId };
      expect(await dispatch(registry, 'publish_manifest_to_screen', input, raced)).toMatchObject({ ok: false, error: 'conflict' });
      expect((await call('get_screen', { screenId: o.screen })).screen.desiredManifestId).not.toBe(manifestId);
      // Pushed again, its read finds the deletion and says so.
      expect(await refusal('publish_manifest_to_screen', input)).toMatchObject({ ok: false, error: 'conflict', details: { deleted: [file] } });
      // Uploaded again (/admin clears the tombstone as it stores the bytes): published.
      await sweep.commit(sweep.storage.stage.restored([file], AT + 1, AT + 1));
      expect(await call('publish_manifest_to_screen', input)).toMatchObject({ changed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('will not publish a manifest uploaded for another screen', async () => {
    const other = await testScope(env.DB, o.orgId).screens.insert({ name: 'Elsewhere', timezone: 'UTC', orientation: 'landscape' });
    expect(await refusal('publish_manifest_to_screen', { screenId: other.id, manifestId: '1'.repeat(64) })).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('delete, takeover and the uploads (#345 PR 5): one tool each, refusing what its type, action or kind does not take', () => {
  const paths = async (name: string, input: Record<string, unknown>) => {
    const r = await refusal(name, input);
    expect(r, `${name} ${JSON.stringify(input)}`).toMatchObject({ ok: false, error: 'invalid_input' });
    return r.ok ? [] : (r.details as { path: string }[]).map((d) => d.path);
  };

  it('refuses ifVersion on a delete of anything but a schedule entry', async () => {
    expect(await paths('delete', { type: 'playlist', id: o.playlist, ifVersion: 1 })).toEqual(['ifVersion']);
    expect(await refusal('delete', { type: 'schedule_entry', id: o.scheduleEntry, ifVersion: 99 })).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('refuses a takeover missing what its action needs, or given what the other action takes', async () => {
    expect(await paths('takeover', { action: 'end' })).toEqual(['scheduleEntryId']);
    expect(await paths('takeover', { action: 'end', scheduleEntryId: o.scheduleEntry, playlistId: o.playlist })).toEqual(['playlistId']);
    expect(await paths('takeover', { action: 'publish', target: 'org' })).toEqual(['playlistId', 'endsAt']);
    expect(await paths('takeover', { action: 'publish', scheduleEntryId: o.scheduleEntry, playlistId: o.playlist, target: 'org', endsAt: 'x' })).toEqual([
      'scheduleEntryId',
    ]);
    expect(await refusal('takeover', { action: 'end', scheduleEntryId: o.scheduleEntry })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it("refuses an upload given another kind's fields, a renewal given more than the asset, and an image's finish given a video's parts", async () => {
    expect(await paths('start_upload', { kind: 'image', name: 'Photo', sha256: '1'.repeat(64) })).toEqual(['renditions', 'sha256']);
    expect(await paths('start_upload', { kind: 'image', assetId: o.asset, name: 'Again' })).toEqual(['name']);
    expect(await paths('start_upload', { kind: 'video', name: 'Clip', size: 10 })).toEqual(['sha256', 'type']);
    expect(await paths('start_upload', { kind: 'video', assetId: o.asset, name: 'Clip', sha256: '1'.repeat(64), type: 'video/mp4', size: 10 })).toEqual([
      'assetId',
    ]);
    expect(await paths('finalize_upload', { assetId: o.asset, uploadId: 'u' })).toEqual(['uploadId']);
  });
});
