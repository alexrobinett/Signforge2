// The stage plays what a publish sends: the spot editor's stage (`compilePreview`) and the
// publish's draft check (packages/tools `probeDrafts`) turn the same draft into the same spot, or
// refuse it for the same reason. Both run @signforge/compiler's draft-to-spot module; each reads
// the org its own way (the CMS its tool views, the tools the org graph), and that is what these
// tests hold together.
import { createHash } from 'node:crypto';
import type { SpotDraft } from '@signforge/compiler/draft';
import type { Orientation, ScreenManifest } from '@signforge/contract';
import stressGolden from '@signforge/cli/golden/stress.json';
import { previewInput, probeDrafts, type OrgGraph } from '@signforge/tools';
import { describe, expect, it } from 'vitest';
import type { AssetView } from '~/lib/assets';
import { withDraftKit } from '~/lib/brand-kits';
import { compilePlaylistPreview, compilePreview, draftOf, type SpotView, type TemplateVersionView } from '~/lib/spots';

const golden: ScreenManifest = JSON.parse(JSON.stringify(stressGolden));
const opts = { hash: (t: string) => createHash('sha256').update(t).digest('hex'), now: new Date('2026-11-20T12:00:00.000Z') };
const sha = (c: string) => c.repeat(64);
const assetId = (file: string) => `ast_${file.slice(0, 8)}`;

/** The stress project's org as a publish reads it: every base template, its files as assets, its data sources. */
function stressOrg(change: { timezone?: string | null; status?: AssetView['status'] } = {}): OrgGraph {
  const templateVersions: OrgGraph['templateVersions'] = new Map(
    Object.entries(golden.templates).map(([key, t]) => [
      `tpv_${t.manifest.id}`,
      { key, manifest: t.manifest, html: t.html, size: golden.files[t.html]!.size, status: 'approved' },
    ]),
  );
  const assets: OrgGraph['assets'] = new Map();
  for (const [file, f] of Object.entries(golden.files)) {
    if (f.type === 'text/html' || f.type.startsWith('font/')) continue;
    const video = f.type.startsWith('video/');
    const base = { orgId: 'org', name: file.slice(0, 8), createdAt: 0, updatedAt: 0 };
    const rendition = (orientation: Orientation, sha256: string, size: number) => ({
      ...base,
      id: `rnd_${orientation}_${file.slice(0, 8)}`,
      assetId: assetId(file),
      orientation,
      sha256,
      type: f.type,
      size,
      width: 0,
      height: 0,
    });
    assets.set(assetId(file), {
      asset: {
        ...base,
        id: assetId(file),
        kind: video ? 'video' : 'image',
        sha256: file,
        type: f.type,
        size: f.size,
        width: null,
        height: null,
        durationMs: null,
        status: change.status ?? 'verified',
      },
      renditions: video ? [] : [rendition('landscape', file, f.size), rendition('portrait', sha('9'), 1)],
    });
  }
  return {
    screens: [],
    groupsOf: new Map(),
    templateVersions,
    assets,
    dataSources: Object.values(golden.dataSources),
    spots: [],
    playlists: [],
    items: new Map(),
    entries: [],
    defaultPlaylist: null,
    brandKits: new Map(),
    brandAssignments: [],
    publishRevision: 0,
    timezone: change.timezone === undefined ? golden.screen.timezone : change.timezone,
  };
}

/** Each of the stress project's spots as its draft, the way `get_spot` gives it. */
const drafts: SpotDraft[] = Object.values(golden.spots).map((s) => {
  const none = { templateVersionId: null, data: null, assets: null, bindings: null, assetId: null, fit: null, url: null };
  const base = { ...none, id: s.id, name: s.name, durationMs: s.durationMs };
  if (s.kind === 'template') {
    return {
      ...base,
      kind: 'template',
      templateVersionId: `tpv_${golden.templates[s.template]!.manifest.id}`,
      data: s.data,
      assets: Object.fromEntries(Object.entries(s.assets).map(([field, file]) => [field, assetId(file)])),
      bindings: s.bindings
        ? Object.fromEntries(
            Object.entries(s.bindings).map(([field, b]) => [field, { dataSourceId: b.source, path: b.path, ...(b.table ? { table: b.table } : {}) }]),
          )
        : null,
    };
  }
  if (s.kind === 'url') return { ...base, kind: 'url', url: s.url };
  return { ...base, kind: s.kind, assetId: assetId(s.file), fit: s.fit };
});

