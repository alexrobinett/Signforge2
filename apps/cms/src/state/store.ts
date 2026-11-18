/**
 * The app store: every piece of UI and in-progress state the CMS keeps, with the actions that
 * change it. One slice per area, each in its own file. `getRouter()` in src/router.tsx makes one
 * store per request (and one per page in the browser), so the server never shares state between
 * requests. Server data is not kept here: it comes from route loaders. The README's "State"
 * section says how to add a slice.
 */
import type { AnyRouter } from '@tanstack/react-router';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { connectUi, createUiSlice, type UiSlice } from './ui';
import { createOrgsSlice, type OrgsSlice } from './orgs';
import { createSignInSlice, type SignInSlice } from './sign-in';

export type AppState = UiSlice & SignInSlice & OrgsSlice;
export type AppStore = StoreApi<AppState>;

/** What actions may reach outside the store for. */
export interface StoreDeps {
  router: AnyRouter;
}

/** Builds one slice. Actions use `set` with named transitions, never a generic patch. */
export type SliceCreator<T> = (set: AppStore['setState'], get: AppStore['getState'], deps: StoreDeps) => T;

export function createAppStore(deps: StoreDeps): AppStore {
  const store = createStore<AppState>()((set, get) => ({
    ...createUiSlice(set, get, deps),
    ...createSignInSlice(set, get, deps),
    ...createOrgsSlice(set, get, deps),
  }));
  if (typeof window !== 'undefined') connectUi(store, deps);
  return store;
}
