// Overview (#357) and its setup checklist (#334): worked out from the tools' answers, so each step
// ticks itself off only once screens have it, Playing now shows what screens report applying, and
// hiding the checklist is kept per browser like the sidebar's fold, merged across tabs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { listOutOfDate } from '../src/lib/fleet-status';
import { playingNow, SHOWN_DRAFTS, setupSteps, templateThumbnail, unpublished } from '../src/lib/overview';
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
/** A screen playing `spot`, which has taken its publish unless `reported` says otherwise. */
const screen = (kind: State['kind'], spot: string | null, over: { reason?: State['reason']; reported?: string | null; asleep?: boolean } = {}) => ({
  state: state(kind, over.reason ?? null),
  showing: spot ? showing(spot, { asleep: over.asleep ?? false }) : null,
  desiredManifestId: 'm2',
  reportedManifestId: over.reported === undefined ? 'm2' : over.reported,
});

describe('setupSteps', () => {
  const published = { published: true, spotIds: ['s1'] };

  it('ticks each step only once screens have it', () => {
    const none = { templateSpot: false, defaultPlaylist: null, screens: [] };
    expect(setupSteps(none)).toEqual({ spot: false, default: false, screen: false });
    expect(setupSteps({ ...none, templateSpot: true })).toEqual({ spot: true, default: false, screen: false });
    // A default that is a draft, or empty, is not one screens play.
    expect(setupSteps({ ...none, defaultPlaylist: { published: false, spotIds: ['s1'] } }).default).toBe(false);
    expect(setupSteps({ ...none, defaultPlaylist: { published: true, spotIds: [] } }).default).toBe(false);
    expect(setupSteps({ ...none, defaultPlaylist: published }).default).toBe(true);
    // A screen counts once it has taken a publish, and only with a published default.
    expect(setupSteps({ ...none, defaultPlaylist: published, screens: [screen('online', 's1', { reported: null })] }).screen).toBe(false);
    // Behind on a later publish, it has still taken one: the checklist does not come back.
    expect(setupSteps({ ...none, defaultPlaylist: published, screens: [screen('needs_you', 's1', { reason: 'behind', reported: 'm1' })] }).screen).toBe(true);
    expect(setupSteps({ ...none, defaultPlaylist: published, screens: [screen('online', 's1')] }).screen).toBe(true);
    expect(setupSteps({ ...none, screens: [screen('online', 's1')] }).screen).toBe(false);
  });

  it('does not count a retired screen', () => {
    expect(setupSteps({ templateSpot: true, defaultPlaylist: published, screens: [screen('needs_you', null, { reason: 'revoked' })] }).screen).toBe(false);
  });
});

describe('unpublished', () => {
  it('names the newest edits of all three lists, saying what screens have of each', () => {
    const spot = (id: string, updatedAt: number, published = false) => ({ id, name: id, published, updatedAt });
    const rows = unpublished({
      spots: [spot('Edited', 9, true), spot('Opening', 1), spot('Old', 0)],
      playlists: [{ id: 'p1', name: 'Main loop', published: false, updatedAt: 2 }],
      entries: [
        { id: 'e1', takeover: false, deleted: true, published: true, updatedAt: 5, playlistName: 'Main loop' },
        { id: 'e2', takeover: true, deleted: false, published: false, updatedAt: 3, playlistName: 'Flash sale' },
      ],
    });
    expect(rows).toHaveLength(SHOWN_DRAFTS);
    expect(rows.map((r) => [r.kind, r.name, r.word])).toEqual([
      ['spot', 'Edited', 'changes not published'],
      ['entry', 'Schedule: Main loop', 'removed, not published'],
      ['entry', 'Takeover: Flash sale', 'never published'],
      ['playlist', 'Main loop', 'never published'],
      ['spot', 'Opening', 'never published'],
    ]);
  });
});

describe('playingNow', () => {
  it('counts the screens that report playing their publish, by spot, the most screens first', () => {
    const rows = playingNow([
      screen('online', 'a'),
      screen('online', 'b'),
      // Unreachable on the latest version: it keeps playing it from its cache.
      screen('unreachable', 'b'),
      // Still fetching the new publish, or behind and unreachable: not playing it yet.
      screen('updating', 'c', { reported: 'm1' }),
      screen('needs_you', 'c', { reason: 'behind', reported: 'm1' }),
      screen('asleep', 'd', { asleep: true }),
      screen('needs_you', 'e', { reason: 'revoked' }),
      screen('needs_you', null, { reason: 'nothing_published', reported: null }),
    ]);
    expect(rows.map((r) => [r.spot.id, r.screens, r.playlist])).toEqual([
      ['b', 2, 'Main loop'],
      ['a', 1, 'Main loop'],
    ]);
  });

  it('is read again when a screen reports a new manifest, so the cards move as screens take a publish', () => {
    const list = [{ id: 's1', ...screen('updating', 'a', { reported: 'm1' }) }];
    const took = [{ id: 's1', ...screen('updating', 'a') }];
    expect(listOutOfDate(list as never, took as never)).toBe(true);
    expect(listOutOfDate(took as never, took as never)).toBe(false);
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
  const storage = () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) });
    return map;
  };
  afterEach(() => vi.unstubAllGlobals());

  it('is kept per org for the next visit in this browser', () => {
    storage();
    const store = uiStore();
    store.getState().hideSetup('org_a');
    expect(store.getState().ui.setupHidden).toEqual(['org_a']);

    const next = uiStore();
    expect(next.getState().ui.setupHidden).toEqual([]);
    connectUi(next as never, { router } as never);
    expect(next.getState().ui.setupHidden).toEqual(['org_a']);
  });

  it('keeps what another tab hid since this one read storage', () => {
    const saved = storage();
    const one = uiStore();
    const two = uiStore();
    connectUi(one as never, { router } as never);
    connectUi(two as never, { router } as never);
    one.getState().hideSetup('org_a');
    two.getState().hideSetup('org_b');
    expect(JSON.parse(saved.get('sf-setup-hidden') ?? '[]')).toEqual(['org_a', 'org_b']);
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
