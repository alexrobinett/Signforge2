/**
 * The SignForge contract: every shape that crosses a boundary.
 *
 *   template author  <-> player   TemplateManifest, the frame protocol
 *   publisher        <-> player   ScreenManifest
 *   screen           <-> server   the device API: pairing, sync, socket messages
 *
 * Nothing here depends on a browser or on Node. The runtime checks for every shape are in
 * `validate.ts`, re-exported here.
 *
 * Versioning. Screens and template bundles outlive any one release, so both versions are ranges:
 *  - A template bundle records the frame protocol it was built against (`TemplateManifest.protocol`)
 *    and the player speaks every protocol in SUPPORTED_PROTOCOLS. A bundle is immutable; a protocol
 *    change must never strand templates already published.
 *  - A player reports the manifest schemas it can play in every sync. The server compiles each
 *    screen at the newest schema that screen supports, and tells an outdated player to reload.
 *  - A player release plays schema N and N-1, so a screen updated while offline still plays the
 *    manifest it cached under the previous release.
 */

import { validateTemplateManifest } from './validate.ts';

export * from './validate.ts';

/**
 * The frame protocol this build of the SDK speaks. Stamped into every template bundle.
 *   1  init, play, stop
 *   2  adds `clock` and `theme` to init, and `reset`: a template can take new data without a reload
 */
export const PROTOCOL_VERSION = 2;
/** Frame protocols this player can drive. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1, 2];
/**
 * The manifest schema this build produces.
 *   1  pre-release; never deployed beyond the test rig
 *   2  template keys carry their owner: `<owner>/<id>@<version>`
 *   3  the screen's `brand`; schedule entries bounded by instants (`startsAt`, `endsAt`)
 */
export const MANIFEST_SCHEMA = 3;
/** Manifest schemas this player can play: the current one and the one before it. */
export const SUPPORTED_MANIFEST_SCHEMAS: readonly number[] = [MANIFEST_SCHEMA - 1, MANIFEST_SCHEMA];

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
  | { type: 'number'; label: string; default?: number; min?: number; max?: number /** Counted from `min`, or from 0 without one. */; step?: number }
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

/** The largest frame a screen of each orientation draws. Images are never shipped bigger than this. */
export const SCREEN_BOX = { landscape: { w: 1920, h: 1080 }, portrait: { w: 1080, h: 1920 } } as const;
export type ScreenBox = { readonly w: number; readonly h: number };

/**
 * The cover rule for images: the smallest size that still covers the box, keeping the aspect
 * ratio, so a screen never decodes more pixels than it can show. An image that already fits
 * (one side within the box) keeps its size, and `scaled` is false. A 3840x2160 photo becomes
 * 1920x1080 for a landscape box and 3413x1920 for a portrait one.
 */
export function coverSize(width: number, height: number, box: ScreenBox): { width: number; height: number; scaled: boolean } {
  const scale = Math.min(1, Math.max(box.w / width, box.h / height));
  if (!(scale < 1)) return { width, height, scaled: false };
  return { width: Math.round(width * scale), height: Math.round(height * scale), scaled: true };
}

/**
 * The most pixels a screen will decode for one image: a 3840x2160 frame, about 33 MB as RGBA.
 * The cover rule alone lets one side run free (a 65,535x1,080 PNG has a side within the box and
 * would cost about 280 MB to decode), so this caps the area. Any photo from 16:9 to 2:1 scaled to
 * cover either box fits under it.
 */
export const MAX_IMAGE_PIXELS = 3840 * 2160;

/** Why an image of this size may not ship for the box; undefined when it may. Both the cover rule and the pixel cap. */
export function imageSizeProblem(width: number, height: number, box: ScreenBox): string | undefined {
  if (width * height > MAX_IMAGE_PIXELS) {
    const mp = (n: number) => (n / 1e6).toFixed(1);
    return `${width}x${height} is ${mp(width * height)} million pixels; a screen decodes at most ${mp(MAX_IMAGE_PIXELS)} million (3840x2160)`;
  }
  if (!(width <= box.w || height <= box.h))
    return `${width}x${height} is larger than a ${box.w >= box.h ? 'landscape' : 'portrait'} screen needs: scale it to cover ${box.w}x${box.h}`;
  return undefined;
}

