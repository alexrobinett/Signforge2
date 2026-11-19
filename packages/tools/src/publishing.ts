/**
 * The publish model: from an org's rows to each screen's `CompileInput`, and drafts promoted to
 * published. See docs/backend-plan.md#publishing.
 *
 *   - `loadOrg(org)` reads everything a publish needs in a fixed number of queries.
 *   - `promoteDrafts(graph, opts)` checks each changed draft (spot, playlist, schedule entry) and
 *     stages publishing the ones that pass. One that fails keeps its published version, if any,
 *     and is reported; it never blocks the rest.
 *   - `compileInputFor(graph, screenId)` is a screen's published graph as `compileScreen` takes it.
 *   - `publishOrg(org, opts)` does all three and compiles every screen. It stages its writes and
 *     never commits; the caller (the publish tool, ./publish.ts) does, through the dispatcher, in one batch
 *     with the screens' desired-manifest switches, which the writes put in order.
 *
 * Brand: `screenInput` gives the compiler the kits this screen may get (its own, its groups',
 * the default) and its choices; the compiler picks one (`chooseBrandKit`) and freezes it into the
 * manifest. Kits have no drafts: a publish takes each kit as it is then.
 */
import { brandFont, compileScreen, type CompileInput, type CompileOptions, type TargetedEntry } from '@signforge/compiler';
import {
  templateKey,
  type Binding,
  type BrandKit,
  type DataSource,
  type Playlist,
  type Spot,
  type TemplateManifest,
  type Transition,
} from '@signforge/contract';
import {
  draftChanged,
  published,
  type Asset,
  type DraftRow,
  type AssetRendition,
  type BrandAssignment,
  type BrandKitRow,
  type OrgScope,
  type PlaylistRow,
  type PublishedPlaylist,
  type ScheduleEntryRow,
  type Screen,
  type SpotRow,
  type TemplateVersion,
  type Write,
} from '@signforge/db';
import { kitColors } from './brand';
import { ToolError } from './tool';

type Orientation = Screen['orientation'];

export interface OrgGraph {
  screens: Screen[];
  /** Screen id to the ids of its groups. */
  groupsOf: Map<string, string[]>;
  /** Template versions spots may play (approved or retired), and draft ones, by version id. */
  templateVersions: Map<string, { key: string; manifest: TemplateManifest; html: string; size: number; status: TemplateVersion['status'] }>;
  assets: Map<string, { asset: Asset; renditions: AssetRendition[] }>;
  dataSources: DataSource[];
  /** Draft rows. A row's published version is `published(row)`. */
  spots: SpotRow[];
  playlists: PlaylistRow[];
  /** Draft playlist items, by playlist id. */
  items: Map<string, string[]>;
  entries: ScheduleEntryRow[];
  defaultPlaylist: string | null;
  brandKits: Map<string, BrandKitRow>;
  brandAssignments: BrandAssignment[];
  /** The org's publish revision as read with the rest: a publish commits only if it is still this. */
  publishRevision: number;
}

export async function loadOrg(org: OrgScope): Promise<OrgGraph> {
  // The publish revision first, before any content: a publish that commits after this read moves
  // it on, so whatever it changed cannot be in what is read below without failing the guard.
  const settings = await org.settings.get();
  const [screens, members, versions, assets, renditions, dataSources, spots, [playlists, items], entries] = await Promise.all([
    org.screens.list(),
    org.screenGroups.allMembers(),
    org.templates.versions.list(),
    org.assets.list(),
    org.assets.renditions.list(),
    org.dataSources.list(),
    org.spots.list(),
    // Versions before items: an items edit moves its playlist's version on, so items newer than
    // the version read fail that playlist's promotion guard instead of publishing unseen.
    org.playlists.list().then(async (p) => [p, await org.playlists.allItems()] as const),
    org.scheduleEntries.list(),
  ]);
  const [brandKits, brandAssignments] = await Promise.all([org.brandKits.list(), org.brandKits.assignments.list()]);
  const groupsOf = new Map<string, string[]>();
  for (const m of members) groupsOf.set(m.screenId, [...(groupsOf.get(m.screenId) ?? []), m.groupId]);
  const templateVersions: OrgGraph['templateVersions'] = new Map();
  for (const v of versions) {
    const manifest = JSON.parse(v.manifestJson) as TemplateManifest;
    // Registering stores the check report, with the bundle's size, on every version.
    const size = v.checkReportJson ? Number((JSON.parse(v.checkReportJson) as { bundleBytes?: unknown }).bundleBytes) || 0 : 0;
    templateVersions.set(v.id, { key: templateKey(manifest, v.orgId ?? 'base'), manifest, html: v.bundleSha256, size, status: v.status });
  }
  const byAsset = Map.groupBy(renditions, (r) => r.assetId);
  return {
    screens,
    groupsOf,
    templateVersions,
    assets: new Map(assets.map((a) => [a.id, { asset: a, renditions: byAsset.get(a.id) ?? [] }])),
    // The feed URL stays on the server; a screen learns the id and refresh rate.
    dataSources: dataSources.map((d) => ({ id: d.id, refreshS: d.refreshS })),
    spots,
    playlists,
    items,
    entries,
    defaultPlaylist: settings?.defaultPlaylistId ?? null,
    brandKits: new Map(brandKits.map((k) => [k.id, k])),
    brandAssignments,
    publishRevision: settings?.publishRevision ?? 0,
  };
}

