/**
 * The manifest compiler: an org's content plus one screen in, that screen's `ScreenManifest`
 * out. Pure, with no I/O, so the server's publish and the local `sf build` share it and cannot
 * drift. Files are already uploaded and hashed by the time content reaches it; image scaling
 * and video checks happen at upload.
 *
 * It checks only what it compiles: the spots this screen's schedule reaches. Content no screen
 * reaches is a draft's business, checked when a publish promotes it (packages/tools
 * `promoteDrafts`) and shown in the CMS, so one broken spot never blocks another screen.
 */
import {
  type BrandColors,
  type BrandKit,
  type FieldDef,
  MANIFEST_SCHEMA,
  manifestIdInput,
  requiredFiles,
  validateManifest,
  validateSpotData,
  type DataSource,
  type Playlist,
  type ScheduleEntry,
  type ScreenManifest,
  type Sha256,
  type Spot,
  type TemplateManifest,
} from '@signforge/contract';
import { chooseBrandKit, DEFAULT_BRAND_COLORS, isBrandColor, tokenName, type BrandChoice } from './brand';

export * from './brand';
export { FONTS, fontById, MAX_FONT_FAMILY_BYTES, type CatalogueFont } from './fonts';

/** A schedule entry as the org stores it: its target level plus which group or screen it targets. */
export type TargetedEntry = ScheduleEntry & {
  /** The group or screen id for `group` and `screen` entries; unused for `org`. */
  targetId?: string;
};

export interface CompileInput {
  screen: ScreenManifest['screen'];
  /** Groups the screen belongs to, for group-targeted schedule entries. */
  groups: string[];
  /** Template versions the org may use, by key. */
  templates: Record<string, { manifest: TemplateManifest; html: Sha256 }>;
  /** Every uploaded file a spot or template may refer to. */
  files: Record<Sha256, { size: number; type: string }>;
  /** Template spots may leave fields out; their defaults are filled in here. */
  spots: Spot[];
  playlists: Playlist[];
  dataSources: DataSource[];
  schedule: TargetedEntry[];
  defaultPlaylist: string;
  /**
   * The brand kits this screen may get and its choices (./brand.ts). Absent, or no kit chosen:
   * the manifest carries no brand, and token defaults take `DEFAULT_BRAND_COLORS`.
   */
  brand?: BrandChoice & { kits: Record<string, BrandKit> };
}

export interface CompileOptions {
  /** Lowercase hex SHA-256 of a string. Node's `crypto` and Web Crypto are both fine. */
  hash: (text: string) => string | Promise<string>;
  now: Date;
}

export interface CompileResult {
  /** Absent when there are problems: nothing unplayable is ever published. */
  manifest?: ScreenManifest;
  /** Each prefixed with where it is, e.g. `spot deal: ...` or `manifest: ...`. */
  problems: string[];
}

/** A field's value with a brand token (`"$brand.accent"`) replaced by the colour it names. */
const resolve = (def: FieldDef, value: unknown, colors: BrandColors): unknown => {
  const name = def.type === 'color' ? tokenName(value) : undefined;
  return name && isBrandColor(name) ? colors[name] : value;
};

/**
 * Every field filled in, so the player never needs the template's field schema, and every brand
 * token resolved, so a screen only ever receives values. A spot's own value is kept as it is.
 */
function withDefaults(spot: Extract<Spot, { kind: 'template' }>, t: TemplateManifest | undefined, colors: BrandColors): Spot {
  if (!t) return spot;
  const data: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(t.fields)) {
    if (def.type === 'list') {
      const rows = (spot.data[name] ?? def.default ?? []) as Record<string, unknown>[];
      data[name] = rows.map((row) => Object.fromEntries(Object.entries(def.item).map(([k, d]) => [k, resolve(d, row[k] ?? d.default, colors)])));
    } else if (def.type !== 'image') data[name] = resolve(def, spot.data[name] ?? def.default, colors);
  }
  return { ...spot, data };
}

/** Tokens, in a template's defaults or a spot's values, that name no brand colour. */
function tokenProblems(t: TemplateManifest, data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const check = (where: string, def: FieldDef, value: unknown, verb: string) => {
    const name = def.type === 'color' ? tokenName(value) : undefined;
    if (name && !isBrandColor(name)) out.push(`field "${where}" ${verb} $brand.${name}, which is not a brand colour`);
  };
  for (const [name, def] of Object.entries(t.fields)) {
    if (def.type === 'list') {
      for (const [k, d] of Object.entries(def.item)) check(`${name}.${k}`, d, d.default, 'defaults to');
      const rows = Array.isArray(data[name]) ? (data[name] as unknown[]) : [];
      rows.forEach((row, i) => {
        if (row && typeof row === 'object')
          for (const [k, d] of Object.entries(def.item)) check(`${name}[${i}].${k}`, d, (row as Record<string, unknown>)[k], 'is');
      });
    } else {
      check(name, def, 'default' in def ? def.default : undefined, 'defaults to');
      check(name, def, data[name], 'is');
    }
  }
  return out;
}

