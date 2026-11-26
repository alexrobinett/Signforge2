/**
 * Draft to spot: a spot's draft, as the spot tools give it (`get_spot`), turned into the
 * contract's `Spot` for one orientation, and the probe screen a draft is checked on. The publish
 * (packages/tools `promoteDrafts`) and the CMS's stage both call it, so what the stage plays is
 * what a publish sends, and a draft the publish refuses is refused on the stage for the same reason.
 *
 * What it reads is the seam (`DraftReads`): the tools read the org's rows, the CMS its asset and
 * template views.
 */
import {
  liveSources,
  PORTRAIT_BOX_UPSCALE,
  type SampleFields,
  type Binding,
  type DataSource,
  type FieldDef,
  type ListItemFieldDef,
  type Orientation,
  type ScalarFieldDef,
  type Playlist,
  type ScreenManifest,
  type Sha256,
  type Spot,
  type TableMapping,
  type TemplateManifest,
} from '@signforge/contract';
import { compileScreen, type CompileInput, type CompileOptions, type TargetedEntry } from './index';

type Fit = 'cover' | 'contain';

/** What an image or video plays at when its draft does not say. */
export const DEFAULT_FIT: Fit = 'cover';

/** A binding as the spot tools take and give it. */
export interface DraftBinding {
  dataSourceId: string;
  path: string;
  table?: TableMapping;
}

type DateDef = Extract<ScalarFieldDef, { type: 'date' | 'datetime' }>;
const isDate = (def: FieldDef): def is DateDef => def.type === 'date' || def.type === 'datetime';
/** A date or datetime with no value yet: `''` (what a picker holds), or left out with no default. */
const unpicked = (def: DateDef, v: unknown) => v === '' || (v ?? def.default) === undefined;

/**
 * What a template draft's save is checked against: the template's fields and the draft's data,
 * less what a draft may leave without a value for now. No start value fits every spot for those (a
 * photo, a countdown's target), so a new spot or row is saved without one, and the publish holds
 * the spot back in the contract's words ("has no asset", "has no date yet") until it has one:
 *  - an image with no asset (nor binding) yet;
 *  - a date or datetime not picked yet, unless it is bound: a bound field needs its fallback;
 *  - the same in a list row, checked with a value its field takes in that cell's place, so the
 *    rest of the row is still checked.
 * Every other value must be one a screen takes.
 */
export function draftCheck(
  fields: Record<string, FieldDef>,
  draft: { data: Record<string, unknown>; assets: Record<string, string>; bindings: Record<string, unknown> },
): { fields: Record<string, FieldDef>; data: Record<string, unknown> } {
  const checked: Record<string, FieldDef> = {};
  // Data for no field stays, so the check names it.
  const data: Record<string, unknown> = Object.fromEntries(Object.entries(draft.data).filter(([name]) => !Object.hasOwn(fields, name)));
  for (const [name, def] of Object.entries(fields)) {
    const v = draft.data[name];
    const bound = name in draft.bindings;
    if (def.type === 'image' ? !(name in draft.assets || bound) : isDate(def) && !bound && unpicked(def, v)) continue;
    checked[name] = def;
    if (v !== undefined) data[name] = def.type === 'list' && Array.isArray(v) ? v.map((row: unknown) => rowChecked(def.item, row)) : v;
  }
  return { fields: checked, data };
}

/** A list row with each unpicked date or datetime in it replaced by a value its field takes (its min, else its max, else 1900). */
function rowChecked(item: Record<string, ListItemFieldDef>, row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const cells: Record<string, unknown> = { ...row };
  for (const [k, d] of Object.entries(item))
    if (isDate(d) && unpicked(d, cells[k])) cells[k] = d.min ?? d.max ?? (d.type === 'date' ? '1900-01-01' : '1900-01-01T00:00');
  return cells;
}

