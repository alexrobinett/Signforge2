/**
 * The spot tools' outputs as the CMS reads them (`list_spots`, `get_spot`, `get_spot_preview`,
 * `list_templates` in packages/tools, the source of truth), and the editor's
 * draft turned into what the real player plays: a one-spot manifest (or a playlist's, for the
 * playlist editor) compiled in the browser on the compiler's probe screen, the one a publish
 * checks drafts on (@signforge/compiler `compileProbe`), so the stage never waits on the network
 * and plays what a publish would send.
 */
import { spotProblems, type CompileInput } from '@signforge/compiler';
import { compileProbe, DEFAULT_FIT, spotFromDraft, type DraftReads, type Probe, type SpotDraft as SavedDraft } from '@signforge/compiler/draft';
import { validateSpotField, type FieldDef, type Orientation, type ScreenManifest, type Transition } from '@signforge/contract';
import type { ToolOutput } from '@signforge/tools/outputs';
import type { AssetView } from './assets';
import type { BindingInput } from './live-data';

export type SpotKind = SavedDraft['kind'];
type Fit = NonNullable<SavedDraft['fit']>;

/** One spot's draft, as `get_spot` returns it. */
export type SpotView = ToolOutput<'get_spot'>['spot'];

/** A template, its versions oldest first, as `list_templates` returns it. */
export type TemplateView = ToolOutput<'list_templates'>['templates'][number];

export type TemplateVersionView = TemplateView['versions'][number];