const json = <T>(text: string | null, fallback: T): T => (text == null ? fallback : (JSON.parse(text) as T));

/** The file an asset plays as on a screen of this orientation: its rendition, or for a video the asset itself. */
function assetFile(graph: OrgGraph, assetId: string, orientation: Orientation, files: CompileInput['files']): { sha?: string; problem?: string } {
  const a = graph.assets.get(assetId);
  if (!a) return { problem: `asset ${assetId} does not exist` };
  if (a.asset.status !== 'verified') return { problem: `asset ${assetId} is not verified` };
  if (a.asset.kind === 'video') {
    files[a.asset.sha256] = { size: a.asset.size, type: a.asset.type };
    return { sha: a.asset.sha256 };
  }
  const r = a.renditions.find((x) => x.orientation === orientation);
  if (!r) return { problem: `asset ${assetId} has no ${orientation} rendition` };
  files[r.sha256] = { size: r.size, type: r.type };
  return { sha: r.sha256 };
}

/**
 * A kit as the manifest carries it for one orientation, or why it cannot be. A logo is its
 * asset's rendition for the screen. A catalogue font whose files are not added yet is left out,
 * so templates draw with their own font until it is (compiler `FONTS`).
 */
function toBrandKit(graph: OrgGraph, row: BrandKitRow, orientation: Orientation, files: CompileInput['files']): { kit?: BrandKit; problems: string[] } {
  const problems: string[] = [];
  const logoFile = (assetId: string | null) => {
    if (!assetId) return undefined;
    const f = assetFile(graph, assetId, orientation, files);
    if (f.problem) problems.push(`logo ${f.problem}`);
    return f.sha;
  };
  const onDark = logoFile(row.logoOnDarkAssetId);
  const onLight = logoFile(row.logoOnLightAssetId);
  const display = brandFont(row.displayFontId, files);
  const body = brandFont(row.bodyFontId, files);
  if (problems.length) return { problems };
  return {
    kit: {
      id: row.id,
      colors: kitColors(row).colors,
      shape: row.shape,
      fonts: { ...(display ? { display } : {}), ...(body ? { body } : {}) },
      ...(onDark ? { logo: { onDark, ...(onLight ? { onLight } : {}) } } : {}),
    },
    problems,
  };
}

/** The kits a screen may get and its choices, as `compileScreen` takes them; plus why a kit could not be built. */
function brandInput(
  graph: OrgGraph,
  screen: Screen,
  files: CompileInput['files'],
): { brand: NonNullable<CompileInput['brand']>; unavailable: Map<string, string[]> } {
  const groups = new Set(graph.groupsOf.get(screen.id) ?? []);
  const brand: NonNullable<CompileInput['brand']> = { kits: {}, groups: {} };
  for (const a of graph.brandAssignments) {
    if (a.target === 'org') brand.default = a.brandKitId;
    else if (a.target === 'screen' && a.screenId === screen.id) brand.screen = a.brandKitId;
    else if (a.target === 'group' && groups.has(a.groupId!)) brand.groups[a.groupId!] = a.brandKitId;
  }
  const unavailable = new Map<string, string[]>();
  const wanted = new Set([brand.screen, brand.default, ...Object.values(brand.groups)].filter((k) => k !== undefined));
  for (const id of wanted) {
    const row = graph.brandKits.get(id);
    if (!row) continue;
    // Built into a scratch file list: only the chosen kit's files belong in the manifest.
    const own: CompileInput['files'] = {};
    const { kit, problems } = toBrandKit(graph, row, screen.orientation, own);
    if (kit) {
      brand.kits[id] = kit;
      Object.assign(files, own);
    } else unavailable.set(id, problems);
  }
  return { brand, unavailable };
}

