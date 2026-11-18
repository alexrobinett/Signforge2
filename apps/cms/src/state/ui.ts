/** The app frame: the phone navigation drawer and the theme. */
import { applyTheme, onSystemThemeChange, readStoredTheme, storeTheme, type Theme } from '~/lib/theme';
import type { AppStore, SliceCreator, StoreDeps } from './store';

export interface UiState {
  drawerOpen: boolean;
  /** 'system' until the browser store reads the saved choice, so server and first client render agree. */
  theme: Theme;
}

export interface UiSlice {
  ui: UiState;
  openDrawer: () => void;
  closeDrawer: () => void;
  setTheme: (theme: Theme) => void;
}

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  ui: { drawerOpen: false, theme: 'system' },
  openDrawer: () => set((s) => ({ ui: { ...s.ui, drawerOpen: true } })),
  closeDrawer: () => set((s) => ({ ui: { ...s.ui, drawerOpen: false } })),
  setTheme: (theme) => {
    storeTheme(theme);
    applyTheme(theme);
    set((s) => ({ ui: { ...s.ui, theme } }));
  },
});

/**
 * Browser only, once per store. Loads the saved theme, follows the system theme while 'system' is
 * chosen, and closes the drawer when navigation changes the path. The saved theme changes the
 * current state, not the initial state, and `useAppStore` renders the initial state while
 * hydrating, so hydration matches the server and the saved choice shows on the next render.
 */
export function connectUi(store: AppStore, { router }: StoreDeps) {
  const saved = readStoredTheme();
  store.setState((s) => ({ ui: { ...s.ui, theme: saved } }));
  onSystemThemeChange(() => {
    if (store.getState().ui.theme === 'system') applyTheme('system');
  });
  router.subscribe('onBeforeNavigate', ({ pathChanged }) => {
    if (pathChanged) store.getState().closeDrawer();
  });
}
