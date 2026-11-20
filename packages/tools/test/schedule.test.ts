// The schedule tools (M3-19): which playlist plays on which screens and when, called through the
// registry as the CMS calls them, and what a publish then gives each screen at chosen instants.
// Time is never read from the machine's clock: what plays is resolved at fixed instants, and the
// takeover tests fix `Date`.
import type { ScreenManifest } from '@signforge/contract';
import { scoped } from '@signforge/db';
import { seedOrganization } from '@signforge/db/testing';
import { resolvePlaylist } from '@signforge/player-core';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestKey } from '../src';
import { editorCalls, ok } from './calls';

/** Instants in Europe/London, which is UTC in November. 2026-11-17 is a Tuesday. */
const at = (iso: string) => new Date(`${iso}Z`);

/**
 * An org with everything published: screens Lobby (in group Front) and Hall, and playlists Main
 * (the default), Breakfast, Lunch and Flash, each playing one photo.
 */
async function setup(orgId: string) {
  await seedOrganization(env.DB, orgId);
  const org = scoped(env.DB, orgId);
  const lobby = await org.screens.insert({ name: 'Lobby', timezone: 'Europe/London', orientation: 'landscape' });
  const hall = await org.screens.insert({ name: 'Hall', timezone: 'Europe/London', orientation: 'landscape' });
  const front = await org.screenGroups.insert({ name: 'Front' });
  await org.screenGroups.setMembers(front.id, [lobby.id]);
  const photo = { sha256: 'a'.repeat(64), type: 'image/jpeg', size: 2000, width: 1920, height: 1080 };
  const asset = await org.assets.insert({ kind: 'image', name: 'photo.jpg', status: 'verified', ...photo });
  await org.assets.renditions.insert({ assetId: asset.id, orientation: 'landscape', ...photo });
  const still = await org.spots.insert({ name: 'Still', kind: 'image', durationMs: 5000, assetId: asset.id, fit: 'contain' });
  const playlist = async (name: string) => {
    const p = await org.playlists.insert({ name, transitionJson: JSON.stringify({ type: 'cut' }) });
    await org.playlists.setItems(p.id, [still.id]);
    return p.id;
  };
  const main = await playlist('Main');
  const breakfast = await playlist('Breakfast');
  const lunch = await playlist('Lunch');
  const flash = await playlist('Flash');
  await org.commit((await org.settings.stage.set({ defaultPlaylistId: main })).writes);
  const call = editorCalls(org);
  await ok(call('publish', {}));
  /** The playlist each screen plays at `when`, from the manifest its last publish stored. */
  const playingAt = async (when: Date) => {
    const on = async (screenId: string) => {
      const id = (await org.screens.get(screenId))!.desiredManifestId!;
      const manifest = (await (await env.BLOBS.get(manifestKey(orgId, screenId, id)))!.json()) as ScreenManifest;
      return resolvePlaylist(manifest, when).id;
    };
    return { lobby: await on(lobby.id), hall: await on(hall.id) };
  };
  /** Publish these entries' drafts. */
  const publish = (...entries: { id: string; version: number }[]) =>
    ok(call('publish', { drafts: entries.map((e) => ({ kind: 'schedule_entry', id: e.id, version: e.version })) }));
  return { org, call, playingAt, publish, lobby: lobby.id, hall: hall.id, front: front.id, main, breakfast, lunch, flash };
}

type Entry = { id: string; version: number; takeover: boolean };
const entryOf = (out: Record<string, unknown>) => out.entry as Entry;

afterEach(() => vi.useRealTimers());