/** A spot row (draft or published version) as the contract's `Spot` for one orientation, or why it cannot be. */
function toSpot(
  graph: OrgGraph,
  row: SpotRow,
  orientation: Orientation,
  input: Pick<CompileInput, 'files' | 'templates'>,
): { spot?: Spot; problems: string[] } {
  const base = { id: row.id, name: row.name, durationMs: row.durationMs };
  const problems: string[] = [];
  const file = (assetId: string) => {
    const f = assetFile(graph, assetId, orientation, input.files);
    if (f.problem) problems.push(f.problem);
    return f.sha ?? '';
  };
  let spot: Spot;
  if (row.kind === 'template') {
    const v = row.templateVersionId ? graph.templateVersions.get(row.templateVersionId) : undefined;
    if (!v) return { problems: [`template version ${row.templateVersionId} does not exist`] };
    if (v.status !== 'draft') {
      input.templates[v.key] = { manifest: v.manifest, html: v.html };
      input.files[v.html] = { size: v.size, type: 'text/html' };
    }
    const assets: Record<string, string> = {};
    for (const [field, assetId] of Object.entries(json<Record<string, string>>(row.assetMapJson, {}))) assets[field] = file(assetId);
    const bindings = json<Record<string, Binding> | null>(row.bindingsJson, null);
    spot = { ...base, kind: 'template', template: v.key, data: json(row.dataJson, {}), assets, ...(bindings ? { bindings } : {}) };
  } else if (row.kind === 'image' || row.kind === 'video') {
    spot = { ...base, kind: row.kind, file: row.assetId ? file(row.assetId) : '', fit: row.fit ?? 'cover' };
    if (!row.assetId) problems.push('no asset');
  } else {
    spot = { ...base, kind: 'url', url: row.url ?? '' };
  }
  return problems.length ? { problems } : { spot, problems };
}

const toPlaylist = (p: PublishedPlaylist): Playlist => ({
  id: p.id,
  name: p.name,
  transition: JSON.parse(p.transitionJson) as Transition,
  items: p.items.map((spot) => ({ spot })),
});

function toEntry(e: ScheduleEntryRow): TargetedEntry {
  const days = json<number[] | null>(e.daysJson, null);
  return {
    id: e.id,
    playlist: e.playlistId,
    priority: e.priority,
    target: e.target,
    ...(e.target === 'group' ? { targetId: e.groupId ?? undefined } : e.target === 'screen' ? { targetId: e.screenId ?? undefined } : {}),
    ...(e.startDate ? { startDate: e.startDate } : {}),
    ...(e.endDate ? { endDate: e.endDate } : {}),
    ...(days ? { days } : {}),
    ...(e.fromTime ? { from: e.fromTime } : {}),
    ...(e.toTime ? { to: e.toTime } : {}),
  };
}

/** A screen's published graph as `compileScreen` takes it, plus why any published spot could not be included. */
function screenInput(graph: OrgGraph, screen: Screen): { input: CompileInput; unavailable: Map<string, string[]>; unavailableKits: Map<string, string[]> } {
  const templates: CompileInput['templates'] = {};
  const files: CompileInput['files'] = {};
  const spots: Spot[] = [];
  const unavailable = new Map<string, string[]>();
  for (const row of graph.spots) {
    const pub = published(row);
    if (!pub) continue;
    const { spot, problems } = toSpot(graph, pub, screen.orientation, { templates, files });
    if (spot) spots.push(spot);
    else unavailable.set(row.id, problems);
  }
  const playlists = graph.playlists.flatMap((row) => {
    const pub = published(row);
    return pub ? [toPlaylist(pub)] : [];
  });
  const schedule = graph.entries.flatMap((row) => {
    const pub = published(row);
    return pub ? [toEntry(pub)] : [];
  });
  const displayHours = screen.displayHoursJson ? JSON.parse(screen.displayHoursJson) : undefined;
  const { brand, unavailable: unavailableKits } = brandInput(graph, screen, files);
  return {
    input: {
      screen: {
        id: screen.id,
        name: screen.name,
        timezone: screen.timezone,
        orientation: screen.orientation,
        ...(screen.locale ? { locale: screen.locale } : {}),
        ...(displayHours ? { displayHours } : {}),
      },
      groups: graph.groupsOf.get(screen.id) ?? [],
      templates,
      files,
      spots,
      playlists,
      schedule,
      dataSources: graph.dataSources,
      defaultPlaylist: graph.defaultPlaylist ?? '',
      brand,
    },
    unavailable,
    unavailableKits,
  };
}

