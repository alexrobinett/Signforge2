/**
 * The spot tools' outputs as the CMS reads them (`list_spots`, `get_spot`, `get_spot_preview`,
 * `list_templates`, `list_brand_kits` in packages/tools, the source of truth), and the editor's
 * draft turned into what the real player plays: a one-spot manifest compiled in the browser with
 * the server's compiler, so the stage never waits on the network.
 */
import { compileScreen, type CompileInput } from '@signforge/compiler';
import {
  validateSpotData,
  type FieldDef,
  type Orientation,
  type ScalarFieldDef,
  type ScreenManifest,
  type Spot,
  type TemplateManifest,
} from '@signforge/contract';
import type { AssetView } from './assets';
import type { BindingInput } from './live-data';

export type SpotKind = 'template' | 'image' | 'video' | 'url';
type Fit = 'cover' | 'contain';

/** One spot's draft, as `get_spot` returns it. */
export interface SpotView {
  id: string;
  name: string;
  kind: SpotKind;
  durationMs: number;
  templateVersionId: string | null;
  data: Record<string, unknown> | null;
  assets: Record<string, string> | null;
  bindings: Record<string, BindingInput> | null;
  assetId: string | null;
  fit: Fit | null;
  url: string | null;
  version: number;
  published: boolean;
  draftChanged: boolean;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateVersionView {
  id: string;
  key: string;
  version: string;
  status: 'draft' | 'approved' | 'retired';
  manifest: TemplateManifest;
}

export interface TemplateView {
  id: string;
  owner: 'base' | 'org';
  key: string;
  name: string;
  versions: TemplateVersionView[];
}

export interface BrandKitView {
  id: string;
  name: string;
  colors: Record<'primary' | 'accent' | 'background' | 'surface' | 'text' | 'muted', string>;
  isDefault: boolean;
}

/** `get_spot_preview`'s output: a compile input without its screen and content. */
export interface SpotPreview {
  preview: Pick<CompileInput, 'templates' | 'files' | 'dataSources' | 'brand'>;
  brandKitId: string | null;
  problems: string[];
}

/** What the editor edits: the parts of a spot's draft a person changes. */
export interface SpotDraft {
  name: string;
  durationMs: number;
  data: Record<string, unknown>;
  assets: Record<string, string>;
  /** Fields bound to a data source; their `data` is the fallback. */
  bindings: Record<string, BindingInput>;
  assetId: string | null;
  fit: Fit;
  url: string;
}

export const draftOf = (s: SpotView): SpotDraft => ({
  name: s.name,
  durationMs: s.durationMs,
  data: s.data ?? {},
  assets: s.assets ?? {},
  bindings: s.bindings ?? {},
  assetId: s.assetId,
  fit: s.fit ?? 'cover',
  url: s.url ?? '',
});

/** Every version of every template, by id. */
export const versionsById = (templates: TemplateView[]) => new Map(templates.flatMap((t) => t.versions.map((v) => [v.id, v] as const)));

/** The newest approved version of each template: what a new spot may use. */
export const usableVersions = (templates: TemplateView[]) =>
  templates.flatMap((t) => {
    const v = t.versions.findLast((x) => x.status === 'approved');
    return v ? [{ template: t, version: v }] : [];
  });

/**
 * The contract's messages for each field, from `validateSpotData` run on that field alone, so a
 * message sits by the field it is about. An image field with no image yet asks for one.
 */
export function fieldProblems(fields: Record<string, FieldDef>, draft: Pick<SpotDraft, 'data' | 'assets'>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, def] of Object.entries(fields)) {
    const data = name in draft.data ? { [name]: draft.data[name] } : {};
    const assets = name in draft.assets ? { [name]: draft.assets[name] } : {};
    const problems = validateSpotData({ [name]: def }, data, assets);
    if (problems.length) out.set(name, problems);
  }
  return out;
}

