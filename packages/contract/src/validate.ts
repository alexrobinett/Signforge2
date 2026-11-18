/**
 * Runtime checks for every shape a screen or a tool receives. Each validator takes any JSON value
 * and returns a list of problems, empty when the value is valid. None of them throws, whatever the
 * input: they are fed random JSON in `validate.test.ts`.
 *
 * A problem is one sentence that names where it is: `spot "promo": field "price" must be at most 100`.
 * Keys are quoted; a value from the input is shown through `show`, never interpolated raw, because
 * an object with a `toString` key that is not a function throws when turned into a string.
 *
 * Lookups by a key taken from the input go through `own`: `fields["constructor"]` is a function on
 * every plain object, and must not count as a field.
 */
import {
  BRAND_COLORS,
  BRAND_SHAPES,
  brandColourWarnings,
  FORBIDDEN_CSS,
  FORBIDDEN_TEMPLATE_CODE,
  ID_PATTERN,
  MAX_IDENTIFY_SECONDS,
  MAX_SNAPSHOT_BYTES,
  MAX_SYNC_PLAY_COUNTS,
  PREVIEW_PROTOCOL,
  SCREEN_KINDS,
  SUPPORTED_MANIFEST_SCHEMAS,
  SUPPORTED_PROTOCOLS,
  TEMPLATE_BUDGET,
  templateKey,
  type BrandKit,
  type DisplayHours,
  type FieldDef,
  type ScalarFieldDef,
  type ScreenManifest,
  type TemplateCheckReport,
  type TemplateManifest,
} from './shapes.ts';

// ------------------------------------------------------------------ helpers

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `o[k]` when `o` is an object that has `k` as its own key; otherwise undefined. */
const own = (o: unknown, k: unknown): unknown => (isObj(o) && typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : undefined);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isIdValue = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
/** A manifest id as a screen reports it: lowercase hex sha256, as `canonicalJson` describes. */
const isManifestId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/** An ISO 8601 date and time, such as `2026-11-17T13:00:00Z`. */
const isInstant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

/** A value from the input, safe to put in a message: never throws, never long. */
export function show(v: unknown): string {
  let s: string | undefined;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = undefined;
    }
  }
  s ??= typeof v;
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

