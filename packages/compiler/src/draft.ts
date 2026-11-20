/**
 * Draft to spot: a spot's draft, as the spot tools give it (`get_spot`), turned into the
 * contract's `Spot` for one orientation, and the probe screen a draft is checked on. The publish
 * (packages/tools `promoteDrafts`) and the CMS's stage both call it, so what the stage plays is
 * what a publish sends, and a draft the publish refuses is refused on the stage for the same reason.
 *
 * What it reads is the seam (`DraftReads`): the tools read the org's rows, the CMS its asset and
 * template views.
 */
import type { Binding, DataSource, Orientation, Playlist, ScreenManifest, Sha256, Spot, TableMapping, TemplateManifest } from '@signforge/contract';
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
  renditions: { orientation: Orientation; sha256: Sha256; size: number; type: string }[];
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
 * The file an asset plays as on a screen of this orientation, added to `files`, or why there is
 * none. Only a verified asset has one: until `finalize_asset` checks an upload, its files are not
 * where screens, or the stage, read them.
 */
export function assetFile(
  reads: Pick<DraftReads, 'asset'>,
  assetId: string,
  orientation: Orientation,
  files: CompileInput['files'],
): { sha?: Sha256; problem?: string } {
  const a = reads.asset(assetId);
  if (!a) return { problem: `asset ${assetId} does not exist` };
  const problem = unverified(assetId, a.status);
  if (problem) return { problem };
  const f = a.kind === 'video' ? a : a.renditions.find((r) => r.orientation === orientation);
  if (!f) return { problem: `asset ${assetId} has no ${orientation} rendition` };
  files[f.sha256] = { size: f.size, type: f.type };
  return { sha: f.sha256 };
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
  const file = (assetId: string) => {
    const f = assetFile(reads, assetId, orientation, into.files);
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
    const assets = Object.fromEntries(Object.entries(draft.assets ?? {}).map(([field, id]) => [field, file(id)]));
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