describe('schedule entries', () => {
  it('schedules a playlist on every screen, a group or one screen, on dates, weekdays and a daily window', async () => {
    const { call, hall, front, breakfast, lunch, flash } = await setup('sch-create');
    const weekdays = await ok(
      call('create_schedule_entry', {
        playlistId: breakfast,
        target: 'group',
        groupId: front,
        days: [5, 1, 2, 3, 4],
        from: '06:00',
        to: '10:00',
        idempotencyKey: 'sch-create-1',
      }),
    );
    expect(weekdays.entry).toMatchObject({
      playlistId: breakfast,
      target: 'group',
      groupId: front,
      screenId: null,
      priority: 0,
      days: [1, 2, 3, 4, 5],
      from: '06:00',
      to: '10:00',
      startDate: null,
      startsAt: null,
      endsAt: null,
      takeover: false,
      version: 1,
      published: false,
      draftChanged: true,
    });
    const atHall = await ok(call('create_schedule_entry', { playlistId: lunch, target: 'screen', screenId: hall, from: '11:00', to: '14:00' }));
    const season = await ok(call('create_schedule_entry', { playlistId: flash, target: 'org', priority: 5, startDate: '2026-12-01', endDate: '2026-12-24' }));
    expect(season.entry).toMatchObject({
      target: 'org',
      groupId: null,
      screenId: null,
      priority: 5,
      startDate: '2026-12-01',
      endDate: '2026-12-24',
      days: null,
    });
    const { entries } = await ok(call('list_schedule_entries', {}));
    expect(entries).toEqual(expect.arrayContaining([weekdays.entry, atHall.entry, season.entry]));
    expect(entries).toHaveLength(3);
  });

  it('refuses an entry a screen would refuse, one aimed wrongly, or at what does not exist', async () => {
    const { call, lobby, front, breakfast } = await setup('sch-refuse');
    const make = (over: Record<string, unknown>) => call('create_schedule_entry', { playlistId: breakfast, target: 'screen', screenId: lobby, ...over });
    expect(await make({ from: '6am', days: [7], startDate: 'Monday' })).toMatchObject({
      ok: false,
      error: 'invalid_input',
      details: { problems: ['from must be HH:MM', 'days must be 0-6', 'startDate must be YYYY-MM-DD'] },
    });
    expect(await make({ days: [1, 1] })).toMatchObject({ ok: false, error: 'invalid_input', details: { problems: ['days must not repeat'] } });
    expect(await make({ target: 'group' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await make({ target: 'org' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await make({ playlistId: 'pls_gone' })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await make({ screenId: 'scr_gone' })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await make({ target: 'group', screenId: undefined, groupId: 'grp_gone' })).toMatchObject({ ok: false, error: 'not_found' });
    expect(await make({ target: 'group', screenId: undefined, groupId: front })).toMatchObject({ ok: true });
  });

  it('changes an entry with ifVersion, refuses an edit from an old read or of the other kind, and deletes', async () => {
    const { call, lobby, front, breakfast, lunch } = await setup('sch-update');
    const made = entryOf(await ok(call('create_schedule_entry', { playlistId: breakfast, target: 'screen', screenId: lobby, from: '06:00', to: '10:00' })));
    const edited = await ok(
      call('update_schedule_entry', { scheduleEntryId: made.id, playlistId: lunch, target: 'group', groupId: front, from: null, days: [0, 6], ifVersion: 1 }),
    );
    expect(edited.entry).toMatchObject({
      playlistId: lunch,
      target: 'group',
      groupId: front,
      screenId: null,
      from: null,
      to: '10:00',
      days: [0, 6],
      version: 2,
    });
    expect(await call('update_schedule_entry', { scheduleEntryId: made.id, priority: 3, ifVersion: 1 })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: made.id, version: 2 },
    });
    expect(await call('update_schedule_entry', { scheduleEntryId: made.id, endsAt: '2030-01-01T00:00:00Z', ifVersion: 2 })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
    expect(await call('update_schedule_entry', { scheduleEntryId: made.id, to: '25:00', ifVersion: 2 })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await ok(call('delete_schedule_entry', { scheduleEntryId: made.id }))).toEqual({ deleted: made.id });
    expect(await call('delete_schedule_entry', { scheduleEntryId: made.id })).toMatchObject({ ok: false, error: 'not_found' });
    expect((await ok(call('list_schedule_entries', {}))).entries).toEqual([]);
  });

  it('an entry made again with a deleted one’s id continues its versions, so an edit from the old read is refused (#64)', async () => {
    const { org, call, lobby, breakfast, lunch } = await setup('sch-tombstone');
    const made = entryOf(await ok(call('create_schedule_entry', { playlistId: breakfast, target: 'screen', screenId: lobby })));
    const read = entryOf(await ok(call('update_schedule_entry', { scheduleEntryId: made.id, from: '06:00', ifVersion: 1 })));
    await ok(call('delete_schedule_entry', { scheduleEntryId: made.id }));
    const again = await org.scheduleEntries.insert({ id: made.id, playlistId: breakfast, target: 'screen', screenId: lobby });
    expect(again.rowVersion).toBe(read.version + 1);

    expect(await call('update_schedule_entry', { scheduleEntryId: made.id, playlistId: lunch, ifVersion: read.version })).toMatchObject({
      ok: false,
      error: 'conflict',
      details: { id: made.id, version: read.version + 1 },
    });
    expect(await org.scheduleEntries.get(made.id)).toEqual(again);
  });

  it('after a publish each screen plays, hour by hour, the entry that applies: highest priority, then most specific, else the default', async () => {
    const { call, publish, playingAt, hall, front, main, breakfast, lunch, flash } = await setup('sch-publish');
    const made = (input: Record<string, unknown>) => ok(call('create_schedule_entry', input)).then(entryOf);
    const entries = [
      await made({ playlistId: breakfast, target: 'group', groupId: front, days: [1, 2, 3, 4, 5], from: '06:00', to: '10:00' }),
      await made({ playlistId: lunch, target: 'screen', screenId: hall, from: '11:00', to: '14:00' }),
      await made({ playlistId: flash, target: 'org', days: [6] }),
      await made({ playlistId: flash, target: 'org', priority: 5, days: [0], from: '12:00', to: '13:00' }),
    ];
    // Drafts: nothing changes on screen until they are published.
    expect(await playingAt(at('2026-11-17T07:00'))).toEqual({ lobby: main, hall: main });
    await publish(...entries);

    // Tuesday: the group's breakfast in the morning, Hall's own lunch at midday, the default after.
    expect(await playingAt(at('2026-11-17T07:00'))).toEqual({ lobby: breakfast, hall: main });
    expect(await playingAt(at('2026-11-17T12:00'))).toEqual({ lobby: main, hall: lunch });
    expect(await playingAt(at('2026-11-17T16:00'))).toEqual({ lobby: main, hall: main });
    // Saturday: every screen's Flash, but Hall's own entry wins the tie at midday.
    expect(await playingAt(at('2026-11-21T09:00'))).toEqual({ lobby: flash, hall: flash });
    expect(await playingAt(at('2026-11-21T12:00'))).toEqual({ lobby: flash, hall: lunch });
    // Sunday noon: priority 5 beats Hall's own entry.
    expect(await playingAt(at('2026-11-22T12:30'))).toEqual({ lobby: flash, hall: flash });
    expect(await playingAt(at('2026-11-22T13:30'))).toEqual({ lobby: main, hall: lunch });
  });

  it('a takeover plays above every entry from its start to its end, lasts at most a day, and can be ended early', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2026-11-17T12:00'));
    const { call, publish, playingAt, hall, main, lunch, flash } = await setup('sch-takeover');
    const atHall = entryOf(await ok(call('create_schedule_entry', { playlistId: lunch, target: 'screen', screenId: hall, from: '11:00', to: '14:00' })));
    const takeover = await ok(call('start_takeover', { playlistId: flash, target: 'org', endsAt: '2026-11-17T14:00:00Z', idempotencyKey: 'takeover-1' }));
    expect(takeover.entry).toMatchObject({
      playlistId: flash,
      target: 'org',
      takeover: true,
      priority: 100,
      startsAt: '2026-11-17T12:00:00.000Z',
      endsAt: '2026-11-17T14:00:00.000Z',
      from: null,
      days: null,
    });
    await publish(atHall, entryOf(takeover));
    expect(await playingAt(at('2026-11-17T11:59'))).toEqual({ lobby: main, hall: lunch });
    expect(await playingAt(at('2026-11-17T12:00'))).toEqual({ lobby: flash, hall: flash });
    expect(await playingAt(at('2026-11-17T13:59'))).toEqual({ lobby: flash, hall: flash });
    expect(await playingAt(at('2026-11-17T14:00'))).toEqual({ lobby: main, hall: main });

    // Ended early: from the next publish it is over at its new end.
    const ended = entryOf(await ok(call('update_schedule_entry', { scheduleEntryId: entryOf(takeover).id, endsAt: '2026-11-17T12:30:00Z', ifVersion: 1 })));
    await publish(ended);
    expect(await playingAt(at('2026-11-17T12:31'))).toEqual({ lobby: main, hall: lunch });

    const start = (over: Record<string, unknown>) => call('start_takeover', { playlistId: flash, target: 'org', endsAt: '2026-11-17T14:00:00Z', ...over });
    expect(await start({ endsAt: '2026-11-17T11:00:00Z' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await start({ endsAt: '2026-11-18T12:00:01Z' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await start({ startsAt: '2026-11-17T15:00:00Z' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await start({ startsAt: '2026-11-17T13:00:00Z', endsAt: '2026-11-18T13:00:00Z' })).toMatchObject({ ok: true });
    expect(await call('update_schedule_entry', { scheduleEntryId: entryOf(takeover).id, from: '06:00', ifVersion: 2 })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });

  it('a deleted entry leaves its screens at the next publish, which may pin no draft at all', async () => {
    const { call, publish, playingAt, lobby, main, breakfast } = await setup('sch-delete');
    const made = entryOf(await ok(call('create_schedule_entry', { playlistId: breakfast, target: 'screen', screenId: lobby })));
    await publish(made);
    const noon = at('2026-11-17T12:00');
    expect((await playingAt(noon)).lobby).toBe(breakfast);

    await ok(call('delete_schedule_entry', { scheduleEntryId: made.id }));
    expect((await playingAt(noon)).lobby).toBe(breakfast);
    expect(await ok(call('publish', { drafts: [] }))).toMatchObject({
      promoted: [],
      screens: expect.arrayContaining([{ screenId: lobby, outcome: 'updated', problems: [] }]),
    });
    expect((await playingAt(noon)).lobby).toBe(main);
  });
});
