/**
 * The Schedule page's model (M3-19): schedule entries and takeovers as the tools return them
 * (`list_schedule_entries`), in words, and the week view: what one screen plays through its week,
 * as drafted, from the entries aimed at it, its groups or every screen. Which entries reach it, and in what order, is
 * the compiler's Screen schedule, as the publish asks it (#330); the week view asks player-core's `playing`, which the
 * screen itself runs, at every instant what plays can change, so the page and the screen cannot disagree.
 */
import { reaches, screenSchedule, targetIdOf, type TargetedEntry } from '@signforge/compiler/schedule';
import { localTime, playing, type ScheduleView } from '@signforge/player-core';
import type { ToolOutput } from '@signforge/tools/outputs';
import { dayRange } from './days';

/** One schedule entry or takeover, its draft, as `list_schedule_entries` returns it: `deleted` waits for a publish, `live` is what screens play. */
export type ScheduleEntryView = ToolOutput<'list_schedule_entries'>['entries'][number];

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

/**
 * An entry as drafted, as the Screen schedule takes it: published ones by when, then the drafts the next publish takes,
 * after every published one.
 */
function toEntry(e: ScheduleEntryView): TargetedEntry {
  const targetId = targetIdOf(e);
  return {
    id: e.id,
    playlist: e.playlistId,
    priority: e.priority,
    target: e.target,
    ...(targetId === undefined ? {} : { targetId }),
    order: e.draftChanged ? Number.POSITIVE_INFINITY : (e.publishedAt ?? Number.POSITIVE_INFINITY),
    ...(e.startDate ? { startDate: e.startDate } : {}),
    ...(e.endDate ? { endDate: e.endDate } : {}),
    ...(e.days ? { days: e.days } : {}),
    ...(e.from ? { from: e.from } : {}),
    ...(e.to ? { to: e.to } : {}),
    ...(e.startsAt ? { startsAt: e.startsAt } : {}),
    ...(e.endsAt ? { endsAt: e.endsAt } : {}),
  };
}

/** The screen as its schedule sees it: its id and the groups it is in. */
const scheduleScreen = (screenId: string, groups: readonly { id: string; screenIds: readonly string[] }[]) => ({
  id: screenId,
  groups: groups.filter((g) => g.screenIds.includes(screenId)).map((g) => g.id),
});

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
 * What the screen's rule reads of `screen`'s schedule, as drafted: the entries that reach it, as the Screen schedule
 * orders them. Every playlist it names counts as one the screen has, and none as alerts alone: the page reads it on a
 * trusted clock, where that never matters.
 */
