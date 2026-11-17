/**
 * The SignForge contract: every shape that crosses a boundary.
 *
 *   template author  <-> player   TemplateManifest, the frame protocol
 *   publisher        <-> player   ScreenManifest
 *   screen           <-> server   the device API: pairing, sync, socket messages
 *
 * Nothing here depends on a browser or on Node.
 *
 * Versioning. Screens and template bundles outlive any one release, so both versions are ranges:
 *  - A template bundle records the frame protocol it was built against (`TemplateManifest.protocol`)
 *    and the player speaks every protocol in SUPPORTED_PROTOCOLS. A bundle is immutable; a protocol
 *    change must never strand templates already published.
 *  - A player reports the manifest schemas it can play in every sync. The server compiles each
 *    screen at the newest schema that screen supports, and tells an outdated player to reload.
 */

/** The frame protocol this build of the SDK speaks. Stamped into every template bundle. */
export const PROTOCOL_VERSION = 1;
/** Frame protocols this player can drive. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1];
/**
 * The manifest schema this build produces.
 *   1  pre-release; never deployed beyond the test rig
 *   2  template keys carry their owner: `<owner>/<id>@<version>`
 */
export const MANIFEST_SCHEMA = 2;
/** Manifest schemas this player can play. */
export const SUPPORTED_MANIFEST_SCHEMAS: readonly number[] = [2];

/**
 * Every id a screen sees (screen, spot, playlist, schedule entry, data source, group, org) goes
 * into URLs, storage keys and the screen credential, so all of them share one grammar: letters,
 * digits, `_` and `-`, no dots or slashes, at most 64 characters.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);

/**
 * JSON with object keys sorted at every level, so equal content always serialises the same.
 * A manifest's id is the lowercase hex SHA-256 of `canonicalJson` of the manifest without its
 * `id` and `generatedAt`: publishing unchanged content to a screen gives the same id, and the
 * screen is skipped.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/** The part of a manifest its id is computed from. */
export const manifestIdInput = (m: Omit<ScreenManifest, 'id' | 'generatedAt'> & Partial<Pick<ScreenManifest, 'id' | 'generatedAt'>>): string => {
  const { id: _id, generatedAt: _at, ...body } = m;
  return canonicalJson(body);
};

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
  /** The frame protocol the bundle speaks. Set by the build, not the author; absent means 1. */
  protocol?: number;
}

/** Who owns a template: `base` for the platform's own, otherwise the org's id. */
export type TemplateOwner = 'base' | (string & {});

/**
 * How a manifest and its spots refer to one template version: `<owner>/<id>@<version>`. The owner
 * keeps a base template and an org's template with the same id and version apart.
 */
export const templateKey = (m: Pick<TemplateManifest, 'id' | 'version'>, owner: TemplateOwner = 'base') => `${owner}/${m.id}@${m.version}`;

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
  | ({ sf: number; type: 'init' } & InitPayload)
  | { sf: number; type: 'play' }
  | { sf: number; type: 'stop' };

export type TemplateMessage =
  | { sf: number; type: 'loaded' }
  | { sf: number; type: 'ready' }
  | { sf: number; type: 'error'; message: string };

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
  schema: number;
  /** SHA-256 of the rest of the manifest; see `canonicalJson`. */
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

// ------------------------------------------------------------------- device API
// What a screen and the server say to each other, under /v1/device. See docs/backend-plan.md.

/** `POST /v1/device/pair/start` */
export interface PairStartResponse {
  /** Shown on screen; the user types it into the CMS. */
  code: string;
  /** Secret, kept by the screen, to collect the credential. Never shown. */
  pollToken: string;
  expiresAt: string;
}

/** `POST /v1/device/pair/poll` with `{ pollToken }` */
export type PairPollResponse =
  | { status: 'waiting' }
  | { status: 'expired' }
  /** Returned once. The credential is `sfd_<screenId>.<secret>`, sent as a bearer token on every device request. */
  | { status: 'paired'; screenId: string; credential: string };

/**
 * A temporary display state set from the CMS, for someone standing at a dark screen. The server
 * computes `until` (normally the next scheduled change), so the screen needs no schedule logic
 * of its own to expire it. Persisted on the screen.
 */
export interface DisplayOverride {
  state: 'on' | 'off';
  until: string;
}

export interface DisplayStatus {
  on: boolean;
  /** What the supervisor reported for each power method, e.g. `{ signal: 'ok', cec: 'not acknowledged' }`. */
  methods?: Record<string, string>;
  override?: DisplayOverride;
}

/**
 * Plays of one spot in one UTC hour. Counted on the screen, persisted across reloads, and sent
 * until a sync acknowledges them.
 */
export interface PlayCount {
  /** Start of the hour in UTC: `2026-11-17T13:00Z`. */
  hour: string;
  spot: string;
  manifest: string;
  plays: number;
  ms: number;
}

/** `POST /v1/device/sync`, every few minutes and whenever the socket is down. */
export interface SyncRequest {
  /**
   * Increases by one per batch of play counts. A retried request repeats its number, and the
   * server ignores counts for a number it has already acknowledged.
   */
  seq: number;
  player: { version: string; manifestSchemas: readonly number[]; protocols: readonly number[] };
  manifest: { active?: string; filesMissing: number };
  display: DisplayStatus;
  /** The screen's clock when it sent this; the server measures drift from it. */
  deviceTime: string;
  playCounts: PlayCount[];
  /** Data snapshot versions the screen holds, by source id. */
  snapshots: Record<string, string>;
}

export interface SyncResponse {
  serverTime: string;
  /** When to sync next. */
  nextSyncS: number;
  /** The highest `seq` whose play counts are stored. The screen drops those counts. */
  ackSeq: number;
  /** The manifest the screen should be on. Fetch it if it differs from the active one. */
  desiredManifest: string;
  /** Snapshots that are newer than what the screen holds. */
  snapshots: DataSnapshot[];
  /** Short-lived ticket for `GET /v1/device/ws?ticket=`. */
  socketTicket: string;
  commands: DeviceCommand[];
}

export type DeviceCommand =
  /** Reload the player, e.g. after the server stops producing a schema this build can play. */
  | { type: 'reload' }
  | { type: 'display'; override: DisplayOverride | null }
  | { type: 'reboot' };

/** Server to screen, over the socket. Kept rare: the socket exists to nudge, not to carry data. */
export type ServerSocketMessage =
  | { type: 'manifest'; id: string }
  | { type: 'command'; command: DeviceCommand }
  | { type: 'revoked' };

/** Screen to server, over the socket. */
export type DeviceSocketMessage = { type: 'applied'; manifest: string };
