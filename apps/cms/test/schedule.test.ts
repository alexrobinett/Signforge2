// The Schedule page's week view (M3-19): what a screen plays each hour of its week, in its own time
// zone, from the entries aimed at it, its groups or every screen. Checked against a week written out
// by hand, and against player-core's resolvePlaylist (what the screen itself runs) for every hour.
import type { ScheduleEntry, ScreenManifest } from '@signforge/contract';
import { resolvePlaylist } from '@signforge/player-core';
import { describe, expect, it } from 'vitest';
import { describeWhen, playingAt, weekOf, type ScheduleEntryView } from '../src/lib/schedule';

const entry = (id: string, over: Partial<ScheduleEntryView>): ScheduleEntryView => ({
  id,
  playlistId: 'main',
  target: 'org',
  groupId: null,
  screenId: null,
  priority: 0,
  startDate: null,
  endDate: null,
  days: null,
  from: null,
  to: null,
  startsAt: null,
  endsAt: null,
  takeover: false,
  version: 1,
  published: false,
  draftChanged: true,
  publishedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const lobby = { id: 'scr_lobby', timezone: 'America/New_York' };
const groups = [
  { id: 'grp_front', name: 'Front', screenIds: ['scr_lobby'] },
  { id: 'grp_back', name: 'Back', screenIds: ['scr_hall'] },
];
const entries = [
  entry('sch_breakfast', { playlistId: 'breakfast', target: 'group', groupId: 'grp_front', days: [1, 2, 3, 4, 5], from: '06:00', to: '10:00' }),
  entry('sch_lunch', { playlistId: 'lunch', target: 'screen', screenId: 'scr_lobby', from: '11:00', to: '14:00' }),
  entry('sch_saturday', { playlistId: 'flash', target: 'org', days: [6] }),
  entry('sch_dinner', { playlistId: 'dinner', target: 'group', groupId: 'grp_back' }),
  // Wednesday 12:00 to 14:00 in New York.
  entry('sch_takeover', {
    playlistId: 'flash',
    priority: 100,
    startsAt: '2026-11-18T17:00:00.000Z',
    endsAt: '2026-11-18T19:00:00.000Z',
    takeover: true,
  }),
];
// Wednesday 18 November 2026, 7 am in New York (UTC-5).
const at = new Date('2026-11-18T12:00:00Z');
const week = weekOf({ screen: lobby, groups, entries, defaultPlaylistId: 'main', at });
const playlistAt = (date: string, hour: number) => week.find((d) => d.date === date)?.hours[hour]?.playlistId;

describe('the week view', () => {
  it("lays out the screen's week, Monday first, in its time zone", () => {
    expect(week.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(week.every((d) => d.hours.length === 24 && d.hours.every((h) => h !== null))).toBe(true);
  });

  it('plays what the entries say, hour by hour: a test week written out', () => {
    expect([5, 6, 9, 10, 11, 13, 14].map((h) => playlistAt('2026-11-16', h))).toEqual(['main', 'breakfast', 'breakfast', 'main', 'lunch', 'lunch', 'main']);
    // Wednesday: the takeover from noon to two, above the screen's own lunch.
    expect([11, 12, 13, 14].map((h) => playlistAt('2026-11-18', h))).toEqual(['lunch', 'flash', 'flash', 'main']);
    expect(week.find((d) => d.date === '2026-11-18')!.hours.map((h) => h!.takeover)).toEqual(Array.from({ length: 24 }, (_, h) => h === 12 || h === 13));
    // Saturday: every screen's Flash, but the screen's own lunch wins the tie at midday.
    expect([6, 11, 15].map((h) => playlistAt('2026-11-21', h))).toEqual(['flash', 'lunch', 'flash']);
    // Group Back's dinner is never this screen's.
    expect(week.flatMap((d) => d.hours).some((h) => h!.playlistId === 'dinner')).toBe(false);
  });

  it('agrees with resolvePlaylist, which the screen runs, for every hour of the week', () => {
    // The entries this screen gets, chosen here as the compiler chooses them.
    const mine = entries.filter((e) => e.target === 'org' || e.groupId === 'grp_front' || e.screenId === 'scr_lobby');
    const schedule: ScheduleEntry[] = mine.map((e) => ({
      id: e.id,
      playlist: e.playlistId,
      priority: e.priority,
      target: e.target,
      ...(e.days ? { days: e.days } : {}),
      ...(e.from ? { from: e.from } : {}),
      ...(e.to ? { to: e.to } : {}),
      ...(e.startsAt ? { startsAt: e.startsAt } : {}),
      ...(e.endsAt ? { endsAt: e.endsAt } : {}),
    }));
    const playlist = (id: string) => ({ id, name: id, transition: { type: 'cut' as const }, items: [] });
    const manifest: ScreenManifest = {
      schema: 4,
      id: 'm',
      generatedAt: '2026-11-16T00:00:00Z',
      screen: { id: lobby.id, name: 'Lobby', timezone: lobby.timezone, orientation: 'landscape' },
      files: {},
      templates: {},
      spots: {},
      playlists: Object.fromEntries(['main', 'breakfast', 'lunch', 'flash', 'dinner'].map((id) => [id, playlist(id)])),
      dataSources: {},
      schedule,
      defaultPlaylist: 'main',
    };
    for (const day of week) for (const cell of day.hours) expect(cell!.playlistId, cell!.at.toISOString()).toBe(resolvePlaylist(manifest, cell!.at).id);
  });

  it('keeps 24 local hours on a day the clocks change, each at its own instant', () => {
    // Sunday 1 November 2026: New York falls back an hour at 2 am.
    const fallBack = weekOf({ screen: lobby, groups, entries: [], defaultPlaylistId: 'main', at: new Date('2026-11-01T12:00:00Z') });
    const sunday = fallBack.find((d) => d.date === '2026-11-01')!;
    expect(sunday.hours.map((h) => h!.at.toISOString()).slice(0, 4)).toEqual([
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ]);
  });
});

describe('what a screen plays now', () => {
  it('names the playlist and whether a takeover plays it, as the week view does', () => {
    const schedule = { screen: lobby, groups, entries, defaultPlaylistId: 'main' };
    expect(playingAt({ ...schedule, at: new Date('2026-11-18T12:00:00Z') })).toEqual({ playlistId: 'breakfast', takeover: false });
    expect(playingAt({ ...schedule, at: new Date('2026-11-18T17:30:00Z') })).toEqual({ playlistId: 'flash', takeover: true });
    expect(playingAt({ ...schedule, at: new Date('2026-11-18T23:00:00Z') })).toEqual({ playlistId: 'main', takeover: false });
  });
});

describe('an entry in words', () => {
  it('says when it plays', () => {
    expect(describeWhen(entries[0]!)).toBe('Mon–Fri, 06:00–10:00');
    expect(describeWhen(entries[1]!)).toBe('Every day, 11:00–14:00');
    expect(describeWhen(entries[2]!)).toBe('Sat, all day');
    expect(describeWhen(entry('d', { startDate: '2026-12-01', endDate: '2026-12-24', days: [0, 6] }))).toBe('Sat, Sun, all day, 2026-12-01 to 2026-12-24');
    expect(describeWhen(entry('d', { from: '22:00', to: '02:00' }))).toBe('Every day, 22:00–02:00 (into the next day)');
  });
});
