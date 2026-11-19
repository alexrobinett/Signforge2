/**
 * The spot tools' outputs as the CMS reads them (`list_spots`, `get_spot`, `get_spot_preview`,
 * `list_templates` in packages/tools, the source of truth), and the editor's
 * draft turned into what the real player plays: a one-spot manifest (or a playlist's, for the
 * playlist editor) compiled in the browser with the server's compiler, so the stage never waits
 * on the network.
 */
import { compileScreen, spotProblems, type CompileInput } from '@signforge/compiler';
import {
  validateSpotData,
  type FieldDef,
  type Orientation,
  type Playlist,
  type ScalarFieldDef,
  type ScreenManifest,
  type Spot,
  type TemplateManifest,
  type Transition,
} from '@signforge/contract';
import type { AssetView } from './assets';

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
  bindings: Record<string, { source: string; path: string }> | null;
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
  assetId: string | null;
  fit: Fit;
  url: string;
}

export const draftOf = (s: SpotView): SpotDraft => ({
  name: s.name,
  durationMs: s.durationMs,
  data: s.data ?? {},
  assets: s.assets ?? {},
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
export function assetFile(asset: AssetView, orientation: Orientation): { sha: string; size: number; type: string } | undefined {
  if (asset.kind === 'video') return { sha: asset.sha256, size: asset.size, type: asset.type };
  const r = asset.renditions.find((x) => x.orientation === orientation);
  return r && { sha: r.sha256, size: r.size, type: r.type };
}

/** The id the preview's one playlist has; each spot keeps its own id, so each edit updates it in place. */
const PREVIEW_PLAYLIST = 'preview';

/** The files a preview's spots play, by asset id, for one orientation; each one used is added to `files`. */
function fileFor(assets: AssetView[], orientation: Orientation, files: CompileInput['files']) {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return (assetId: string | null) => {
    const a = assetId ? byId.get(assetId) : undefined;
    const f = a && assetFile(a, orientation);
    if (!f) return '';
    files[f.sha] = { size: f.size, type: f.type };
    return f.sha;
  };
}

/** A spot's draft as the contract's `Spot`, or undefined when its template is not available. */
function spotContent(spot: SpotView, draft: SpotDraft, version: TemplateVersionView | undefined, file: (assetId: string | null) => string): Spot | undefined {
  const base = { id: spot.id, name: draft.name || spot.name, durationMs: draft.durationMs };
  if (spot.kind === 'template') {
    if (!version) return undefined;
    const assets = Object.fromEntries(Object.entries(draft.assets).map(([field, id]) => [field, file(id)]));
    return { ...base, kind: 'template', template: version.key, data: draft.data, assets, ...(spot.bindings ? { bindings: spot.bindings } : {}) };
  }
  if (spot.kind === 'url') return { ...base, kind: 'url', url: draft.url };
  return { ...base, kind: spot.kind, file: file(draft.assetId), fit: draft.fit };
}

/** A preview screen of this orientation playing `playlist`, compiled as a publish compiles. */
const compileFor = (preview: SpotPreview['preview'], files: CompileInput['files'], orientation: Orientation, spots: Spot[], playlist: Playlist) =>
  compileScreen(
    {
      ...preview,
      files,
      screen: { id: 'preview', name: 'Preview', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, orientation },
      groups: [],
      spots,
      playlists: [playlist],
      schedule: [],
      defaultPlaylist: playlist.id,
    },
    { hash: sha256Hex, now: new Date() },
  );

/**
 * The draft compiled for the stage: a screen of this orientation playing just this spot, with
 * the brand kit and template `preview` holds. Problems are the compiler's, as a publish would see them.
 */
export async function compilePreview(opts: {
  spot: SpotView;
  draft: SpotDraft;
  version: TemplateVersionView | undefined;
  preview: SpotPreview['preview'];
  assets: AssetView[];
  orientation: Orientation;
}): Promise<{ manifest?: ScreenManifest; problems: string[] }> {
  const { spot, preview, orientation } = opts;
  const files: CompileInput['files'] = { ...preview.files };
  const content = spotContent(spot, opts.draft, opts.version, fileFor(opts.assets, orientation, files));
  if (!content) return { problems: ['the template is not available'] };
  return compileFor(preview, files, orientation, [content], { id: PREVIEW_PLAYLIST, name: 'Preview', transition: { type: 'cut' }, items: [{ spot: spot.id }] });
}

/**
 * A playlist's draft compiled for the stage, each spot as its saved draft. A spot a screen could
 * not play (no image yet, data its template refuses, a template not available) is left out of
 * the preview and listed with why, so the rest still plays; a publish would hold the playlist back.
 */
export async function compilePlaylistPreview(opts: {
  playlist: { id: string; name: string; transition: Transition; spotIds: string[] };
  spots: SpotView[];
  versions: Map<string, TemplateVersionView>;
  preview: SpotPreview['preview'];
  assets: AssetView[];
  orientation: Orientation;
}): Promise<{ manifest?: ScreenManifest; problems: string[]; leftOut: Map<string, string[]> }> {
  const { playlist, preview, orientation } = opts;
  const files: CompileInput['files'] = { ...preview.files };
  const file = fileFor(opts.assets, orientation, files);
  const byId = new Map(opts.spots.map((s) => [s.id, s]));
  const playable = new Map<string, Spot>();
  const leftOut = new Map<string, string[]>();
  for (const id of new Set(playlist.spotIds)) {
    const spot = byId.get(id);
    const content = spot && spotContent(spot, draftOf(spot), opts.versions.get(spot.templateVersionId ?? ''), file);
    const problems = !content
      ? ['its template is not available']
      : content.kind === 'template'
        ? spotProblems(content, preview.templates)
        : 'file' in content && !content.file
          ? [`it has no ${content.kind} for ${orientation} screens`]
          : [];
    if (content && !problems.length) playable.set(id, content);
    else leftOut.set(id, problems);
  }
  const items = playlist.spotIds.filter((id) => playable.has(id)).map((spot) => ({ spot }));
  if (!items.length) return { problems: [], leftOut };
  const result = await compileFor(preview, files, orientation, [...playable.values()], { ...playlist, items });
  return { ...result, leftOut };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const KIND_WORD = { image: 'Image', video: 'Video', url: 'Web page' } as const;

/** What the spot is, in a few words: its template's name, or its kind. */
export const spotWhat = (s: Pick<SpotView, 'kind' | 'templateVersionId'>, versions: Map<string, TemplateVersionView>) =>
  s.kind === 'template' ? (versions.get(s.templateVersionId ?? '')?.manifest.name ?? 'Template') : KIND_WORD[s.kind];

/** Whether screens have it, in words. */
export const publishWord = (s: Pick<SpotView, 'published' | 'draftChanged'>) =>
  !s.published ? 'Draft, never published' : s.draftChanged ? 'Published, with unpublished changes' : 'Published';

/** Seconds, as the duration field shows them. */
export const seconds = (ms: number) => Math.round(ms / 100) / 10;
