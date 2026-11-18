import type { CalendarFeed } from '@signforge/contract';
import ICAL from 'ical.js';
import { checkSize, FeedError, LIMITS } from './errors';
import { isIanaZone, isoDate, isoInstant, wallOffset, wallToInstant, type Wall } from './time';

type CalendarEvent = CalendarFeed['events'][number];

export interface CalendarOptions {
  /** The moment the feed is read at. Events that have ended by then are dropped. */
  now: Date;
  horizonDays?: number;
  maxBytes?: number;
  maxIterations?: number;
  maxPastIterations?: number;
  maxEvents?: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** An all-day event lasts until its end date begins in the last time zone to reach it, UTC-12. */
const LAST_ZONE_MS = 12 * HOUR_MS;

interface Occurrence extends CalendarEvent {
  /** Start as an instant, for sorting and the horizon. All-day events use UTC midnight. */
  sortMs: number;
  /** When the event is over everywhere. */
  overMs: number;
}

/**
 * An iCalendar feed (Google Calendar, Outlook, ...) as a CalendarFeed: the events that have not
 * ended by `now` and start within the horizon, recurring ones expanded, soonest first.
 *
 * Times: a TZID that names an IANA zone is used directly; otherwise the file's
 * VTIMEZONE definition for it (Outlook's "Eastern Standard Time"); otherwise, like floating
 * times, X-WR-TIMEZONE; otherwise UTC.
 */
export function parseCalendar(text: string, options: CalendarOptions): CalendarFeed {
  const o = { ...LIMITS, ...options };
  checkSize(text, o.maxBytes);

  let jcal: unknown;
  try {
    jcal = ICAL.parse(text);
  } catch (e) {
    // biome-ignore lint/style/useErrorCause: the cause is passed, in the options argument; the rule reads only the second argument.
    throw new FeedError('malformed', `not an iCalendar feed: ${(e as Error).message.slice(0, 80)}`, { cause: e });
  }
  const roots = (Array.isArray(jcal) && typeof jcal[0] === 'string' ? [jcal] : (jcal as unknown[])).map((j) => new ICAL.Component(j as unknown[]));
  if (!roots.some((r) => r.name === 'vcalendar')) throw new FeedError('malformed', 'no VCALENDAR in the feed');

  const nowMs = options.now.getTime();
  const window = { nowMs, endMs: nowMs + o.horizonDays * DAY_MS, maxIterations: o.maxIterations, maxPastIterations: o.maxPastIterations };
  const out: Occurrence[] = [];

  for (const cal of roots) {
    if (cal.name !== 'vcalendar') continue;
    const xwr = String(cal.getFirstPropertyValue('x-wr-timezone') ?? '').trim();
    const defaultTz = isIanaZone(xwr) ? xwr : 'UTC';
    const vevents = cal.getAllSubcomponents('vevent');

    // Group moved and cancelled instances (RECURRENCE-ID) under their series by UID.
    const exceptions = new Map<string, ICAL.Component[]>();
    for (const c of vevents) {
      if (!c.hasProperty('recurrence-id')) continue;
      const uid = String(c.getFirstPropertyValue('uid') ?? '');
      exceptions.set(uid, [...(exceptions.get(uid) ?? []), c]);
    }
    const masters = new Set<string>();
    for (const c of vevents) {
      if (!c.hasProperty('recurrence-id')) masters.add(String(c.getFirstPropertyValue('uid') ?? ''));
    }

    for (const c of vevents) {
      const uid = String(c.getFirstPropertyValue('uid') ?? '');
      const isException = c.hasProperty('recurrence-id');
      // An exception whose series is missing from the file stands alone.
      if (isException && masters.has(uid)) continue;
      try {
        const event = new ICAL.Event(c, { exceptions: isException ? [] : (exceptions.get(uid) ?? []) });
        expand(event, defaultTz, window, out);
      } catch {
        // One broken event does not lose the rest of the calendar.
      }
    }
  }

  out.sort((a, b) => a.sortMs - b.sortMs || a.title.localeCompare(b.title));
  return { events: out.slice(0, o.maxEvents).map(({ sortMs: _s, overMs: _o, ...e }) => e) };
}

interface Window {
  nowMs: number;
  endMs: number;
  maxIterations: number;
  maxPastIterations: number;
}

function expand(event: ICAL.Event, defaultTz: string, w: Window, out: Occurrence[]): void {
  if (isCancelled(event)) return;
  const push = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null) => {
    if (isCancelled(item)) return;
    const occ = occurrence(item, start, end, defaultTz);
    if (occ && occ.overMs > w.nowMs && occ.sortMs < w.endMs) out.push(occ);
  };

