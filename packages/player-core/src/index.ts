/**
 * Player logic with no browser dependency: which playlist is live, what plays next,
 * and which files a manifest still needs. Checking a manifest is the contract's job. The browser shell supplies time, storage and frames.
 */
import {
  brandFiles,
  readPath,
  SNAPSHOT_STALE_MS,
  requiredFiles,
  validateBoundValue,
  type DataSnapshot,
  type DisplayHours,
  type Playlist,
  type ScheduleEntry,
  type ScreenManifest,
  type Spot,
  type TargetLevel,
} from '@signforge/contract';

/**
 * Validation lives in the contract, which the server imports too. Re-exported here while callers
 * move to `@signforge/contract`; new code imports from there.
 */
export { displayHoursProblems, requiredFiles, safeUrl, validateManifest, validTimezone } from '@signforge/contract';

// ------------------------------------------------------------------ schedule

export interface LocalTime {
  /** `YYYY-MM-DD` */
  date: string;
  /** 0 = Sunday */
  day: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock time in a given IANA time zone. */
export function localTime(now: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    day: DAY_INDEX[get('weekday')] ?? 0,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** The calendar date before a `YYYY-MM-DD` date. */
const previousDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export function entryApplies(e: ScheduleEntry, t: LocalTime): boolean {
  const from = e.from ? toMinutes(e.from) : 0;
  const to = e.to ? toMinutes(e.to) : 24 * 60;
  const crossesMidnight = to <= from && !!e.to && !!e.from;
  const inWindow = crossesMidnight ? t.minutes >= from || t.minutes < to : t.minutes >= from && t.minutes < to;
  if (!inWindow) return false;
  // After midnight, an overnight window still belongs to the day and date it started on.
  const tail = crossesMidnight && t.minutes < to;
  const date = tail ? previousDate(t.date) : t.date;
  if (e.startDate && date < e.startDate) return false;
  if (e.endDate && date > e.endDate) return false;
  if (e.days && !e.days.includes(tail ? (t.day + 6) % 7 : t.day)) return false;
  return true;
}

const inWindow = (w: { from: string; to: string }, minutes: number) => {
  const from = toMinutes(w.from),
    to = toMinutes(w.to);
  return to <= from ? minutes >= from || minutes < to : minutes >= from && minutes < to;
};

/**
 * Whether the display should be on. A dated exception replaces the weekly hours for that whole
 * date, including the tail of an overnight window from the day before.
 */
export function displayOn(hours: DisplayHours | undefined, t: LocalTime): boolean {
  if (!hours) return true;
  const exception = hours.exceptions?.find((e) => e.date === t.date);
  if (exception) return exception.on.some((w) => toMinutes(w.to) > toMinutes(w.from) && inWindow(w, t.minutes));
  return hours.weekly.some((w) => {
    if (!entryApplies({ id: '', playlist: '', priority: 0, target: 'screen', ...w }, t)) return false;
    // The after-midnight tail of an overnight window belongs to the previous date, so an
    // exception on that date replaces it too.
    const tail = toMinutes(w.to) <= toMinutes(w.from) && t.minutes < toMinutes(w.to);
    return !(tail && hours.exceptions?.some((e) => e.date === previousDate(t.date)));
  });
}

/** The instant a local wall-clock time happens in `timezone` (the later reading where a clock change repeats it). */
function localToInstant(date: string, minutes: number, timezone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  const offsetAt = (t: number) => {
    const l = localTime(new Date(t), timezone);
    return Date.parse(`${l.date}T00:00:00Z`) + l.minutes * 60_000 - Math.floor(t / 60_000) * 60_000;
  };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

/** How far ahead `nextDisplayChange` looks: past a week, so a weekly window is always found. */
const DISPLAY_LOOKAHEAD_DAYS = 9;

/**
 * When the display next turns on or off by its hours, after `now`: the CMS's "wakes 07:00", and
 * the end of a display override. Undefined for a screen without hours, or one whose hours do not
 * change in the next nine days. Changes happen only at a window's edge or at local midnight (an
 * exception's day), so only those instants are checked.
 */
export function nextDisplayChange(hours: DisplayHours | undefined, timezone: string, now: Date): Date | undefined {
  if (!hours) return undefined;
  const edges = new Set<number>([0]);
  for (const w of [...hours.weekly, ...(hours.exceptions ?? []).flatMap((e) => e.on)]) {
    edges.add(toMinutes(w.from) % 1440);
    edges.add(toMinutes(w.to) % 1440);
  }
  const today = localTime(now, timezone).date;
  const start = Date.parse(`${today}T00:00:00Z`);
  const candidates: number[] = [];
  for (let d = -1; d <= DISPLAY_LOOKAHEAD_DAYS; d++) {
    const date = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    for (const m of edges) candidates.push(localToInstant(date, m, timezone));
  }
  const on = displayOn(hours, localTime(now, timezone));
  const after = [...new Set(candidates)].filter((t) => t > now.getTime()).sort((a, b) => a - b);
  const found = after.find((t) => displayOn(hours, localTime(new Date(t), timezone)) !== on);
  return found === undefined ? undefined : new Date(found);
}

const LEVEL: Record<TargetLevel, number> = { org: 0, group: 1, screen: 2 };

/**
 * Whether `now` is inside an entry's absolute bounds. On a clock the screen does not trust, an entry
 * with either bound never applies: better a takeover missed than one that never ends.
 */
export function withinBounds(e: ScheduleEntry, now: Date, clockTrusted = true): boolean {
  if (e.startsAt === undefined && e.endsAt === undefined) return true;
  if (!clockTrusted) return false;
  const ms = now.getTime();
  return !(e.startsAt !== undefined && ms < Date.parse(e.startsAt)) && !(e.endsAt !== undefined && ms >= Date.parse(e.endsAt));
}

/** Highest priority wins; on a tie the more specific target wins; otherwise the default playlist. */
export function resolvePlaylist(manifest: ScreenManifest, now: Date, { clockTrusted = true } = {}): Playlist {
  const t = localTime(now, manifest.screen.timezone);
  const live = manifest.schedule
    .filter((e) => withinBounds(e, now, clockTrusted) && entryApplies(e, t) && manifest.playlists[e.playlist])
    .sort((a, b) => b.priority - a.priority || LEVEL[b.target] - LEVEL[a.target] || a.id.localeCompare(b.id));
  const id = live[0]?.playlist ?? manifest.defaultPlaylist;
  const playlist = manifest.playlists[id];
  if (!playlist) throw new Error(`manifest ${manifest.id} has no playlist "${id}"`);
  return playlist;
}

// ----------------------------------------------------------------- sequencer

export interface Step {
  playlist: Playlist;
  spot: Spot;
  /** Position of the spot in the playlist. */
  index: number;
}

/**
 * Walks the live playlist one spot at a time. The schedule is re-evaluated on every step,
 * so a daypart change or a new manifest takes effect at the next spot boundary.
 */
export class Sequencer {
  private playlistId?: string;
  private index = -1;

  constructor(private manifest: ScreenManifest) {}

  /** Swap in a new manifest. The current position carries over when the playlist still exists. */
  setManifest(manifest: ScreenManifest): void {
    this.manifest = manifest;
  }

  get manifestId(): string {
    return this.manifest.id;
  }

  /** The next spot at `now`. On a clock the screen does not trust, bounded entries are skipped (`resolvePlaylist`). */
  next(now: Date, opts: { clockTrusted?: boolean } = {}): Step | undefined {
    const playlist = resolvePlaylist(this.manifest, now, opts);
    if (playlist.id !== this.playlistId) {
      this.playlistId = playlist.id;
      this.index = -1;
    }
    const n = playlist.items.length;
    for (let tried = 0; tried < n; tried++) {
      this.index = (this.index + 1) % n;
      const spot = this.manifest.spots[playlist.items[this.index]!.spot];
      if (spot) return { playlist, spot, index: this.index };
    }
    return undefined;
  }

  /** What `next` would return, without moving. Used to prepare the following spot early. */
  peek(now: Date, opts: { clockTrusted?: boolean } = {}): Step | undefined {
    const saved = { playlistId: this.playlistId, index: this.index };
    const step = this.next(now, opts);
    this.playlistId = saved.playlistId;
    this.index = saved.index;
    return step;
  }
}

// ----------------------------------------------------------------- live data

/** A live value that was refused: the source it came from and what is wrong with it. */
export interface Rejected {
  source: string;
  problem: string;
}

/**
 * The data a template spot plays with at `now`: its static values, with each bound field replaced
 * by the latest snapshot value when that value fits the field (`validateBoundValue`). A missing
 * source, or a snapshot the server last confirmed more than `SNAPSHOT_STALE_MS` before `now`,
 * leaves the static fallback in place quietly; a value that is missing at its path or does not fit
 * also leaves the fallback, and is listed in `rejected` so a broken feed can be seen.
 */
export function resolveSpotData(
  spot: Extract<Spot, { kind: 'template' }>,
  fields: unknown,
  snapshots: ReadonlyMap<string, DataSnapshot>,
  now: number,
): { data: Record<string, unknown>; rejected: Rejected[] } {
  const data = { ...spot.data };
  const rejected: Rejected[] = [];
  for (const [field, b] of Object.entries(spot.bindings ?? {})) {
    const snapshot = snapshots.get(b.source);
    if (!snapshot || now - Date.parse(snapshot.checkedAt) > SNAPSHOT_STALE_MS) continue;
    const v = readPath(snapshot.data, b.path);
    const problems = validateBoundValue(fields, field, v);
    if (problems.length) rejected.push(...problems.map((problem) => ({ source: b.source, problem })));
    else data[field] = v;
  }
  return { data, rejected };
}

/**
 * How a snapshot serves the spots of a manifest: how many bound values it would fill, and what is
 * wrong with the rest. A snapshot that fills none while some spot binds to it is broken for this
 * screen, and must not replace the last good one.
 */
export function snapshotFit(manifest: ScreenManifest, snapshot: DataSnapshot): { fits: number; problems: string[] } {
  let fits = 0;
  const problems: string[] = [];
  for (const spot of Object.values(manifest.spots)) {
    if (spot.kind !== 'template') continue;
    const fields = manifest.templates[spot.template]?.manifest.fields;
    for (const [field, b] of Object.entries(spot.bindings ?? {})) {
      if (b.source !== snapshot.id) continue;
      const p = validateBoundValue(fields, field, readPath(snapshot.data, b.path));
      if (p.length) problems.push(...p.map((e) => `spot "${spot.id}": ${e}`));
      else fits++;
    }
  }
  return { fits, problems };
}

// --------------------------------------------------------------------- files

/**
 * The files one spot needs to play: a template spot its bundle and assets, and from frame protocol
 * 2 the brand kit's fonts and logo, which it reads as it prepares; an image or video its file.
 */
export function spotFiles(spot: Spot, manifest: ScreenManifest): Set<string> {
  const out = new Set<string>();
  if (spot.kind === 'template') {
    const t = manifest.templates[spot.template];
    if (t) out.add(t.html);
    Object.values(spot.assets).forEach((a) => out.add(a));
    if (manifest.brand && (t?.manifest.protocol ?? 1) >= 2) brandFiles(manifest.brand).forEach((f) => out.add(f));
  } else if (spot.kind === 'image' || spot.kind === 'video') out.add(spot.file);
  return out;
}

/** Files to download before a manifest can go live, and files no longer needed once it has. */
export function planSync(next: ScreenManifest, have: Iterable<string>): { missing: string[]; stale: string[] } {
  const need = requiredFiles(next);
  const held = new Set(have);
  return {
    missing: [...need].filter((h) => !held.has(h)),
    stale: [...held].filter((h) => !need.has(h)),
  };
}

export { Clock, CLOCK_JUMP_MS, type ClockOptions, type PersistedClock } from './clock';
export { PlayLedger, hourOf, type PlayBatch } from './plays';
export { READY_TIMEOUT_MS, TEMPLATE_SANDBOX, WRAPPER_HTML } from './frame';
