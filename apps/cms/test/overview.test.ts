// Overview (#357) and its setup checklist (#334): worked out from the tools' own lists, so each
// step ticks itself off, and hiding the checklist is kept per browser like the sidebar's fold.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { playingNow, setupSteps, templateThumbnail, unpublished } from '../src/lib/overview';
import type { ScreenView } from '../src/lib/screen-types';
import { connectUi, createUiSlice, type UiSlice } from '../src/state/ui';

vi.mock('~/lib/theme', () => ({ applyTheme: vi.fn(), onSystemThemeChange: vi.fn(), readStoredTheme: () => 'system', storeTheme: vi.fn() }));

type State = ScreenView['state'];
const state = (kind: State['kind'], reason: State['reason'] = null): State => ({ kind, reason, wakesAt: null, filesMissing: null });
const showing = (spot: string, over: Partial<NonNullable<ScreenView['showing']>> = {}): ScreenView['showing'] => ({
  asleep: false,
  wakesAt: null,
  playlist: { id: 'p1', name: 'Main loop' },
  takeover: false,
  spot: { id: spot, name: `Spot ${spot}`, kind: 'template', template: 'base/clock@1.2.4', image: null },
  spots: 1,
  ...over,
});

const spot = (over: Partial<Parameters<typeof unpublished>[0]['spots'][number]> = {}) => ({
  id: 's1',
  name: 'Opening',
  kind: 'template' as const,
  published: false,
  draftChanged: true,
  updatedAt: 1,
  ...over,
});
const playlist = (over: Partial<Parameters<typeof unpublished>[0]['playlists'][number]> = {}) => ({
  id: 'p1',
  name: 'Main loop',
  spotIds: ['s1'],
  isDefault: false,
  published: false,
  draftChanged: true,
  updatedAt: 2,
  ...over,
});

describe('setupSteps', () => {
  it('ticks each step from the data alone', () => {
    expect(setupSteps({ spots: [], playlists: [], screens: [] })).toEqual({ spot: false, default: false, screen: false });
    expect(setupSteps({ spots: [spot({ kind: 'url' })], playlists: [], screens: [] }).spot).toBe(false);
    expect(setupSteps({ spots: [spot()], playlists: [playlist()], screens: [] })).toEqual({ spot: true, default: false, screen: false });
    expect(setupSteps({ spots: [spot()], playlists: [playlist({ isDefault: true })], screens: [{ state: state('unreachable') }] })).toEqual({
      spot: true,
      default: true,
      screen: true,
    });
  });

  it('does not count an empty default playlist, or a retired screen', () => {
    const steps = setupSteps({ spots: [spot()], playlists: [playlist({ isDefault: true, spotIds: [] })], screens: [{ state: state('needs_you', 'revoked') }] });
    expect(steps).toEqual({ spot: true, default: false, screen: false });
  });
});

describe('unpublished', () => {
  it('lists drafts screens do not have, newest edit first, saying what screens have of each', () => {
    const rows = unpublished({
      spots: [
        spot(),
        spot({ id: 's2', name: 'Done', published: true, draftChanged: false }),
        spot({ id: 's3', name: 'Edited', published: true, updatedAt: 9 }),
      ],
      playlists: [playlist()],
      entries: [
        { id: 'e1', playlistId: 'p1', takeover: false, deleted: true, published: true, draftChanged: true, updatedAt: 5 },
        { id: 'e2', playlistId: 'p1', takeover: true, deleted: false, published: false, draftChanged: true, updatedAt: 3 },
      ],
    });
    expect(rows.map((r) => [r.kind, r.name, r.word])).toEqual([
      ['spot', 'Edited', 'changes not published'],
      ['entry', 'Schedule: Main loop', 'removed, not published'],
      ['entry', 'Takeover: Main loop', 'never published'],
      ['playlist', 'Main loop', 'never published'],
      ['spot', 'Opening', 'never published'],
    ]);
  });
});

describe('playingNow', () => {
  it('groups awake screens by the spot they show, the most screens first', () => {
    const rows = playingNow([
      { state: state('online'), showing: showing('a') },
      { state: state('online'), showing: showing('b') },
      { state: state('unreachable'), showing: showing('b') },
      { state: state('asleep'), showing: showing('c', { asleep: true }) },
      { state: state('needs_you', 'revoked'), showing: showing('d') },
      { state: state('needs_you', 'nothing_published'), showing: null },
    ]);
    expect(rows.map((r) => [r.spot.id, r.screens, r.playlist])).toEqual([
      ['b', 2, 'Main loop'],
      ['a', 1, 'Main loop'],
    ]);
  });
});

describe('templateThumbnail', () => {
  it("is a base template's drawn thumbnail, and none for an org's own", () => {
    expect(templateThumbnail('base/clock@1.2.4')).toBe('/template-thumbnails/clock.webp');
    expect(templateThumbnail('base/clock@9.9.9')).toBe('/template-thumbnails/clock.webp');
    expect(templateThumbnail('base/unknown@1.0.0')).toBeNull();
    expect(templateThumbnail('org_1/clock@1.2.4')).toBeNull();
  });
});

describe('hiding the setup checklist', () => {
  const router = { subscribe: vi.fn() };
  const uiStore = () => createStore<UiSlice>()((set, get) => createUiSlice(set as never, get as never, { router } as never));
  afterEach(() => vi.unstubAllGlobals());

  it('is kept per org for the next visit in this browser', () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) });
    const store = uiStore();
    store.getState().hideSetup('org_a');
    expect(store.getState().ui.setupHidden).toEqual(['org_a']);

    const next = uiStore();
    expect(next.getState().ui.setupHidden).toEqual([]);
    connectUi(next as never, { router } as never);
    expect(next.getState().ui.setupHidden).toEqual(['org_a']);
  });

  it('drops anything else storage holds, and works without storage for this page', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"not":"a list"}', setItem: vi.fn() });
    const store = uiStore();
    connectUi(store as never, { router } as never);
    expect(store.getState().ui.setupHidden).toEqual([]);

    vi.stubGlobal('localStorage', undefined);
    const blocked = uiStore();
    connectUi(blocked as never, { router } as never);
    blocked.getState().hideSetup('org_b');
    expect(blocked.getState().ui.setupHidden).toEqual(['org_b']);
  });
});
