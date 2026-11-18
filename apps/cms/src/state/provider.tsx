import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AppState, AppStore } from './store';

const StoreContext = createContext<AppStore | null>(null);

/** Provides the request's store. Only src/router.tsx renders this. */
export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

/**
 * Reads one value or action from the app store, and re-renders when it changes. Select narrowly:
 * a selector that builds a new object or array on each call re-renders forever.
 */
export function useAppStore<T>(selector: (state: AppState) => T): T {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useAppStore needs the StoreProvider that src/router.tsx renders.');
  return useStore(store, selector);
}
