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
  /** 'system' until the browser store reads the saved choice, so server and first client render agree. */
  theme: Theme;
}

export interface UiSlice {
  ui: UiState;
  openDrawer: () => void;
  closeDrawer: () => void;
  /** The fold button: folds the sidebar, or unfolds it whatever folded it. */
  toggleSidebar: () => void;
  /** A panel on the right opened or closed: open, it folds the sidebar. */
  setRightPanel: (open: boolean) => void;
  setTheme: (theme: Theme) => void;
}

const FOLD_KEY = 'sf-sidebar-folded';

/** Whether the sidebar shows only icons: the person folded it, or a panel on the right did. */
export const isFolded = (ui: Pick<UiState, 'sidebarFolded' | 'panelFolded'>) => ui.sidebarFolded || ui.panelFolded;

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  ui: { drawerOpen: false, sidebarFolded: false, panelFolded: false, theme: 'system' },
  openDrawer: () => set((s) => ({ ui: { ...s.ui, drawerOpen: true } })),
  closeDrawer: () => set((s) => ({ ui: { ...s.ui, drawerOpen: false } })),
  toggleSidebar: () =>
    set((s) => {
      const sidebarFolded = !isFolded(s.ui);
      try {
        localStorage.setItem(FOLD_KEY, String(sidebarFolded));
      } catch {}
      return { ui: { ...s.ui, sidebarFolded, panelFolded: false } };
    }),
  setRightPanel: (open) => set((s) => ({ ui: { ...s.ui, panelFolded: open } })),
  setTheme: (theme) => {
    storeTheme(theme);
    applyTheme(theme);
    set((s) => ({ ui: { ...s.ui, theme } }));
  },
});

/**
 * Browser only, once per store. Loads the saved theme and fold, follows the system theme while 'system' is
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
  store.setState((s) => ({ ui: { ...s.ui, theme: saved, sidebarFolded } }));
  onSystemThemeChange(() => {
    if (store.getState().ui.theme === 'system') applyTheme('system');
  });
  router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (pathChanged) store.getState().closeDrawer();
  });
}
