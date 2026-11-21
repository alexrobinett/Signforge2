// The brand kit page's store slice: its previews keep re-theming as the kit is edited. The player
// is a stub frame that records what it is posted; the server functions are stubbed at the network
// edge, and the Query client forgets an unobserved entry after a second, as the page's does after five
// minutes. The compile's hashing is the test's too: the real crypto.subtle finishes in wall-clock
// time, so which of two compiles finished first was the runner's speed (#103's flaky queue test).
import { createHash } from 'node:crypto';
import { PREVIEW_PROTOCOL, templateKey, type TemplateManifest } from '@signforge/contract';
import clock from '@signforge/template-clock/template.json';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AssetView } from '../src/lib/assets';
import type { BrandKitView } from '../src/lib/brand-kits';
import type { SpotPreview, SpotView, TemplateView } from '../src/lib/spots';
import { getSpotPreview } from '../src/server/spots.functions';
import { assetsQuery, brandKitsQuery, spotPreviewQuery, spotsQuery, templatesQuery } from '../src/queries/spots';
import { createBrandKitsSlice, previewKey, type BrandKitsSlice } from '../src/state/brand-kits';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/spots.functions', () => ({ getBrandKits: vi.fn(), getSpot: vi.fn(), getSpotPreview: vi.fn(), getSpots: vi.fn(), getTemplates: vi.fn() }));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));

const ORG = 'org_1';
const manifest = clock as unknown as TemplateManifest;
const HTML = 'c'.repeat(64);
const version = {
  id: 'tpv_clock',
  templateId: 'tpl_clock',
  key: templateKey(manifest),
  version: manifest.version,
  status: 'approved' as const,
  manifest,
  bundleSha256: HTML,
  checkReport: null,
  createdAt: 0,
  updatedAt: 0,
};
const templates: TemplateView[] = [{ id: 'tpl_clock', owner: 'base', key: manifest.id, name: manifest.name, versions: [version] }];
const spot: SpotView = {
  id: 'spt_clock',
  name: 'Lobby clock',
  kind: 'template',
  durationMs: 10_000,
  templateVersionId: version.id,
  data: {},
  assets: {},
  bindings: null,
  assetId: null,
  fit: null,
  url: null,
  version: 1,
  published: false,
  draftChanged: true,
  publishedAt: null,
  createdAt: 0,
  updatedAt: 0,
};
const kit = (id: string, primary: string): BrandKitView => ({
  id,
  name: id,
  colors: {
    primary,
    onPrimary: '#ffffff',
    accent: '#f59e0b',
    onAccent: '#000000',
    background: '#0b0f17',
    surface: '#1a2130',
    text: '#f5f7fa',
    muted: '#a3acbb',
  },
  derived: ['onPrimary', 'onAccent'],
  shape: 'soft',
  displayFont: null,
  bodyFont: null,
  logo: null,
  isDefault: false,
  groupIds: [],
  screenIds: [],
  reach: [],
  conflicts: [],
  warnings: [],
  version: 1,
  createdAt: 0,
  updatedAt: 0,
});
const preview = (brandKitId: string): SpotPreview => ({
  preview: { templates: { [version.key]: { manifest, html: HTML } }, files: { [HTML]: { size: 100, type: 'text/html' } }, dataSources: [] },
  brandKitId,
  problems: [],
  timezone: null,
});

let hear: (e: unknown) => void = () => {};

/** The router as the store reads it: where the member is, in which org, and where it was sent. */
const router = {
  state: { location: { href: '' }, matches: [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }] },
  navigate: vi.fn(async () => {}),
};

/** Hashes held back by the test, by a text their input contains; every other hash is done at once. */
const held = new Map<string, Promise<void>>();

/** Holds back the hash of any compile whose manifest contains `text` until the returned function is called. */
function holdHashOf(text: string): () => void {
  let release = () => {};
  held.set(
    text,
    new Promise<void>((go) => {
      release = go;
    }),
  );
  return release;
}

