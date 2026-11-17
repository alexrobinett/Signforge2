/**
 * The SignForge contract: every shape that crosses a boundary.
 *
 *   template author  <-> player   TemplateManifest, the frame protocol
 *   publisher        <-> player   ScreenManifest
 *
 * Nothing here depends on a browser or on Node.
 */

export const PROTOCOL_VERSION = 1;
export const MANIFEST_SCHEMA = 1;

export type Orientation = 'landscape' | 'portrait';
export type Capability = 'canvas' | 'webgl' | 'audio';
export type Sha256 = string;

// ---------------------------------------------------------------- templates

export type ScalarFieldDef =
  | { type: 'text'; label: string; default?: string; maxLength?: number }
  | { type: 'number'; label: string; default?: number; min?: number; max?: number }
  | { type: 'boolean'; label: string; default?: boolean }
  | { type: 'color'; label: string; default?: string }
  | { type: 'select'; label: string; options: string[]; default?: string };

export type FieldDef =
  | ScalarFieldDef
  | { type: 'image'; label: string }
  /** Repeating rows, such as menu items or calendar events. Each row is an object of scalar fields. */
  | { type: 'list'; label: string; item: Record<string, ScalarFieldDef>; maxItems?: number; default?: Record<string, unknown>[] };

/** `template.json`, written by the template author. */
export interface TemplateManifest {
  id: string;
  /** Semver. A published version never changes. */
  version: string;
  name: string;
  description?: string;
  fields: Record<string, FieldDef>;
  /** A spot may run for any length inside this range. */
  duration: { defaultMs: number; minMs: number; maxMs: number };
  orientations: Orientation[];
  /** Platform features the template needs beyond DOM and CSS. */
  uses: Capability[];
  /** CSS colour shown behind the template when it is scaled onto an orientation it does not support. */
  background: string;
}

export const templateKey = (m: Pick<TemplateManifest, 'id' | 'version'>) => `${m.id}@${m.version}`;

/** Budgets a built template bundle must meet. Measured on a Raspberry Pi 4 at 1080p 60 Hz. */
export const TEMPLATE_BUDGET = {
  /** Size of the single built HTML file, fonts included. */
  maxBundleBytes: 600_000,
  /** From `init` to `ready`. */
  maxReadyMs: 500,
  maxDroppedFramePct: 1,
  maxFrameMs: 50,
  /** DOM elements animating at the same moment. Use one canvas for anything denser. */
  maxAnimatedElements: 50,
} as const;

/**
 * The one video profile screens accept. Measured on a Raspberry Pi 4: 1080p30 H.264 plays on the
 * hardware decoder with about 1% of frames dropped; 1080p60 drops about 18% of its frames.
 */
export const VIDEO_SPEC = {
  codec: 'h264',
  /** 8-bit 4:2:0. The Pi 4's hardware decoder cannot play 10-bit or 4:2:2 H.264. */
  pixelFormats: ['yuv420p', 'yuvj420p'],
  profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'],
  /** H.264 level 4.2, written as ffprobe reports it. */
  maxLevel: 42,
  /** The long side and the short side, so portrait video fits too. */
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 30,
  maxBitrate: 10_000_000,
} as const;

/**
 * Code a template author may not write. Templates run with every request blocked, but the policy
 * cannot stop a frame navigating itself, and these never belong in a template anyway. Checked
 * against the author's own files, not the bundled SDK.
 */