/** The CMS's reads of the same org: `get_spot`, `list_assets`, `list_templates` and `get_spot_preview`, as their outputs. */
function views(graph: OrgGraph, draft: SpotDraft, orientation: Orientation) {
  const spot: SpotView = { ...draft, version: 1, published: false, draftChanged: true, publishedAt: null, createdAt: 0, updatedAt: 0 };
  const assets: AssetView[] = [...graph.assets.values()].map(({ asset: a, renditions }) => ({
    ...a,
    renditions: renditions.map((r) => ({ orientation: r.orientation, sha256: r.sha256, type: r.type, size: r.size, width: r.width, height: r.height })),
    usageCount: 0,
  }));
  const v = draft.templateVersionId ? graph.templateVersions.get(draft.templateVersionId) : undefined;
  const version: TemplateVersionView | undefined = v && {
    id: draft.templateVersionId ?? '',
    key: v.key,
    version: v.manifest.version,
    templateId: `tpl_${v.manifest.id}`,
    status: v.status,
    manifest: v.manifest,
    bundleSha256: v.html,
    checkReport: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const { input, brandKitId, problems } = previewInput(graph, orientation, {
    ...(draft.templateVersionId ? { templateVersionId: draft.templateVersionId } : {}),
  });
  const versions = new Map(version ? [[version.id, version]] : []);
  return { spot, assets, versions, preview: { preview: input, brandKitId, problems, timezone: graph.timezone } };
}

/** What the stage plays for a draft, and why it would not publish. */
async function stage(graph: OrgGraph, draft: SpotDraft, orientation: Orientation = 'landscape') {
  const v = views(graph, draft, orientation);
  const { manifest, problems, refused } = await compilePreview({
    spot: v.spot,
    draft: draftOf(v.spot),
    versions: v.versions,
    preview: v.preview.preview,
    timezone: v.preview.timezone,
    assets: v.assets,
    orientation,
    live: true,
  });
  return { manifest: manifest && { ...manifest, generatedAt: opts.now.toISOString() }, problems, refused };
}

/** What a publish's check of the draft compiles, and why it would hold the draft back. */
const publish = (graph: OrgGraph, draft: SpotDraft, orientation: Orientation = 'landscape') => probeDrafts(graph, orientation, opts, { spots: [draft] });

const draftOfKind = (kind: SpotDraft['kind']) => drafts.find((d) => d.kind === kind)!;

describe('the stage and the publish', () => {
  it('play every base template, image and video spot as the same spot, in both orientations', async () => {
    const templates = new Set(drafts.flatMap((d) => (d.kind === 'template' ? [d.templateVersionId] : [])));
    expect(templates.size).toBe(Object.keys(golden.templates).length);
    for (const orientation of ['landscape', 'portrait'] as const) {
      for (const d of drafts) {
        const published = await publish(stressOrg(), d, orientation);
        expect(published.problems, d.id).toEqual([]);
        expect(await stage(stressOrg(), d, orientation), `${d.id} ${orientation}`).toEqual(published);
      }
    }
  });

  it("play a spot as screens get it: the stage's spot is the one the stress golden has", async () => {
    for (const d of drafts) expect((await stage(stressOrg(), d)).manifest!.spots[d.id], d.id).toEqual(golden.spots[d.id]);
  });

  it("refuse an asset still being checked for the same reason, an image spot's or a template's image field, and neither plays it", async () => {
    const graph = stressOrg({ status: 'pending' });
    const image = draftOfKind('image');
    expect(await stage(graph, image)).toEqual({ problems: [`spot ${image.id}: asset ${image.assetId} is still being checked`], refused: true });
    expect(await publish(graph, image)).toEqual(await stage(graph, image));
    const field = drafts.find((d) => Object.keys(d.assets ?? {}).length)!;
    expect((await stage(graph, field)).problems).toEqual(Object.values(field.assets!).map((id) => `spot ${field.id}: asset ${id} is still being checked`));
    expect(await publish(graph, field)).toEqual(await stage(graph, field));
  });

  it('refuse a spot on a template version not approved yet, in the words a publish holds it back with', async () => {
    const graph = stressOrg();
    const d = draftOfKind('template');
    const v = graph.templateVersions.get(d.templateVersionId!)!;
    graph.templateVersions.set(d.templateVersionId!, { ...v, status: 'draft' });
    const want = { problems: [`spot ${d.id}: template ${v.key} is draft; only an approved version can be published`], refused: true };
    expect(await stage(graph, d)).toEqual(want);
    expect(await publish(graph, d)).toEqual(want);
  });

  it("refuse a brand kit whose logo is still being checked: the stage's draft kit and the publish's kit, for the same reason", async () => {
    const graph = stressOrg();
    const logo = [...graph.assets.values()].find((a) => a.asset.kind === 'image')!;
    graph.assets.set(logo.asset.id, { ...logo, asset: { ...logo.asset, status: 'pending' } });
    const row = {
      id: 'bk_north',
      orgId: 'org',
      name: 'North',
      colorsJson: JSON.stringify({ primary: '#123456', accent: '#ff8800', background: '#ffffff', surface: '#f4f4f4', text: '#111111', muted: '#666666' }),
      shape: 'soft' as const,
      displayFontId: null,
      bodyFontId: null,
      logoOnDarkAssetId: logo.asset.id,
      logoOnLightAssetId: null,
      rowVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    graph.brandKits.set(row.id, row);
    graph.brandAssignments.push({ orgId: 'org', brandKitId: row.id, target: 'org', groupId: null, screenId: null, updatedAt: 0 });
    expect(previewInput(graph, 'landscape', {}).problems).toEqual([`brand kit ${row.id}: logo asset ${logo.asset.id} is still being checked`]);
    const v = views(graph, draftOfKind('template'), 'landscape');
    const draft = {
      name: row.name,
      colors: { ...JSON.parse(row.colorsJson), onPrimary: null, onAccent: null },
      shape: row.shape,
      displayFontId: null,
      bodyFontId: null,
      logoOnDarkAssetId: logo.asset.id,
      logoOnLightAssetId: null,
    };
    expect(withDraftKit({ preview: v.preview.preview, kitId: row.id, draft, assets: v.assets, orientation: 'landscape' })).toEqual({
      problems: [`logo asset ${logo.asset.id} is still being checked`],
    });
  });

  it('refuse a rejected asset alike, and neither plays it', async () => {
    const graph = stressOrg({ status: 'rejected' });
    const d = draftOfKind('video');
    expect(await stage(graph, d)).toEqual(await publish(graph, d));
    expect((await stage(graph, d)).manifest).toBeUndefined();
  });

  it('refuse an image or video spot with no asset alike, with nothing to play', async () => {
    for (const kind of ['image', 'video'] as const) {
      const d = { ...draftOfKind(kind), assetId: null };
      expect(await stage(stressOrg(), d)).toEqual({ problems: [`spot ${d.id}: no asset`], refused: true });
      expect(await publish(stressOrg(), d)).toEqual({ problems: [`spot ${d.id}: no asset`], refused: true });
    }
  });

  it("compile in the org's time zone for new screens", async () => {
    const graph = stressOrg({ timezone: 'Asia/Kolkata' });
    const d = draftOfKind('template');
    const staged = await stage(graph, d);
    expect(staged.manifest!.screen.timezone).toBe('Asia/Kolkata');
    expect(staged).toEqual(await publish(graph, d));
  });

  it("without one, refuse alike; the stage keeps the editor's own zone and the publish UTC, which no check reads", async () => {
    const graph = stressOrg({ timezone: null });
    const d = { ...draftOfKind('template'), durationMs: 1 };
    const staged = await stage(graph, d);
    const published = await publish(graph, d);
    expect(staged.problems).toEqual(published.problems);
    expect(staged.problems).not.toEqual([]);
    const ok = draftOfKind('template');
    expect((await stage(graph, ok)).manifest!.screen.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect((await publish(graph, ok)).manifest!.screen.timezone).toBe('UTC');
  });

  it('fit an image whose draft names no fit the same way', async () => {
    const d = { ...draftOfKind('image'), fit: null };
    const staged = await stage(stressOrg(), d);
    expect(staged).toEqual(await publish(stressOrg(), d));
    expect(staged.manifest!.spots[d.id]).toMatchObject({ fit: 'cover' });
  });

  it("bind a spot's fields to its sources as the same bindings", async () => {
    const d = drafts.find((x) => x.bindings && Object.values(x.bindings).some((b) => b.table)) ?? drafts.find((x) => x.bindings)!;
    const staged = await stage(stressOrg(), d);
    expect(staged).toEqual(await publish(stressOrg(), d));
    expect(staged.manifest!.spots[d.id]).toEqual(golden.spots[d.id]);
  });

  it("leave a playlist's spot out of its stage for the reason a publish would hold the playlist back", async () => {
    const graph = stressOrg();
    const missing = { ...draftOfKind('image'), assetId: null };
    const kept = draftOfKind('template');
    const v = views(graph, kept, 'landscape');
    const spots = [missing, kept].map((d) => views(graph, d, 'landscape').spot);
    const result = await compilePlaylistPreview({
      playlist: { id: 'pl', name: 'Loop', transition: { type: 'cut' }, spotIds: [missing.id, kept.id] },
      spots,
      versions: v.versions,
      preview: v.preview.preview,
      timezone: v.preview.timezone,
      assets: v.assets,
      orientation: 'landscape',
    });
    expect([...result.leftOut]).toEqual([[missing.id, ['no asset']]]);
    expect(Object.keys(result.manifest!.spots)).toEqual([kept.id]);
  });
});