/** Lets every pending compile finish, held ones excepted. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  // Timers only: the compile hashes with crypto.subtle, which resolves outside fake time.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('window', { addEventListener: (_: string, f: (e: unknown) => void) => (hear = f) });
  vi.stubGlobal('location', { origin: 'http://cms.test' });
  held.clear();
  router.state.location.href = '/settings/brand-kits';
  router.state.matches = [{ routeId: '/_app', loaderData: { organization: { id: ORG } } }];
  router.navigate.mockClear();
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_: AlgorithmIdentifier, data: BufferSource) => {
    const bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
    const text = new TextDecoder().decode(bytes);
    for (const [k, wait] of held) if (text.includes(k)) await wait;
    const d = createHash('sha256').update(bytes).digest();
    return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
  });
  vi.mocked(getSpotPreview).mockImplementation(async ({ data }: { data: { brandKitId?: string } }) => preview(data.brandKitId ?? '')) as never;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The kit page as the store sees it: what the page reads and observes, and a player frame that records its drafts. */
function page(kits: BrandKitView[], assets: AssetView[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 1000 } } });
  queryClient.setQueryData(brandKitsQuery(ORG).queryKey, { brandKits: kits });
  queryClient.setQueryData(spotsQuery(ORG).queryKey, { spots: [spot] });
  queryClient.setQueryData(templatesQuery(ORG).queryKey, { templates });
  queryClient.setQueryData(assetsQuery(ORG).queryKey, { assets });
  // The loader reads the first kit's preview input; nothing on the page observes it.
  queryClient.setQueryData(spotPreviewQuery(ORG, previewKey({ kitId: kits[0]!.id, templateVersionId: version.id })).queryKey, preview(kits[0]!.id));
  // The page's components observe these reads (useSuspenseQuery), so they are kept.
  const observe = (q: object) => new QueryObserver(queryClient, q as never).subscribe(() => {});
  for (const q of [brandKitsQuery(ORG), spotsQuery(ORG), templatesQuery(ORG), assetsQuery(ORG)]) observe(q);
  const store = createStore<BrandKitsSlice>()((set, get) => createBrandKitsSlice(set as never, get as never, { router, queryClient } as never));
  const posted: string[] = [];
  const frame: Window = {
    postMessage: (m: { manifest: { brand?: { colors: { primary: string } } } }) => posted.push(m.manifest.brand?.colors.primary ?? 'none'),
  } as never;
  const attach = (kitId: string) => store.getState().attachKitPreview(spot.id, { frame, orgId: ORG, kitId, spotId: spot.id, templateVersionId: version.id });
  const listening = () => hear({ origin: 'http://cms.test', source: frame, data: { sfPreview: PREVIEW_PROTOCOL, type: 'listening' } });
  const playing = () => hear({ origin: 'http://cms.test', source: frame, data: { sfPreview: PREVIEW_PROTOCOL, type: 'playing', spot: spot.id } });
  return { store, posted, attach, listening, playing };
}

describe("the kit page's previews (review of #103)", () => {
  it('say why a kit whose logo is still being checked is not shown, and send the player nothing (review of #158)', async () => {
    const logo: AssetView = {
      id: 'ast_logo',
      name: 'logo.png',
      kind: 'image',
      status: 'pending',
      sha256: 'e'.repeat(64),
      type: 'image/png',
      size: 900,
      width: 400,
      height: 100,
      durationMs: null,
      renditions: [{ orientation: 'landscape', sha256: 'e'.repeat(64), type: 'image/png', size: 900, width: 400, height: 100 }],
      createdAt: 0,
      updatedAt: 0,
      usageCount: 1,
    };
    const a = { ...kit('bk_a', '#2563eb'), logo: { onDarkAssetId: logo.id, onLightAssetId: null } };
    const { store, posted, attach, listening } = page([a], [logo]);
    attach(a.id);
    listening();
    await vi.waitFor(() => expect(store.getState().brandKits.previews[spot.id]?.refused).toBe('logo asset ast_logo is still being checked'));
    expect(store.getState().brandKits.previews[spot.id]).toEqual({ playing: false, error: null, refused: 'logo asset ast_logo is still being checked' });
    expect(posted).toEqual([]);
  });

  it('keep re-theming after the page has been open longer than Query keeps an unobserved read (1)', async () => {
    const a = kit('bk_a', '#2563eb');
    const { store, posted, attach, listening, playing } = page([a]);
    attach(a.id);
    listening();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb']));
    playing();

    await vi.advanceTimersByTimeAsync(5_000);
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#c8102e' } }));
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb', '#c8102e']));
  });

  it('re-theme for the next kit when the same frame is attached to it, as after Duplicate (2)', async () => {
    const [a, b] = [kit('bk_a', '#2563eb'), kit('bk_b', '#7a3e1d')];
    const { store, posted, attach, listening, playing } = page([a, b]);
    attach(a.id);
    listening();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb']));
    playing();

    // The route stays mounted on another kit: the frame's ref callback runs its cleanup, then attaches again.
    store.getState().attachKitPreview(spot.id, null);
    attach(b.id);
    await vi.waitFor(() => expect(posted.at(-1)).toBe('#7a3e1d'));
    playing();
    store.getState().editKit(ORG, b.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#0f766e' } }));
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(posted.at(-1)).toBe('#0f766e'));
  });
});

