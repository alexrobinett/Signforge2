/**
 * The Schedule page's model (M3-19): schedule entries and takeovers as the tools return them
 * (`list_schedule_entries`), in words, and the week view: what one screen plays through its week,
 * as drafted, from the entries aimed at it, its groups or every screen. The week view asks
 * player-core's `resolvePlaylist`, which the screen itself runs, at every instant what plays can
 * change, so the page and the screen cannot disagree.
 */
import type { ScheduleEntry, ScreenManifest } from '@signforge/contract';
import { activeTakeover, localTime, resolvePlaylist } from '@signforge/player-core';
import { dayRange } from './days';

/** What an entry plays where and when, as drafted or as published. */
interface EntryFields {
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
}

/** One schedule entry or takeover, its draft, as `list_schedule_entries` returns it. */
export interface ScheduleEntryView extends EntryFields {
  id: string;
  /** Deleted, waiting for a publish: screens keep `live` until then. */
  deleted: boolean;
  /** The published version, what screens play; null if never published. */
  live: EntryFields | null;
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
function toEntry(e: EntryFields & { id: string }): ScheduleEntry {
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

/** A stretch of an hour with one playlist on screen. */
interface Segment {
  /** Minutes into the hour it starts, 0 to 59. */
  from: number;
  /** Minutes into the hour it ends, 1 to 60. */
  to: number;
  playlistId: string;
  /** Whether a takeover plays it. */
  takeover: boolean;
}

interface WeekHour {
  /** The instant the hour starts. */
  at: Date;
  /** What plays through the hour, in order: one segment unless something starts or ends inside it. */
  segments: Segment[];
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

/**
 * The part of a manifest `resolvePlaylist` reads, for `screen`, as drafted: the entries that reach
 * it in the order a publish would list them (published ones by when, then the drafts the next
 * publish takes), the playlists they name, its time zone.
 */
function scheduleManifest({ screen, groups, entries, defaultPlaylistId }: ScreenSchedule): ScreenManifest {
  const groupIds = groups.filter((g) => g.screenIds.includes(screen.id)).map((g) => g.id);
  const when = (e: ScheduleEntryView) => (e.draftChanged ? Number.POSITIVE_INFINITY : (e.publishedAt ?? Number.POSITIVE_INFINITY));
  const schedule = entries
    .filter((e) => !e.deleted && reaches(e, screen.id, groupIds))
    .sort((a, b) => when(a) - when(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toEntry);
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

const HOUR = 3_600_000;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * What `screen` plays through the week holding `at`, Monday first, in its own time zone, as
 * drafted: from the `entries` that reach it, else `defaultPlaylistId`. Each hour is the instant its
 * local hour starts, so a day the clocks change keeps the hours it has. What plays can change only
 * at an entry's daily start or end, a takeover's start or end, or midnight, so each hour is read at
 * its start and at each of those inside it: exact to the minute.
 */
export function weekOf(s: ScreenSchedule & { at: Date }): WeekDay[] {
  const { screen, at } = s;
  const manifest = scheduleManifest(s);
  const daily = manifest.schedule.flatMap((e) => [e.from, e.to].flatMap((t) => (t ? [minutesOf(t)] : [])));
  const instants = manifest.schedule.flatMap((e) => [e.startsAt, e.endsAt].flatMap((t) => (t ? [Date.parse(t)] : [])));
  /** The hour starting at `start`, local hour `hour`, cut where what plays changes. */
  const hourAt = (start: number, hour: number): WeekHour => {
    const cuts = new Set([0]);
    for (const m of daily) if (Math.floor(m / 60) === hour) cuts.add(m % 60);
    for (const t of instants) if (t > start && t < start + HOUR) cuts.add(Math.ceil((t - start) / 60_000));
    const minutes = [...cuts].filter((m) => m < 60).sort((a, b) => a - b);
    const segments: Segment[] = [];
    minutes.forEach((from, i) => {
      const when = new Date(start + from * 60_000);
      const playlistId = resolvePlaylist(manifest, when).id;
      const takeover = activeTakeover(manifest, when) !== undefined;
      const to = minutes[i + 1] ?? 60;
      const last = segments.at(-1);
      if (last && last.playlistId === playlistId && last.takeover === takeover) last.to = to;
      else segments.push({ from, to, playlistId, takeover });
    });
    return { at: new Date(start), segments };
  };
  const now = localTime(at, screen.timezone);
  // Local Monday 00:00, give or take a clock change: the scan below reads every instant's local time.
  const monday = Math.floor(at.getTime() / 60_000) * 60_000 - (((now.day + 6) % 7) * 1440 + now.minutes) * 60_000;
  const dates = Array.from({ length: 7 }, (_, d) => localTime(new Date(monday + d * 24 * HOUR + 12 * HOUR), screen.timezone).date);
  const week: WeekDay[] = dates.map((date) => ({ date, hours: Array.from({ length: 24 }, () => null) }));
  for (let t = monday - 2 * HOUR; t <= monday + (7 * 24 + 2) * HOUR; t += HOUR) {
    const local = localTime(new Date(t), screen.timezone);
    const day = week[dates.indexOf(local.date)];
    const hour = Math.floor(local.minutes / 60);
    // A repeated hour (clocks going back) keeps its first instant.
    if (!day || day.hours[hour]) continue;
    day.hours[hour] = hourAt(t, hour);
  }
  return week;
}
