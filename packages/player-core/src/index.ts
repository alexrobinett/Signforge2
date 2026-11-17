/**
 * Player logic with no browser dependency: which playlist is live, what plays next,
 * and which files a manifest still needs. The browser shell supplies time, storage and frames.
 */
import { SUPPORTED_MANIFEST_SCHEMAS, isId, templateKey, type DataSnapshot, type DisplayHours, type Playlist, type ScheduleEntry, type ScreenManifest, type Spot, type TargetLevel } from '@signforge/contract';

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

/** Read a dot path out of a JSON value. Returns undefined when any step is missing. */
export function readPath(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const key of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

/**
 * The data a template spot plays with: its static values, with each bound field replaced by
 * the latest snapshot value. A missing source or path leaves the static fallback in place.
 */
export function resolveSpotData(spot: Extract<Spot, { kind: 'template' }>, snapshots: ReadonlyMap<string, DataSnapshot>): Record<string, unknown> {
  const data = { ...spot.data };
  for (const [field, b] of Object.entries(spot.bindings ?? {})) {
    const snapshot = snapshots.get(b.source);
    const v = snapshot ? readPath(snapshot.data, b.path) : undefined;
    if (v !== undefined && v !== null) data[field] = v;
  }
  return data;
}

// --------------------------------------------------------------------- files

/** A screen checks a data source no more often than this. */
const MIN_REFRESH_S = 60;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A URL spot shows a page from the internet: never a relative, local or script URL. */
export function safeUrl(url: unknown): boolean {
  try {
    return typeof url === 'string' && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function windowProblems(where: string, w: { from?: string; to?: string; days?: number[]; startDate?: string; endDate?: string }, required: boolean): string[] {
  const out: string[] = [];
  for (const k of ['from', 'to'] as const) {
    const v = w[k];
    if (v === undefined ? required : typeof v !== 'string' || !TIME.test(v)) out.push(`${where}: ${k} must be HH:MM`);
  }
  if (w.days !== undefined && (!Array.isArray(w.days) || w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) out.push(`${where}: days must be 0-6`);
  else if (required && !Array.isArray(w.days) && 'days' in w) out.push(`${where}: days must be a list`);
  for (const k of ['startDate', 'endDate'] as const) if (w[k] !== undefined && !DATE.test(String(w[k]))) out.push(`${where}: ${k} must be YYYY-MM-DD`);
  return out;
}

export function validateManifest(m: unknown): string[] {
  const errors: string[] = [];
  const s = m as Partial<ScreenManifest> | null;
  if (!s || typeof s !== 'object') return ['manifest is not an object'];
  if (!SUPPORTED_MANIFEST_SCHEMAS.includes(s.schema as number)) errors.push(`manifest schema ${String(s.schema)} is not one this player can play (${SUPPORTED_MANIFEST_SCHEMAS.join(', ')})`);
  if (!s.id) errors.push('id is missing');
  if (!s.screen?.timezone) errors.push('screen.timezone is missing');
  if (!s.files || !s.spots || !s.playlists || !s.templates || !s.schedule || !s.dataSources) return [...errors, 'manifest is incomplete'];
  if (!s.playlists[s.defaultPlaylist ?? '']) errors.push('defaultPlaylist does not exist');
  for (const [key, t] of Object.entries(s.templates)) {
    if (!t?.manifest || typeof t.manifest !== 'object') {
      errors.push(`template "${key}" has no manifest`);
      continue;
    }
    const owner = key.split('/')[0] ?? '';
    if (!(owner === 'base' || isId(owner)) || key !== templateKey(t.manifest, owner)) {
      errors.push(`template key "${key}" must be <owner>/${t.manifest.id}@${t.manifest.version}`);
    }
  }
  for (const sha of requiredFiles(s as ScreenManifest)) if (!s.files[sha]) errors.push(`file ${sha.slice(0, 12)} is referenced but not listed`);
  for (const [key, spot] of Object.entries(s.spots)) {
    if (spot.id !== key) errors.push(`spot "${key}" is listed under a different id ("${spot.id}")`);
    if (!isId(key)) errors.push(`spot id "${key}" is not a valid id`);
    if (spot.kind === 'template' && !s.templates[spot.template]) errors.push(`spot "${spot.id}" uses unknown template ${spot.template}`);
    if (!(spot.durationMs > 0)) errors.push(`spot "${spot.id}" has no duration`);
    if (spot.kind === 'url' && !safeUrl(spot.url)) errors.push(`spot "${spot.id}" needs an absolute https URL`);
    if (spot.kind === 'template') {
      for (const b of Object.values(spot.bindings ?? {})) {
        if (!s.dataSources[b.source]) errors.push(`spot "${spot.id}" binds to unknown data source "${b.source}"`);
      }
    }
  }
  if (s.screen?.timezone && !validTimezone(s.screen.timezone)) errors.push(`screen.timezone "${s.screen.timezone}" is not a time zone`);
  if (s.screen?.id !== undefined && !isId(s.screen.id)) errors.push(`screen id "${s.screen.id}" is not a valid id`);
  for (const e of s.schedule) {
    if (!isId(e.id)) errors.push(`schedule entry id "${e.id}" is not a valid id`);
    if (typeof e.priority !== 'number' || !Number.isFinite(e.priority)) errors.push(`schedule entry "${e.id}": priority must be a number`);
    if (!['org', 'group', 'screen'].includes(e.target)) errors.push(`schedule entry "${e.id}": target must be org, group or screen`);
    if (!s.playlists[e.playlist]) errors.push(`schedule entry "${e.id}" plays unknown playlist "${e.playlist}"`);
    errors.push(...windowProblems(`schedule entry "${e.id}"`, e, false));
  }
  const hours = s.screen?.displayHours;
  if (hours) {
    if (!Array.isArray(hours.weekly)) errors.push('display hours have no weekly list');
    else for (const w of hours.weekly) errors.push(...windowProblems('display hours', w, true));
    for (const e of hours.exceptions ?? []) {
      if (!DATE.test(e.date) || !Array.isArray(e.on)) errors.push(`display hours exception "${e.date}" is malformed`);
      else for (const w of e.on) {
        errors.push(...windowProblems(`display hours on ${e.date}`, w, true));
        if (toMinutes(w.to) <= toMinutes(w.from)) errors.push(`display hours on ${e.date}: ${w.from}-${w.to} must end after it starts`);
      }
    }
  }
  for (const [key, p] of Object.entries(s.playlists)) {
    if (p.id !== key) errors.push(`playlist "${key}" is listed under a different id ("${p.id}")`);
    if (!isId(key)) errors.push(`playlist id "${key}" is not a valid id`);
    const tr = p.transition as { type?: string; ms?: unknown } | undefined;
    const okMs = (ms: unknown) => typeof ms === 'number' && ms >= 1 && ms <= 10_000;
    if (!tr || !(tr.type === 'cut' || ((tr.type === 'fade' || tr.type === 'crossfade') && okMs(tr.ms)))) {
      errors.push(`playlist "${key}": transition must be cut, fade or crossfade with ms between 1 and 10000`);
    }
    if (!Array.isArray(p.items)) {
      errors.push(`playlist "${key}" has no items list`);
      continue;
    }
    for (const item of p.items) if (!s.spots[item.spot]) errors.push(`playlist "${p.id}" lists unknown spot "${item.spot}"`);
  }
  for (const [key, d] of Object.entries(s.dataSources)) {
    if (d.id !== key) errors.push(`data source "${key}" is listed under a different id ("${d.id}")`);
    if (!isId(key)) errors.push(`data source id "${key}" is not a valid id`);
    if (!(typeof d.refreshS === 'number' && d.refreshS >= MIN_REFRESH_S)) errors.push(`data source "${key}": refreshS must be at least ${MIN_REFRESH_S}`);
  }
  return errors;
}

/** Every file hash a manifest refers to. */
export function requiredFiles(manifest: ScreenManifest): Set<string> {
  const out = new Set<string>();
  for (const t of Object.values(manifest.templates)) out.add(t.html);
  for (const s of Object.values(manifest.spots)) {
    if (s.kind === 'template') Object.values(s.assets).forEach((a) => out.add(a));
    else if (s.kind === 'image' || s.kind === 'video') out.add(s.file);
  }
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