/** A value for a field with no default yet: a new list row's, or a new spot's. */
export function startValue(d: ScalarFieldDef): unknown {
  if (d.default !== undefined) return d.default;
  switch (d.type) {
    case 'text':
    case 'url':
      return '';
    case 'number':
      return d.min ?? 0;
    case 'boolean':
      return false;
    case 'color':
      return '#ffffff';
    case 'select':
      return d.options[0];
    case 'date':
    case 'datetime':
      // No day is right for every template (a countdown's target, an event's start): without a `min`, the editor asks for one.
      return d.min ?? '';
  }
}

/**
 * A new spot's data as the agent's fill (#263) starts it, and under `sampleData` New spot's: a value
 * for each field the template gives no default, so the draft starts valid but for a date to pick.
 * Text and lists start empty whatever their default: a template's defaults are sample copy for its
 * preview ("Pier 9 opens on Monday"), which only New spot starts with, marked (#360). Other defaults
 * are settings, and stand.
 */
export const startData = (fields: Record<string, FieldDef>) =>
  Object.fromEntries(
    Object.entries(fields).flatMap(([name, def]) =>
      def.type === 'list'
        ? [[name, []]]
        : def.type === 'text'
          ? [[name, '']]
          : def.type === 'image' || def.default !== undefined
            ? []
            : [[name, startValue(def)]],
    ),
  );

/**
 * A text or list field's sample (#360): the template's own default, the copy its thumbnail shows;
 * a text with none stands in with its label, as the thumbnail does (an empty default stands: a
 * clock's greeting left empty greets by the time of day). A list with no default stays
 * empty: stand-in rows would be someone's content to delete, and three of them put Announcement's
 * stage past the player's 2 s ready time on a laptop. Undefined for every other field, which starts
 * as `startData` starts it. The editor marks a value equal to its sample until it is replaced.
 */
export function sampleValue(def: FieldDef): unknown {
  if (def.type === 'text') return (def.default ?? def.label).slice(0, def.maxLength);
  if (def.type === 'list') return def.default ?? [];
  return undefined;
}

/**
 * A new spot's data as `create_spot`'s `sample` starts it for New spot (#360): `startData`, with
 * each text and list holding its sample, so the stage plays at once and the person edits rather
 * than writes. This reverses #253's empty text for the dialog only; the server records the fields
 * (`sampleFieldsOf`), the editor marks them, and a publish refuses them unless a person allows it. A live field keeps `startData`'s value: it is the fallback screens show
 * when its source is down, which the form does not draw while bound, so a sample there would reach
 * screens unseen (#253's headlines). The agent's fill keeps `startData`: it writes the copy itself.
 */
export function sampleData(m: Pick<TemplateManifest, 'fields' | 'live'>): Record<string, unknown> {
  const live = new Set(m.live ? Object.values(liveSources(m.live)).flatMap((source) => Object.keys(source.fields)) : []);
  return {
    ...startData(m.fields),
    ...Object.fromEntries(
      Object.entries(m.fields).flatMap(([name, def]) => ((def.type === 'text' || def.type === 'list') && !live.has(name) ? [[name, sampleValue(def)]] : [])),
    ),
  };
}

/**
 * The fields `sampleData` filled with sample copy (#360), as the contract's `SampleFields`: each text
 * holding words, and each list's rows, every cell but an image's: only a feed fills one, and the form
 * has no edit for it, so a mark there could never be cleared (review of #240). A live field starts
 * empty, so none is. Null for none.
 */
