// The spot editor's store slice: a save's answer belongs to the spot it was made for. Tool calls go
// through a stubbed `fetch`, held open until the test answers.
import { PREVIEW_PROTOCOL } from '@signforge/contract';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { SpotView } from '../src/lib/spots';
import { spotKeys } from '../src/queries/spots';
import { createSpotEditorSlice, type SpotEditorSlice } from '../src/state/spot-editor';

// The tab's org comes from the page's router, which a store test has none of.
vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/server/spots.functions', () => ({ getBrandKits: vi.fn(), getSpot: vi.fn(), getSpotPreview: vi.fn(), getSpots: vi.fn(), getTemplates: vi.fn() }));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));

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

beforeEach(() => {
  vi.useFakeTimers();
  answers = [];
  // The stage's frame is only attached, never listened to: no player answers here.
  vi.stubGlobal('window', { addEventListener: () => {} });
  vi.stubGlobal('location', { origin: 'http://cms.test' });
  vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => answers.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })))));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('spot saves belong to the spot they were made for (review of #97, 2)', () => {
  it("does not apply A's answer to B, opened while A's save was in flight", async () => {
    const queryClient = new QueryClient();
    const store = createStore<SpotEditorSlice>()((set, get) => createSpotEditorSlice(set as never, get as never, { router: {}, queryClient } as never));
    const [a, b] = [spot('spt_a', 4), spot('spt_b', 1)];
    for (const s of [a, b]) queryClient.setQueryData(spotKeys.one(ORG, s.id), s);
    const frame = (): Window => ({ postMessage: () => {} }) as never;

    store.getState().attachStage({ frame: frame(), orgId: ORG, spotId: a.id, orientation: 'landscape' });
    store.getState().editSpot(a, (d) => ({ ...d, name: 'A, renamed' }));
    void store.getState().saveSpotDraft();
    await vi.advanceTimersByTimeAsync(0);
    expect(answers).toHaveLength(1);

    store.getState().attachStage({ frame: frame(), orgId: ORG, spotId: b.id, orientation: 'landscape' });
    store.getState().editSpot(b, (d) => ({ ...d, name: 'B, renamed' }));
    answers[0]!({ spot: { ...a, name: 'A, renamed', version: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().spotEditor).toMatchObject({ spotId: 'spt_b', version: 1, status: 'unsaved', saveError: null, stale: false });
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