function scheduleView({ screen, groups, entries, defaultPlaylistId }: ScreenSchedule): ScheduleView {
  return {
    timezone: screen.timezone,
    schedule: screenSchedule(entries.filter((e) => !e.deleted).map(toEntry), scheduleScreen(screen.id, groups)),
    defaultPlaylist: defaultPlaylistId,
    has: () => true,
    alertsOnly: () => false,
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
  const view = scheduleView(s);
  const daily = view.schedule.flatMap((e) => [e.from, e.to].flatMap((t) => (t ? [minutesOf(t)] : [])));
  const instants = view.schedule.flatMap((e) => [e.startsAt, e.endsAt].flatMap((t) => (t ? [Date.parse(t)] : [])));
  /** The hour starting at `start`, local hour `hour`, cut where what plays changes. */
  const hourAt = (start: number, hour: number): WeekHour => {
    const cuts = new Set([0]);
    for (const m of daily) if (Math.floor(m / 60) === hour) cuts.add(m % 60);
    for (const t of instants) if (t > start && t < start + HOUR) cuts.add(Math.ceil((t - start) / 60_000));
    const minutes = [...cuts].filter((m) => m < 60).sort((a, b) => a - b);
    const segments: Segment[] = [];
    minutes.forEach((from, i) => {
      const when = new Date(start + from * 60_000);
      const now = playing(view, when);
      const playlistId = now.playlist;
      const takeover = now.takeover !== undefined;
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

/** Where an entry stands between its draft and screens: published, a draft, changes not published, or removed until the next publish. */
export const stateWord = (e: Pick<ScheduleEntryView, 'deleted' | 'published' | 'draftChanged'>) =>
  e.deleted ? 'Removed, not published' : !e.published ? 'Draft, not published' : e.draftChanged ? 'Changes not published' : 'Published';

/** In the viewer's time zone, as the takeover dialog takes it, on the week view's 24-hour clock. */
export const timeWord = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** Whether a takeover (as drafted, or as screens have it) ends after `now`. */
export const runsAfter = (e: { endsAt: string | null } | null, now: number) => !!e?.endsAt && Date.parse(e.endsAt) > now;

/** Whom an entry is aimed at, in a list of entries: "Every screen", "Group Front", or the screen's name. */
export function aimedAt(
  e: Pick<ScheduleEntryView, 'target' | 'groupId' | 'screenId'>,
  screens: readonly { id: string; name: string }[],
  groups: readonly { id: string; name: string }[],
): string {
  if (e.target === 'group') return `Group ${groups.find((g) => g.id === e.groupId)?.name ?? 'removed'}`;
  if (e.target === 'screen') return screens.find((s) => s.id === e.screenId)?.name ?? 'A removed screen';
  return 'Every screen';
}

/** How an entry reaches one screen (#181): aimed at it, through one of its groups, or at every screen; undefined when it does not. */
export function howItReaches(
  e: Pick<ScheduleEntryView, 'target' | 'groupId' | 'screenId'>,
  screenId: string,
  groups: readonly { id: string; name: string; screenIds: readonly string[] }[],
): string | undefined {
  if (!reaches({ target: e.target, targetId: targetIdOf(e) }, scheduleScreen(screenId, groups))) return undefined;
  if (e.target === 'screen') return 'This screen';
  if (e.target === 'group') return `Via group ${groups.find((g) => g.id === e.groupId)?.name ?? 'removed'}`;
  return 'Every screen';
}

/**
 * The schedule as screens have it: each published entry as it was published (`live`), though its
 * draft changed or waits to be removed; one never published is left out. What a pinned publish of
 * one more entry builds on (Save and publish, #181).
 */
export const publishedEntries = (entries: readonly ScheduleEntryView[]): ScheduleEntryView[] =>
  entries.flatMap((e) => (e.live ? [{ ...e, ...e.live, deleted: false, draftChanged: false }] : []));

/** The entry being written in the dialog, aimed at one screen, as the tools take its when (null for a field left out). */
interface DraftEntry {
  playlistId: string;
  priority: number;
  days: number[] | null;
  from: string | null;
  to: string | null;
  startDate: string | null;
  endDate: string | null;
  /** The entry it changes, left out of the others; null for a new one. */
  replaces: string | null;
}

/** The entry dialog's preview line, and the priority that would make it win where it loses (null where nothing can: a takeover, or priority 99). */
export interface EntryPreview {
  text: string;
  raise: { priority: number; above: string } | null;
}

const DRAFT = 'draft';
const MAX_PRIORITY = 99;
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Which entry plays at each minute of the week holding `at`, Monday first: a day per local date, 1440 minutes each, undefined for a skipped hour. */
function winnersByMinute(week: WeekDay[]): (string | undefined)[][] {
  return week.map((d) => {
    const minutes: (string | undefined)[] = Array.from({ length: 1440 }, () => undefined);
    d.hours.forEach((hour, h) => {
      for (const g of hour?.segments ?? []) for (let m = g.from; m < g.to; m++) minutes[h * 60 + m] = g.playlistId;
    });
    return minutes;
  });
}

/**
 * "What this screen will play" (#181): `draft`, aimed at `screen`, over this week as drafted, as
 * one line. Each entry is given a playlist of its own id, so `weekOf` (which asks player-core's
 * `playing`, as the screen does) says which entry wins each minute: where the draft would
 * play alone, the entry that wins instead is where it loses. Takeovers cut in; anything else can
 * be outranked.
 */
export function entryPreview(s: {
  screen: { id: string; timezone: string };
  groups: readonly { id: string; name: string; screenIds: readonly string[] }[];
  entries: readonly ScheduleEntryView[];
  draft: DraftEntry;
  defaultPlaylistId: string;
  names: (playlistId: string) => string;
  at: Date;
}): EntryPreview {
  const { screen, groups, draft, names, at } = s;
  const asSelf = (e: ScheduleEntryView): ScheduleEntryView => ({ ...e, playlistId: e.id });
  const mine: ScheduleEntryView = {
    id: DRAFT,
    playlistId: DRAFT,
    target: 'screen',
    groupId: null,
    screenId: screen.id,
    priority: draft.priority,
    startDate: draft.startDate,
    endDate: draft.endDate,
    days: draft.days,
    from: draft.from,
    to: draft.to,
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
  };
  const others = s.entries.filter((e) => e.id !== draft.replaces && !e.deleted);
  const alone = winnersByMinute(weekOf({ screen, groups, entries: [mine], defaultPlaylistId: '', at }));
  const week = weekOf({ screen, groups, entries: [...others.map(asSelf), mine], defaultPlaylistId: '', at });
  const all = winnersByMinute(week);
  const name = names(draft.playlistId);
  const when = describeWhen(draft);

  // Where it would play alone and another entry wins instead, as runs of one winner within a day.
  const runs = new Map<string, { from: number; to: number; winner: string; days: number[] }>();
  const playsOn = new Set<number>();
  let plays = 0;
  let loses = 0;
  week.forEach((d, i) => {
    const weekday = new Date(`${d.date}T12:00:00Z`).getUTCDay();
    let run: { from: number; winner: string } | null = null;
    const close = (to: number) => {
      if (!run) return;
      const key = `${run.from}-${to}-${run.winner}`;
      const found = runs.get(key) ?? { from: run.from, to, winner: run.winner, days: [] };
      found.days.push(weekday);
      runs.set(key, found);
      run = null;
    };
    for (let m = 0; m < 1440; m++) {
      const own = alone[i]![m] === DRAFT;
      const winner = all[i]![m];
      if (own) {
        plays++;
        playsOn.add(weekday);
      }
      const lost = own && winner !== undefined && winner !== DRAFT ? winner : null;
      if (lost) loses++;
      if (run && run.winner !== lost) close(m);
      if (lost && !run) run = { from: m, winner: lost };
    }
    close(1440);
  });

  if (!plays) return { text: `${name} does not play this week: ${when === 'Always' ? 'its dates leave it out' : when}.`, raise: null };
  const byId = new Map(others.map((e) => [e.id, e]));
  const winnerOf = (id: string) => byId.get(id)!;
  const what = (e: ScheduleEntryView) => {
    if (e.takeover) return `a takeover of ${names(e.playlistId)}`;
    const on =
      e.target === 'group' ? (groups.find((g) => g.id === e.groupId)?.name ?? 'a removed group') : e.target === 'screen' ? 'this screen' : 'every screen';
    return `${names(e.playlistId)} on ${on}`;
  };
  const beats = (e: ScheduleEntryView) => (e.takeover ? 'cuts in' : `wins (priority ${e.priority})`);
  const beatable = [...runs.values()].map((r) => winnerOf(r.winner)).filter((e) => !e.takeover);
  const top = beatable.toSorted((a, b) => b.priority - a.priority)[0];
  const raise = top && top.priority < MAX_PRIORITY ? { priority: top.priority + 1, above: names(top.playlistId) } : null;

  const listed = [...runs.values()];
  const never = loses === plays;
  if (never && listed.length === 1) {
    const e = winnerOf(listed[0]!.winner);
    return { text: `${name} would not play: ${what(e)} ${e.takeover ? 'cuts in' : `wins whenever it would (priority ${e.priority})`}.`, raise };
  }
  const allDays = (days: number[]) => [...playsOn].every((d) => days.includes(d));
  const shown = listed.slice(0, 3).map((r) => {
    const e = winnerOf(r.winner);
    const span = r.from === 0 && r.to === 1440 ? 'all day' : `${clock(r.from)}–${clock(r.to)}`;
    return `${allDays(r.days) ? '' : `${dayRange(r.days)} `}${span} when ${what(e)} ${beats(e)}`;
  });
  const more = listed.length > 3 ? ` and ${listed.length - 3} more times` : '';
  if (never) return { text: `${name} would not play: ${shown.join('; ')}${more}.`, raise };
  const exceptions = shown.length ? `, except ${shown.join('; ')}${more}` : '';
  return { text: `Plays ${name} ${when === 'Always' ? 'all day' : when}${exceptions}.`, raise };
}