describe('a kit save (re-check of #103)', () => {
  it('sends the version its draft started from, so a change made since is refused rather than overwritten', async () => {
    const calls: { name: string; input: { ifVersion?: number } }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ name: url.split('/').at(-1) ?? '', input: JSON.parse(init.body) });
      return new Response(JSON.stringify({ error: 'conflict', message: 'stale', details: { version: 2 } }), { status: 409 });
    });
    const v1 = kit('bk_a', '#2563eb');
    const { store } = page([v1]);
    store.getState().editKit(ORG, v1.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#c8102e' } }));
    // Someone else saves; the page reads the kits again (after an assignment, say) and holds v2.
    const v2 = { ...v1, shape: 'round' as const, version: 2 };
    await store.getState().saveKit(v2.id);
    expect(calls).toMatchObject([{ name: 'update_brand_kit', input: { brandKitId: 'bk_a', ifVersion: 1 } }]);
    // The page says it in a kit's words (This kit changed since you opened it).
    expect(store.getState().brandKits.drafts.bk_a).toMatchObject({
      stale: true,
      error: 'This changed since you opened it.',
      edit: { colors: { primary: '#c8102e' } },
    });
  });

  it('a save answered after the member switched org changes nothing: the kit is not marked saved, and its version stays (versioned draft)', async () => {
    let answer: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (answer = resolve)));
    const a = kit('bk_a', '#2563eb');
    const { store } = page([a]);
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#c8102e' } }));
    const saving = store.getState().saveKit(a.id);
    await settle();
    router.state.matches = [{ routeId: '/_app', loaderData: { organization: { id: 'org_2' } } }];
    answer(new Response(JSON.stringify({ brandKit: { ...a, version: 2 } }), { status: 200 }));
    await saving;
    expect(store.getState().brandKits.drafts.bk_a).toMatchObject({ status: 'unsaved', version: 1, savedAt: null, pending: false });
  });
});

describe('drafts to one player (re-check of #103)', () => {
  it('posts one draft at a time: edits made while the player applies one are sent as the newest, once it answers', async () => {
    const a = kit('bk_a', '#2563eb');
    const { store, posted, attach, listening, playing } = page([a]);
    attach(a.id);
    listening();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb']));
    // The player has not answered the first draft yet: two quick edits wait, and only the newer is sent.
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#c8102e' } }));
    await vi.advanceTimersByTimeAsync(100);
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#0f766e' } }));
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(posted).toEqual(['#2563eb']);
    playing();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb', '#0f766e']));
  });

  it('does not send a queued edit that a newer one still compiling has made old, when the player answers', async () => {
    const a = kit('bk_a', '#2563eb');
    const { store, posted, attach, listening, playing } = page([a]);
    attach(a.id);
    listening();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb']));
    // A slow runner: the first edit's compile is done and queued, the second's is still hashing.
    const release = holdHashOf('#0f766e');
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#c8102e' } }));
    await vi.advanceTimersByTimeAsync(100);
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#0f766e' } }));
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    playing();
    await settle();
    expect(posted).toEqual(['#2563eb']);
    release();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb', '#0f766e']));
  });
});

describe('drafts to one player across a kit switch and a reload (re-check of #103, optional 1 and 2)', () => {
  it("waits for the player's answer to the old kit's draft before sending the new kit's, and drops the old kit's queued edit", async () => {
    const [a, b] = [kit('bk_a', '#2563eb'), kit('bk_b', '#7a3e1d')];
    const { store, posted, attach, listening, playing } = page([a, b]);
    attach(a.id);
    listening();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb']));
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#c8102e' } }));
    await vi.advanceTimersByTimeAsync(100);
    // The route stays mounted on kit B (Duplicate) while A's draft is still being applied.
    store.getState().attachKitPreview(spot.id, null);
    attach(b.id);
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((r) => setImmediate(r));
    expect(posted).toEqual(['#2563eb']);
    playing();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb', '#7a3e1d']));
  });

  it('a player that loads again gets the newest draft once, not again when it answers', async () => {
    const a = kit('bk_a', '#2563eb');
    const { store, posted, attach, listening, playing } = page([a]);
    attach(a.id);
    listening();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb']));
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#111111' } }));
    await vi.advanceTimersByTimeAsync(100);
    listening();
    await vi.waitFor(() => expect(posted).toEqual(['#2563eb', '#111111']));
    playing();
    await vi.advanceTimersByTimeAsync(100);
    await new Promise((r) => setImmediate(r));
    expect(posted).toEqual(['#2563eb', '#111111']);
  });
});

