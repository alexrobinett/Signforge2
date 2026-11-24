/** The app frame: the phone navigation drawer, the sidebar's fold and the theme. */
import { applyTheme, onSystemThemeChange, readStoredTheme, storeTheme, type Theme } from '~/lib/theme';
import type { AppStore, SliceCreator, StoreDeps } from './store';

interface UiState {
  drawerOpen: boolean;
  /**
   * The person's choice to fold the sidebar to icons, kept per browser as a convenience. Blocked or
   * missing storage leaves the default, unfolded.
   */
  sidebarFolded: boolean;
  /** A panel on the right (the agent's drawer) folded the sidebar to make room, until it closes or the person unfolds it. */
  panelFolded: boolean;
  /** The editor the person unfolded the sidebar in: an editor folds it by default (#363), until then, for that visit. */
  unfoldedIn: string | null;
  /**
   * The folded rail's tooltip that is open, by its text, or null. Held here so every tooltip stays
   * controlled: one that was open when the sidebar unfolded would otherwise show again on the next fold.
   */
  tip: string | null;
  /** 'system' until the browser store reads the saved choice, so server and first client render agree. */
  theme: Theme;
  /**
   * The orgs whose setup checklist on Overview the person hid (#334), kept per browser like the
   * fold: hiding it is a convenience, and the steps still tick themselves off from the org's data.
   */
  setupHidden: readonly string[];
}

export interface UiSlice {
  ui: UiState;
  openDrawer: () => void;
  closeDrawer: () => void;
  /** The fold button: folds the sidebar, or unfolds it whatever folded it. */
  toggleSidebar: () => void;
  /** A panel on the right opened or closed: open, it folds the sidebar. */
  setRightPanel: (open: boolean) => void;
  /** A rail tooltip opened (its text) or closed (null). */
  showTip: (tip: string | null) => void;
  setTheme: (theme: Theme) => void;
  /** Hides the setup checklist for an org. */
  hideSetup: (orgId: string) => void;
}

const FOLD_KEY = 'sf-sidebar-folded';
const SETUP_KEY = 'sf-setup-hidden';

/** A spot's or a playlist's editor: its stage needs the room, so the sidebar starts folded there (#363). */
const EDITOR = /^\/(?:spots|playlists)\/[^/]+$/;

/**
 * Whether the sidebar shows only icons at `path`: the person folded it, a panel on the right did, or
 * it is an editor the person has not unfolded it in. From the path, so the server draws it as the browser does.
 */
export const isFolded = (ui: Pick<UiState, 'sidebarFolded' | 'panelFolded' | 'unfoldedIn'>, path: string) =>
  ui.panelFolded || (EDITOR.test(path) ? ui.unfoldedIn !== path : ui.sidebarFolded);

export const createUiSlice: SliceCreator<UiSlice> = (set, _get, { router }) => ({
  ui: { drawerOpen: false, sidebarFolded: false, panelFolded: false, unfoldedIn: null, tip: null, theme: 'system', setupHidden: [] },
  openDrawer: () => set((s) => ({ ui: { ...s.ui, drawerOpen: true } })),
  closeDrawer: () => set((s) => ({ ui: { ...s.ui, drawerOpen: false } })),
  toggleSidebar: () =>
    set((s) => {
      const path = router.state.location.pathname;
      const folding = !isFolded(s.ui, path);
      // In an editor the fold is its own, for this visit: the person's saved choice, for every other page, is never written from one.
      if (EDITOR.test(path)) return { ui: { ...s.ui, panelFolded: false, unfoldedIn: folding ? null : path, tip: null } };
      try {
        localStorage.setItem(FOLD_KEY, String(folding));
      } catch {}
      return { ui: { ...s.ui, sidebarFolded: folding, panelFolded: false, tip: null } };
    }),
  setRightPanel: (open) => set((s) => ({ ui: { ...s.ui, panelFolded: open, tip: null } })),
  showTip: (tip) => set((s) => (s.ui.tip === tip ? s : { ui: { ...s.ui, tip } })),
  setTheme: (theme) => {
    storeTheme(theme);
    applyTheme(theme);
    set((s) => ({ ui: { ...s.ui, theme } }));
  },
  hideSetup: (orgId) =>
    set((s) => {
      // What another tab hid since this one read storage stays hidden: merged, not replaced.
      const setupHidden = [...new Set([...readSetupHidden(), ...s.ui.setupHidden, orgId])];
      try {
        localStorage.setItem(SETUP_KEY, JSON.stringify(setupHidden));
      } catch {}
      return { ui: { ...s.ui, setupHidden } };
    }),
});

/** The hidden checklists' orgs as saved, or none: storage is the browser's, so anything else in it is dropped. */
function readSetupHidden(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETUP_KEY) ?? '[]');
    return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Browser only, once per store. Loads the saved theme, fold and hidden checklists, follows the system theme while 'system' is
 * chosen, and closes the drawer when navigation changes the path. The saved theme changes the
 * current state, not the initial state, and `useAppStore` renders the initial state while
 * hydrating, so hydration matches the server and the saved choice shows on the next render.
 */
export function connectUi(store: AppStore, { router }: StoreDeps) {
  const saved = readStoredTheme();
  let sidebarFolded = false;
  try {
    sidebarFolded = localStorage.getItem(FOLD_KEY) === 'true';
  } catch {}
  store.setState((s) => ({ ui: { ...s.ui, theme: saved, sidebarFolded, setupHidden: readSetupHidden() } }));
  onSystemThemeChange(() => {
    if (store.getState().ui.theme === 'system') applyTheme('system');
  });
  router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (!pathChanged) return;
    store.getState().closeDrawer();
    // An editor unfolded on this visit starts folded on the next.
    store.setState((s) => ({ ui: { ...s.ui, unfoldedIn: null } }));
  });
}
