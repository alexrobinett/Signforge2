// The spot editor's store slice: a save's answer belongs to the spot it was made for, Publish waits
// for a save on its way and publishes the latest edit, and a spot left with an edit waiting is
// saved (#150). Tool calls go through a stubbed `fetch`, held open until the test answers; the
// autosave's second is fake time.
import { PREVIEW_PROTOCOL } from '@signforge/contract';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { SpotView } from '../src/lib/spots';
import { spotKeys } from '../src/queries/spots';
import { createPublishingSlice, type PublishingSlice } from '../src/state/publishing';
import { createSpotEditorSlice, type SpotEditorSlice } from '../src/state/spot-editor';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/spots.functions', () => ({ getBrandKits: vi.fn(), getSpot: vi.fn(), getSpotPreview: vi.fn(), getSpots: vi.fn(), getTemplates: vi.fn() }));
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
    store.getState().editSpot(ORG, a, (d) => ({ ...d, name: 'A, renamed' }));
    void store.getState().saveSpotDraft(a.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);

    store.getState().attachStage({ frame: frame(), orgId: ORG, spotId: b.id, orientation: 'landscape' });
    store.getState().editSpot(ORG, b, (d) => ({ ...d, name: 'B, renamed' }));
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
    store.getState().editSpot(ORG, a, (d) => ({ ...d, name: 'One' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toMatchObject([{ name: 'update_spot', input: { name: 'One', ifVersion: 4 } }]);

    store.getState().editSpot(ORG, a, (d) => ({ ...d, name: 'Two' }));
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

  it('opening another spot sends the edit left waiting on the first, not dropping it', async () => {
    const { store, queryClient } = editorAndPublishing();
    const [a, b] = [spot('spt_a', 4), spot('spt_b', 1)];
    for (const s of [a, b]) queryClient.setQueryData(spotKeys.one(ORG, s.id), s);
    store.getState().editSpot(ORG, a, (d) => ({ ...d, name: 'A, renamed' }));
    store.getState().editSpot(ORG, b, (d) => ({ ...d, name: 'B, renamed' }));
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
});
