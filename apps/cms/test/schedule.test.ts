// The Schedule page's week view (M3-19): what a screen plays through its week, in its own time zone,
// from the entries aimed at it, its groups or every screen, to the minute. Checked against a week
// written out by hand, and against player-core's resolvePlaylist (what the screen itself runs) at
// the start of every stretch it draws.
import type { ScheduleEntry, ScreenManifest } from '@signforge/contract';
import { resolvePlaylist } from '@signforge/player-core';
import { describe, expect, it } from 'vitest';
import { describeWhen, weekOf, type ScheduleEntryView } from '../src/lib/schedule';

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
  deleted: false,
  live: null,
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
/** What plays at the top of the hour. */
const playlistAt = (date: string, hour: number) => week.find((d) => d.date === date)?.hours[hour]?.segments[0]?.playlistId;

describe('the week view', () => {
  it("lays out the screen's week, Monday first, in its time zone", () => {
    expect(week.map((d) => d.date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(week.every((d) => d.hours.length === 24 && d.hours.every((h) => h !== null))).toBe(true);
    // Every hour is covered from its first minute to its last.
    for (const h of week.flatMap((d) => d.hours)) {
      expect(h!.segments[0]!.from).toBe(0);
      expect(h!.segments.at(-1)!.to).toBe(60);
      h!.segments.slice(1).forEach((g, i) => expect(g.from).toBe(h!.segments[i]!.to));
    }
  });

  it('plays what the entries say, hour by hour: a test week written out', () => {
    expect([5, 6, 9, 10, 11, 13, 14].map((h) => playlistAt('2026-11-16', h))).toEqual(['main', 'breakfast', 'breakfast', 'main', 'lunch', 'lunch', 'main']);
    // Wednesday: the takeover from noon to two, above the screen's own lunch.
    expect([11, 12, 13, 14].map((h) => playlistAt('2026-11-18', h))).toEqual(['lunch', 'flash', 'flash', 'main']);
    expect(week.find((d) => d.date === '2026-11-18')!.hours.map((h) => h!.segments[0]!.takeover)).toEqual(
      Array.from({ length: 24 }, (_, h) => h === 12 || h === 13),
    );
    // Saturday: every screen's Flash, but the screen's own lunch wins the tie at midday.
    expect([6, 11, 15].map((h) => playlistAt('2026-11-21', h))).toEqual(['flash', 'lunch', 'flash']);
    // Group Back's dinner is never this screen's.
    expect(week.flatMap((d) => d.hours).some((h) => h!.segments.some((g) => g.playlistId === 'dinner'))).toBe(false);
  });

  it('agrees with resolvePlaylist, which the screen runs, at the start of everything it draws', () => {
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
    for (const day of week)
      for (const cell of day.hours)
        for (const g of cell!.segments) {
          const when = new Date(cell!.at.getTime() + g.from * 60_000);
          expect(g.playlistId, when.toISOString()).toBe(resolvePlaylist(manifest, when).id);
        }
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

describe('to the minute', () => {
  // Monday 16 November 2026 in New York: lunch 11:30 to 13:15, a short break 16:10 to 16:50, and a
  // takeover 14:05 to 14:55 (19:05 to 19:55 UTC).
  const day = weekOf({
    screen: lobby,
    groups,
    entries: [
      entry('sch_lunch', { playlistId: 'lunch', target: 'screen', screenId: 'scr_lobby', days: [1], from: '11:30', to: '13:15' }),
      entry('sch_break', { playlistId: 'break', target: 'org', days: [1], from: '16:10', to: '16:50' }),
      entry('sch_flash', { playlistId: 'flash', priority: 100, startsAt: '2026-11-16T19:05:00.000Z', endsAt: '2026-11-16T19:55:00.000Z', takeover: true }),
    ],
    defaultPlaylistId: 'main',
    at,
  }).find((d) => d.date === '2026-11-16')!;
  const hour = (h: number) => day.hours[h]!.segments.map((g) => [g.from, g.to, g.playlistId, ...(g.takeover ? ['takeover'] : [])]);

  it('draws what starts or ends inside an hour where it does', () => {
    expect(hour(11)).toEqual([
      [0, 30, 'main'],
      [30, 60, 'lunch'],
    ]);
    expect(hour(12)).toEqual([[0, 60, 'lunch']]);
    expect(hour(13)).toEqual([
      [0, 15, 'lunch'],
      [15, 60, 'main'],
    ]);
    expect(hour(16)).toEqual([
      [0, 10, 'main'],
      [10, 50, 'break'],
      [50, 60, 'main'],
    ]);
  });

  it('shows a takeover shorter than an hour', () => {
    expect(hour(14)).toEqual([
      [0, 5, 'main'],
      [5, 55, 'flash', 'takeover'],
      [55, 60, 'main'],
    ]);
  });
});

describe('as drafted', () => {
  it('leaves out a removed entry, and of two takeovers draws the newer', () => {
    const older = entry('sch_b', {
      playlistId: 'flash',
      priority: 100,
      startsAt: '2026-11-18T17:00:00.000Z',
      endsAt: '2026-11-18T19:00:00.000Z',
      takeover: true,
    });
    const newer = entry('sch_a', {
      playlistId: 'lunch',
      priority: 100,
      startsAt: '2026-11-18T17:30:00.000Z',
      endsAt: '2026-11-18T18:00:00.000Z',
      takeover: true,
    });
    const removed = entry('sch_c', { playlistId: 'dinner', target: 'screen', screenId: 'scr_lobby', deleted: true });
    const wed = weekOf({ screen: lobby, groups, entries: [older, newer, removed], defaultPlaylistId: 'main', at }).find((d) => d.date === '2026-11-18')!;
    expect(wed.hours[12]!.segments.map((g) => [g.from, g.playlistId])).toEqual([
      [0, 'flash'],
      [30, 'lunch'],
    ]);
    expect(wed.hours[13]!.segments.map((g) => g.playlistId)).toEqual(['flash']);
    expect(wed.hours.flatMap((h) => h!.segments).some((g) => g.playlistId === 'dinner')).toBe(false);
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
