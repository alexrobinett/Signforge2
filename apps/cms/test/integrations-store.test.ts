// The Integrations store's news photos switch (#195): optimistic state while saving, cleared once
// the refreshed source lands, and rolled back with an error when update_data_source is refused.
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ListedSource } from '../src/lib/integrations';
import { Refusal } from '../src/lib/tools';
import { dataSourceKeys } from '../src/queries/spots';
import { createIntegrationsSlice, type IntegrationsSlice } from '../src/state/integrations';

const callTool = vi.fn();
vi.mock('~/lib/tools', async (actual) => ({ ...(await actual<object>()), callTool: (name: string, input: unknown) => callTool(name, input) }));
vi.mock('~/server/integrations.functions', () => ({ getConnections: vi.fn() }));
vi.mock('~/server/spots.functions', () => ({
  getBrandKits: vi.fn(),
  getDataSource: vi.fn(),
  getDataSources: vi.fn(),
  getSpot: vi.fn(),
  getSpotPreview: vi.fn(),
  getSpots: vi.fn(),
  getTemplates: vi.fn(),
}));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));

const ORG = 'org_1';
const feed: ListedSource = {
  id: 'src_news',
  name: 'Local news',
  format: 'rss',
  connectionId: null,
  refreshS: 300,
  horizonDays: null,
  rowsPath: null,
  photos: true,
  nextPollAt: 0,
  failures: 0,
  lastError: null,
  version: 3,
  createdAt: 0,
  updatedAt: 0,
  lastCheckedAt: null,
  spots: [],
};

function makeStore() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
  const store = createStore<IntegrationsSlice>()((set, get) => createIntegrationsSlice(set as never, get as never, { queryClient } as never));
  return { store, invalidate };
}

beforeEach(() => {
  callTool.mockReset();
});

describe('setSourcePhotos', () => {
  it('shows the new state while saving, invalidates data sources on success, and clears settingPhotos', async () => {
    let resolveCall: () => void = () => {};
    callTool.mockImplementationOnce(() => new Promise<void>((r) => (resolveCall = r)));
    const { store, invalidate } = makeStore();

    const saving = store.getState().setSourcePhotos(ORG, feed, false);
    expect(store.getState().integrations.settingPhotos).toEqual({ id: 'src_news', photos: false });
    expect(store.getState().integrations.pending).toBe(true);

    resolveCall();
    await saving;
    expect(callTool).toHaveBeenCalledWith('update_data_source', { dataSourceId: 'src_news', photos: false, ifVersion: 3 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: dataSourceKeys.all(ORG), exact: true });
    expect(store.getState().integrations).toMatchObject({ settingPhotos: null, pending: false, error: null });
  });

  it('rolls back settingPhotos and reports the error when update_data_source is refused', async () => {
    let rejectCall: (err: unknown) => void = () => {};
    callTool.mockImplementationOnce(() => new Promise<void>((_, reject) => (rejectCall = reject)));
    const { store, invalidate } = makeStore();

    const saving = store.getState().setSourcePhotos(ORG, feed, false);
    expect(store.getState().integrations.settingPhotos).toEqual({ id: 'src_news', photos: false });
    rejectCall(new Refusal('conflict', 'stale version', { version: 4 }));
    await saving;
    expect(invalidate).not.toHaveBeenCalled();
    expect(store.getState().integrations).toMatchObject({
      settingPhotos: null,
      pending: false,
      error: 'This changed since you opened it. Close this and open it again to see it.',
    });

    callTool.mockRejectedValueOnce(new Refusal('forbidden', 'Editors and owners only.'));
    await store.getState().setSourcePhotos(ORG, feed, false);
    expect(store.getState().integrations).toMatchObject({
      settingPhotos: null,
      pending: false,
      error: 'Editors and owners only.',
    });
  });
});