export const FORBIDDEN_TEMPLATE_CODE: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, reason: 'templates may not make network requests; bind to a data source instead' },
  { pattern: /\bimport\s*\(/, reason: 'templates may not load code at run time' },
  {
    // Bare `location.x` / `location =` and `window.location`, but not a data field such as `event.location`.
    pattern: /(?<![.\w$])location\s*(?:[.[]|=(?!=))|\b(?:window|document|self|globalThis)\s*\.\s*location\b|\bwindow\.open\b|(?<![.\w$])(?:top|parent|opener)\s*\./,
    reason: 'templates may not navigate or reach outside their frame',
  },
  { pattern: /@import\b/, reason: 'stylesheets must be bundled, not imported at run time' },
  { pattern: /["'(=]\s*(?:https?:)?\/\/[a-z0-9]/i, reason: 'a template may not refer to anything on the network' },
];

/** CSS a template may not ship. Each entry was measured as too slow on the baseline device. */
export const FORBIDDEN_CSS: { pattern: RegExp; reason: string }[] = [
  { pattern: /backdrop-filter\s*:/i, reason: '`backdrop-filter` drops about a fifth of frames over moving content' },
];

export function validateTemplateManifest(m: unknown): string[] {
  const errors: string[] = [];
  const t = m as Partial<TemplateManifest> | null;
  if (!t || typeof t !== 'object') return ['manifest is not an object'];
  if (!t.id || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) errors.push('id must be lowercase letters, digits and dashes');
  if (!t.version || !/^\d+\.\d+\.\d+$/.test(t.version)) errors.push('version must be semver, e.g. 1.0.0');
  if (!t.name) errors.push('name is required');
  if (!t.fields || typeof t.fields !== 'object') errors.push('fields is required');
  const d = t.duration;
  if (!d || !(d.minMs > 0) || !(d.minMs <= d.defaultMs) || !(d.defaultMs <= d.maxMs)) {
    errors.push('duration needs 0 < minMs <= defaultMs <= maxMs');
  }
  if (!t.orientations?.length || t.orientations.some((o) => o !== 'landscape' && o !== 'portrait')) {
    errors.push('orientations must list landscape and/or portrait');
  }
  if (!Array.isArray(t.uses)) errors.push('uses must be an array (it may be empty)');
  if (!t.background) errors.push('background is required');
  return errors;
}

function checkScalar(name: string, def: ScalarFieldDef, v: unknown): string | undefined {
  if (def.type === 'text' && typeof v !== 'string') return `field "${name}" must be text`;
  if (def.type === 'text' && def.maxLength && (v as string).length > def.maxLength) return `field "${name}" is longer than ${def.maxLength}`;
  if (def.type === 'number' && typeof v !== 'number') return `field "${name}" must be a number`;
  if (def.type === 'boolean' && typeof v !== 'boolean') return `field "${name}" must be true or false`;
  if (def.type === 'color' && typeof v !== 'string') return `field "${name}" must be a colour`;
  if (def.type === 'select' && !def.options.includes(v as string)) return `field "${name}" must be one of ${def.options.join(', ')}`;
  return undefined;
}

/** Check a spot's data against the template's fields. Returns problems; empty means valid. */
export function validateSpotData(
  fields: Record<string, FieldDef>,
  data: Record<string, unknown>,
  assets: Record<string, unknown>,
  bindings: Record<string, Binding> = {},
): string[] {
  const errors: string[] = [];
  for (const name of Object.keys(bindings)) {
    if (!fields[name]) errors.push(`binding for unknown field "${name}"`);
    else if (fields[name]!.type === 'image') errors.push(`image field "${name}" cannot be bound to live data`);
  }
  for (const [name, def] of Object.entries(fields)) {
    if (def.type === 'image') {
      if (!assets[name]) errors.push(`image field "${name}" has no asset`);
      continue;
    }
    const v = data[name] ?? ('default' in def ? def.default : undefined);
    // A bound field still needs a static value: it is what shows before the first snapshot arrives.
    if (v === undefined) errors.push(`field "${name}" is missing${bindings[name] ? ' (a bound field needs a fallback value)' : ''}`);
    else if (def.type === 'list') {
      if (!Array.isArray(v)) errors.push(`field "${name}" must be a list`);
      else {
        if (def.maxItems && v.length > def.maxItems) errors.push(`field "${name}" has more than ${def.maxItems} rows`);
        v.forEach((row: Record<string, unknown>, i) => {
          for (const [k, d] of Object.entries(def.item)) {
            const cell = row?.[k] ?? d.default;
            if (cell === undefined) errors.push(`field "${name}" row ${i + 1} is missing "${k}"`);
            else {
              const e = checkScalar(`${name}[${i + 1}].${k}`, d, cell);
              if (e) errors.push(e);
            }
          }
        });
      }
    } else {
      const e = checkScalar(name, def, v);
      if (e) errors.push(e);
    }
  }
  for (const name of Object.keys(data)) if (!fields[name]) errors.push(`unknown field "${name}"`);
  return errors;
}

// ------------------------------------------------------------ frame protocol
// The player and a template talk only through postMessage. The template runs in a
// sandboxed frame with no network and no storage; everything it needs arrives in `init`.

export interface InitPayload {
  data: Record<string, unknown>;
  /** Image fields, by field name. The SDK turns each into an object URL. */
  assets: Record<string, Blob>;
  /** How long this play lasts. The template fits its outro to it. */
  durationMs: number;
  orientation: Orientation;
  viewport: { width: number; height: number };
  /** The screen's IANA time zone and locale. Use these, not the device's, for anything shown. */
  timezone: string;
  locale: string;
}

export type HostMessage =
  | ({ sf: typeof PROTOCOL_VERSION; type: 'init' } & InitPayload)
  | { sf: typeof PROTOCOL_VERSION; type: 'play' }
  | { sf: typeof PROTOCOL_VERSION; type: 'stop' };

export type TemplateMessage =
  | { sf: typeof PROTOCOL_VERSION; type: 'loaded' }
  | { sf: typeof PROTOCOL_VERSION; type: 'ready' }
  | { sf: typeof PROTOCOL_VERSION; type: 'error'; message: string };

// ------------------------------------------------------------------ live data
// A data source is a JSON feed the server polls. Screens never call the feed themselves:
// they fetch the latest snapshot from `data/<id>.json` beside the manifest, keep the last
// good one on disk, and read bound fields from it each time a spot starts.

export interface DataSource {
  id: string;
  /** How often a screen checks for a newer snapshot. */
  refreshS: number;
}

export interface DataSnapshot {
  id: string;
  fetchedAt: string;
  data: unknown;
}

/**
 * Feeds that are not JSON are converted on the server into these shapes, so a template binds
 * to the same paths whichever calendar or news service the data came from.
 */
export interface CalendarFeed {
  /** Upcoming events, soonest first. */
  events: {
    title: string;
    /** `YYYY-MM-DD` for an all-day event, otherwise an ISO 8601 instant. */
    start: string;
    end: string;
    allDay: boolean;
    location: string;
  }[];
}
export interface NewsFeed {
  title: string;
  /** Newest first. */
  items: { title: string; published: string; source: string }[];
}

export interface Binding {
  source: string;
  /** Dot path into the snapshot's data. Numbers index arrays: `daily.temperature_2m_max.0`. */
  path: string;
}

// ------------------------------------------------------------ screen manifest

/**
 * How one spot gives way to the next.
 *  cut        instant. Templates animate their own intro and outro, so this already looks smooth.
 *  fade       out to black, then in: one spot on screen at a time. Cheap on any device.
 *  crossfade  both spots on screen at once while one fades over the other. Costs double the GPU
 *             work for its length: about 10% dropped frames on a Raspberry Pi 4.
 */
export type Transition = { type: 'cut' } | { type: 'fade'; ms: number } | { type: 'crossfade'; ms: number };

interface SpotBase {
  id: string;
  name: string;
  /** Any length. For a template spot it must sit inside the template's range. */
  durationMs: number;
}
export type Spot =
  | (SpotBase & {
      kind: 'template';
      template: string;
      /** Static values. For a bound field this is the fallback. */
      data: Record<string, unknown>;
      assets: Record<string, Sha256>;
      /** Fields that take their value from a data source, by field name. */
      bindings?: Record<string, Binding>;
    })
  | (SpotBase & { kind: 'image'; file: Sha256; fit: 'cover' | 'contain' })
  | (SpotBase & { kind: 'video'; file: Sha256; fit: 'cover' | 'contain' })
  | (SpotBase & { kind: 'url'; url: string });

export interface Playlist {
  id: string;
  name: string;
  transition: Transition;
  items: { spot: string }[];
}

/** What a schedule entry is aimed at. More specific wins a priority tie. */
export type TargetLevel = 'org' | 'group' | 'screen';

export interface ScheduleEntry {
  id: string;
  playlist: string;
  priority: number;
  target: TargetLevel;
  /** Inclusive local dates, `YYYY-MM-DD`, in the screen's time zone. */
  startDate?: string;
  endDate?: string;
  /** 0 = Sunday. Omitted means every day. */
  days?: number[];
  /** Local `HH:MM`. `from` is inclusive, `to` exclusive. A window may cross midnight. */
  from?: string;
  to?: string;
}

/** Everything one screen needs. Immutable; a change produces a new manifest with a new id. */
/** A daily window in the screen's time zone. A `to` at or before `from` crosses midnight and belongs to the day it starts on. `24:00` is end of day. */
export interface TimeWindow {
  from: string;
  to: string;
}

/**
 * When the display is powered. Outside these hours the player stops drawing and the device puts
 * the panel in standby: over HDMI-CEC on a TV, and by turning the video signal off, which sends
 * a monitor to sleep. Content keeps syncing so the screen wakes up current. Absent: always on.
 */
export interface DisplayHours {
  /** Weekly hours. */
  weekly: (TimeWindow & { days: number[] })[];
  /** Dated exceptions such as holidays, in the screen's time zone. They replace the weekly hours for that date; no windows means off all day. Their windows stay within the date. */
  exceptions?: { date: string; on: TimeWindow[] }[];
}

export interface ScreenManifest {
  schema: typeof MANIFEST_SCHEMA;
  /** Hash of the content below. */
  id: string;
  generatedAt: string;
  screen: { id: string; name: string; timezone: string; locale?: string; orientation: Orientation; displayHours?: DisplayHours };
  /** Every file the manifest refers to, fetched from `blobs/<sha256>` beside the manifest. */
  files: Record<Sha256, { size: number; type: string }>;
  templates: Record<string, { manifest: TemplateManifest; html: Sha256 }>;
  spots: Record<string, Spot>;
  playlists: Record<string, Playlist>;
  dataSources: Record<string, DataSource>;
  schedule: ScheduleEntry[];
  /** Plays when no schedule entry applies, so a screen is never blank. */
  defaultPlaylist: string;
}