  if (!event.isRecurring()) {
    push(event, event.startDate, null);
    return;
  }

  const startHint = tzidOf(event.component, 'dtstart');
  const seen = new Set<ICAL.Event>();
  const from = skipAhead(event, startHint, defaultTz, w.nowMs);
  const fromMs = sortMs(from, startHint, defaultTz);
  const it = event.iterator(from);
  let reachedEnd = false;
  // What is left of the past after skipping ahead (all of it, for a series that cannot skip) is
  // stepped through on a budget of its own; the cap that matters counts from now.
  let past = 0;
  let ahead = 0;
  while (ahead < w.maxIterations && past < w.maxPastIterations) {
    const next = it.next();
    if (!next) {
      reachedEnd = true;
      break;
    }
    const startMs = sortMs(next, startHint, defaultTz);
    if (startMs >= w.endMs) {
      reachedEnd = true;
      break;
    }
    if (startMs < w.nowMs) past++;
    else ahead++;
    const d = event.getOccurrenceDetails(next);
    if (d.item !== event) {
      seen.add(d.item);
      push(d.item, d.item.startDate, null);
    } else {
      push(event, d.startDate, d.endDate);
    }
  }
  // A moved instance whose original slot lies before where the steps began, beyond the horizon,
  // or past the iteration cap can still land inside it.
  for (const ex of Object.values(event.exceptions)) {
    if (seen.has(ex)) continue;
    const slotMs = sortMs(ex.recurrenceId, tzidOf(ex.component, 'recurrence-id') ?? startHint, defaultTz);
    if (!reachedEnd || slotMs < fromMs || slotMs >= w.endMs) push(ex, ex.startDate, null);
  }
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * How many days a rule takes to repeat its pattern exactly, in wall-clock days, or undefined if it
 * does not (monthly and yearly rules, whose months differ) or must be counted from its first
 * occurrence (COUNT). A daily or weekly rule repeats every interval; a sub-daily one every day on
 * which a whole number of its intervals ends.
 */
function periodDays(rule: ICAL.Recur): number | undefined {
  if (rule.count) return undefined;
  const k = rule.interval || 1;
  switch (rule.freq) {
    case 'DAILY':
      return k;
    case 'WEEKLY':
      return 7 * k;
    case 'HOURLY':
      return k / gcd(k, 24);
    case 'MINUTELY':
      return k / gcd(k, 1440);
    case 'SECONDLY':
      return k / gcd(k, 86_400);
    default:
      return undefined;
  }
}

/**
 * Where to start stepping a series: its first occurrence moved on by whole periods to a little
 * before `nowMs`, so a series begun years ago costs what a new one does. ical.js steps from the
 * first occurrence and cannot skip itself. Moving by whole periods of wall-clock days keeps every
 * later occurrence in step, across DST. The moved start may not itself match the rule (a weekday
 * rule moved to a Saturday), so it is kept a day and an event's length before `nowMs` (and the
 * 12 hours an all-day event lasts past its end, `LAST_ZONE_MS`), where anything it yields is over
 * and dropped. A rule with more than one RRULE, or one that cannot be
 * moved (`periodDays`), starts from its first occurrence.
 */
function skipAhead(event: ICAL.Event, startHint: string | undefined, defaultTz: string, nowMs: number): ICAL.Time {
  const first = event.startDate;
  const rules = event.component.getAllProperties('rrule');
  if (rules.length !== 1) return first;
  const rule = rules[0]?.getFirstValue();
  const days = rule instanceof ICAL.Recur ? periodDays(rule) : undefined;
  if (!days) return first;
  const lengthMs = event.duration.toSeconds() * 1000;
  const marginMs = DAY_MS + lengthMs + (first.isDate ? LAST_ZONE_MS : 0);
  const n = Math.floor((nowMs - marginMs - sortMs(first, startHint, defaultTz)) / (days * DAY_MS));
  if (n <= 0) return first;
  const from = first.clone();
  from.adjust(n * days, 0, 0, 0);
  return from;
}

const isCancelled = (e: ICAL.Event) => String(e.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';

function tzidOf(c: ICAL.Component, prop: string): string | undefined {
  const v = c.getFirstProperty(prop)?.getParameter('tzid');
  return typeof v === 'string' && v ? v : undefined;
}

const clean = (v: unknown) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const wallOf = (t: ICAL.Time): Wall => ({
  year: t.year,
  month: t.month,
  day: t.day,
  hour: t.hour,
  minute: t.minute,
  second: t.second,
});

/** The instant of a timed value and its UTC offset there. */
function instant(t: ICAL.Time, tzid: string | undefined, defaultTz: string): { ms: number; offsetMs: number } {
  const w = wallOf(t);
  const zone = t.zone?.tzid;
  let ms: number;
  if (zone === 'UTC') {
    ms = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  } else if (tzid && isIanaZone(tzid)) {
    ms = wallToInstant(w, tzid);
  } else if (zone && zone !== 'floating') {
    // Defined by a VTIMEZONE in the file, such as Outlook's Windows zone names.
    ms = t.toUnixTime() * 1000;
  } else {
    ms = wallToInstant(w, defaultTz);
  }
  return { ms, offsetMs: wallOffset(w, ms) };
}

function sortMs(t: ICAL.Time, tzid: string | undefined, defaultTz: string): number {
  return t.isDate ? Date.UTC(t.year, t.month - 1, t.day) : instant(t, tzid, defaultTz).ms;
}

/**
 * One occurrence of `item`. `end` is given for an expanded instance of a series; otherwise the
 * item's own DTEND or DURATION is used, and failing both, a day for an all-day event and an
 * hour for a timed one.
 */
function occurrence(item: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null, defaultTz: string): Occurrence | null {
  const c = item.component;
  const hasLength = c.hasProperty('dtend') || c.hasProperty('duration');
  const title = clean(c.getFirstPropertyValue('summary')) || 'Untitled';
  const location = clean(c.getFirstPropertyValue('location'));

  if (start.isDate) {
    let endT = end ?? (hasLength ? item.endDate : null);
    if (!endT || !hasLength || endT.compare(start) <= 0) {
      endT = start.clone();
      endT.adjust(1, 0, 0, 0);
    }
    const startMs = Date.UTC(start.year, start.month - 1, start.day);
    const endMs = Date.UTC(endT.year, endT.month - 1, endT.day);
    return {
      title,
      start: isoDate(start),
      end: isoDate(endT),
      allDay: true,
      location,
      sortMs: startMs,
      overMs: endMs + LAST_ZONE_MS,
    };
  }

  const startHint = tzidOf(c, 'dtstart');
  const s = instant(start, startHint, defaultTz);
  let e: { ms: number; offsetMs: number };
  if (hasLength) {
    const endT = end ?? item.endDate;
    const endHint = end || !c.hasProperty('dtend') ? startHint : tzidOf(c, 'dtend');
    e = endT.isDate ? { ms: s.ms + HOUR_MS, offsetMs: s.offsetMs } : instant(endT, endHint, defaultTz);
    if (e.ms < s.ms) e = { ms: s.ms, offsetMs: s.offsetMs };
  } else {
    e = { ms: s.ms + HOUR_MS, offsetMs: s.offsetMs };
  }
  return {
    title,
    start: isoInstant(s.ms, s.offsetMs),
    end: isoInstant(e.ms, e.offsetMs),
    allDay: false,
    location,
    sortMs: s.ms,
    overMs: e.ms,
  };
}
