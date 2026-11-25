/** Every shape in the contract, with the constants that go with it. The checks for them are in `validate.ts`. */
import { IMAGE_SAMPLE_CELL } from './sample.ts';

/** Frame protocols this player can drive. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1, 2];
/**
 * The manifest schema this build produces.
 *   1  pre-release; never deployed beyond the test rig
 *   2  template keys carry their owner: `<owner>/<id>@<version>`
 *   3  the screen's `brand`; schedule entries bounded by instants (`startsAt`, `endsAt`)
 *   4  a template may declare a `table` live source, and a binding a `table` mapping (#84). A player
 *      that knows only 3 refuses such a template, so it must not get one: it reports [2, 3], and
 *      the server tells it to reload into a player that plays 4.
 *   5  a template may declare a `url` field (#191). A player that knows only 3 and 4 refuses such a
 *      template, so the server tells it to reload, as for 4.
 *   6  a template may declare `date` and `datetime` fields (#192). A player that knows only 4 and 5
 *      refuses such a template, so the server tells it to reload, as for 4.
 *   7  a template's `live` may name several sources (`sources`, #193). A player that knows only 5
 *      and 6 refuses such a template, so the server tells it to reload, as for 4.
 */
export const MANIFEST_SCHEMA = 7;
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
  /**
   * Text. `maxMarks` bounds the combining marks (accents, vowel signs, tone marks) stacked on any one character: Zalgo
   * text stacks dozens, whose ink stands far past its line, over whatever is near (#230).
   */
  | { type: 'text'; label: string; default?: string; maxLength?: number; maxMarks?: number }
  | { type: 'number'; label: string; default?: number; min?: number; max?: number /** Counted from `min`, or from 0 without one. */; step?: number }
  | { type: 'boolean'; label: string; default?: boolean }
  | { type: 'color'; label: string; default?: string }
  | { type: 'select'; label: string; options: string[]; default?: string }
  /**
   * A web address people type, such as a QR code's: `https:` only, at most `MAX_URL_BYTES`, or empty for none. `maxBytes`
   * bounds its UTF-8 bytes, which is what a QR code holds: some characters use more than one byte (#230).
   */
  | { type: 'url'; label: string; default?: string; maxLength?: number; maxBytes?: number }
  /** A calendar day, `YYYY-MM-DD`; `min` and `max` are days too. */
  | { type: 'date'; label: string; default?: string; min?: string; max?: string }
  /**
   * A wall time, `YYYY-MM-DDTHH:mm`, with no zone or offset; `min` and `max` are wall times too.
   * The template reads it in the screen's time zone (the SDK's `wallTime`), so "Friday 18:00"
   * means 18:00 where each screen is, as a person means it, whichever zone the editor is in. An
   * instant would tie the spot to one zone, and every screen elsewhere would count to another hour.
   */
  | { type: 'datetime'; label: string; default?: string; min?: string; max?: string };

/**
 * The most a `url` field holds, in bytes of UTF-8 (the form a QR code carries it in), whatever its
 * `maxLength`. A QR code at error correction M carries at most 2,331 bytes (version 40), so every
 * address a spot may hold can be drawn.
 */
export const MAX_URL_BYTES = 2048;

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
  /** The fields a data source fills. Absent: every field is typed by people. */
  live?: LiveData;
}

/**
 * The kinds of feed a template's live fields come from: an Open-Meteo forecast (a JSON source),
 * a news (`rss`) or calendar (`ical`) feed, which the server converts to `NewsFeed` and
 * `CalendarFeed`, or a `table` (a CSV file or a JSON list, converted to `TableFeed`) whose rows
 * fill a list field through a `TableMapping`.
 */
export const LIVE_SOURCES = ['open-meteo', 'rss', 'ical', 'table'] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];

/** The units an Open-Meteo forecast is fetched in, as a weather template's unit fields write them. */
export const WEATHER_UNITS = { temperature: ['°F', '°C'], wind: ['mph', 'km/h'] } as const;