/** `get_spot_preview`'s output: a compile input without its screen and content, and the org's time zone for new screens. */
export type SpotPreview = ToolOutput<'get_spot_preview'>;

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
  fit: s.fit ?? DEFAULT_FIT,
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
 * The contract's messages for each field, from the check a publish runs on it (`validateSpotField`),
 * so a message sits by the field it is about and the editor agrees with the publish: an image is
 * checked with its toggle (#252), and a bound toggle never counts as off (#285). `fields` are the
 * spot's, every one, as a publish sees them: an image's toggle may be a live field the form does
 * not draw (#304). `names` are the fields to report on.
 */
export function fieldProblems(
  fields: Record<string, FieldDef>,
  draft: Pick<SpotDraft, 'data' | 'assets' | 'bindings'>,
  names: string[] = Object.keys(fields),
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of names) {
    const problems = validateSpotField(fields, draft.data, draft.assets, draft.bindings, name);
    if (problems.length) out.set(name, problems);
  }
  return out;
}

/**
 * The asset and template views as the draft-to-spot module reads them. A template is the one
 * `get_spot_preview` gave for its version, with the version's status from `list_templates`.
 */
function viewReads(assets: AssetView[], versions: Map<string, TemplateVersionView>, preview: SpotPreview['preview']): DraftReads {
  const byId = new Map(assets.map((a) => [a.id, a]));
  return {
    asset: (id) => byId.get(id),
    templateVersion: (id) => {
      const v = versions.get(id);
      const t = v && preview.templates[v.key];
      const bundle = t && preview.files[t.html];
      return bundle && { key: v.key, manifest: t.manifest, html: t.html, size: bundle.size, status: v.status };
    },
  };
}

/** The editor's draft over the saved spot; with `live` false, unbound, so the player shows the fallback. */
const editedDraft = (spot: SpotView, draft: SpotDraft, live: boolean): SavedDraft => ({
  ...spot,
  name: draft.name || spot.name,
  durationMs: draft.durationMs,
  data: draft.data,
  assets: draft.assets,
  bindings: live ? draft.bindings : null,
  assetId: draft.assetId,
  fit: draft.fit,
  url: draft.url,
});

/**
 * The probe screen the stage compiles on: the preview's kit and files, in the org's time zone for
 * new screens, else the editor's own, the zone a screen paired here starts with.
 */
const stageProbe = (preview: SpotPreview['preview'], timezone: string | null, orientation: Orientation, spots: SavedDraft[]): Probe => ({
  orientation,
  timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  spots,
  dataSources: preview.dataSources,
  files: preview.files,
  ...(preview.brand ? { brand: preview.brand } : {}),
});

/**
 * The draft compiled for the stage: the probe screen of this orientation playing just this spot,
 * with the brand kit and template `preview` holds; or why a publish would refuse it. `refused`:
 * it cannot be a spot at all (an image still being checked), so no field of it is at fault.
 */
export function compilePreview(opts: {
  spot: SpotView;
  draft: SpotDraft;
  versions: Map<string, TemplateVersionView>;
  preview: SpotPreview['preview'];
  timezone: string | null;
  assets: AssetView[];
  orientation: Orientation;
  live: boolean;
}): Promise<{ manifest?: ScreenManifest; problems: string[]; refused: boolean }> {
  const { preview, orientation } = opts;
  return compileProbe(
    stageProbe(preview, opts.timezone, orientation, [editedDraft(opts.spot, opts.draft, opts.live)]),
    viewReads(opts.assets, opts.versions, preview),
    { hash: sha256Hex, now: new Date() },
  );
}

/**
 * A playlist's draft compiled for the stage, each spot as its saved draft. A spot a publish would
 * refuse (no image yet, data its template refuses, a template not available) is left out of the
 * preview and listed with why, so the rest still plays; a publish would hold the playlist back.
 */
export async function compilePlaylistPreview(opts: {
  playlist: { id: string; name: string; transition: Transition; spotIds: string[] };
  spots: SpotView[];
  versions: Map<string, TemplateVersionView>;
  preview: SpotPreview['preview'];
  timezone: string | null;
  assets: AssetView[];
  orientation: Orientation;
}): Promise<{ manifest?: ScreenManifest; problems: string[]; leftOut: Map<string, string[]> }> {
  const { playlist, preview, orientation } = opts;
  const reads = viewReads(opts.assets, opts.versions, preview);
  const byId = new Map(opts.spots.map((s) => [s.id, s]));
  const playable = new Map<string, SavedDraft>();
  const leftOut = new Map<string, string[]>();
  for (const id of new Set(playlist.spotIds)) {
    const spot = byId.get(id);
    if (!spot) {
      leftOut.set(id, ['it is not in the library']);
      continue;
    }
    // Bound as saved; the playlist stage posts no snapshots, so a bound spot plays its fallback there.
    const into: Pick<CompileInput, 'files' | 'templates'> = { templates: {}, files: {} };
    const r = spotFromDraft(spot, orientation, reads, into);
    const problems = [...r.problems, ...(r.spot ? spotProblems(r.spot, into.templates) : [])];
    if (problems.length) leftOut.set(id, problems);
    else playable.set(id, spot);
  }
  const items = playlist.spotIds.filter((id) => playable.has(id)).map((spot) => ({ spot }));
  if (!items.length) return { problems: [], leftOut };
  const result = await compileProbe(
    {
      ...stageProbe(preview, opts.timezone, orientation, [...playable.values()]),
      playlist: { id: playlist.id, name: playlist.name, transition: playlist.transition, items },
    },
    reads,
    { hash: sha256Hex, now: new Date() },
  );
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

/** A spot's name, as `create_spot` takes it: at most this many characters. */
const NAME_MAX = 100;

/**
 * A new spot's name from its template's (#360): the name itself while no spot has it, else the
 * first free "Name 2", "Name 3", …; trimmed, and cut so the number still fits in a name's length.
 */
export function nextName(template: string, spots: readonly { name: string }[]): string {
  const base = template.trim();
  const taken = new Set(spots.map((s) => s.name));
  const named = (suffix: string) => `${base.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
  if (!taken.has(named(''))) return named('');
  let n = 2;
  while (taken.has(named(` ${n}`))) n += 1;
  return named(` ${n}`);
}

const and = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? ''));

/**
 * What Publish asks before sample copy reaches screens (#360): "In Pier 9, Headline and Body still
 * have sample text.", each spot named, even one alone: a publish from ⌘K or the sidebar shows no spot.
 */
export function sampleWords(spots: readonly { name: string; labels: string[] }[]): string {
  return spots.map(({ name, labels }) => `In ${name}, ${and(labels)} still ${labels.length === 1 ? 'has' : 'have'} sample text.`).join(' ');
}

/** Whether screens have it, in words. */
export const publishWord = (s: Pick<SpotView, 'published' | 'draftChanged'>) =>
  !s.published ? 'Draft, never published' : s.draftChanged ? 'Published, with unpublished changes' : 'Published';

/** Seconds, as the duration field shows them. */
export const seconds = (ms: number) => Math.round(ms / 100) / 10;