const prefix = (where: string, problems: string[]) => problems.map((p) => `${where}: ${p}`);
/** Check each item of a list; problems are prefixed with the 1-based position. */
const list = (where: string, v: unknown, check: (item: unknown) => string[]): string[] =>
  Array.isArray(v) ? v.flatMap((item, i) => prefix(`${where} ${i + 1}`, check(item))) : [`${where} must be a list`];

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Whether `tz` is an IANA time zone this runtime knows. */
export function validTimezone(tz: unknown): boolean {
  if (!isText(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Whether `locale` is one BCP 47 language tag. */
export function validLocale(locale: unknown): boolean {
  if (!isText(locale)) return false;
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
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

// ----------------------------------------------------------- template fields

const SCALAR_TYPES = ['text', 'number', 'boolean', 'color', 'select'] as const;

/** Whether `v` sits on the step grid, counted from `min` (or 0), allowing for float rounding. */
function onStep(v: number, step: number, base: number): boolean {
  const q = (v - base) / step;
  return Math.abs(q - Math.round(q)) <= 1e-9 * Math.max(1, Math.abs(q));
}

/** Why a value does not fit a scalar field; undefined if it does. `def` is already known valid. */
function scalarProblem(name: string, def: ScalarFieldDef, v: unknown): string | undefined {
  switch (def.type) {
    case 'text':
      if (!isStr(v)) return `field "${name}" must be text`;
      if (def.maxLength && v.length > def.maxLength) return `field "${name}" is longer than ${def.maxLength}`;
      return undefined;
    case 'number':
      if (!isNum(v)) return `field "${name}" must be a number`;
      if (def.min !== undefined && v < def.min) return `field "${name}" must be at least ${def.min}`;
      if (def.max !== undefined && v > def.max) return `field "${name}" must be at most ${def.max}`;
      if (def.step !== undefined && !onStep(v, def.step, def.min ?? 0))
        return `field "${name}" must be a multiple of ${def.step}${def.min ? ` from ${def.min}` : ''}`;
      return undefined;
    case 'boolean':
      return typeof v === 'boolean' ? undefined : `field "${name}" must be true or false`;
    case 'color':
      return isStr(v) ? undefined : `field "${name}" must be a colour`;
    case 'select':
      return isStr(v) && def.options.includes(v) ? undefined : `field "${name}" must be one of ${def.options.join(', ')}`;
  }
}

/** What is wrong with one field definition. List items may hold only scalar fields. */
function fieldDefProblems(name: string, def: unknown, inList = false): string[] {
  const where = `field "${name}"`;
  if (!isObj(def)) return [`${where} is not a field definition`];
  const out: string[] = [];
  if (!isText(def.label)) out.push(`${where} needs a label`);
  const has = (k: string) => Object.hasOwn(def, k) && def[k] !== undefined;
  const optional = (k: string, ok: (v: unknown) => boolean, what: string) => {
    if (has(k) && !ok(def[k])) out.push(`${where}: ${k} must be ${what}`);
  };
  switch (def.type) {
    case 'text':
      optional('maxLength', (v) => Number.isSafeInteger(v) && (v as number) > 0, 'a whole number above 0');
      break;
    case 'number':
      optional('min', isNum, 'a number');
      optional('max', isNum, 'a number');
      optional('step', (v) => isNum(v) && v > 0, 'a number above 0');
      if (isNum(def.min) && isNum(def.max) && def.min > def.max) out.push(`${where}: min must not be above max`);
      break;
    case 'boolean':
    case 'color':
      break;
    case 'select':
      if (!Array.isArray(def.options) || !def.options.length || !def.options.every(isStr)) out.push(`${where}: options must be a list of text`);
      break;
    case 'image':
      if (inList) out.push(`${where}: a list row cannot hold an image`);
      return out;
    case 'list':
      if (inList) return [...out, `${where}: a list row cannot hold a list`];
      optional('maxItems', (v) => Number.isSafeInteger(v) && (v as number) > 0, 'a whole number above 0');
      if (!isObj(def.item)) out.push(`${where}: item must map names to fields`);
      else for (const [k, d] of Object.entries(def.item)) out.push(...fieldDefProblems(`${name}.${k}`, d, true));
      if (!out.length && has('default')) out.push(...prefix(`${where} default`, listProblems(name, def as Extract<FieldDef, { type: 'list' }>, def.default)));
      return out;
    default:
      return [`${where}: type must be one of ${[...SCALAR_TYPES, 'image', 'list'].join(', ')}`];
  }
  if (!out.length && has('default')) {
    const e = scalarProblem(name, def as ScalarFieldDef, def.default);
    if (e) out.push(`${where} default: ${e}`);
  }
  return out;
}

function listProblems(name: string, def: Extract<FieldDef, { type: 'list' }>, v: unknown): string[] {
  if (!Array.isArray(v)) return [`field "${name}" must be a list`];
  const out: string[] = [];
  if (def.maxItems && v.length > def.maxItems) out.push(`field "${name}" has more than ${def.maxItems} rows`);
  v.forEach((row: unknown, i) => {
    if (!isObj(row)) {
      out.push(`field "${name}" row ${i + 1} must be an object`);
      return;
    }
    for (const [k, d] of Object.entries(def.item)) {
      const cell = own(row, k) ?? d.default;
      if (cell === undefined) out.push(`field "${name}" row ${i + 1} is missing "${k}"`);
      else {
        const e = scalarProblem(`${name}[${i + 1}].${k}`, d, cell);
        if (e) out.push(e);
      }
    }
  });
  return out;
}

/** Check a template's `template.json`. Returns problems; empty means valid. */
export function validateTemplateManifest(m: unknown): string[] {
  if (!isObj(m)) return ['manifest is not an object'];
  const errors: string[] = [];
  if (!isStr(m.id) || !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) errors.push('id must be lowercase letters, digits and dashes');
  if (!isStr(m.version) || !/^\d+\.\d+\.\d+$/.test(m.version)) errors.push('version must be semver, e.g. 1.0.0');
  if (!isText(m.name)) errors.push('name is required');
  if (m.description !== undefined && !isStr(m.description)) errors.push('description must be text');
  if (!isObj(m.fields)) errors.push('fields is required');
  else for (const [name, def] of Object.entries(m.fields)) errors.push(...fieldDefProblems(name, def));
  const d = m.duration;
  if (!isObj(d) || !isNum(d.minMs) || !isNum(d.defaultMs) || !isNum(d.maxMs) || !(d.minMs > 0) || !(d.minMs <= d.defaultMs) || !(d.defaultMs <= d.maxMs)) {
    errors.push('duration needs 0 < minMs <= defaultMs <= maxMs');
  }
  if (!Array.isArray(m.orientations) || !m.orientations.length || m.orientations.some((o) => o !== 'landscape' && o !== 'portrait')) {
    errors.push('orientations must list landscape and/or portrait');
  }
  if (!Array.isArray(m.uses)) errors.push('uses must be an array (it may be empty)');
  else if (m.uses.some((u) => u !== 'canvas' && u !== 'webgl' && u !== 'audio')) errors.push('uses may list only canvas, webgl and audio');
  if (!isText(m.background)) errors.push('background is required');
  if (m.protocol !== undefined && !Number.isSafeInteger(m.protocol)) errors.push('protocol must be a whole number');
  return errors;
}

/** Check one binding's shape. */
const bindingProblem = (name: string, b: unknown): string | undefined =>
  isObj(b) && isIdValue(b.source) && isText(b.path) ? undefined : `binding for "${name}" needs a data source id and a path`;

/**
 * Check a spot's data against the template's fields. Returns problems; empty means valid. Total
 * over any input; a malformed field definition is reported rather than trusted.
 */
export function validateSpotData(fields: unknown, data: unknown, assets: unknown, bindings: unknown = {}): string[] {
  if (!isObj(fields)) return ['the template has no fields map'];
  const errors: string[] = [];
  if (!isObj(data)) errors.push('data is not an object');
  if (!isObj(assets)) errors.push('assets is not an object');
  if (!isObj(bindings)) errors.push('bindings is not an object');
  if (errors.length) return errors;
  const d = data as Obj,
    a = assets as Obj,
    b = bindings as Obj;

  for (const [name, binding] of Object.entries(b)) {
    const def = own(fields, name);
    if (!def) errors.push(`binding for unknown field "${name}"`);
    else if (own(def, 'type') === 'image') errors.push(`image field "${name}" cannot be bound to live data`);
    const e = bindingProblem(name, binding);
    if (e) errors.push(e);
  }
  for (const [name, raw] of Object.entries(fields)) {
    if (fieldDefProblems(name, raw).length) {
      errors.push(`field "${name}" has no valid definition`);
      continue;
    }
    const def = raw as FieldDef;
    if (def.type === 'image') {
      if (!isText(own(a, name))) errors.push(`image field "${name}" has no asset`);
      continue;
    }
    const v = own(d, name) ?? ('default' in def ? def.default : undefined);
    // A bound field still needs a static value: it is what shows before the first snapshot arrives.
    if (v === undefined) errors.push(`field "${name}" is missing${own(b, name) ? ' (a bound field needs a fallback value)' : ''}`);
    else if (def.type === 'list') errors.push(...listProblems(name, def, v));
    else {
      const e = scalarProblem(name, def, v);
      if (e) errors.push(e);
    }
  }
  for (const name of Object.keys(d)) if (!own(fields, name)) errors.push(`unknown field "${name}"`);
  return errors;
}

// ------------------------------------------------------------------ bound values

/**
 * Read a binding's dot path out of a snapshot's data. Numbers index arrays: `daily.max.0`. Only
 * own keys count, so `constructor` or an array's `length` reads as missing. Undefined when any
 * step is missing.
 */
export function readPath(data: unknown, path: string): unknown {
  let v: unknown = data;
  for (const key of path.split('.')) {
    if (Array.isArray(v)) v = /^\d+$/.test(key) ? v[Number(key)] : undefined;
    else v = own(v, key);
    if (v === undefined) return undefined;
  }
  return v;
}

/**
 * Check a live value against the field it is bound to, before it replaces the spot's static
 * value. Returns problems; empty means the value may be shown. A missing value (`undefined` or
 * `null`, as `readPath` gives for a path the snapshot does not have) is a problem: the fallback
 * stays. The player runs this on every bound field it plays; the server runs it when it stores a
 * snapshot (M3-23), so both refuse the same values.
 */
export function validateBoundValue(fields: unknown, name: unknown, value: unknown): string[] {
  const field = typeof name === 'string' ? name : show(name);
  const raw = own(fields, name);
  if (raw === undefined) return [`unknown field "${field}"`];
  if (fieldDefProblems(field, raw).length) return [`field "${field}" has no valid definition`];
  const def = raw as FieldDef;
  if (def.type === 'image') return [`image field "${field}" cannot be bound to live data`];
  if (value === undefined || value === null) return [`field "${field}" has no value at the bound path`];
  if (def.type === 'list') return listProblems(field, def, value);
  const e = scalarProblem(field, def, value);
  return e ? [e] : [];
}

// --------------------------------------------------------------- display hours

function windowProblems(where: string, w: unknown, required: boolean): string[] {
  if (!isObj(w)) return [`${where}: a window must be an object`];
  const out: string[] = [];
  for (const k of ['from', 'to'] as const) {
    const v = w[k];
    if (v === undefined ? required : !isStr(v) || !TIME.test(v)) out.push(`${where}: ${k} must be HH:MM`);
  }
  if (w.days !== undefined && (!Array.isArray(w.days) || w.days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)))
    out.push(`${where}: days must be 0-6`);
  for (const k of ['startDate', 'endDate'] as const) if (w[k] !== undefined && !(isStr(w[k]) && DATE.test(w[k]))) out.push(`${where}: ${k} must be YYYY-MM-DD`);
  return out;
}

/** What is wrong with a screen's display hours, as `validateManifest` checks them. Empty if they are valid. */
export function displayHoursProblems(hours: unknown): string[] {
  if (!isObj(hours)) return ['display hours must be an object'];
  const errors: string[] = [];
  if (!Array.isArray(hours.weekly)) errors.push('display hours have no weekly list');
  else for (const w of hours.weekly) errors.push(...windowProblems('display hours', w, true));
  if (hours.exceptions !== undefined && !Array.isArray(hours.exceptions)) errors.push('display hours exceptions must be a list');
  for (const e of Array.isArray(hours.exceptions) ? (hours.exceptions as unknown[]) : []) {
    const date = own(e, 'date'),
      on = own(e, 'on');
    if (!isStr(date) || !DATE.test(date) || !Array.isArray(on)) {
      errors.push(`display hours exception "${show(date)}" is malformed`);
      continue;
    }
    for (const w of on) {
      const p = windowProblems(`display hours on ${date}`, w, true);
      errors.push(...p);
      const win = w as DisplayHours['weekly'][number];
      if (!p.length && toMinutes(win.to) <= toMinutes(win.from)) errors.push(`display hours on ${date}: ${win.from}-${win.to} must end after it starts`);
    }
  }
  return errors;
}

/** The least `DataSource.refreshS` a manifest may carry. */
export const MIN_REFRESH_S = 60;

// ---------------------------------------------------------------------- brand

/** Every file a brand kit refers to. The kit must already be valid. */
export const brandFiles = (b: BrandKit): string[] => [
  ...[b.fonts.display, b.fonts.body].flatMap((f) => f?.files.map((x) => x.file) ?? []),
  ...(b.logo ? [b.logo.onDark, b.logo.onLight].filter(isText) : []),
];

function fontProblems(where: string, f: unknown): string[] {
  if (!isObj(f)) return [`${where} font must be an object`];
  const errors: string[] = [];
  const [owner, id, more] = isStr(f.id) ? f.id.split('/') : [];
  if (more !== undefined || !(owner === 'base' || isIdValue(owner)) || !isStr(id) || !/^[a-z0-9][a-z0-9-]*$/.test(id))
    errors.push(`${where} font id must be <owner>/<id>`);
  if (!isText(f.family)) errors.push(`${where} font needs a family`);
  if (Array.isArray(f.files) && !f.files.length) errors.push(`${where} font has no files`);
  errors.push(
    ...list(`${where} font file`, f.files, (x) => {
      if (!isObj(x)) return ['is not an object'];
      const out: string[] = [];
      if (!(Number.isSafeInteger(x.weight) && (x.weight as number) >= 1 && (x.weight as number) <= 1000)) out.push('weight must be 1 to 1000');
      if (x.style !== 'normal' && x.style !== 'italic') out.push('style must be normal or italic');
      if (!isText(x.file)) out.push('file must name a file');
      return out;
    }),
  );
  return errors;
}

/** Check a brand kit as the manifest carries it. Problems are not prefixed; the manifest adds `brand: `. */
export function validateBrandKit(b: unknown): string[] {
  if (!isObj(b)) return ['brand must be an object'];
  const errors: string[] = [];
  if (!isIdValue(b.id)) errors.push('id is not a valid id');
  if (!isObj(b.colors)) errors.push('colors must be an object');
  else for (const c of BRAND_COLORS) if (!isText(own(b.colors, c))) errors.push(`colour "${c}" must be a CSS colour`);
  if (!(BRAND_SHAPES as readonly unknown[]).includes(b.shape)) errors.push(`shape must be ${BRAND_SHAPES.slice(0, -1).join(', ')} or ${BRAND_SHAPES.at(-1)}`);
  if (!isObj(b.fonts)) errors.push('fonts must be an object');
  else for (const k of ['display', 'body'] as const) if (b.fonts[k] !== undefined) errors.push(...fontProblems(k, b.fonts[k]));
  if (b.logo !== undefined && !(isObj(b.logo) && isText(b.logo.onDark) && (b.logo.onLight === undefined || isText(b.logo.onLight)))) {
    errors.push('logo needs an onDark file, and onLight is a file when present');
  }
  return errors;
}

// ------------------------------------------------------------- screen manifest

/** Every file hash a manifest refers to. The manifest must already be valid. */
export function requiredFiles(manifest: ScreenManifest): Set<string> {
  const out = new Set<string>();
  if (manifest.brand) brandFiles(manifest.brand).forEach((f) => out.add(f));
  for (const t of Object.values(manifest.templates)) out.add(t.html);
  for (const s of Object.values(manifest.spots)) {
    if (s.kind === 'template') Object.values(s.assets).forEach((a) => out.add(a));
    else if (s.kind === 'image' || s.kind === 'video') out.add(s.file);
  }
  return out;
}

/** Check a screen manifest. Returns problems; empty means a player can play it. */
export function validateManifest(m: unknown): string[] {
  if (!isObj(m)) return ['manifest is not an object'];
  const errors: string[] = [];
  if (!SUPPORTED_MANIFEST_SCHEMAS.includes(m.schema as number))
    errors.push(`manifest schema ${show(m.schema)} is not one this player can play (${SUPPORTED_MANIFEST_SCHEMAS.join(', ')})`);
  if (!isText(m.id)) errors.push('id is missing');
  if (!isInstant(m.generatedAt)) errors.push('generatedAt must be an ISO 8601 time');

  const screen = m.screen;
  if (!isObj(screen)) errors.push('screen is missing');
  else {
    if (!isIdValue(screen.id)) errors.push(`screen id "${show(screen.id)}" is not a valid id`);
    if (!isStr(screen.name)) errors.push('screen.name is missing');
    if (screen.timezone === undefined || screen.timezone === '') errors.push('screen.timezone is missing');
    else if (!validTimezone(screen.timezone)) errors.push(`screen.timezone "${show(screen.timezone)}" is not a time zone`);
    if (screen.locale !== undefined && !validLocale(screen.locale)) errors.push(`screen.locale "${show(screen.locale)}" is not a locale`);
    if (screen.orientation !== 'landscape' && screen.orientation !== 'portrait') errors.push('screen.orientation must be landscape or portrait');
    if (screen.displayHours !== undefined) errors.push(...displayHoursProblems(screen.displayHours));
  }

  const { files, templates, spots, playlists, dataSources, schedule } = m;
  if (!isObj(files) || !isObj(spots) || !isObj(playlists) || !isObj(templates) || !Array.isArray(schedule) || !isObj(dataSources))
    return [...errors, 'manifest is incomplete'];
  if (!own(playlists, m.defaultPlaylist)) errors.push('defaultPlaylist does not exist');

  for (const [sha, f] of Object.entries(files)) {
    if (!isCount(own(f, 'size')) || !isText(own(f, 'type'))) errors.push(`file ${sha.slice(0, 12)} needs a size and a type`);
  }

  const referenced = new Set<string>();
  const ref = (where: string, sha: unknown) => {
    if (isText(sha)) referenced.add(sha);
    else errors.push(`${where} must name a file`);
  };

  for (const [key, t] of Object.entries(templates)) {
    const manifest = own(t, 'manifest');
    if (!isObj(manifest)) {
      errors.push(`template "${key}" has no manifest`);
      continue;
    }
    ref(`template "${key}" html`, own(t, 'html'));
    const problems = validateTemplateManifest(manifest);
    errors.push(...prefix(`template "${key}"`, problems));
    if (isStr(manifest.id) && isStr(manifest.version)) {
      const owner = key.split('/')[0] ?? '';
      if (!(owner === 'base' || isIdValue(owner)) || key !== templateKey({ id: manifest.id, version: manifest.version }, owner)) {
        errors.push(`template key "${key}" must be <owner>/${manifest.id}@${manifest.version}`);
      }
    }
  }

  for (const [key, spot] of Object.entries(spots)) {
    const where = `spot "${key}"`;
    if (!isObj(spot)) {
      errors.push(`${where} is not an object`);
      continue;
    }
    if (spot.id !== key) errors.push(`${where} is listed under a different id ("${show(spot.id)}")`);
    if (!isIdValue(key)) errors.push(`spot id "${key}" is not a valid id`);
    if (!isStr(spot.name)) errors.push(`${where} has no name`);
    if (!isNum(spot.durationMs) || !(spot.durationMs > 0)) errors.push(`${where} has no duration`);
    switch (spot.kind) {
      case 'template': {
        const t = own(own(templates, spot.template), 'manifest');
        if (!t) {
          errors.push(`${where} uses unknown template ${show(spot.template)}`);
          break;
        }
        if (isObj(spot.assets)) for (const [field, sha] of Object.entries(spot.assets)) ref(`${where} asset "${field}"`, sha);
        const bindings = spot.bindings ?? {};
        if (isObj(bindings)) {
          for (const b of Object.values(bindings)) {
            const source = own(b, 'source');
            if (isStr(source) && !own(dataSources, source)) errors.push(`${where} binds to unknown data source "${source}"`);
          }
        }
        const fields = own(t, 'fields');
        if (isObj(fields)) errors.push(...prefix(where, validateSpotData(fields, spot.data, spot.assets, bindings)));
        const d = own(t, 'duration');
        const minMs = own(d, 'minMs'),
          maxMs = own(d, 'maxMs');
        if (isNum(spot.durationMs) && isNum(minMs) && isNum(maxMs) && (spot.durationMs < minMs || spot.durationMs > maxMs)) {
          errors.push(`${where}: duration ${spot.durationMs} ms is outside the template's range ${minMs} to ${maxMs}`);
        }
        break;
      }
      case 'image':
      case 'video':
        ref(`${where} file`, spot.file);
        if (spot.fit !== 'cover' && spot.fit !== 'contain') errors.push(`${where}: fit must be cover or contain`);
        break;
      case 'url':
        if (!safeUrl(spot.url)) errors.push(`${where} needs an absolute https URL`);
        break;
      default:
        errors.push(`${where}: kind must be template, image, video or url`);
    }
  }

  if (m.brand !== undefined) {
    errors.push(...prefix('brand', validateBrandKit(m.brand)));
    // Read leniently, so a brand file that is not listed is reported even when the kit has other problems.
    const fonts = [own(own(m.brand, 'fonts'), 'display'), own(own(m.brand, 'fonts'), 'body')].flatMap((f) => {
      const files = own(f, 'files');
      return Array.isArray(files) ? files.map((x) => own(x, 'file')) : [];
    });
    const logo = own(m.brand, 'logo');
    for (const sha of [...fonts, own(logo, 'onDark'), own(logo, 'onLight')]) if (isText(sha)) referenced.add(sha);
  }

  for (const sha of referenced) if (!own(files, sha)) errors.push(`file ${sha.slice(0, 12)} is referenced but not listed`);

  for (const e of schedule as unknown[]) {
    if (!isObj(e)) {
      errors.push('a schedule entry is not an object');
      continue;
    }
    const where = `schedule entry "${show(e.id)}"`;
    if (!isIdValue(e.id)) errors.push(`schedule entry id "${show(e.id)}" is not a valid id`);
    if (!isNum(e.priority)) errors.push(`${where}: priority must be a number`);
    if (e.target !== 'org' && e.target !== 'group' && e.target !== 'screen') errors.push(`${where}: target must be org, group or screen`);
    if (!own(playlists, e.playlist)) errors.push(`${where} plays unknown playlist "${show(e.playlist)}"`);
    errors.push(...windowProblems(where, e, false));
    for (const k of ['startsAt', 'endsAt'] as const) if (e[k] !== undefined && !isInstant(e[k])) errors.push(`${where}: ${k} must be an ISO 8601 time`);
    if (isInstant(e.startsAt) && isInstant(e.endsAt) && !(Date.parse(e.endsAt) > Date.parse(e.startsAt)))
      errors.push(`${where}: endsAt must be after startsAt`);
  }

  for (const [key, p] of Object.entries(playlists)) {
    if (!isObj(p)) {
      errors.push(`playlist "${key}" is not an object`);
      continue;
    }
    if (p.id !== key) errors.push(`playlist "${key}" is listed under a different id ("${show(p.id)}")`);
    if (!isIdValue(key)) errors.push(`playlist id "${key}" is not a valid id`);
    const tr = p.transition;
    const okMs = (ms: unknown) => isNum(ms) && ms >= 1 && ms <= 10_000;
    if (!isObj(tr) || !(tr.type === 'cut' || ((tr.type === 'fade' || tr.type === 'crossfade') && okMs(tr.ms)))) {
      errors.push(`playlist "${key}": transition must be cut, fade or crossfade with ms between 1 and 10000`);
    }
    if (!Array.isArray(p.items)) {
      errors.push(`playlist "${key}" has no items list`);
      continue;
    }
    for (const item of p.items as unknown[]) {
      const s = own(item, 'spot');
      if (!own(spots, s)) errors.push(`playlist "${key}" lists unknown spot "${show(s)}"`);
    }
  }

  for (const [key, d] of Object.entries(dataSources)) {
    if (own(d, 'id') !== key) errors.push(`data source "${key}" is listed under a different id ("${show(own(d, 'id'))}")`);
    if (!isIdValue(key)) errors.push(`data source id "${key}" is not a valid id`);
    const r = own(d, 'refreshS');
    if (!(isNum(r) && r >= MIN_REFRESH_S)) errors.push(`data source "${key}": refreshS must be at least ${MIN_REFRESH_S}`);
  }
  return errors;
}

// ------------------------------------------------------------------ live data

/** The size `MAX_SNAPSHOT_BYTES` caps: `data` as JSON, in UTF-8. Undefined (not JSON) counts as 0. */
export function snapshotBytes(data: unknown): number {
  return new TextEncoder().encode(JSON.stringify(data) ?? '').length;
}

/** Check a data snapshot, as `data/<id>.json` and a sync response carry it. */
export function validateDataSnapshot(s: unknown): string[] {
  if (!isObj(s)) return ['snapshot is not an object'];
  const errors: string[] = [];
  if (!isIdValue(s.id)) errors.push(`snapshot id "${show(s.id)}" is not a valid id`);
  if (!isCount(s.version)) errors.push('snapshot version must be a whole number, 0 or more');
  if (!isInstant(s.fetchedAt)) errors.push('snapshot fetchedAt must be an ISO 8601 time');
  if (!isInstant(s.checkedAt)) errors.push('snapshot checkedAt must be an ISO 8601 time');
  if (!Object.hasOwn(s, 'data')) errors.push('snapshot has no data');
  else if (snapshotBytes(s.data) > MAX_SNAPSHOT_BYTES) errors.push(`snapshot data is over ${MAX_SNAPSHOT_BYTES} bytes as JSON`);
  return errors;
}

// ------------------------------------------------------------------ device API

/** `POST /v1/device/pair/start`, as the server receives it. */
export function validatePairStartRequest(r: unknown): string[] {
  if (!isObj(r)) return ['request is not an object'];
  if (r.kind !== undefined && !SCREEN_KINDS.some((k) => k === r.kind)) return [`kind must be one of ${SCREEN_KINDS.join(', ')}`];
  return [];
}

/** `POST /v1/device/pair/start`, as the screen receives it. */
export function validatePairStartResponse(r: unknown): string[] {
  if (!isObj(r)) return ['response is not an object'];
  const errors: string[] = [];
  if (!isText(r.code)) errors.push('code is missing');
  if (!isText(r.pollToken)) errors.push('pollToken is missing');
  if (!isInstant(r.expiresAt)) errors.push('expiresAt must be an ISO 8601 time');
  return errors;
}

/** `POST /v1/device/pair/poll`, as the screen receives it. */
export function validatePairPollResponse(r: unknown): string[] {
  if (!isObj(r)) return ['response is not an object'];
  if (r.status === 'waiting' || r.status === 'expired') return [];
  if (r.status !== 'paired') return ['status must be waiting, expired or paired'];
  const errors: string[] = [];
  if (!isIdValue(r.screenId)) errors.push('screenId is not a valid id');
  else if (!isStr(r.credential) || !r.credential.startsWith(`sfd_${r.screenId}.`) || r.credential.length <= `sfd_${r.screenId}.`.length) {
    errors.push('credential must be sfd_<screenId>.<secret>');
  }
  return errors;
}

function overrideProblems(o: unknown): string[] {
  if (!isObj(o)) return ['override must be an object'];
  const errors: string[] = [];
  if (o.state !== 'on' && o.state !== 'off') errors.push('override state must be on or off');
  if (!isInstant(o.until)) errors.push('override until must be an ISO 8601 time');
  return errors;
}

/** One command from the server, in a sync response or over the socket. */
export function validateDeviceCommand(c: unknown): string[] {
  if (!isObj(c)) return ['command is not an object'];
  if (c.type === 'reload' || c.type === 'restart' || c.type === 'reboot') return [];
  if (c.type === 'display') return c.override === null ? [] : overrideProblems(c.override);
  if (c.type === 'identify') {
    const errors: string[] = [];
    if (!isStr(c.name) || !c.name.trim() || c.name.length > 100) errors.push('identify needs the name to show, 1 to 100 characters');
    if (!Number.isInteger(c.seconds) || (c.seconds as number) < 1 || (c.seconds as number) > MAX_IDENTIFY_SECONDS)
      errors.push(`identify seconds must be a whole number from 1 to ${MAX_IDENTIFY_SECONDS}`);
    return errors;
  }
  return ['command type must be reload, restart, display, identify or reboot'];
}

function displayStatusProblems(d: unknown): string[] {
  if (!isObj(d)) return ['display must be an object'];
  const errors: string[] = [];
  if (typeof d.on !== 'boolean') errors.push('display on must be true or false');
  if (d.methods !== undefined && !(isObj(d.methods) && Object.values(d.methods).every(isStr))) errors.push('display methods must map names to text');
  if (d.override !== undefined) errors.push(...prefix('display', overrideProblems(d.override)));
  return errors;
}

/** The start of an hour in UTC, as play counts are keyed: `2026-11-17T13:00Z`. */
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}:00(?::00(?:\.000)?)?Z$/;

function playCountProblems(p: unknown): string[] {
  if (!isObj(p)) return ['is not an object'];
  const errors: string[] = [];
  if (!isStr(p.hour) || !HOUR.test(p.hour) || Number.isNaN(Date.parse(p.hour))) errors.push('hour must be the start of a UTC hour, e.g. 2026-11-17T13:00Z');
  if (!isIdValue(p.spot)) errors.push('spot is not a valid id');
  if (!isCount(p.plays)) errors.push('plays must be a whole number, 0 or more');
  if (!isNum(p.ms) || p.ms < 0) errors.push('ms must be 0 or more');
  return errors;
}

/**
 * A sync's map of source id to a count, checked entry by entry but reported as one problem at
 * most: a player before gh-45 sends every source it has seen, so one cause must not make a
 * problem per entry. The size of the work is bounded by `MAX_SYNC_REQUEST_BYTES`.
 */
function sourceMapProblems(name: string, map: Obj, what: string): string[] {
  const bad = Object.keys(map).filter((k) => !isIdValue(k) || !isCount(own(map, k)));
  if (!bad.length) return [];
  return [`${name}: "${show(bad[0])}" must be a source id with ${what}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}`];
}

const versions = (v: unknown) => Array.isArray(v) && v.every((n) => Number.isSafeInteger(n));

/** `POST /v1/device/sync`, as the server receives it. */
export function validateSyncRequest(r: unknown): string[] {
  if (!isObj(r)) return ['request is not an object'];
  const errors: string[] = [];
  if (!isCount(r.seq)) errors.push('seq must be a whole number, 0 or more');
  if (!isIdValue(r.epoch)) errors.push('epoch must be a valid id');
  const p = r.player;
  if (!isObj(p) || !isText(p.version) || !versions(p.manifestSchemas) || !versions(p.protocols)) {
    errors.push('player needs a version and the manifest schemas and protocols it supports');
  }
  const m = r.manifest;
  const optionalId = (k: string) => own(m, k) === undefined || isManifestId(own(m, k));
  if (!isObj(m) || !optionalId('active') || !optionalId('fallbackFrom') || !optionalId('lastGood') || !isCount(m.filesMissing))
    errors.push('manifest needs filesMissing, and active, fallbackFrom and lastGood when there are any, as sha256 ids');
  errors.push(...displayStatusProblems(r.display));
  if (!isInstant(r.deviceTime)) errors.push('deviceTime must be an ISO 8601 time');
  if (!isObj(r.clock) || !isNum(r.clock.offsetMs) || typeof r.clock.trusted !== 'boolean') errors.push('clock needs offsetMs and whether the screen trusts it');
  errors.push(...list('play count', r.playCounts, playCountProblems));
  if (Array.isArray(r.playCounts) && r.playCounts.length > MAX_SYNC_PLAY_COUNTS) errors.push(`playCounts holds at most ${MAX_SYNC_PLAY_COUNTS} counts`);
  if (!isObj(r.snapshots)) errors.push('snapshots must map source ids to versions');
  else errors.push(...sourceMapProblems('snapshots', r.snapshots, 'a version number'));
  if (r.dataRejected !== undefined) {
    if (!isObj(r.dataRejected)) errors.push('dataRejected must map source ids to counts');
    else errors.push(...sourceMapProblems('dataRejected', r.dataRejected, 'a count'));
  }
  return errors;
}

/** `POST /v1/device/sync`, as the screen receives it. */
export function validateSyncResponse(r: unknown): string[] {
  if (!isObj(r)) return ['response is not an object'];
  const errors: string[] = [];
  if (!isInstant(r.serverTime)) errors.push('serverTime must be an ISO 8601 time');
  if (!isNum(r.nextSyncS) || r.nextSyncS <= 0) errors.push('nextSyncS must be above 0');
  if (!isIdValue(r.epoch)) errors.push('epoch must be a valid id');
  if (!isCount(r.ackSeq)) errors.push('ackSeq must be a whole number, 0 or more');
  if (r.desiredManifest !== undefined && !isText(r.desiredManifest)) errors.push('desiredManifest must be a manifest id when present');
  errors.push(...list('snapshot', r.snapshots, validateDataSnapshot));
  if (r.checked !== undefined) {
    if (!isObj(r.checked)) errors.push('checked must map source ids to a version and checkedAt');
    else
      for (const [k, v] of Object.entries(r.checked))
        if (!isIdValue(k) || !isCount(own(v, 'version')) || !isInstant(own(v, 'checkedAt')))
          errors.push(`checked: "${k}" must be a source id with a version and checkedAt`);
  }
  if (!isText(r.socketTicket)) errors.push('socketTicket is missing');
  errors.push(...list('command', r.commands, validateDeviceCommand));
  return errors;
}

/** A socket message from the server, as the screen receives it. */
export function validateServerSocketMessage(msg: unknown): string[] {
  if (!isObj(msg)) return ['message is not an object'];
  switch (msg.type) {
    case 'manifest':
      return isText(msg.id) ? [] : ['manifest message needs an id'];
    case 'command':
      return validateDeviceCommand(msg.command);
    case 'revoked':
      return [];
    default:
      return ['message type must be manifest, command or revoked'];
  }
}

/** A socket message from a screen, as the server receives it. */
export function validateDeviceSocketMessage(msg: unknown): string[] {
  if (!isObj(msg)) return ['message is not an object'];
  if (msg.type !== 'applied') return ['message type must be applied'];
  return isManifestId(msg.manifest) ? [] : ['applied message needs a sha256 manifest id'];
}

// ------------------------------------------------------------- preview channel

const isBlob = (v: unknown) => typeof Blob !== 'undefined' && v instanceof Blob;

/** A message from the CMS page, as the preview player receives it (after its origin check). */
export function validatePreviewHostMessage(msg: unknown): string[] {
  if (!isObj(msg)) return ['message is not an object'];
  if (msg.sfPreview !== PREVIEW_PROTOCOL) return [`preview protocol ${show(msg.sfPreview)} is not ${PREVIEW_PROTOCOL}`];
  if (msg.type !== 'draft') return ['message type must be draft'];
  const errors = prefix('draft manifest', validateManifest(msg.manifest));
  if (msg.files !== undefined) {
    if (!isObj(msg.files)) errors.push('files must be an object of hash to Blob');
    else
      for (const [sha, blob] of Object.entries(msg.files)) {
        if (own(own(msg.manifest, 'files'), sha) === undefined) errors.push(`file "${sha.slice(0, 12)}" is not a file of the manifest`);
        else if (!isBlob(blob)) errors.push(`file "${sha.slice(0, 12)}" is not a Blob`);
      }
  }
  if (msg.data !== undefined) errors.push(...list('snapshot', msg.data, validateDataSnapshot));
  return errors;
}

// ------------------------------------------------------------- template bundle

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
  const authored = Object.values(sources)
    .map((text) => text.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, ''))
    .join('\n');
  const source = Object.keys(sources).length ? matches(FORBIDDEN_TEMPLATE_CODE, authored) : ['no source files were given'];

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
  return { ok: checks.every((c) => c.ok), bundleBytes, checks, warnings: brandColourWarnings(sources) };
}