/** A binding's path: dot-separated keys, numbers indexing arrays. */
export const BINDING_PATH = /^[^.\s]+(?:\.[^.\s]+)*$/;

/**
 * One feed a template's live fields come from: its kind and each field's path in its snapshot.
 * The editor binds them to a source of that kind with these paths; the fields keep their values as
 * the fallback a screen shows without fresh data. Other fields are typed by people.
 */
export interface LiveSourceDef {
  source: LiveSource;
  /**
   * Field name to its path in the source's snapshot, as a `Binding` names it. A `table` source
   * fills list fields only, each at `rows` (`TABLE_ROWS_PATH`), mapped by the spot's binding.
   */
  fields: Record<string, string>;
  /** Open-Meteo: the text field naming the place, which starts as the place picked. */
  place?: string;
  /** Open-Meteo: the select fields that say which units the forecast is fetched in (`WEATHER_UNITS`). */
  units?: { temperature?: string; wind?: string };
}

/**
 * Which fields of a template are live data: one source, or from manifest schema 7 several by name
 * (#193), such as weather from Open-Meteo and headlines from a feed in one frame. Each named source
 * has a label, shown over its picker in the editor, and feeds its own fields: a field comes from
 * one source at most, and a field a source names as its place or units is one no source fills.
 * A spot binds each field to a data source of its own, so the sources go stale apart.
 */
export type LiveData = LiveSourceDef | { sources: Record<string, LiveSourceDef & { label: string }> };

/** A template's live sources by name. The one source of a template that declares one is named `source`. */
export const liveSources = (live: LiveData): Record<string, LiveSourceDef & { label?: string }> => ('sources' in live ? live.sources : { source: live });

/** Who owns a template: `base` for the platform's own, otherwise the org's id. */
export type TemplateOwner = 'base' | (string & {});

/**
 * How a manifest and its spots refer to one template version: `<owner>/<id>@<version>`. The owner
 * keeps a base template and an org's template with the same id and version apart.
 */
export const templateKey = (m: Pick<TemplateManifest, 'id' | 'version'>, owner: TemplateOwner = 'base') => `${owner}/${m.id}@${m.version}`;

/** Whether a template key (`templateKey`) names a base template, the platform's own. */
export const isBaseTemplateKey = (key: string) => key.startsWith('base/');

/**
 * The bundle hashes of a manifest's base templates. Their bytes live under the shared R2 prefix,
 * every other file under the org's (the device blob route, the `/admin` upload).
 */
export const baseTemplateHtml = (m: { templates?: ScreenManifest['templates'] }): Set<Sha256> =>
  new Set(
    Object.entries(m.templates ?? {})
      .filter(([key]) => isBaseTemplateKey(key))
      .map(([, t]) => t.html),
  );

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
 *
 * Written in the terms of the H.264 sequence parameter set (SPS), which an MP4 header carries, so
 * `packages/media-check` can check it without decoding. `sf build` checks the same rules from
 * ffprobe's report. A value that cannot be read fails the check.
 */
