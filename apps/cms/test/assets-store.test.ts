// The asset library in the store: deleting an image, which the spot editor's picker no longer offers once it is gone.
// Tool calls go to a stubbed `callTool` the test answers; nothing waits on a clock.
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { assetsQuery } from '../src/queries/spots';
import { createAssetsSlice, type AssetsSlice } from '../src/state/assets';
import { ORG, watchedQueries } from './store-kit';

const callTool = vi.fn();
vi.mock('~/lib/tools', async (actual) => ({ ...(await actual<object>()), callTool: (name: string, input: unknown) => callTool(name, input) }));
vi.mock('~/server/assets.functions', () => ({ getAssets: vi.fn() }));
vi.mock('~/server/spots.functions', () => ({}));

describe('deleting an asset', () => {
  it("reads the org's assets again, so the picker, which reads the Query cache, no longer offers it", async () => {
    const { queryClient } = watchedQueries();
    queryClient.setQueryData(assetsQuery(ORG).queryKey, { assets: [] });
    const router = { invalidate: vi.fn(async () => {}) };
    const s = createStore<AssetsSlice>()((set, get) => createAssetsSlice(set as never, get as never, { router, queryClient } as never));
    s.getState().askToDeleteAsset({ id: 'ast_1', name: 'cup.jpg' });
    callTool.mockResolvedValueOnce({ deleted: 'ast_1', version: null });
    await s.getState().deleteAsset(ORG);
    expect(callTool).toHaveBeenCalledWith('delete', { type: 'asset', id: 'ast_1' });
    expect(queryClient.getQueryState(assetsQuery(ORG).queryKey)?.isInvalidated).toBe(true);
    expect(s.getState().assets.deleting).toBeNull();
  });
});
