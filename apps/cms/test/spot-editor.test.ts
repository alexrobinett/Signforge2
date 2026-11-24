// The spot editor's store slice: a save's answer belongs to the spot it was made for, Publish waits
// for a save on its way and publishes the latest edit, and a spot left with an edit waiting is
// saved (#150). Tool calls go through a stubbed `fetch`, held open until the test answers; the
// autosave's second is fake time.
import { liveSources, PREVIEW_PROTOCOL, type TemplateManifest } from '@signforge/contract';
import news from '@signforge/template-news/template.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ComponentProps, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AssetView } from '../src/lib/assets';
import type { SpotView } from '../src/lib/spots';
import { assetsQuery, dataSourceKeys, spotKeys, spotPreviewQuery, templatesQuery } from '../src/queries/spots';
import { SourceSection } from '../src/components/spots/source-section';
import { StoreProvider } from '../src/state/provider';
import { getDataSource } from '../src/server/spots.functions';
import { createPublishingSlice, type PublishingSlice } from '../src/state/publishing';
import { createSpotSourceSlice, sourceStateOf, type SpotSourceSlice } from '../src/state/spot-source';
import { draftOf, fieldProblems } from '../src/lib/spots';
import { type AgentSlice, createAgentSlice } from '../src/state/agent';
import { createSpotEditorSlice, spotShown, type SpotEditorSlice } from '../src/state/spot-editor';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/spots.functions', () => ({
  getBrandKits: vi.fn(),
  getDataSource: vi.fn(),
  getDataSources: vi.fn(),
  getSpot: vi.fn(),
  getSpotPreview: vi.fn(),
  getSpots: vi.fn(),
  getTemplates: vi.fn(),
}));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));
vi.mock('~/server/playlists.functions', () => ({ getPlaylists: vi.fn(), getPlaylist: vi.fn() }));
vi.mock('~/server/schedule.functions', () => ({ getSchedule: vi.fn() }));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), toasts) }));