/** A screen's published graph as `compileScreen` takes it; undefined for a screen the org does not have. */
export function compileInputFor(graph: OrgGraph, screenId: string): CompileInput | undefined {
  const screen = graph.screens.find((s) => s.id === screenId);
  return screen && screenInput(graph, screen).input;
}

/** The loader: an org's published graph, read through its scope, for one screen. */
export async function loadCompileInput(org: OrgScope, screenId: string): Promise<CompileInput | undefined> {
  return compileInputFor(await loadOrg(org), screenId);
}

// ------------------------------------------------------------------ preview

/** What the spot editor's stage compiles a draft against: everything of a `CompileInput` but the screen and the content. */
export type PreviewInput = Pick<CompileInput, 'templates' | 'files' | 'dataSources'> & { brand?: NonNullable<CompileInput['brand']> };

/**
 * A preview's template, brand kit and data sources for one orientation, built as a publish builds
 * them, so the stage draws what a screen would. The kit is `brandKitId`, else the org's default;
 * one that cannot be built (an unverified logo) is left out and its problems returned.
 */
export function previewInput(
  graph: OrgGraph,
  orientation: Orientation,
  opts: { templateVersionId?: string; brandKitId?: string },
): { input: PreviewInput; brandKitId: string | null; problems: string[] } {
  const input: PreviewInput = { templates: {}, files: {}, dataSources: graph.dataSources };
  const v = opts.templateVersionId ? graph.templateVersions.get(opts.templateVersionId) : undefined;
  if (v) {
    input.templates[v.key] = { manifest: v.manifest, html: v.html };
    input.files[v.html] = { size: v.size, type: 'text/html' };
  }
  const kitId = opts.brandKitId ?? graph.brandAssignments.find((a) => a.target === 'org')?.brandKitId;
  const row = kitId ? graph.brandKits.get(kitId) : undefined;
  if (!row) return { input, brandKitId: null, problems: [] };
  const own: CompileInput['files'] = {};
  const { kit, problems } = toBrandKit(graph, row, orientation, own);
  if (!kit) return { input, brandKitId: row.id, problems: problems.map((p) => `brand kit ${row.id}: ${p}`) };
  Object.assign(input.files, own);
  return { input: { ...input, brand: { kits: { [kit.id]: kit }, groups: {}, screen: kit.id } }, brandKitId: row.id, problems };
}

// ------------------------------------------------------------------ drafts

export type DraftKind = 'spot' | 'playlist' | 'schedule_entry';
export interface DraftReport {
  /** Drafts published by this publish. */
  promoted: { kind: DraftKind; id: string }[];
  /** Drafts that failed their checks: they keep their published version, if any. For the CMS to show. */
  held: { kind: DraftKind; id: string; problems: string[] }[];
}

const PROBE = 'draft-check';

/**
 * Check a draft the way a screen would: compile a probe screen whose default playlist plays it.
 * Problems are the ones a screen reaching it would get.
 */
async function probe(
  graph: OrgGraph,
  orientation: Orientation,
  opts: CompileOptions,
  content: { spots: SpotRow[]; playlist: Playlist; entry?: TargetedEntry },
): Promise<string[]> {
  const templates: CompileInput['templates'] = {};
  const files: CompileInput['files'] = {};
  const spots: Spot[] = [];
  const problems: string[] = [];
  for (const row of content.spots) {
    const r = toSpot(graph, row, orientation, { templates, files });
    if (r.spot) spots.push(r.spot);
    else problems.push(...r.problems.map((p) => `spot ${row.id}: ${p}`));
  }
  if (problems.length) return problems;
  const result = await compileScreen(
    {
      screen: { id: PROBE, name: 'Draft check', timezone: 'UTC', orientation },
      groups: [],
      templates,
      files,
      spots,
      playlists: [content.playlist],
      dataSources: graph.dataSources,
      schedule: content.entry ? [{ ...content.entry, target: 'org', targetId: undefined }] : [],
      defaultPlaylist: content.playlist.id,
    },
    opts,
  );
  return result.problems;
}

