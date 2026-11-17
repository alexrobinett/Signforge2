/**
 * Player logic with no browser dependency: which playlist is live, what plays next,
 * and which files a manifest still needs. Checking a manifest is the contract's job. The browser shell supplies time, storage and frames.
 */
import { readPath, requiredFiles, validateBoundValue, type DataSnapshot, type DisplayHours, type Playlist, type ScheduleEntry, type ScreenManifest, type Spot, type TargetLevel } from '@signforge/contract';

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
    timeZone: timezone, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
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
  const from = toMinutes(w.from), to = toMinutes(w.to);
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

const LEVEL: Record<TargetLevel, number> = { org: 0, group: 1, screen: 2 };

/** Highest priority wins; on a tie the more specific target wins; otherwise the default playlist. */
export function resolvePlaylist(manifest: ScreenManifest, now: Date): Playlist {
  const t = localTime(now, manifest.screen.timezone);
  const live = manifest.schedule
    .filter((e) => entryApplies(e, t) && manifest.playlists[e.playlist])
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

  next(now: Date): Step | undefined {
    const playlist = resolvePlaylist(this.manifest, now);
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
  peek(now: Date): Step | undefined {
    const saved = { playlistId: this.playlistId, index: this.index };
    const step = this.next(now);
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
 * The data a template spot plays with: its static values, with each bound field replaced by the
 * latest snapshot value when that value fits the field (`validateBoundValue`). A missing source
 * leaves the static fallback in place quietly; a value that is missing at its path or does not
 * fit also leaves the fallback, and is listed in `rejected` so a broken feed can be seen.
 */
export function resolveSpotData(
  spot: Extract<Spot, { kind: 'template' }>,
  fields: unknown,
  snapshots: ReadonlyMap<string, DataSnapshot>,
): { data: Record<string, unknown>; rejected: Rejected[] } {
  const data = { ...spot.data };
  const rejected: Rejected[] = [];
  for (const [field, b] of Object.entries(spot.bindings ?? {})) {
    const snapshot = snapshots.get(b.source);
    if (!snapshot) continue;
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

/** Files to download before a manifest can go live, and files no longer needed once it has. */
export function planSync(next: ScreenManifest, have: Iterable<string>): { missing: string[]; stale: string[] } {
  const need = requiredFiles(next);
  const held = new Set(have);
  return {
    missing: [...need].filter((h) => !held.has(h)),
    stale: [...held].filter((h) => !need.has(h)),
  };
}
