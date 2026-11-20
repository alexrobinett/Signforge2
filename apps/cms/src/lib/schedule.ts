/**
 * The Schedule page's model (M3-19): schedule entries and takeovers as the tools return them
 * (`list_schedule_entries`), in words, and the week view: what one screen plays each hour of its
 * week, from the entries aimed at it, its groups or every screen. The week view asks player-core's
 * `resolvePlaylist`, which the screen itself runs, so the page and the screen cannot disagree.
 */
import type { ScheduleEntry, ScreenManifest } from '@signforge/contract';
import { activeTakeover, localTime, resolvePlaylist } from '@signforge/player-core';
import { dayRange } from './days';

/** One schedule entry or takeover, its draft, as `list_schedule_entries` returns it. */
export interface ScheduleEntryView {
  id: string;
  playlistId: string;
  target: 'org' | 'group' | 'screen';
  groupId: string | null;
  screenId: string | null;
  priority: number;
  startDate: string | null;
  endDate: string | null;
  days: number[] | null;
  from: string | null;
  to: string | null;
  startsAt: string | null;
  endsAt: string | null;
  takeover: boolean;
  version: number;
  published: boolean;
  draftChanged: boolean;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** "Mon–Fri, 06:00–10:00", "Sat, all day, 2026-12-01 to 2026-12-24", or "Always". */
export function describeWhen(e: Pick<ScheduleEntryView, 'days' | 'from' | 'to' | 'startDate' | 'endDate'>): string {
  const parts: string[] = [];
  if (e.days || e.from || e.to) {
    parts.push(dayRange(e.days ?? [0, 1, 2, 3, 4, 5, 6]));
    const from = e.from ?? '00:00';
    const to = e.to ?? '24:00';
    parts.push(e.from || e.to ? `${from}–${to}${e.from && e.to && e.to <= e.from ? ' (into the next day)' : ''}` : 'all day');
  }
  if (e.startDate || e.endDate)
    parts.push(e.startDate && e.endDate ? `${e.startDate} to ${e.endDate}` : e.startDate ? `from ${e.startDate}` : `until ${e.endDate}`);
  return parts.length ? parts.join(', ') : 'Always';
}

/** The entry as a screen gets it: the contract's `ScheduleEntry`. */
function toEntry(e: ScheduleEntryView): ScheduleEntry {
  return {
    id: e.id,
    playlist: e.playlistId,
    priority: e.priority,
    target: e.target,
    ...(e.startDate ? { startDate: e.startDate } : {}),
    ...(e.endDate ? { endDate: e.endDate } : {}),
    ...(e.days ? { days: e.days } : {}),
    ...(e.from ? { from: e.from } : {}),
    ...(e.to ? { to: e.to } : {}),
    ...(e.startsAt ? { startsAt: e.startsAt } : {}),
    ...(e.endsAt ? { endsAt: e.endsAt } : {}),
  };
}

/** Whether an entry reaches the screen: aimed at every screen, one of its groups, or it. */
const reaches = (e: Pick<ScheduleEntryView, 'target' | 'groupId' | 'screenId'>, screenId: string, groupIds: readonly string[]) =>
  e.target === 'org' || (e.target === 'group' && groupIds.includes(e.groupId ?? '')) || (e.target === 'screen' && e.screenId === screenId);

interface WeekHour {
  /** The instant the hour starts. */
  at: Date;
  playlistId: string;
  /** Whether a takeover plays then. */
  takeover: boolean;
}

export interface WeekDay {
  /** The screen's local date, `YYYY-MM-DD`. */
  date: string;
  /** Its 24 local hours; null for an hour a clock change skips. */
  hours: (WeekHour | null)[];
}

interface ScreenSchedule {
  screen: { id: string; timezone: string };
  groups: readonly { id: string; screenIds: readonly string[] }[];
  entries: readonly ScheduleEntryView[];
  defaultPlaylistId: string;
}

/** The part of a manifest `resolvePlaylist` reads, for `screen`: the entries that reach it, the playlists they name, its time zone. */
function scheduleManifest({ screen, groups, entries, defaultPlaylistId }: ScreenSchedule): ScreenManifest {
  const groupIds = groups.filter((g) => g.screenIds.includes(screen.id)).map((g) => g.id);
  const schedule = entries.filter((e) => reaches(e, screen.id, groupIds)).map(toEntry);
  const ids = new Set([defaultPlaylistId, ...schedule.map((e) => e.playlist)]);
  return {
    schema: 0,
    id: 'schedule',
    generatedAt: '',
    screen: { id: screen.id, name: screen.id, timezone: screen.timezone, orientation: 'landscape' },
    files: {},
    templates: {},
    spots: {},
    playlists: Object.fromEntries([...ids].map((id) => [id, { id, name: id, transition: { type: 'cut' }, items: [] }])),
    dataSources: {},
    schedule,
    defaultPlaylist: defaultPlaylistId,
  };
}

/** What `screen` plays at `at`, as drafted, and whether a takeover plays it. */
export function playingAt(s: ScreenSchedule & { at: Date }): { playlistId: string; takeover: boolean } {
  const manifest = scheduleManifest(s);
  return { playlistId: resolvePlaylist(manifest, s.at).id, takeover: activeTakeover(manifest, s.at) !== undefined };
}

/**
 * What `screen` plays each hour of the week holding `at`, Monday first, in its own time zone, as
 * drafted: from the `entries` that reach it, else `defaultPlaylistId`. Each hour is the instant
 * its local hour starts, so a day the clocks change keeps the hours it has.
 */
export function weekOf(s: ScreenSchedule & { at: Date }): WeekDay[] {
  const { screen, at } = s;
  const manifest = scheduleManifest(s);
  const HOUR = 3_600_000;
  const now = localTime(at, screen.timezone);
  // Local Monday 00:00, give or take a clock change: the scan below reads every instant's local time.
  const monday = Math.floor(at.getTime() / 60_000) * 60_000 - (((now.day + 6) % 7) * 1440 + now.minutes) * 60_000;
  const dates = Array.from({ length: 7 }, (_, d) => localTime(new Date(monday + d * 24 * HOUR + 12 * HOUR), screen.timezone).date);
  const week: WeekDay[] = dates.map((date) => ({ date, hours: Array.from({ length: 24 }, () => null) }));
  for (let t = monday - 2 * HOUR; t <= monday + (7 * 24 + 2) * HOUR; t += HOUR) {
    const when = new Date(t);
    const local = localTime(when, screen.timezone);
    const day = week[dates.indexOf(local.date)];
    const hour = Math.floor(local.minutes / 60);
    // A repeated hour (clocks going back) keeps its first instant.
    if (!day || day.hours[hour]) continue;
    day.hours[hour] = { at: when, playlistId: resolvePlaylist(manifest, when).id, takeover: activeTakeover(manifest, when) !== undefined };
  }
  return week;
}