export function sampleFieldsOf(m: Pick<TemplateManifest, 'fields'>, data: Record<string, unknown>): SampleFields | null {
  const sample: SampleFields = { texts: [], lists: {} };
  for (const [name, def] of Object.entries(m.fields)) {
    const v = data[name];
    if (def.type === 'text' && typeof v === 'string' && v !== '') sample.texts.push(name);
    if (def.type === 'list' && Array.isArray(v) && v.length) {
      const cells = Object.entries(def.item).flatMap(([k, d]) => (d.type === 'image' ? [] : [k]));
      sample.lists[name] = v.map(() => cells);
    }
  }
  return compactSample(sample);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const rowsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const cell = (row: unknown, key: string): unknown => (row && typeof row === 'object' ? Object.entries(row).find(([k]) => k === key)?.[1] : undefined);

/** Null for nothing left: a list's rows with no cell left, a list with no row left, no field left. */
function compactSample(s: SampleFields): SampleFields | null {
  const lists = Object.fromEntries(Object.entries(s.lists).filter(([, rows]) => rows.some((r) => r.length > 0)));
  return s.texts.length || Object.keys(lists).length ? { texts: s.texts, lists } : null;
}

/** A field's value as screens get it: its own, else its default, as the compiler fills it. */
const withDefault = (value: unknown, def: FieldDef | undefined) => value ?? (def && 'default' in def ? def.default : undefined);

/**
 * What is left of a draft's sample fields after a saved edit from `before` to `after` (#360). Each
 * field, and each list cell, is compared as screens get it, its template default standing in for a
 * value left out: a text bound now, or showing other words, is out. A list bound now is out;
 * otherwise rows now are paired with the sample rows before, the pairs that still hold the most
 * marked cells first, then a row whose marked cells all hold, then one that stayed where it was,
 * wherever the rows moved: a row added beside a sample row, sharing a cell with it, never takes
 * its marks. A row keeps the marks on the cells it still holds; one with none, new or rewritten,
 * has none. Null for nothing left.
 */
export function sampleAfterEdit(
  sample: SampleFields,
  fields: Record<string, FieldDef>,
  before: { data: Record<string, unknown> },
  after: { data: Record<string, unknown>; bindings: Record<string, unknown> },
): SampleFields | null {
  const shown = (data: Record<string, unknown>, f: string) => withDefault(data[f], fields[f]);
  const texts = sample.texts.filter((f) => !(f in after.bindings) && same(shown(before.data, f), shown(after.data, f)));
  const lists: Record<string, string[][]> = {};
  for (const [f, rows] of Object.entries(sample.lists)) {
    if (f in after.bindings) continue;
    const def = fields[f];
    const item = def?.type === 'list' ? def.item : {};
    const at = (row: unknown, k: string) => withDefault(cell(row, k), item[k]);
    const was = rowsOf(shown(before.data, f));
    const now = rowsOf(shown(after.data, f));
    const pairs = now
      .flatMap((row, i) =>
        rows.map((keys, j) => {
          const held = keys.filter((k) => same(at(was[j], k), at(row, k)));
          return { i, j, held, whole: held.length === keys.length, still: i === j };
        }),
      )
      .filter((p) => p.held.length > 0)
      .sort((a, b) => b.held.length - a.held.length || Number(b.whole) - Number(a.whole) || Number(b.still) - Number(a.still));
    const marks: string[][] = now.map(() => []);
    const placed = new Set<number>();
    const taken = new Set<number>();
    for (const p of pairs) {
      if (placed.has(p.i) || taken.has(p.j)) continue;
      marks[p.i] = p.held;
      placed.add(p.i);
      taken.add(p.j);
    }
    lists[f] = marks;
  }
  return compactSample({ texts, lists });
}

/** A spot's draft (or published version), as `get_spot` gives it. */
export interface SpotDraft {
  id: string;
  name: string;
  kind: 'template' | 'image' | 'video' | 'url';
  durationMs: number;
  templateVersionId: string | null;
  data: Record<string, unknown> | null;
  /** Image fields to asset ids. */
  assets: Record<string, string> | null;
  bindings: Record<string, DraftBinding> | null;
  assetId: string | null;
  fit: Fit | null;
  url: string | null;
}

/** An uploaded asset: a video plays its own file, an image the rendition for the screen's orientation. */
export interface DraftAsset {
  kind: 'image' | 'video';
  /** Only a verified asset publishes. */
  status: 'pending' | 'verified' | 'rejected';
  sha256: Sha256;
  size: number;
  type: string;
  /** `width` and `height` are null for an SVG, which is one file for both. */
  renditions: {
    orientation: Orientation;
    sha256: Sha256;
    size: number;
    type: string;
    width: number | null;
    height: number | null;
    sample: { sha256: Sha256; size: number } | null;
  }[];
}

/** A template version: its key, manifest and bundle. A draft version plays on no screen. */
export interface DraftTemplate {
  key: string;
  manifest: TemplateManifest;
  html: Sha256;
  size: number;
  status: 'draft' | 'approved' | 'retired';
}

/** What turning a draft into a spot reads, by id; undefined for one the org does not have. */
export interface DraftReads {
  asset(id: string): DraftAsset | undefined;
  templateVersion(id: string): DraftTemplate | undefined;
}

/** A binding as a screen reads it. */
export const bindingOf = (b: DraftBinding): Binding => ({ source: b.dataSourceId, path: b.path, ...(b.table ? { table: b.table } : {}) });

/** Why an asset cannot be used yet, in the words every refusal uses; undefined once it is verified. */
export const unverified = (assetId: string, status: DraftAsset['status']): string | undefined =>
  status === 'pending' ? `asset ${assetId} is still being checked` : status === 'rejected' ? `asset ${assetId} was rejected` : undefined;

/**
 * The file an asset plays as on a screen of this orientation, added to `files` with its sample
 * when it has one, or why there is none. Only a verified asset has one: until `finalize_upload` checks an upload, its files are not
 * where screens, or the stage, read them. In portrait, with the `portraitBox` its field declares, the
 * landscape rendition when it has fewer pixels and covers that box drawn at most
 * `PORTRAIT_BOX_UPSCALE` times its size (#224): a photo in a frame needs no copy that covers the
 * whole portrait screen, 3.2 times the pixels of a 16:9 photo's landscape one.
 */
export function assetFile(
  reads: Pick<DraftReads, 'asset'>,
  assetId: string,
  orientation: Orientation,
  files: CompileInput['files'],
  portraitBox?: { w: number; h: number },
): { sha?: Sha256; problem?: string } {
  const a = reads.asset(assetId);
  if (!a) return { problem: `asset ${assetId} does not exist` };
  const problem = unverified(assetId, a.status);
  if (problem) return { problem };
  if (a.kind === 'video') {
    files[a.sha256] = { size: a.size, type: a.type };
    return { sha: a.sha256 };
  }
  const own = a.renditions.find((x) => x.orientation === orientation);
  if (!own) return { problem: `asset ${assetId} has no ${orientation} rendition` };
  const wide = a.renditions.find((x) => x.orientation === 'landscape');
  const coversWithFewer =
    !!wide?.width &&
    !!wide.height &&
    !!own.width &&
    !!own.height &&
    !!portraitBox &&
    wide.width * PORTRAIT_BOX_UPSCALE >= portraitBox.w &&
    wide.height * PORTRAIT_BOX_UPSCALE >= portraitBox.h &&
    wide.width * wide.height < own.width * own.height;
  const r = orientation === 'portrait' && wide && coversWithFewer ? wide : own;
  files[r.sha256] = { size: r.size, type: r.type, ...(r.sample ? { sample: r.sample.sha256 } : {}) };
  if (r.sample) files[r.sample.sha256] = { size: r.sample.size, type: 'image/png' };
  return { sha: r.sha256 };
}

/**
 * A draft as the contract's `Spot` for one orientation, with no problems; or, when it cannot be
 * one, why. The template and files it uses are added to `into`. A spot's data is checked when it
 * is compiled (`compileProbe`).
 */
export function spotFromDraft(
  draft: SpotDraft,
  orientation: Orientation,
  reads: DraftReads,
  into: Pick<CompileInput, 'files' | 'templates'>,
): { spot?: Spot; problems: string[] } {
  const base = { id: draft.id, name: draft.name, durationMs: draft.durationMs };
  const problems: string[] = [];
  const file = (assetId: string, portraitBox?: { w: number; h: number }) => {
    const f = assetFile(reads, assetId, orientation, into.files, portraitBox);
    if (f.problem) problems.push(f.problem);
    return f.sha ?? '';
  };
  let spot: Spot;
  if (draft.kind === 'template') {
    const v = draft.templateVersionId ? reads.templateVersion(draft.templateVersionId) : undefined;
    if (!v) return { problems: [`template version ${draft.templateVersionId} does not exist`] };
    // A screen never gets a draft version; the publish refuses a spot on one with these words too.
    if (v.status === 'draft') return { problems: [`template ${v.key} is draft; only an approved version can be published`] };
    into.templates[v.key] = { manifest: v.manifest, html: v.html };
    into.files[v.html] = { size: v.size, type: 'text/html' };
    const assets = Object.fromEntries(
      Object.entries(draft.assets ?? {}).map(([field, id]) => {
        const def = v.manifest.fields[field];
        return [field, file(id, def?.type === 'image' ? def.portraitBox : undefined)];
      }),
    );
    const bindings = Object.entries(draft.bindings ?? {}).map(([field, b]) => [field, bindingOf(b)] as const);
    spot = {
      ...base,
      kind: 'template',
      template: v.key,
      data: draft.data ?? {},
      assets,
      ...(bindings.length ? { bindings: Object.fromEntries(bindings) } : {}),
    };
  } else if (draft.kind === 'image' || draft.kind === 'video') {
    if (!draft.assetId) return { problems: ['no asset'] };
    spot = { ...base, kind: draft.kind, file: file(draft.assetId), fit: draft.fit ?? DEFAULT_FIT };
  } else {
    spot = { ...base, kind: 'url', url: draft.url ?? '' };
  }
  return problems.length ? { problems } : { spot, problems };
}

/** The probe screen's id, and the id of the playlist it plays when it is given none. */
const PROBE = 'draft-check';

/** A probe screen: what it plays and what it has besides. */
export interface Probe {
  orientation: Orientation;
  timezone: string;
  /** The drafts it plays. */
  spots: SpotDraft[];
  /** The playlist it plays; absent, one playing each of `spots` once, in order. */
  playlist?: Playlist;
  /** A schedule entry's draft, played as an org-wide entry. */
  entry?: TargetedEntry;
  dataSources: DataSource[];
  brand?: CompileInput['brand'];
  /** Files beyond the drafts' own: a brand kit's. */
  files?: CompileInput['files'];
}

/**
 * Compile a probe screen playing drafts, as a screen reaching them would get them: the manifest,
 * or why a publish refuses them, each problem prefixed with where it is. A draft that cannot be
 * a spot compiles nothing (`refused`): its problems are all there is to say, and none is about
 * its data.
 */
export async function compileProbe(
  probe: Probe,
  reads: DraftReads,
  opts: CompileOptions,
): Promise<{ manifest?: ScreenManifest; problems: string[]; refused: boolean }> {
  const into: Pick<CompileInput, 'files' | 'templates'> = { templates: {}, files: { ...probe.files } };
  const spots: Spot[] = [];
  const problems: string[] = [];
  for (const d of probe.spots) {
    const r = spotFromDraft(d, probe.orientation, reads, into);
    problems.push(...r.problems.map((p) => `spot ${d.id}: ${p}`));
    if (r.spot) spots.push(r.spot);
  }
  if (problems.length) return { problems, refused: true };
  const playlist = probe.playlist ?? { id: PROBE, name: PROBE, transition: { type: 'cut' }, items: probe.spots.map((s) => ({ spot: s.id })) };
  const result = await compileScreen(
    {
      screen: { id: PROBE, name: 'Draft check', timezone: probe.timezone, orientation: probe.orientation },
      groups: [],
      ...into,
      spots,
      playlists: [playlist],
      dataSources: probe.dataSources,
      schedule: probe.entry ? [{ ...probe.entry, target: 'org', targetId: undefined }] : [],
      defaultPlaylist: playlist.id,
      ...(probe.brand ? { brand: probe.brand } : {}),
    },
    opts,
  );
  return { ...result, refused: false };
}