/**
 * Promote every changed draft that passes its checks, in dependency order: spots, then playlists
 * (every item must be a published spot), then schedule entries (their playlist must be published).
 * Returns the graph as it will be once `writes` are committed.
 */
export async function promoteDrafts(
  org: OrgScope,
  graph: OrgGraph,
  opts: CompileOptions,
  pins?: ReadonlyMap<string, number>,
): Promise<{ graph: OrgGraph; writes: Write[]; drafts: DraftReport }> {
  const writes: Write[] = [];
  // With pins, only the pinned drafts are candidates: every other draft stays as it is published.
  const changed = (kind: DraftKind, row: DraftRow, items?: string[]) => (!pins || pins.has(pinKey(kind, row.id))) && draftChanged(row, items);
  const drafts: DraftReport = { promoted: [], held: [] };
  // Every orientation a screen of this org has: a spot's files differ by orientation.
  const orientations = [...new Set<Orientation>(graph.screens.length ? graph.screens.map((s) => s.orientation) : ['landscape'])].sort();
  const check = async (content: Parameters<typeof probe>[3]) => {
    for (const o of orientations) {
      const problems = await probe(graph, o, opts, content);
      if (problems.length) return problems;
    }
    return [];
  };

  const spots: SpotRow[] = [];
  for (const row of graph.spots) {
    if (!changed('spot', row)) {
      spots.push(row);
      continue;
    }
    const problems: string[] = [];
    const v = row.kind === 'template' && row.templateVersionId ? graph.templateVersions.get(row.templateVersionId) : undefined;
    // A retired version stays playable for a spot already published with it, but nothing new may use it.
    if (v && v.status !== 'approved' && !(v.status === 'retired' && published(row)?.templateVersionId === row.templateVersionId)) {
      problems.push(`template ${v.key} is ${v.status}; only an approved version can be published`);
    } else {
      problems.push(...(await check({ spots: [row], playlist: { id: PROBE, name: PROBE, transition: { type: 'cut' }, items: [{ spot: row.id }] } })));
    }
    if (problems.length) {
      drafts.held.push({ kind: 'spot', id: row.id, problems });
      spots.push(row);
    } else {
      const s = org.spots.stage.publish(row);
      writes.push(...s.writes);
      spots.push(s.row);
      drafts.promoted.push({ kind: 'spot', id: row.id });
    }
  }
  const publishedSpots = new Map(
    spots.flatMap((r) => {
      const p = published(r);
      return p ? [[r.id, p] as const] : [];
    }),
  );

  const playlists: PlaylistRow[] = [];
  for (const row of graph.playlists) {
    const items = graph.items.get(row.id) ?? [];
    if (!changed('playlist', row, items)) {
      playlists.push(row);
      continue;
    }
    const missing = [...new Set(items.filter((id) => !publishedSpots.has(id)))];
    const draft = toPlaylist({ ...row, items });
    const problems = missing.length
      ? missing.map((id) => `spot ${id} is not published`)
      : await check({ spots: [...new Set(items)].map((id) => publishedSpots.get(id)!), playlist: draft });
    if (problems.length) {
      drafts.held.push({ kind: 'playlist', id: row.id, problems });
      playlists.push(row);
    } else {
      const s = org.playlists.stage.publish(row, items);
      writes.push(...s.writes);
      playlists.push(s.row);
      drafts.promoted.push({ kind: 'playlist', id: row.id });
    }
  }
  const publishedPlaylists = new Map(
    playlists.flatMap((r) => {
      const p = published(r);
      return p ? [[r.id, p] as const] : [];
    }),
  );

  const entries: ScheduleEntryRow[] = [];
  for (const row of graph.entries) {
    if (!changed('schedule_entry', row)) {
      entries.push(row);
      continue;
    }
    const playlist = publishedPlaylists.get(row.playlistId);
    const problems = !playlist
      ? [`playlist ${row.playlistId} is not published`]
      : await check({ spots: [...new Set(playlist.items)].flatMap((id) => publishedSpots.get(id) ?? []), playlist: toPlaylist(playlist), entry: toEntry(row) });
    if (problems.length) {
      drafts.held.push({ kind: 'schedule_entry', id: row.id, problems });
      entries.push(row);
    } else {
      const s = org.scheduleEntries.stage.publish(row);
      writes.push(...s.writes);
      entries.push(s.row);
      drafts.promoted.push({ kind: 'schedule_entry', id: row.id });
    }
  }

  const order = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind.localeCompare(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  drafts.promoted.sort(order);
  drafts.held.sort(order);
  return { graph: { ...graph, spots, playlists, entries }, writes, drafts };
}

export interface ScreenPublish {
  screenId: string;
  /** The screen's desired manifest as read: one compiled to the same id changes nothing. */
  current: string | null;
  /** Absent when the screen cannot be published; it keeps the manifest it has. */
  manifest?: Awaited<ReturnType<typeof compileScreen>>['manifest'];
  problems: string[];
}

/** A draft chosen for a publish, at the version it was chosen at. */
export interface DraftPin {
  kind: DraftKind;
  id: string;
  version: number;
}

const pinKey = (kind: DraftKind, id: string) => `${kind}:${id}`;

/**
 * Promote drafts, then compile every screen from the published graph. A screen that cannot be
 * compiled is reported and the others still publish. Stages writes; the caller commits them with
 * its switch of each screen's desired manifest, in one batch. The writes put the publish in order
 * (`publishes.stage.advance`) and each promotion is guarded by its draft's version, so a batch
 * that lost to another publish or to an edit fails with `StaleVersionError` and writes nothing.
 *
 * With `pins`, only those drafts are promoted, and only at the version pinned: one that changed or
 * was deleted since is refused (`conflict`, details `{ id, version }`, the version now, 0 if gone).
 * `revision` is the org's publish revision as read; the publish moves it to the next. `read` is the
 * org as read, and `graph` as it will be once the writes commit, its drafts promoted.
 */
export async function publishOrg(
  org: OrgScope,
  opts: CompileOptions,
  pins?: readonly DraftPin[],
): Promise<{ writes: Write[]; drafts: DraftReport; screens: ScreenPublish[]; revision: number; read: OrgGraph; graph: OrgGraph }> {
  const read = await loadOrg(org);
  const pinned = pins && new Map(pins.map((p) => [pinKey(p.kind, p.id), p.version]));
  if (pins) {
    const rows: Record<DraftKind, DraftRow[]> = { spot: read.spots, playlist: read.playlists, schedule_entry: read.entries };
    for (const p of pins) {
      const now = rows[p.kind].find((r) => r.id === p.id)?.rowVersion ?? 0;
      if (now !== p.version) {
        throw new ToolError('conflict', `${p.kind.replace('_', ' ')} ${p.id} has changed since it was chosen for this publish; it is now version ${now}`, {
          id: p.id,
          version: now,
        });
      }
    }
  }
  const { graph, writes: promotions, drafts } = await promoteDrafts(org, read, opts, pinned);
  const writes = [...org.publishes.stage.advance(read.publishRevision).writes, ...promotions];
  const screens: ScreenPublish[] = [];
  for (const screen of [...graph.screens].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const current = screen.desiredManifestId;
    if (!graph.defaultPlaylist) {
      screens.push({ screenId: screen.id, current, problems: ['the organization has no default playlist'] });
      continue;
    }
    const { input, unavailable, unavailableKits } = screenInput(graph, screen);
    const result = await compileScreen(input, opts);
    // A published spot that could not be loaded shows up as unknown; say why.
    const reasons = [...unavailable]
      .filter(([id]) => result.problems.some((p) => p.includes(`spot "${id}"`)))
      .flatMap(([id, ps]) => ps.map((p) => `spot ${id}: ${p}`));
    // A chosen kit that could not be built shows up as not available; say why.
    const kitReasons = [...unavailableKits]
      .filter(([id]) => result.problems.includes(`brand: brand kit ${id} is not available`))
      .flatMap(([id, ps]) => ps.map((p) => `brand: brand kit ${id}: ${p}`));
    const problems = [...reasons, ...kitReasons, ...result.problems];
    screens.push(result.manifest ? { screenId: screen.id, current, manifest: result.manifest, problems } : { screenId: screen.id, current, problems });
  }
  return { writes, drafts, screens, revision: read.publishRevision, read, graph };
}