/** Whether an image may ship for the box: at least one side within it (the cover rule), and no more than `MAX_IMAGE_PIXELS`. */
export const fitsScreenBox = (width: number, height: number, box: ScreenBox) => imageSizeProblem(width, height, box) === undefined;

/**
 * Code a template author may not write. Templates run with every request blocked, but the policy
 * cannot stop a frame navigating itself, and these never belong in a template anyway. Checked
 * against the author's own files, not the bundled SDK.
 */
export const FORBIDDEN_TEMPLATE_CODE: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/,
    reason: 'templates may not make network requests; bind to a data source instead',
  },
  { pattern: /\bimport\s*\(/, reason: 'templates may not load code at run time' },
  {
    // Bare `location.x` / `location =` and `window.location`, but not a data field such as `event.location`.
    pattern:
      /(?<![.\w$])location\s*(?:[.[]|=(?!=))|\b(?:window|document|self|globalThis)\s*\.\s*location\b|\bwindow\.open\b|(?<![.\w$])(?:top|parent|opener)\s*\./,
    reason: 'templates may not navigate or reach outside their frame',
  },
  { pattern: /@import\b/, reason: 'stylesheets must be bundled, not imported at run time' },
  { pattern: /["'(=]\s*(?:https?:)?\/\/[a-z0-9]/i, reason: 'a template may not refer to anything on the network' },
];

/** CSS a template may not ship. Each entry was measured as too slow on the baseline device. */
export const FORBIDDEN_CSS: { pattern: RegExp; reason: string }[] = [
  { pattern: /backdrop-filter\s*:/i, reason: '`backdrop-filter` drops about a fifth of frames over moving content' },
];

/** The checks a built template is put through, by `sf build` and again by the server. */
export const TEMPLATE_CHECKS = ['manifest', 'forbidden-css', 'size', 'network', 'source-code'] as const;
export type TemplateCheckName = (typeof TEMPLATE_CHECKS)[number];

/** The result of `checkTemplateBundle`. The server stores it on the template version. */
export interface TemplateCheckReport {
  ok: boolean;
  /** Bytes of the built HTML file. */
  bundleBytes: number;
  checks: { check: TemplateCheckName; ok: boolean; problems: string[] }[];
}

/**
 * Lint a built template: the manifest, the forbidden CSS list, the size budget and network
 * references are checked on the bundle; the forbidden-code list on the author's own source files
 * (`index.html`, `style.css`, `main.ts`), because the bundle holds the SDK, which itself calls
 * `parent.postMessage`. A lint, not a boundary: string checks can be evaded, and the template
 * sandbox with its no-network policy is what keeps a screen safe.
 */
export function checkTemplateBundle(input: { manifest: unknown; html: string; sources: Record<string, string> }): TemplateCheckReport {
  const { manifest, html, sources } = input;
  const bundleBytes = new TextEncoder().encode(html).byteLength;
  const matches = (rules: { pattern: RegExp; reason: string }[], text: string) => rules.filter((r) => r.pattern.test(text)).map((r) => r.reason);

  const manifestProblems = validateTemplateManifest(manifest);
  const protocol = (manifest as Partial<TemplateManifest> | null)?.protocol;
  if (protocol !== undefined && !SUPPORTED_PROTOCOLS.includes(protocol)) manifestProblems.push(`protocol ${String(protocol)} is not supported`);

  const network: string[] = [];
  if (/\b(?:src|href)\s*=\s*["']https?:/i.test(html) || /url\(\s*["']?https?:/i.test(html)) network.push('a template may not load anything from the network');

  // Comments are stripped first, so a note about `fetch` is not a call to it. `//` after a colon is a URL, and is kept.
  const own = Object.values(sources)
    .map((text) => text.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, ''))
    .join('\n');
  const source = Object.keys(sources).length ? matches(FORBIDDEN_TEMPLATE_CODE, own) : ['no source files were given'];

  const checks: TemplateCheckReport['checks'] = [
    { check: 'manifest', ok: !manifestProblems.length, problems: manifestProblems },
    { check: 'forbidden-css', ok: true, problems: matches(FORBIDDEN_CSS, html) },
    {
      check: 'size',
      ok: true,
      problems: bundleBytes > TEMPLATE_BUDGET.maxBundleBytes ? [`bundle is ${bundleBytes} bytes; the budget is ${TEMPLATE_BUDGET.maxBundleBytes}`] : [],
    },
    { check: 'network', ok: true, problems: network },
    { check: 'source-code', ok: true, problems: source },
  ];
  for (const c of checks) c.ok = !c.problems.length;
  return { ok: checks.every((c) => c.ok), bundleBytes, checks };
}

// ------------------------------------------------------------ frame protocol
// The player and a template talk only through postMessage. The template runs in a
// sandboxed frame with no network and no storage; everything it needs arrives in `init`.
//
// Lifecycle:  loaded -> init -> ready -> play -> stop
// Updating a template already on screen (the editor's preview) never re-sends `init` over the old
// state. Protocol 2: the player sends `reset`; the SDK stops the template, restores the document as
// it loaded, and sends `loaded` again, and the usual `init` follows. (An `init` that arrives without
// a `reset` is handled the same way.) Protocol 1: the player reloads the frame.

/**
 * Time as the screen knows it. A screen corrects its clock from server time (a Pi has no
 * battery-backed clock), and a template must show that time, not the device's: the SDK's `now()`.
 */
export interface FrameClock {
  /** The corrected time when `init` was sent, in ms since the epoch. */
  now: number;
  /** Add to `Date.now()` for the corrected time. */
  offsetMs: number;
}

export interface FrameFont {
  family: string;
  /** Each file as a Blob: an object URL made by the player would not resolve in the opaque-origin frame. */
  files: { weight: number; style: 'normal' | 'italic'; data: Blob }[];
}

/** The screen's brand, resolved for one spot. Absent: the template draws with its own fallbacks. */
export interface FrameTheme {
  colors: BrandColors;
  shape: BrandShape;
  /** A missing font means the template's own. */
  fonts: { display?: FrameFont; body?: FrameFont };
  logo?: { onDark: Blob; onLight?: Blob };
}

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
  /** Protocol 2. */
  clock: FrameClock;
  /** Protocol 2. */
  theme?: FrameTheme;
}

export type HostMessage =
  | ({ sf: number; type: 'init' } & InitPayload)
  | { sf: number; type: 'play' }
  | { sf: number; type: 'stop' }
  /** Protocol 2: stop, restore the document as loaded, and answer `loaded`. */
  | { sf: number; type: 'reset' };

export type TemplateMessage = { sf: number; type: 'loaded' } | { sf: number; type: 'ready' } | { sf: number; type: 'error'; message: string };

// ---------------------------------------------------------------------- brand
// A brand kit is the org's look, chosen per screen and frozen into the manifest at publish.
// Template fields may default to a token (`"$brand.accent"`); the compiler resolves those into
// plain values, so a spot's data never holds a token.

export const BRAND_COLORS = ['primary', 'onPrimary', 'accent', 'onAccent', 'background', 'surface', 'text', 'muted'] as const;
export type BrandColor = (typeof BRAND_COLORS)[number];
export type BrandColors = Record<BrandColor, string>;
export const BRAND_SHAPES = ['square', 'soft', 'round'] as const;
export type BrandShape = (typeof BRAND_SHAPES)[number];

/** The CSS custom properties the SDK sets on a template's root from a theme. */
export const BRAND_CSS_VARS = {
  primary: '--sf-primary',
  onPrimary: '--sf-on-primary',
  accent: '--sf-accent',
  onAccent: '--sf-on-accent',
  background: '--sf-bg',
  surface: '--sf-surface',
  text: '--sf-text',
  muted: '--sf-muted',
  radius: '--sf-radius',
  fontDisplay: '--sf-font-display',
  fontBody: '--sf-font-body',
} as const;

/** A field default of `$brand.<colour>` names a brand colour; the compiler replaces it. */
export const BRAND_TOKEN = /^\$brand\.([A-Za-z]+)$/;

export interface BrandFont {
  /** Catalogue key, `<owner>/<id>`: `base/inter`. Only `base` fonts exist for now. */
  id: string;
  family: string;
  /** WOFF2 files, listed in the manifest's `files`. */
  files: { weight: number; style: 'normal' | 'italic'; file: Sha256 }[];
}

/** One screen's brand kit, as the manifest carries it. */
export interface BrandKit {
  id: string;
  colors: BrandColors;
  shape: BrandShape;
  fonts: { display?: BrandFont; body?: BrandFont };
  /** SVG or PNG. */
  logo?: { onDark: Sha256; onLight?: Sha256 };
}

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
  /**
   * Increases every time the source's data changes, so a screen keeps the newest snapshot whichever
   * order they arrive in (a first-load fetch and a sync can cross). The server uses the time the
   * changed data was fetched, in ms since the epoch.
   */
  version: number;
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
  /**
   * Absolute bounds, ISO 8601 instants, on top of the local dates and window: `startsAt` inclusive,
   * `endsAt` exclusive. A takeover sets `endsAt`, so it ends on time whatever the screen's time
   * zone and with the network down. A screen that does not trust its clock skips any entry with
   * either bound rather than risk running a takeover forever.
   */
  startsAt?: string;
  endsAt?: string;
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
  /** The screen's brand kit, frozen at publish. Its fonts and logo are in `files`. Absent: templates use their own look. */
  brand?: BrandKit;
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
   * server ignores counts for a number it has already acknowledged in the same `epoch`.
   */
  seq: number;
  /**
   * Names this run of `seq` numbers: a random id the screen makes when it has no counter (first
   * start, re-imaged, storage cleared) and starts again at seq 1. The server keeps the highest
   * acknowledged seq per epoch; a new epoch starts from nothing, so a screen that lost its counter
   * is never ignored as a repeat. Never derived from the clock, which may be wrong.
   */
  epoch: string;
  player: { version: string; manifestSchemas: readonly number[]; protocols: readonly number[] };
  manifest: { active?: string; filesMissing: number };
  display: DisplayStatus;
  /** The screen's own clock when it sent this, uncorrected; the server measures drift from it. */
  deviceTime: string;
  /** The correction the screen applies to its own clock, and whether it trusts the result (docs/architecture.md, Player, Clock). */
  clock: { offsetMs: number; trusted: boolean };
  playCounts: PlayCount[];
  /** `DataSnapshot.version` of each snapshot the screen holds, by source id. */
  snapshots: Record<string, number>;
}

export interface SyncResponse {
  serverTime: string;
  /** When to sync next. */
  nextSyncS: number;
  /** The request's epoch: `ackSeq` counts in it. A screen ignores an ack for an epoch it is not in. */
  epoch: string;
  /** The highest `seq` whose play counts are stored. The screen drops those counts. */
  ackSeq: number;
  /**
   * The manifest the screen should be on. Fetch it if it differs from the active one. Absent until
   * something is published to the screen, which still syncs for its socket ticket.
   */
  desiredManifest?: string;
  /** Snapshots that are newer than what the screen holds. */
  snapshots: DataSnapshot[];
  /** Short-lived ticket for `GET /v1/device/ws?ticket=`. */
  socketTicket: string;
  commands: DeviceCommand[];
}

export type DeviceCommand =
  /** Reload the player, e.g. after the server stops producing a schema this build can play. */
  { type: 'reload' } | { type: 'display'; override: DisplayOverride | null } | { type: 'reboot' };

/** Server to screen, over the socket. Kept rare: the socket exists to nudge, not to carry data. */
export type ServerSocketMessage = { type: 'manifest'; id: string } | { type: 'command'; command: DeviceCommand } | { type: 'revoked' };

/** Screen to server, over the socket. */
export type DeviceSocketMessage = { type: 'applied'; manifest: string };