export const VIDEO_SPEC = {
  /** H.264 in an MP4 (`avc1` sample entry, the SPS in the header). */
  codec: 'h264',
  /**
   * SPS profile_idc: Baseline (66, Constrained Baseline included), Main (77), High (100). The
   * profiles for 10-bit, 4:2:2 and 4:4:4 (High 10 is 110) are left out: the Pi 4's decoder cannot play them.
   */
  profileIdcs: [66, 77, 100],
  /** SPS level_idc: 42 is level 4.2. ffprobe reports `level` the same way. */
  maxLevel: 42,
  /** SPS chroma_format_idc 1, 4:2:0. */
  chromaFormat: 1,
  /** Luma and chroma bit depth. */
  bitDepth: 8,
  /** SPS frame_mbs_only_flag 1: every picture is a whole frame, never interlaced fields. */
  progressive: true,
  /** The long side and the short side, so portrait video fits too. */
  maxWidth: 1920,
  maxHeight: 1080,
  /** Average frames per second. 29.97 counts as 30: up to half a frame over is allowed. */
  maxFps: 30,
  /** The video stream's average bits per second. */
  maxBitrate: 10_000_000,
  /**
   * The whole file. About 6.5 minutes at the full bit rate. Every screen stores the file, and the
   * browser hashes it in memory before upload.
   */
  maxBytes: 500_000_000,
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
 * The size in pixels of the sample of a `width`x`height` image (`ManifestFile.sample`): a column
 * per `IMAGE_SAMPLE_CELL` of its width, a row per cell of its height for its darkest pixels, and as
 * many again for its lightest.
 */
export const imageSampleSize = (width: number, height: number) => ({
  width: Math.ceil(width / IMAGE_SAMPLE_CELL),
  height: 2 * Math.ceil(height / IMAGE_SAMPLE_CELL),
});

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
  { pattern: /["'(=]\s*(?:https?:)?\/\/[a-z0-9]/i, reason: 'a template may not refer to anything on the network' },
  // The player's policy runs only the bundle's own scripts (Template containment in docs/architecture.md).
  {
    // An `on…=` attribute in markup, in a file or in a string, or set with setAttribute; not a property such as `img.onload = f`.
    pattern: /<[a-z][^>]*\son[a-z]+\s*=|\bsetAttribute\(\s*["'`]on[a-z]/i,
    reason: 'inline event handlers do not run in a template; use addEventListener',
  },
  { pattern: /\bjavascript:/i, reason: '`javascript:` URLs do not run in a template' },
];

/**
 * What every classic inline script of a built template starts with, exactly (`sf build` emits it).
 * The player puts its WebRTC guard right after these bytes and lets no other script run, so it never
 * parses a template's code (Template containment in docs/architecture.md).
 */
export const TEMPLATE_SCRIPT_START = '"use strict";';
/**
 * CSS a template may not ship, checked on the bundle. `backdrop-filter` was measured as too slow on
 * the baseline device. An `@import` in the author's `style.css` is fine (the look kit's is one):
 * the build inlines it, so one left in the bundle would be fetched at run time.
 */
export const FORBIDDEN_CSS: { pattern: RegExp; reason: string }[] = [
  { pattern: /backdrop-filter\s*:/i, reason: '`backdrop-filter` drops about a fifth of frames over moving content' },
  { pattern: /@import\b/i, reason: 'stylesheets must be bundled, not imported at run time' },
];

/** The checks a built template is put through, by `sf build` and again by the server. */
export const TEMPLATE_CHECKS = ['manifest', 'forbidden-css', 'size', 'network', 'source-code', 'scripts'] as const;
export type TemplateCheckName = (typeof TEMPLATE_CHECKS)[number];

/** The result of `checkTemplateBundle`. The server stores it on the template version. */
export interface TemplateCheckReport {
  ok: boolean;
  /** Bytes of the built HTML file. */
  bundleBytes: number;
  checks: { check: TemplateCheckName; ok: boolean; problems: string[] }[];
  /**
   * Findings that do not stop a template shipping: colour literals outside a `var(--sf-*)`
   * fallback (`brandColourWarnings`). Absent on reports stored before the lint existed.
   */
  warnings?: string[];
  /**
   * The runtime check, which the server adds to an org template's report. Absent on base
   * templates (CI checks those) and on reports stored before the check existed.
   */
  runtime?: TemplateRuntimeReport;
}

/**
 * The runtime check of a template (`apps/template-check`): its bundle rendered in headless
 * Chromium, in the player's sandbox and policy, in a container with no network, at 1920x1080 in
 * each orientation it supports, with example data. Each request or navigation it attempts, an
 * uncaught error, a failed prepare and no `ready` within the player's limit is a problem.
 */
export interface TemplateRuntimeReport {
  ok: boolean;
  /** Sentences, such as `requested https://example.com/x (blocked)`. */
  problems: string[];
  /** What rendered it: the runner image (pinned by digest when deployed) and the browser. */
  runner: { image: string; browser: string };
  /** One per orientation the template supports. */
  renders: TemplateRender[];
  /** What the check cost, in ms: starting the container (0 when it was running) and the check in it. */
  cost: { startMs: number; checkMs: number };
}

export interface TemplateRender {
  orientation: Orientation;
  viewport: { width: number; height: number };
  /** From `init` to `ready`, as the page around the template saw it; null when it never came. */
  readyMs: number | null;
  /**
   * The first second of play, counted in the template's own frame, so the template could skew
   * it: information, not a gate. The frame budgets are measured on the Pi. Null when it never played,
   * or played but drew no second of frames (wedged in `play`), which the check refuses.
   */
  frames: { count: number; longestMs: number } | null;
}

/** Named colours the lint knows. Not the whole CSS list: the ones a template is likely to write. */
const NAMED_COLOURS =
  /\b(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|cyan|magenta|fuchsia|gold|brown|indigo|violet|beige|ivory|coral|salmon|tomato|crimson|khaki)\b/gi;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
/** Properties where a bare word may be a colour; anywhere else `white` could be a name. */
const COLOUR_PROPERTY = /color|background|border|outline|shadow|fill|stroke|text-decoration|column-rule|^--/i;

/** `text` with every `name(...)` call (balanced) replaced by spaces, so offsets stay put. */
function blankCalls(text: string, name: RegExp): string {
  let out = text;
  for (const m of [...text.matchAll(name)]) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    out = out.slice(0, m.index!) + ' '.repeat(i + 1 - m.index!) + out.slice(i + 1);
  }
  return out;
}

/**
 * The brand colour lint: colours in a template's CSS should come from `var(--sf-*)` or be built on
 * one (`color-mix()`, gradients), with a literal only as the fallback inside `var()`, so the
 * template follows the screen's brand kit and still renders without one. A literal elsewhere is a
 * warning, not a failure. The shipped templates have none: shades are the kit's background mixed
 * with `transparent`, and colours that are no brand role are mixes of tokens with literal fallbacks.
 * Reads `.css` sources and the `<style>` elements of `.html` sources.
 */
export function brandColourWarnings(sources: Record<string, string>): string[] {
  const warnings: string[] = [];
  for (const [name, text] of Object.entries(sources)) {
    let css: string;
    if (name.endsWith('.css')) css = text;
    else if (name.endsWith('.html')) {
      // Everything outside <style> becomes blank, newlines kept, so line numbers stay the file's.
      const blank = (t: string) => t.replace(/[^\n]/g, ' ');
      css = '';
      let at = 0;
      for (const m of text.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/gi)) {
        css += blank(text.slice(at, m.index! + m[1]!.length)) + m[2];
        at = m.index! + m[1]!.length + m[2]!.length;
      }
      css += blank(text.slice(at));
    } else continue;
    css = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const d of css.matchAll(/([-\w]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
      const prop = d[1]!;
      const value = blankCalls(blankCalls(d[2]!, /\bvar\(/gi), /\burl\(/gi);
      const found: { at: number; text: string }[] = [];
      for (const m of value.matchAll(/#[0-9a-f]{3,8}\b/gi)) found.push({ at: m.index!, text: m[0] });
      const calls = blankCalls(value, COLOUR_FUNCTION);
      for (const m of value.matchAll(COLOUR_FUNCTION)) {
        const end = calls.slice(m.index!).search(/\S/);
        found.push({ at: m.index!, text: d[2]!.slice(m.index!, end < 0 ? undefined : m.index! + end).trim() });
      }
      if (COLOUR_PROPERTY.test(prop)) for (const m of calls.matchAll(NAMED_COLOURS)) found.push({ at: m.index!, text: m[0] });
      const line = css.slice(0, d.index!).split('\n').length;
      for (const f of found.sort((a, b) => a.at - b.at))
        warnings.push(`${name}:${line}: literal colour ${f.text} in ${prop}; use var(--sf-*) with it as the fallback`);
    }
  }
  return warnings;
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
  /**
   * Image fields, by field name, and under `sampleAsset(field)` the sample of a field's image when
   * its file has one (`ManifestFile.sample`). The SDK turns each into an object URL.
   */
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
// A data source is a feed the server polls. Screens never call the feed themselves: from
// the API they get snapshots on each sync (`SyncResponse.snapshots`); static content has them at
// `data/<id>.json` beside the manifest. A screen keeps the last good one on disk and reads bound
// fields from it each time a spot starts, while it is fresher than `SNAPSHOT_STALE_MS`.

export interface DataSource {
  id: string;
  /**
   * Retired: no screen polls by it any more (snapshots come on sync, and static content checks
   * every source each minute). Kept, as the server's poll interval, because players built before
   * M3-23 require it; it goes with the next manifest schema.
   */
  refreshS: number;
}

/** A snapshot's `data`, as JSON in UTF-8, is at most this many bytes. The server refuses a larger feed. */
export const MAX_SNAPSHOT_BYTES = 65_536;

/**
 * A snapshot the server has not confirmed (`checkedAt`) for this long is stale: a screen plays the
 * spot's static fallback rather than old data. The poller backs off to 6 hours on failure, so a
 * source gets several tries before its screens fall back.
 */
export const SNAPSHOT_STALE_MS = 24 * 3_600_000;

export interface DataSnapshot {
  id: string;
  /**
   * The content's version: it increases every time the source's data changes, and only then, so a
   * screen keeps the newest snapshot whichever order they arrive in (a first-load fetch and a sync
   * can cross). The server uses the time the changed data was fetched, in ms since the epoch; it
   * tells a change by the hash of the data, which stays on the server.
   */
  version: number;
  /** When this content was first fetched. */
  fetchedAt: string;
  /** When the server last saw the feed still say this. Staleness counts from it. */
  checkedAt: string;
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
    /**
     * Who booked it: the ORGANIZER's display name (its CN), or `''`. Never the address, which a
     * screen in a corridor would show to everyone passing: a name holding an `@` (a CN that is an
     * address, or `Name <address>`) is `''` too. A connector maps the display name by the same rule
     * (Google `organizer.displayName`, Graph `organizer.emailAddress.name`), never the address.
     */
    organizer: string;
  }[];
}
export interface NewsFeed {
  title: string;
  /**
   * The feed's language as it declares it (RSS `<language>`, Atom `xml:lang`), a BCP 47 tag such as
   * `fr-FR`, or `''` when it declares none. A template writes the feed's own words, such as an
   * age label, in it, and in the screen's locale when it is empty. Always present, so a spot can
   * bind it whatever the feed.
   */
  language: string;
  /** Newest first. */
  items: { title: string; published: string; source: string; image?: NewsImage }[];
}

/**
 * A story's photo as a screen gets it: the server's checked copy of the image the feed names,
 * stored by hash in the org's storage, as an uploaded image is. The feed's own URL never reaches a
 * screen. Only the first stories of a feed have one, and only once the server has fetched it: a
 * story without one plays as a story with no photo. A screen that does not hold the files plays it
 * the same way. Players before this field ignore it, as they ignore any property a list's item
 * does not define.
 */
export interface NewsImage {
  /**
   * The photo for the lead slot: the fetched JPEG or WebP itself when it already fits within 1.25×
   * `SCREEN_BOX.landscape` and the server's pass-through byte cap, otherwise scaled to cover
   * `SCREEN_BOX.landscape` (never larger than the feed's; JPEG stays JPEG, any other type becomes
   * WebP). No contrast sample is stored: templates put text over feed photos behind a scrim.
   */
  file: Sha256;
  /**
   * A small copy for a list row, scaled to cover `NEWS_THUMB_BOX`, of the same type; equal to
   * `file` when the photo already fits `NEWS_THUMB_BOX`.
   */
  thumb: Sha256;
}

/** The box a story's thumbnail (`NewsImage.thumb`) covers: a list row's picture, a quarter of a landscape screen's width. */
export const NEWS_THUMB_BOX = { w: 480, h: 270 } as const;

/**
 * A CSV file or a JSON list of objects, as the server converts a `csv` or `json-table` source.
 * `columns` in the file's order (a CSV's header row; for JSON every key, in the order first
 * seen); each row has one cell per column, `''` where it had none. CSV cells are text as written,
 * so "$4.50" and "02134" keep their form; JSON numbers stay numbers.
 */
export interface TableFeed {
  columns: string[];
  rows: (string | number)[][];
}

/** A table binding's path: the rows of a `TableFeed`. */
export const TABLE_ROWS_PATH = 'rows';

/**
 * How a table's rows fill a list field (`Binding.table`). Each row becomes an item: the column
 * named for each item property fills it, converted to the property's type (a number written as
 * text in the screen's locale, as a price: 4.5 is "4.50"; a select matched to its options in any
 * case). A property with no column takes its default. A row that does not fit the item, or leaves
 * a property with no default empty, is left out; when every row the filter keeps is left out, the
 * binding has no value, so the last good snapshot or the fallback stays. The rows kept are
 * filtered, then sorted, then cut to the field's `maxItems`.
 */
export interface TableMapping {
  /** Item property to the column that fills it. Every property without a default needs one. */
  columns: Record<string, string>;
  /** Only rows whose cell in `column` is `equals`, ignoring case and surrounding spaces: `section` = `Mains`. */
  filter?: { column: string; equals: string };
  /** Rows in the order of `column`: numbers by value, text in the screen's locale with its digits as numbers. Absent: the file's order. */
  sort?: { column: string; descending?: boolean };
}

export interface Binding {
  source: string;
  /** Dot path into the snapshot's data. Numbers index arrays: `daily.temperature_2m_max.0`. With `table`, `rows`. */
  path: string;
  /** A list field filled from a `TableFeed`'s rows. From manifest schema 4. */
  table?: TableMapping;
}

/**
 * A spot draft's fields that still hold its template's sample copy, untouched (#360): what New spot
 * started it with (a text's default, a list's default rows), never worked out from values later.
 * `texts` names the text fields; `lists` gives each list field, row by row, the cells not edited yet
 * (a row is sample while any are). A saved edit of a field, or binding it to a source, takes it
 * out; a spot made any other way, or before #360, has none. It never reaches a screen: a publish
 * that would put a spot with any live is refused (`sample_text`) unless a person allows it.
 */
export interface SampleFields {
  texts: string[];
  lists: Record<string, string[][]>;
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

/** What a schedule entry is aimed at. More specific wins a priority tie (`ScheduleEntry`). */
export type TargetLevel = 'org' | 'group' | 'screen';

/**
 * Where entries that apply overlap, the highest `priority` plays; of equal priority the more
 * specific target; then the later `startsAt` (an entry without one counts as earliest), so the
 * newest of two takeovers wins; then the one later in the manifest's `schedule`.
 */
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
   * `endsAt` exclusive. An entry with `endsAt` is a takeover: it ends on time whatever the screen's
   * time zone and with the network down, and when the takeover that wins changes (one published,
   * starting or ending) the player ends the spot on screen at once instead of at its end. A screen
   * that does not trust its clock skips any entry with either bound rather than risk running a
   * takeover forever, except a takeover whose playlist plays only base `alert` spots (owner, #200):
   * an alert that is live is not held back. It plays while the earliest the real time can be (the
   * player's build or its last sync, plus the time the screen has run since) is at or after its
   * `startsAt` and before its `endsAt`. So one published to start at once plays, one scheduled for
   * later waits until it has surely started, and one surely over stops, offline too; the first sync
   * that makes the clock trusted again ends it on time.
   */
  startsAt?: string;
  endsAt?: string;
}

/** One file of a manifest. */
export interface ManifestFile {
  size: number;
  type: string;
  /**
   * An opaque raster image's sample, a file listed in the same `files`: a PNG of the image's
   * darkest and lightest pixel (WCAG relative luminance) in each cell of `IMAGE_SAMPLE_CELL` by
   * `IMAGE_SAMPLE_CELL` pixels, the last row and column of cells cut by the image's edge. Its top
   * half has each cell's darkest pixel and its bottom half each cell's lightest, at the cell's place
   * (`imageSampleSize`). A template that measures text over the image reads it in place of decoding
   * the image again, which costs a Pi 4 100 ms or more of a prepare; `init` carries it beside the
   * image (`sampleAsset`), and a manifest names it only for an image a template spot shows
   * (`requiredFiles`). Made when the image is uploaded and by `sf build`; an image uploaded
   * before has none, and an image with any transparent pixel never has one, since what shows
   * through is known only where it plays.
   */
  sample?: Sha256;
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
  files: Record<Sha256, ManifestFile>;
  templates: Record<string, { manifest: TemplateManifest; html: Sha256 }>;
  spots: Record<string, Spot>;
  playlists: Record<string, Playlist>;
  dataSources: Record<string, DataSource>;
  /** In the order the entries were published, oldest first: of two otherwise tied, the later wins. */
  schedule: ScheduleEntry[];
  /** Plays when no schedule entry applies, so a screen is never blank. */
  defaultPlaylist: string;
  /** The screen's brand kit, frozen at publish. Its fonts and logo are in `files`. Absent: templates use their own look. */
  brand?: BrandKit;
}

// ------------------------------------------------------------------- device API
// What a screen and the server say to each other, under /v1/device. See docs/backend-plan.md.

/**
 * What runs the player: a device with a supervisor (a Raspberry Pi), or a browser tab with none
 * (a test screen, opened from the CMS). A browser screen keeps its credential in the browser and
 * has no panel to power.
 */
export const SCREEN_KINDS = ['device', 'browser'] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

/** `POST /v1/device/pair/start`. The screen says what it is; the claim makes a screen of that kind. An empty body is a device. */
export interface PairStartRequest {
  kind?: ScreenKind;
}

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
 * once the hour has ended, until a sync acknowledges them. Which manifest a spot played from is
 * not counted: the screen's publish history says which manifest it had when.
 */
export interface PlayCount {
  /** Start of the hour in UTC: `2026-11-17T13:00Z`. */
  hour: string;
  spot: string;
  plays: number;
  /** Time on screen: the spots' scheduled durations, summed. */
  ms: number;
}

/** The most play counts one sync carries; a screen with more sends the rest at the next. */
export const MAX_SYNC_PLAY_COUNTS = 500;

/**
 * The most sources a player reports in `snapshots` or `dataRejected`: it sends only the sources of
 * the manifests it holds. A sync with more is still taken, as players before gh-45 send every
 * source seen since they started; the server keeps at most this many of `dataRejected`, so that map
 * cannot make a huge row (the body as a whole is bounded by MAX_SYNC_REQUEST_BYTES).
 */
export const MAX_SYNC_SOURCES = 256;

/**
 * The largest `POST /v1/device/sync` body the server reads, in bytes; a larger one is refused (413)
 * before it is parsed. A sync holds at most MAX_SYNC_PLAY_COUNTS counts (about 50 kB). A player
 * before gh-45 also sends both source maps with every source seen since it started, about 160
 * bytes a source with 64-character ids: this leaves room for some 6000 sources in one run.
 */
export const MAX_SYNC_REQUEST_BYTES = 1_048_576;

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
  /**
   * `active`: the manifest playing. `filesMissing`: files not yet held, of the manifest being synced and, while
   * falling back, of the last good one.
   * `fallbackFrom`: a newer manifest that played nothing in a full pass, so the screen went back to
   * its last good one (`active`). `lastGood`: the last manifest that played a spot, which the
   * screen may go back to, so the server lets it fetch that manifest's files. Manifest ids are
   * lowercase hex sha256 (`canonicalJson`).
   */
  manifest: { active?: string; filesMissing: number; fallbackFrom?: string; lastGood?: string };
  display: DisplayStatus;
  /** The screen's own clock when it sent this, uncorrected; the server measures drift from it. */
  deviceTime: string;
  /** The correction the screen applies to its own clock, and whether it trusts the result (docs/architecture.md, Player, Clock). */
  clock: { offsetMs: number; trusted: boolean };
  playCounts: PlayCount[];
  /** `DataSnapshot.version` of each snapshot the screen holds, by source id. */
  snapshots: Record<string, number>;
  /** Live values and snapshots refused since the player started, by source id: a broken feed shows here. */
  dataRejected?: Record<string, number>;
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
  /**
   * For snapshots the screen already holds, when the server last confirmed them, by source id. A
   * screen moves its copy's `checkedAt` on only if it holds that `version`, so an unchanged feed
   * does not go stale and the data is not sent again.
   */
  checked?: Record<string, { version: number; checkedAt: string }>;
  /** Short-lived ticket for `GET /v1/device/ws?ticket=`. */
  socketTicket: string;
  commands: DeviceCommand[];
}

export type DeviceCommand =
  /** Reload the player, e.g. after the server stops producing a schema this build can play. A screen obeys it at most every 15 minutes. */
  | { type: 'reload' }
  /** Restart the player now, because a person asked from the CMS. Obeyed every time, unlike `reload`. */
  | { type: 'restart' }
  | { type: 'display'; override: DisplayOverride | null }
  /** Show the screen's name over its content for `seconds`, so someone in the room can tell which screen this is. */
  | { type: 'identify'; name: string; seconds: number }
  | { type: 'reboot' };

/** The longest an `identify` command shows the screen's name. */
export const MAX_IDENTIFY_SECONDS = 60;

/** Server to screen, over the socket. Kept rare: the socket exists to nudge, not to carry data. */
export type ServerSocketMessage = { type: 'manifest'; id: string } | { type: 'command'; command: DeviceCommand } | { type: 'revoked' };

/**
 * Screen to server, over the socket. `observedAt`: when the screen saw `manifest` on screen, on
 * its corrected clock, so the server orders it against the manifest a sync reports (gh-44).
 * Absent from a player before it, or while the screen does not trust its clock: the server then
 * orders the report by when it arrived.
 */
export type DeviceSocketMessage = { type: 'applied'; manifest: string; observedAt?: string };

// -------------------------------------------------------------- preview channel
// The CMS editor runs the real player build in an iframe, in preview mode (`?source=preview`).
// The CMS page posts the draft to it; the player accepts messages only from the CMS origin and
// only while that origin frames it. See docs/architecture.md (Player, Content sources).

/** The preview channel's version, in every message both ways. */
export const PREVIEW_PROTOCOL = 1;

/**
 * Where the CMS and the preview fetch a saved file with the user's session, relative to the CMS
 * origin. `v2` is a new cache key: until #43 these responses were cached as immutable for a year,
 * so a browser may still hold a copy under the old `/api/blobs/<sha256>` that it would reuse
 * without asking. Nothing requests that URL any more. Change the version again if this route's
 * caching ever has to tighten.
 */
export const sessionBlobPath = (sha256: string) => `/api/blobs/v2/${sha256}`;

/** CMS page to preview player. */
export interface PreviewDraftMessage {
  sfPreview: number;
  type: 'draft';
  /** A compiled draft manifest. Its first spot plays now, and later drafts update it in place. */
  manifest: ScreenManifest;
  /**
   * Files of the manifest, by hash. A file not here is fetched from `<cms>` + `sessionBlobPath(sha256)`
   * with the user's session, so the CMS posts only what is not saved yet.
   */
  files?: Record<string, Blob>;
  /** The latest snapshot of each data source the draft binds. */
  data?: DataSnapshot[];
}
export type PreviewHostMessage = PreviewDraftMessage;

/** Preview player to CMS page. */
export type PreviewPlayerMessage =
  /** The player is listening: post the draft. */
  | { sfPreview: number; type: 'listening' }
  /** A spot of the draft is on screen. */
  | { sfPreview: number; type: 'playing'; manifest: string; spot: string }
  /** The draft was refused or a spot could not be shown. */
  | { sfPreview: number; type: 'error'; message: string };