describe('kit actions run one at a time (review of #143)', () => {
  /** `fetch` for the tools: each call is recorded, and its answer waits until the test gives one. */
  function heldTools() {
    const calls: { name: string; input: unknown; answer: (status: number, body: unknown) => void }[] = [];
    let arrived: () => void = () => {};
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      const answer = new Promise<Response>((resolve) => {
        calls.push({
          name: url.split('/').at(-1) ?? '',
          input: JSON.parse(init.body),
          answer: (status, body) => resolve(new Response(JSON.stringify(body), { status })),
        });
      });
      arrived();
      return answer;
    });
    /** Resolves once the tools have been called `n` times in all. */
    const called = (n: number) =>
      new Promise<void>((resolve) => {
        arrived = () => calls.length >= n && resolve();
        arrived();
      });
    return { calls, called };
  }
  const refused = { error: 'error', message: 'Refused' };

  it('a Duplicate, or a new kit, while the kit saves is ignored; so is a save while Duplicate runs', async () => {
    const { calls, called } = heldTools();
    const a = kit('bk_a', '#2563eb');
    const { store } = page([a]);
    store.getState().editKit(ORG, a.id, (d) => ({ ...d, colors: { ...d.colors, primary: '#335577' } }));
    const saving = store.getState().saveKit(a.id);
    await called(1);
    await store.getState().duplicateKit(ORG, a);
    store.getState().nameNewKit('Spring');
    await store.getState().createKit(ORG);
    expect(calls.map((c) => c.name)).toEqual(['update_brand_kit']);
    calls[0]!.answer(409, refused);
    await saving;

    const duplicating = store.getState().duplicateKit(ORG, a);
    await called(2);
    await store.getState().saveKit(a.id);
    await store.getState().createKit(ORG);
    expect(calls.map((c) => c.name)).toEqual(['update_brand_kit', 'create_brand_kit']);
    calls[1]!.answer(409, refused);
    await duplicating;
    expect(store.getState().brandKits.pending).toBeNull();
  });

  it('a request that gets no answer releases the action, with its message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const a = kit('bk_a', '#2563eb');
    const { store } = page([a]);
    await store.getState().makeDefaultKit(ORG, a.id);
    expect(store.getState().brandKits).toMatchObject({
      pending: null,
      actionError: { kitId: 'bk_a', text: 'Could not reach SignForge. Check your connection and try again.' },
    });
  });

  it('a new kit on its way goes on with its dialog closed: Escape and a second Create make no second kit (re-check of #143, 4)', async () => {
    const { calls, called } = heldTools();
    const { store } = page([kit('bk_a', '#2563eb')]);
    store.getState().openNewKit(true);
    store.getState().nameNewKit('One');
    const creating = store.getState().createKit(ORG);
    await called(1);
    store.getState().openNewKit(false);
    store.getState().openNewKit(true);
    expect(store.getState().brandKits.newKit).toMatchObject({ open: true, pending: true, name: 'One' });
    store.getState().nameNewKit('Two');
    await store.getState().createKit(ORG);
    expect(calls.map((c) => c.name)).toEqual(['create_brand_kit']);
    calls[0]!.answer(200, { brandKit: { ...kit('bk_one', '#2563eb'), name: 'One' } });
    await creating;
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith({ to: '/settings/brand-kits/$kitId', params: { kitId: 'bk_one' } });
  });

  it('a copy that is made after the member has moved on does not take them away from where they are now', async () => {
    const { calls, called } = heldTools();
    const a = kit('bk_a', '#2563eb');
    const { store } = page([a]);
    const duplicating = store.getState().duplicateKit(ORG, a);
    await called(1);
    router.state.location.href = '/settings/general';
    calls[0]!.answer(200, { brandKit: kit('bk_copy', '#2563eb') });
    await duplicating;
    expect(router.navigate).not.toHaveBeenCalled();
    expect(store.getState().brandKits.pending).toBeNull();
  });
});