/**
 * What stops a template spot from playing: a missing template, a bad duration, bad data. Exported
 * for checks of content no screen reaches yet: `sf build` and the publish's draft checks.
 */
export function spotProblems(spot: Spot, templates: CompileInput['templates']): string[] {
  if (spot.kind !== 'template') return [];
  const t = templates[spot.template]?.manifest;
  if (!t) return [`template ${spot.template} is not available`];
  const out = [...validateSpotData(t.fields, spot.data, spot.assets, spot.bindings), ...tokenProblems(t, spot.data)];
  const { minMs, maxMs } = t.duration;
  if (spot.durationMs < minMs || spot.durationMs > maxMs) out.unshift(`duration ${spot.durationMs} ms is outside the template's range ${minMs} to ${maxMs}`);
  return out;
}

/** Why an entry cannot be placed on any screen. */
function entryProblems(e: TargetedEntry): string[] {
  if (!['org', 'group', 'screen'].includes(e.target)) return ['target must be org, group or screen'];
  if (e.target !== 'org' && !e.targetId) return [`a ${e.target} entry needs a targetId`];
  return [];
}

export async function compileScreen(input: CompileInput, opts: CompileOptions): Promise<CompileResult> {
  // Entries are checked first: one that cannot be placed cannot be said to miss this screen.
  const problems = input.schedule.flatMap((e) => entryProblems(e).map((p) => `schedule entry ${e.id}: ${p}`));

  const targets = (e: TargetedEntry) =>
    e.target === 'org' || (e.target === 'group' && input.groups.includes(e.targetId ?? '')) || (e.target === 'screen' && e.targetId === input.screen.id);
  // The screen ranks entries by level itself; it never learns which other groups or screens exist.
  const schedule = input.schedule.filter(targets).map(({ targetId: _t, ...e }) => e);

  // Only what this screen's schedule can reach: smaller downloads, and no screen holds another's content.
  const reachable = new Set([input.defaultPlaylist, ...schedule.map((e) => e.playlist)]);
  const playlistList = input.playlists.filter((p) => reachable.has(p.id));
  const spotIds = new Set(playlistList.flatMap((p) => p.items.map((i) => i.spot)));
  const spotList = input.spots.filter((s) => spotIds.has(s.id));

  // Only what this screen plays is checked: a broken spot elsewhere in the org is that content's
  // problem (a draft the publish did not promote, see docs/backend-plan.md#publishing), not this screen's.
  problems.push(...spotList.flatMap((s) => spotProblems(s, input.templates).map((p) => `spot ${s.id}: ${p}`)));
  const brokenSpots = new Set(problems.filter((p) => p.startsWith('spot ')).map((p) => p.slice(5, p.indexOf(':'))));

  // The screen's brand kit, frozen into the manifest: editing a kit reaches a screen at its next publish.
  let brand: BrandKit | undefined;
  if (input.brand) {
    const { kitId, problem } = chooseBrandKit(input.brand);
    if (problem) problems.push(`brand: ${problem}`);
    else if (kitId && !input.brand.kits[kitId]) problems.push(`brand: brand kit ${kitId} is not available`);
    else if (kitId) brand = input.brand.kits[kitId];
  }
  const colors = brand?.colors ?? DEFAULT_BRAND_COLORS;

  const spots = Object.fromEntries(spotList.map((s) => [s.id, s.kind === 'template' ? withDefaults(s, input.templates[s.template]?.manifest, colors) : s]));
  const templateKeys = new Set(spotList.flatMap((s) => (s.kind === 'template' ? [s.template] : [])));
  const templates = Object.fromEntries(Object.entries(input.templates).filter(([key]) => templateKeys.has(key)));
  const bound = new Set(spotList.flatMap((s) => (s.kind === 'template' ? Object.values(s.bindings ?? {}).map((b) => b.source) : [])));
  const dataSources = Object.fromEntries(input.dataSources.filter((d) => bound.has(d.id)).map((d) => [d.id, d]));
  const playlists = Object.fromEntries(playlistList.map((p) => [p.id, p]));

  const draft = {
    schema: MANIFEST_SCHEMA,
    screen: input.screen,
    ...(brand ? { brand } : {}),
    files: {},
    templates,
    spots,
    playlists,
    dataSources,
    schedule,
    defaultPlaylist: input.defaultPlaylist,
  };
  const files: ScreenManifest['files'] = {};
  for (const sha of [...requiredFiles(draft as ScreenManifest)].sort()) {
    const f = input.files[sha];
    if (f) files[sha] = f;
  }
  const body = { ...draft, files };
  const manifest: ScreenManifest = { ...body, id: await opts.hash(manifestIdInput(body)), generatedAt: opts.now.toISOString() };
  // Report everything in one pass, but say each thing once: a spot already reported is not
  // reported again by the whole-manifest check.
  problems.push(
    ...validateManifest(manifest)
      .filter((p) => ![...brokenSpots].some((id) => p.includes(`spot "${id}"`)))
      .map((p) => `manifest: ${p}`),
  );
  return problems.length ? { problems } : { manifest, problems };
}