/** A value for a field with no default yet: a new list row's, or a new spot's. */
export function startValue(d: ScalarFieldDef): unknown {
  if (d.default !== undefined) return d.default;
  switch (d.type) {
    case 'text':
      return '';
    case 'number':
      return d.min ?? 0;
    case 'boolean':
      return false;
    case 'color':
      return '#ffffff';
    case 'select':
      return d.options[0];
  }
}

/** A new spot's data: a value for each field the template gives no default, so the draft starts valid. */
export const startData = (fields: Record<string, FieldDef>) =>
  Object.fromEntries(
    Object.entries(fields).flatMap(([name, def]) =>
      def.type === 'image' || def.default !== undefined ? [] : [[name, def.type === 'list' ? [] : startValue(def)]],
    ),
  );

/** The file an asset plays as on a screen of this orientation, as the publish picks it (packages/tools `assetFile`). */
function assetFile(asset: AssetView, orientation: Orientation): { sha: string; size: number; type: string } | undefined {
  if (asset.kind === 'video') return { sha: asset.sha256, size: asset.size, type: asset.type };
  const r = asset.renditions.find((x) => x.orientation === orientation);
  return r && { sha: r.sha256, size: r.size, type: r.type };
}

/** The id the preview's one playlist has; the spot keeps its own id, so each edit updates it in place. */
const PREVIEW_PLAYLIST = 'preview';

/**
 * The draft compiled for the stage: a screen of this orientation playing just this spot, with
 * the brand kit and template `preview` holds. Problems are the compiler's, as a publish would see them.
 * With `live` false the spot is compiled without its bindings, so the player shows the fallback.
 */
export async function compilePreview(opts: {
  spot: SpotView;
  draft: SpotDraft;
  version: TemplateVersionView | undefined;
  preview: SpotPreview['preview'];
  assets: AssetView[];
  orientation: Orientation;
  live: boolean;
}): Promise<{ manifest?: ScreenManifest; problems: string[] }> {
  const { spot, draft, preview, orientation } = opts;
  const files: CompileInput['files'] = { ...preview.files };
  const byId = new Map(opts.assets.map((a) => [a.id, a]));
  const file = (assetId: string | null) => {
    const a = assetId ? byId.get(assetId) : undefined;
    const f = a && assetFile(a, orientation);
    if (!f) return '';
    files[f.sha] = { size: f.size, type: f.type };
    return f.sha;
  };
  const base = { id: spot.id, name: draft.name || spot.name, durationMs: draft.durationMs };
  let content: Spot;
  if (spot.kind === 'template') {
    if (!opts.version) return { problems: ['the template is not available'] };
    const assets = Object.fromEntries(Object.entries(draft.assets).map(([field, id]) => [field, file(id)]));
    const bindings = Object.fromEntries(Object.entries(draft.bindings).map(([field, b]) => [field, { source: b.dataSourceId, path: b.path }]));
    content = {
      ...base,
      kind: 'template',
      template: opts.version.key,
      data: draft.data,
      assets,
      ...(opts.live && Object.keys(bindings).length ? { bindings } : {}),
    };
  } else if (spot.kind === 'url') content = { ...base, kind: 'url', url: draft.url };
  else content = { ...base, kind: spot.kind, file: file(draft.assetId), fit: draft.fit };
  return compileScreen(
    {
      ...preview,
      files,
      screen: { id: 'preview', name: 'Preview', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, orientation },
      groups: [],
      spots: [content],
      playlists: [{ id: PREVIEW_PLAYLIST, name: 'Preview', transition: { type: 'cut' }, items: [{ spot: spot.id }] }],
      schedule: [],
      defaultPlaylist: PREVIEW_PLAYLIST,
    },
    { hash: sha256Hex, now: new Date() },
  );
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether screens have it, in words. */
export const publishWord = (s: Pick<SpotView, 'published' | 'draftChanged'>) =>
  !s.published ? 'Draft, never published' : s.draftChanged ? 'Published, with unpublished changes' : 'Published';

/** Seconds, as the duration field shows them. */
export const seconds = (ms: number) => Math.round(ms / 100) / 10;
