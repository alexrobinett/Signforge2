/**
 * The app store: every piece of UI and in-progress state the CMS keeps, with the actions that
 * change it. One slice per area, each in its own file. `getRouter()` in src/router.tsx makes one
 * store per request (and one per page in the browser), so the server never shares state between
 * requests. Server data is not kept here: it comes from route loaders and the Query cache. The
 * README's "State" section says how to add a slice.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { AnyRouter } from '@tanstack/react-router';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { connectCommandMenu, createCommandMenuSlice, type CommandMenuSlice } from './command-menu';
import { connectUi, createUiSlice, type UiSlice } from './ui';
import { createAgentSlice, type AgentSlice } from './agent';
import { createApprovalsSlice, type ApprovalsSlice } from './approvals';
import { createAgentDrawerSlice, type AgentDrawerSlice } from './agent-drawer';
import { createAssetsSlice, type AssetsSlice } from './assets';
import { createAuditSlice, type AuditSlice } from './audit';
import { createBrandKitsSlice, type BrandKitsSlice } from './brand-kits';
import { createConnectSlice, type ConnectSlice } from './connect';
import { createGroupsSlice, type GroupsSlice } from './groups';
import { createIntegrationsSlice, type IntegrationsSlice } from './integrations';
import { createOrgsSlice, type OrgsSlice } from './orgs';
import { createPlaylistEditorSlice, type PlaylistEditorSlice } from './playlist-editor';
import { createProposalsSlice, type ProposalsSlice } from './proposals';
import { createPublishingSlice, type PublishingSlice } from './publishing';
import { createScheduleSlice, type ScheduleSlice } from './schedule';
import { createScreensSlice, type ScreensSlice } from './screens';
import { createSettingsSlice, type SettingsSlice } from './settings';
import { createSignInSlice, type SignInSlice } from './sign-in';
import { createSpotEditorSlice, type SpotEditorSlice } from './spot-editor';
import { createSpotSourceSlice, type SpotSourceSlice } from './spot-source';
import { createTargetPickerSlice, type TargetPickerSlice } from './target-picker';

export type AppState = UiSlice &
  SignInSlice &
  OrgsSlice &
  ScreensSlice &
  AssetsSlice &
  CommandMenuSlice &
  SettingsSlice &
  SpotEditorSlice &
  PlaylistEditorSlice &
  SpotSourceSlice &
  IntegrationsSlice &
  AuditSlice &
  BrandKitsSlice &
  PublishingSlice &
  ScheduleSlice &
  TargetPickerSlice &
  GroupsSlice &
  ConnectSlice &
  AgentSlice &
  AgentDrawerSlice &
  ProposalsSlice &
  ApprovalsSlice;
export type AppStore = StoreApi<AppState>;

/** What actions may reach outside the store for. */
export interface StoreDeps {
  router: AnyRouter;
  /** Server data (src/queries/): actions that change it update or invalidate its entries. */
  queryClient: QueryClient;
}

/** Builds one slice. Actions use `set` with named transitions, never a generic patch. */
export type SliceCreator<T> = (set: AppStore['setState'], get: AppStore['getState'], deps: StoreDeps) => T;

export function createAppStore(deps: StoreDeps): AppStore {
  const store = createStore<AppState>()((set, get) => ({
    ...createUiSlice(set, get, deps),
    ...createSignInSlice(set, get, deps),
    ...createOrgsSlice(set, get, deps),
    ...createScreensSlice(set, get, deps),
    ...createAssetsSlice(set, get, deps),
    ...createCommandMenuSlice(set, get, deps),
    ...createSettingsSlice(set, get, deps),
    ...createSpotEditorSlice(set, get, deps),
    ...createSpotSourceSlice(set, get, deps),
    ...createPlaylistEditorSlice(set, get, deps),
    ...createBrandKitsSlice(set, get, deps),
    ...createIntegrationsSlice(set, get, deps),
    ...createAuditSlice(set, get, deps),
    ...createPublishingSlice(set, get, deps),
    ...createScheduleSlice(set, get, deps),
    ...createTargetPickerSlice(set, get, deps),
    ...createGroupsSlice(set, get, deps),
    ...createConnectSlice(set, get, deps),
    ...createAgentSlice(set, get, deps),
    ...createAgentDrawerSlice(set, get, deps),
    ...createProposalsSlice(set, get, deps),
    ...createApprovalsSlice(set, get, deps),
  }));
  if (typeof window !== 'undefined') {
    connectUi(store, deps);
    connectCommandMenu(store, deps);
  }
  return store;
}