const ORG = 'org_1';
const spot = (id: string, version: number): SpotView => ({
  id,
  name: id,
  kind: 'url',
  durationMs: 10_000,
  templateVersionId: null,
  data: null,
  assets: null,
  bindings: null,
  assetId: null,
  fit: null,
  url: 'https://example.com/',
  version,
  published: false,
  draftChanged: true,
  publishedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

let answers: ((body: unknown) => void)[] = [];
/** Each tool call, in order: its name and input. */
let calls: { name: string; input: Record<string, unknown> }[] = [];
/** The router as the store reads it: the org its shell shows. */
const router = { state: { matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] } };

/** A store of the spot editor's and the source pickers' slices; `pickers` opens some from the start, as a server render reads it. */
function sourceStore(queryClient: QueryClient, pickers?: (s: SpotSourceSlice['spotSource']) => SpotSourceSlice['spotSource']) {
  return createStore<SpotEditorSlice & SpotSourceSlice>()((set, get) => {
    const sources = createSpotSourceSlice(set as never, get as never, { router, queryClient } as never);
    return {
      ...createSpotEditorSlice(set as never, get as never, { router, queryClient } as never),
      ...sources,
      ...(pickers ? { spotSource: pickers(sources.spotSource) } : {}),
    };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  answers = [];
  calls = [];
  // The stage's frame is only attached, never listened to: no player answers here.
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('location', { origin: 'http://cms.test' });
  vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
    calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
    return new Promise<Response>((resolve) => answers.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 }))));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('spot saves belong to the spot they were made for (review of #97, 2)', () => {
  it("does not apply A's answer to B, opened while A's save was in flight", async () => {
    const queryClient = new QueryClient();
    const store = createStore<SpotEditorSlice>()((set, get) => createSpotEditorSlice(set as never, get as never, { router, queryClient } as never));
    const [a, b] = [spot('spt_a', 4), spot('spt_b', 1)];
    for (const s of [a, b]) queryClient.setQueryData(spotKeys.one(ORG, s.id), s);
    const frame = (): Window => ({ postMessage: () => {} }) as never;

    store.getState().attachStage({ frame: frame(), orgId: ORG, spotId: a.id, orientation: 'landscape' });
    store.getState().editSpot(ORG, a.id, (d) => ({ ...d, name: 'A, renamed' }));
    void store.getState().saveSpotDraft(a.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);

    store.getState().attachStage({ frame: frame(), orgId: ORG, spotId: b.id, orientation: 'landscape' });
    store.getState().editSpot(ORG, b.id, (d) => ({ ...d, name: 'B, renamed' }));
    answers[0]!({ spot: { ...a, name: 'A, renamed', version: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().spotEditor.drafts.spt_b).toMatchObject({ version: 1, status: 'unsaved', error: null, stale: false });
    expect(store.getState().spotEditor.drafts.spt_a).toMatchObject({ version: 5, status: 'saved' });
  });
});

describe('a save on its way (#150)', () => {
  function editorAndPublishing() {
    const queryClient = new QueryClient();
    const store = createStore<SpotEditorSlice & PublishingSlice>()((set, get) => ({
      ...createSpotEditorSlice(set as never, get as never, { router, queryClient } as never),
      ...createPublishingSlice(set as never, get as never, { router, queryClient } as never),
    }));
    return { store, queryClient };
  }

  it('Publish pressed while an autosave is in flight waits for it, saves the latest edit, and publishes that version', async () => {
    const { store, queryClient } = editorAndPublishing();
    const a = spot('spt_a', 4);
    queryClient.setQueryData(spotKeys.one(ORG, a.id), a);
    store.getState().editSpot(ORG, a.id, (d) => ({ ...d, name: 'One' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toMatchObject([{ name: 'update_spot', input: { name: 'One', ifVersion: 4 } }]);

    store.getState().editSpot(ORG, a.id, (d) => ({ ...d, name: 'Two' }));
    void store.getState().publishSpot(ORG, a.id);
    await vi.advanceTimersByTimeAsync(0);
    answers[0]!({ spot: { ...a, name: 'One', version: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.name)).toEqual(['update_spot', 'update_spot']);
    expect(calls[1]!.input).toMatchObject({ name: 'Two', ifVersion: 5 });

    answers[1]!({ spot: { ...a, name: 'Two', version: 6 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[2]).toEqual({ name: 'publish', input: { drafts: [{ kind: 'spot', id: 'spt_a', version: 6 }] } });
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('editing another spot sends the edit left waiting on the first, not dropping it', async () => {
    const { store, queryClient } = editorAndPublishing();
    const [a, b] = [spot('spt_a', 4), spot('spt_b', 1)];
    for (const s of [a, b]) queryClient.setQueryData(spotKeys.one(ORG, s.id), s);
    store.getState().editSpot(ORG, a.id, (d) => ({ ...d, name: 'A, renamed' }));
    store.getState().editSpot(ORG, b.id, (d) => ({ ...d, name: 'B, renamed' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toMatchObject([{ name: 'update_spot', input: { spotId: 'spt_a', name: 'A, renamed', ifVersion: 4 } }]);
    expect(store.getState().spotEditor.drafts.spt_a?.edit.name).toBe('A, renamed');
  });
});

describe('the stage (review of #97)', () => {
  it("says so when what a playlist's preview needs cannot be loaded, instead of waiting for the player", async () => {
    const queryClient = new QueryClient();
    let hear: (e: unknown) => void = () => {};
    vi.stubGlobal('window', { addEventListener: (_: string, f: (e: unknown) => void) => (hear = f) });
    const store = createStore<SpotEditorSlice & { playlistStageDraft: () => Promise<never> }>()((set, get) => ({
      ...createSpotEditorSlice(set as never, get as never, { router: {}, queryClient } as never),
      playlistStageDraft: () => Promise.reject(new Error('get_spot_preview failed: 500')),
    }));
    const frame: Window = { postMessage: () => {} } as never;
    store.getState().attachStage({ frame, orgId: ORG, playlistId: 'pls_a', orientation: 'landscape' });
    hear({ origin: 'http://cms.test', source: frame, data: { sfPreview: PREVIEW_PROTOCOL, type: 'listening' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().spotEditor.stageError).toBe('what it needs did not load (get_spot_preview failed: 500)');
  });

  it('holds an image still being checked and says why, as a publish refuses it; it posts nothing the player cannot fetch', async () => {
    const queryClient = new QueryClient();
    let hear: (e: unknown) => void = () => {};
    vi.stubGlobal('window', { addEventListener: (_: string, f: (e: unknown) => void) => (hear = f) });
    // The stage plays an open review of the agent's (#264): the agent's slice is there, with none open.
    const store = createStore<SpotEditorSlice & AgentSlice>()((set, get) => ({
      ...createSpotEditorSlice(set as never, get as never, { router: {}, queryClient } as never),
      ...createAgentSlice(set as never, get as never, { router: {}, queryClient } as never),
    }));
    const sha = 'b'.repeat(64);
    const image: SpotView = { ...spot('spt_img', 1), kind: 'image', url: null, assetId: 'ast_new' };
    const asset: AssetView = {
      id: 'ast_new',
      name: 'new.jpg',
      kind: 'image',
      status: 'pending',
      sha256: sha,
      type: 'image/jpeg',
      size: 2000,
      width: 1920,
      height: 1080,
      durationMs: null,
      renditions: [{ orientation: 'landscape', sha256: sha, type: 'image/jpeg', size: 2000, width: 1920, height: 1080, sample: null }],
      createdAt: 0,
      updatedAt: 0,
      usageCount: 1,
    };
    queryClient.setQueryData(spotKeys.one(ORG, image.id), image);
    queryClient.setQueryData(templatesQuery(ORG).queryKey, { templates: [] });
    queryClient.setQueryData(assetsQuery(ORG).queryKey, { assets: [asset] });
    queryClient.setQueryData(spotPreviewQuery(ORG, { orientation: 'landscape' }).queryKey, {
      preview: { templates: {}, files: {}, dataSources: [] },
      brandKitId: null,
      problems: [],
      timezone: 'Europe/London',
    });
    const posted: unknown[] = [];
    const frame: Window = { postMessage: (m: never) => posted.push(m) } as never;
    const held = new Promise<void>((resolve) => store.subscribe((s) => s.spotEditor.holding && resolve()));
    store.getState().attachStage({ frame, orgId: ORG, spotId: image.id, orientation: 'landscape' });
    hear({ origin: 'http://cms.test', source: frame, data: { sfPreview: PREVIEW_PROTOCOL, type: 'listening' } });
    await held;
    expect(store.getState().spotEditor.refusals).toEqual(['asset ast_new is still being checked']);
    expect(posted).toEqual([]);
  });
});

describe('a date not picked yet (review of #192)', () => {
  const countdown: TemplateManifest = {
    id: 'countdown',
    version: '1.0.0',
    name: 'Countdown',
    fields: {
      target: { type: 'datetime', label: 'Target' },
      title: { type: 'text', label: 'Title', default: 'Launch', maxLength: 20 },
      events: { type: 'list', label: 'Events', item: { name: { type: 'text', label: 'Name' }, at: { type: 'datetime', label: 'At' } }, default: [] },
    },
    duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
    orientations: ['landscape'],
    uses: [],
    background: '#000',
  };

  /** The editor on a countdown spot holding `data` and `bindings`, as get_spot gave it at version 1. */
  function editing(data: Record<string, unknown>, bindings: SpotView['bindings'] = {}) {
    const queryClient = new QueryClient();
    const store = createStore<SpotEditorSlice>()((set, get) => createSpotEditorSlice(set as never, get as never, { router, queryClient } as never));
    const launch: SpotView = { ...spot('spt_launch', 1), kind: 'template', url: null, templateVersionId: 'tv_countdown', data, assets: {}, bindings };
    queryClient.setQueryData(spotKeys.one(ORG, launch.id), launch);
    queryClient.setQueryData(templatesQuery(ORG).queryKey, {
      templates: [{ versions: [{ id: 'tv_countdown', status: 'approved', manifest: countdown }] }],
    } as never);
    return { store, launch };
  }

  it('saves an edit to a spot whose datetime is not picked, as the server takes it, and says under the field that it needs one', async () => {
    const { store, launch } = editing({ target: '' });
    store.getState().editSpot(ORG, launch.id, (d) => ({ ...d, data: { ...d.data, title: 'Doors open' } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toMatchObject([{ name: 'update_spot', input: { spotId: launch.id, data: { target: '', title: 'Doors open' }, ifVersion: 1 } }]);
    expect(fieldProblems(countdown.fields, { data: { target: '', title: 'Doors open' }, assets: {}, bindings: {} })).toEqual(
      new Map([['target', ['field "target" has no date and time yet']]]),
    );

    // A title over its limit is still held back, as the server would refuse it.
    answers[0]!({ spot: { ...launch, data: { target: '', title: 'Doors open' }, version: 2 } });
    await vi.advanceTimersByTimeAsync(0);
    store.getState().editSpot(ORG, launch.id, (d) => ({ ...d, data: { ...d.data, title: 'x'.repeat(21) } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
  });

  it('holds back a bound datetime with no fallback, as the server refuses it, rather than send a save it will refuse', async () => {
    const { store, launch } = editing({ target: '' }, { target: { dataSourceId: 'src_events', path: 'next.start' } });
    store.getState().editSpot(ORG, launch.id, (d) => ({ ...d, data: { ...d.data, title: 'Doors open' } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
    store.getState().editSpot(ORG, launch.id, (d) => ({ ...d, data: { ...d.data, target: '2026-12-24T18:00' } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toMatchObject([{ name: 'update_spot', input: { data: { target: '2026-12-24T18:00', title: 'Doors open' } } }]);
  });

  it('saves a new list row whose datetime is not picked yet, and still holds back a row the server would refuse for another reason', async () => {
    const { store, launch } = editing({ target: '', events: [] });
    store.getState().editSpot(ORG, launch.id, (d) => ({ ...d, data: { ...d.data, events: [{ name: '', at: '' }] } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toMatchObject([{ name: 'update_spot', input: { data: { target: '', events: [{ name: '', at: '' }] } } }]);
    answers[0]!({ spot: { ...launch, data: { target: '', events: [{ name: '', at: '' }] }, version: 2 } });
    await vi.advanceTimersByTimeAsync(0);
    store.getState().editSpot(ORG, launch.id, (d) => ({ ...d, data: { ...d.data, events: [{ name: 7, at: '' }] } }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
  });
});

describe('an edit after a save, once someone else has saved since (review of #153, 1)', () => {
  it('builds on what the page shows, at the version it shows: never an old value with the newer version', async () => {
    const queryClient = new QueryClient();
    const store = createStore<SpotEditorSlice>()((set, get) => createSpotEditorSlice(set as never, get as never, { router, queryClient } as never));
    const v4 = spot('spt_a', 4);
    queryClient.setQueryData(spotKeys.one(ORG, v4.id), v4);
    const cached = () => queryClient.getQueryData<SpotView>(spotKeys.one(ORG, v4.id))!;
    /** What the page shows for the spot as the cache holds it. */
    const onPage = () => spotShown(store.getState().spotEditor, ORG, cached()) ?? draftOf(cached());
    /** A keystroke in the name field: what it shows, and one more character. */
    const type = (key: string) => {
      const name = `${onPage().name}${key}`;
      store.getState().editSpot(ORG, cached().id, (d) => ({ ...d, name }));
    };

    store.getState().editSpot(ORG, cached().id, (d) => ({ ...d, name: 'Mine' }));
    void store.getState().saveSpotDraft(v4.id);
    await vi.advanceTimersByTimeAsync(0);
    answers[0]!({ spot: { ...v4, name: 'Mine', version: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(onPage().name).toBe('Mine');

    // Someone else renames it; the page reads it again (focus, a publish).
    queryClient.setQueryData(spotKeys.one(ORG, v4.id), { ...v4, name: 'Theirs', version: 6 });
    expect(onPage().name).toBe('Theirs');
    type('!');
    void store.getState().saveSpotDraft(v4.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ name: 'update_spot', input: { name: 'Theirs!', ifVersion: 6 } });
  });

  it('with nobody else saving, the next edit builds on the saved draft, at the version it saved', async () => {
    const queryClient = new QueryClient();
    const store = createStore<SpotEditorSlice>()((set, get) => createSpotEditorSlice(set as never, get as never, { router, queryClient } as never));
    const v4 = spot('spt_a', 4);
    queryClient.setQueryData(spotKeys.one(ORG, v4.id), v4);
    store.getState().editSpot(ORG, v4.id, (d) => ({ ...d, name: 'Mine ' }));
    void store.getState().saveSpotDraft(v4.id);
    await vi.advanceTimersByTimeAsync(0);
    // The server trims the name; the page keeps the space just typed.
    answers[0]!({ spot: { ...v4, name: 'Mine', version: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    const v5 = queryClient.getQueryData<SpotView>(spotKeys.one(ORG, v4.id))!;
    expect(spotShown(store.getState().spotEditor, ORG, v5)?.name).toBe('Mine ');
    store.getState().editSpot(ORG, v5.id, (d) => ({ ...d, name: `${d.name}two` }));
    void store.getState().saveSpotDraft(v4.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toMatchObject({ name: 'update_spot', input: { name: 'Mine two', ifVersion: 5 } });
  });
});

describe('a place picked while a typed edit saves (re-check of #153, 2)', () => {
  it('binds on top of the edit as saved, at the version it saved, not on the spot as it was when the pick began', async () => {
    const queryClient = new QueryClient();
    const store = sourceStore(queryClient);
    const manifest = news as unknown as TemplateManifest;
    const v4: SpotView = { ...spot('spt_news', 4), kind: 'template', templateVersionId: 'tpv_news', url: null, data: {}, assets: {}, bindings: {} };
    queryClient.setQueryData(spotKeys.one(ORG, v4.id), v4);
    let read: (v: unknown) => void = () => {};
    vi.mocked(getDataSource).mockImplementation(() => new Promise((resolve) => (read = resolve)) as never);

    store.getState().editSpot(ORG, v4.id, (d) => ({ ...d, name: 'Typed' }));
    void store.getState().saveSpotDraft(v4.id);
    await vi.advanceTimersByTimeAsync(0);
    // The pick starts from the page's spot at 4, then waits on the source's read.
    const binding = store
      .getState()
      .connectSource({ orgId: ORG, spot: v4, manifest, source: 'source', live: liveSources(manifest.live!).source! }, 'dsrc_news');
    await vi.advanceTimersByTimeAsync(0);
    // Meanwhile the typed edit's save is answered: the spot is at 5.
    answers[0]!({ spot: { ...v4, name: 'Typed', version: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    read({ dataSource: { id: 'dsrc_news' }, snapshot: null });
    await binding;
    expect(store.getState().spotEditor.drafts.spt_news).toMatchObject({
      version: 5,
      edit: { name: 'Typed', bindings: { items: { dataSourceId: 'dsrc_news' } } },
    });
  });
});

describe('a template with two sources (#193)', () => {
  it("keeps each picker to itself, and binds a source's fields only, leaving the other source's bindings", async () => {
    const queryClient = new QueryClient();
    const store = sourceStore(queryClient);
    const weather = { label: 'Weather', source: 'open-meteo', fields: { temp: 'current.temperature_2m' }, place: 'city' } as const;
    const headlines = { label: 'Headlines', source: 'rss', fields: { items: 'items' } } as const;
    const manifest: TemplateManifest = { ...(news as unknown as TemplateManifest), live: { sources: { weather, headlines } } };
    const v4: SpotView = {
      ...spot('spt_frame', 4),
      kind: 'template',
      templateVersionId: 'tpv_frame',
      url: null,
      data: {},
      assets: {},
      bindings: { temp: { dataSourceId: 'weather-1', path: 'current.temperature_2m' } },
    };
    queryClient.setQueryData(spotKeys.one(ORG, v4.id), v4);
    vi.mocked(getDataSource).mockResolvedValue({ dataSource: { id: 'dsrc_news' }, snapshot: null } as never);
    const at = (source: string) => ({ spot: v4, source });

    store.getState().editFeed(at('headlines'), { feedUrl: 'https://feeds.example.com/world.rss' });
    store.getState().openFeedForm(at('weather'), true);
    expect(sourceStateOf(store.getState().spotSource, at('headlines'))).toMatchObject({ feedUrl: 'https://feeds.example.com/world.rss', adding: false });
    expect(sourceStateOf(store.getState().spotSource, at('weather'))).toMatchObject({ feedUrl: '', adding: true });

    await store.getState().connectSource({ orgId: ORG, spot: v4, manifest, source: 'headlines', live: headlines }, 'dsrc_news');
    expect(store.getState().spotEditor.drafts.spt_frame?.edit.bindings).toEqual({
      temp: { dataSourceId: 'weather-1', path: 'current.temperature_2m' },
      items: { dataSourceId: 'dsrc_news', path: 'items' },
    });
    // The bind closed the headlines picker only.
    expect(sourceStateOf(store.getState().spotSource, at('headlines')).focusChange).toBe(true);
    expect(sourceStateOf(store.getState().spotSource, at('weather')).adding).toBe(true);
  });
});

describe('the Source section of a template with two named sources (#193)', () => {
  it('gives every control an id of its own, even when one source is named like another with a suffix', () => {
    // A table source `a` and a feed source `a-table`: "source-" + name + "-table-url" would be the same for both.
    const item = { title: { type: 'text', label: 'Title' } } as const;
    const manifest: TemplateManifest = {
      ...(news as unknown as TemplateManifest),
      fields: { rows: { type: 'list', label: 'Rows', default: [], item }, items: { type: 'list', label: 'Headlines', default: [], item } },
      live: {
        sources: {
          a: { label: 'Menu', source: 'table', fields: { rows: 'rows' } },
          'a-table': { label: 'News', source: 'rss', fields: { items: 'items' } },
        },
      },
    };
    const frame: SpotView = { ...spot('spt_frame', 1), kind: 'template', templateVersionId: 'tpv_frame', url: null, data: {}, assets: {}, bindings: {} };
    const queryClient = new QueryClient();
    queryClient.setQueryData(dataSourceKeys.all(ORG), { dataSources: [] });
    // Both forms open: the table's link form and, with no feed in the org, the feed's.
    const store = sourceStore(queryClient, (s) => ({ spotId: frame.id, pickers: { a: { ...sourceStateOf(s, { spot: frame, source: 'a' }), adding: true } } }));
    const section = createElement(SourceSection, {
      orgId: ORG,
      spot: frame,
      manifest,
      live: manifest.live!,
      draft: draftOf(frame),
      assets: [],
      canManage: true,
      onChange: () => {},
    });
    // StoreProvider's props name its children; built apart, as createElement's arguments cannot satisfy them.
    const provider: ComponentProps<typeof StoreProvider> = { store: store as never, children: section };
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(StoreProvider, provider)));
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(4);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});

describe('deleting a spot (#242)', () => {
  /** The spot editor and the agent's slices, with a router that records where it went. */
  function deletable() {
    const queryClient = new QueryClient();
    const went: string[] = [];
    const at = { ...router, navigate: async ({ to }: { to: string }) => void went.push(to) };
    const store = createStore<SpotEditorSlice & AgentSlice>()((set, get) => ({
      ...createSpotEditorSlice(set as never, get as never, { router: at, queryClient } as never),
      ...createAgentSlice(set as never, get as never, { router: at, queryClient } as never),
    }));
    return { store, queryClient, went };
  }
  /** Answers tool calls with a status, as the tool route does. */
  const withStatus = () => {
    const pending: ((r: Response) => void)[] = [];
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
      return new Promise<Response>((resolve) => pending.push(resolve));
    });
    return (body: unknown, status = 200) => pending.shift()?.(new Response(JSON.stringify(body), { status }));
  };

  /** Spot A open with an edit waiting to save, and Delete confirmed: the call on its way. */
  async function deleting() {
    const d = deletable();
    const reply = withStatus();
    const a = spot('spt_a', 4);
    d.queryClient.setQueryData(spotKeys.one(ORG, a.id), a);
    d.store.getState().editSpot(ORG, a.id, (e) => ({ ...e, name: 'Renamed' }));
    d.store.getState().askDeleteSpot(true);
    void d.store.getState().deleteSpot(ORG, a.id);
    await vi.advanceTimersByTimeAsync(0);
    return { ...d, reply, a };
  }

  it('deletes it, drops the edit waiting to save, and goes to the spot library', async () => {
    const { store, queryClient, went, reply, a } = await deleting();
    expect(calls).toEqual([{ name: 'delete_spot', input: { spotId: 'spt_a' } }]);
    reply({ deleted: 'spt_a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(went).toEqual(['/spots']);
    expect(queryClient.getQueryData(spotKeys.one(ORG, a.id))).toBeUndefined();
    expect(store.getState().spotEditor.deleting).toEqual({ open: false, pending: false, error: null, playlists: [] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map((c) => c.name)).toEqual(['delete_spot']);
  });

  it('names the playlists that play it when refused, and keeps the edit waiting to save', async () => {
    const { store, went, reply } = await deleting();
    reply(
      {
        error: 'conflict',
        message: 'spot spt_a is in 2 playlists: "Lunch", "Main"; take it out of them first',
        details: { playlists: [{ id: 'pls_lunch', name: 'Lunch' }, { id: 'pls_main', name: 'Main' }] },
      },
      409,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().spotEditor.deleting).toEqual({
      open: true,
      pending: false,
      error: expect.stringMatching(/^Playlists play this spot/),
      playlists: [
        { id: 'pls_lunch', name: 'Lunch' },
        { id: 'pls_main', name: 'Main' },
      ],
    });
    expect(went).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toMatchObject({ name: 'update_spot', input: { spotId: 'spt_a', name: 'Renamed' } });
  });

  it("deletes a fill's first try on Try another template, then opens New spot with the same material", async () => {
    const { store, queryClient, went } = deletable();
    const reply = withStatus();
    const a = spot('spt_a', 1);
    queryClient.setQueryData(spotKeys.one(ORG, a.id), a);
    store.setState((s) => ({
      agent: { ...s.agent, filled: { spt_a: { kind: 'fill', marks: {}, photo: null, link: 'https://example.com/flyer', uploading: false, uploadError: null } } },
    }) as never);
    void store.getState().fillWithAnother(ORG, a.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ name: 'delete_spot', input: { spotId: 'spt_a' } }]);
    reply({ deleted: 'spt_a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(went).toEqual(['/spots', '/spots']);
    expect(store.getState().spotEditor.newSpot.open).toBe(true);
    expect(store.getState().agent.fill).toMatchObject({ link: 'https://example.com/flyer', again: true });
    expect(store.getState().agent.filled.spt_a).toBeUndefined();
  });
});
