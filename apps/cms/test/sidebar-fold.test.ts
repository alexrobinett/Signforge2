// The sidebar's fold in the store (#260): the person's choice, kept per browser as a convenience,
// and a panel on the right that folds it until it closes or the person unfolds it. Storage that is
// missing or blocked changes nothing but the default.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { connectUi, createUiSlice, isFolded, type UiSlice } from '../src/state/ui';

vi.mock('~/lib/theme', () => ({ applyTheme: vi.fn(), onSystemThemeChange: vi.fn(), readStoredTheme: () => 'system', storeTheme: vi.fn() }));

/** The page shown: the router the store reads the path from when the fold button is pressed. */
const router = { subscribe: vi.fn(), state: { location: { pathname: '/screens' } } };
function uiStore() {
  const store = createStore<UiSlice>()((set, get) => createUiSlice(set as never, get as never, { router } as never));
  return { store, folded: () => isFolded(store.getState().ui, router.state.location.pathname) };
}

/** A browser's localStorage, as a Map. */
function storage(saved: Record<string, string> = {}) {
  const map = new Map(Object.entries(saved));
  vi.stubGlobal('localStorage', { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v) });
  return map;
}

afterEach(() => {
  vi.unstubAllGlobals();
  router.state.location.pathname = '/screens';
});

describe('the sidebar fold', () => {
  it('is the person’s choice, kept for the next visit', () => {
    const saved = storage();
    const { store, folded } = uiStore();
    connectUi(store as never, { router } as never);
    expect(folded()).toBe(false);
    store.getState().toggleSidebar();
    expect(folded()).toBe(true);
    expect(saved.get('sf-sidebar-folded')).toBe('true');

    const next = uiStore();
    connectUi(next.store as never, { router } as never);
    expect(next.folded()).toBe(true);
  });

  it('without storage, or with it blocked, starts unfolded and still folds for this page', () => {
    for (const blocked of [
      undefined,
      {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    ]) {
      vi.stubGlobal('localStorage', blocked);
      const { store, folded } = uiStore();
      connectUi(store as never, { router } as never);
      expect(folded()).toBe(false);
      store.getState().toggleSidebar();
      expect(folded()).toBe(true);
    }
  });

  it('folds while a panel on the right is open, and the person can unfold it anyway', () => {
    const saved = storage();
    const { store, folded } = uiStore();
    store.getState().setRightPanel(true);
    expect(folded()).toBe(true);
    store.getState().setRightPanel(false);
    expect(folded()).toBe(false);

    store.getState().setRightPanel(true);
    store.getState().toggleSidebar();
    expect(folded()).toBe(false);
    expect(saved.get('sf-sidebar-folded')).toBe('false');
    // A panel never changes the saved choice.
    store.getState().setRightPanel(false);
    store.getState().setRightPanel(true);
    expect(saved.get('sf-sidebar-folded')).toBe('false');
  });

  it('forgets the open tooltip on every fold and unfold, so a tooltip open as it unfolded does not show on the next fold (review of #279)', () => {
    storage();
    const { store } = uiStore();
    store.getState().toggleSidebar();
    store.getState().showTip('Screens');
    expect(store.getState().ui.tip).toBe('Screens');
    store.getState().toggleSidebar();
    expect(store.getState().ui.tip).toBeNull();
    store.getState().setRightPanel(true);
    store.getState().showTip('Spots');
    store.getState().setRightPanel(false);
    expect(store.getState().ui.tip).toBeNull();
  });

  it("folds in a spot's or a playlist's editor by default, for the stage's room, unfolds there for that visit, and never saves the editor's fold (#363)", () => {
    const saved = storage();
    const { store, folded } = uiStore();
    for (const path of ['/spots/spt_1', '/playlists/pls_1']) {
      router.state.location.pathname = path;
      expect(folded(), path).toBe(true);
    }
    router.state.location.pathname = '/spots';
    expect(folded()).toBe(false);

    router.state.location.pathname = '/spots/spt_1';
    store.getState().toggleSidebar();
    expect(folded()).toBe(false);
    expect(saved.get('sf-sidebar-folded')).toBe('false');
    // Another editor starts folded; so does this one on the next visit.
    router.state.location.pathname = '/spots/spt_2';
    expect(folded()).toBe(true);
    connectUi(store as never, { router } as never);
    const navigated = router.subscribe.mock.calls.at(-1)?.[1] as (e: { pathChanged: boolean }) => void;
    navigated({ pathChanged: true });
    router.state.location.pathname = '/spots/spt_1';
    expect(folded()).toBe(true);
    store.getState().toggleSidebar();
    expect(folded()).toBe(false);
    router.state.location.pathname = '/spots/spt_1';
    store.getState().toggleSidebar();
    expect(folded()).toBe(true);
    expect(saved.get('sf-sidebar-folded')).toBe('false');
    router.state.location.pathname = '/screens';
    expect(folded()).toBe(false);
  });
});
