// An agent's proposal in the editors (#116): Reject sends the version shown, and its toast's Undo the
// version the Reject made; Keep sends the version shown; a refusal is said. Each reads the editor's draft
// and the proposal again. The tools are stubbed; toasts read from sonner's store.
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { callTool, Refusal } from '../src/lib/tools';
import { createProposalsSlice, type ProposalsSlice } from '../src/state/proposals';
import { ORG, toastTitled, watchedQueries } from './store-kit';

vi.mock('~/server/proposals.functions', () => ({ getProposal: vi.fn() }));
vi.mock('~/lib/tools', async (original) => ({ ...(await original<typeof import('../src/lib/tools')>()), callTool: vi.fn() }));

const reloadSpot = vi.fn(async () => {});
const reloadPlaylist = vi.fn(async () => {});

function setup() {
  const { queryClient, invalidated } = watchedQueries();
  const store = createStore<ProposalsSlice & { reloadSpot: typeof reloadSpot; reloadPlaylist: typeof reloadPlaylist }>()((set, get) => ({
    reloadSpot,
    reloadPlaylist,
    ...createProposalsSlice(set as never, get as never, { router: {}, queryClient } as never),
  }));
  return { s: store, invalidated };
}

beforeEach(() => {
  toast.dismiss();
  vi.mocked(callTool).mockReset();
  reloadSpot.mockClear();
  reloadPlaylist.mockClear();
});

describe("an agent's proposal", () => {
  it('is rejected at the version shown, its Undo at the version the Reject made; the editor reads it again', async () => {
    const { s, invalidated } = setup();
    vi.mocked(callTool).mockResolvedValue({ spot: { version: 8 }, rejected: true } as never);
    await s.getState().rejectProposal(ORG, 'spot', 'spt_soup', 7);
    expect(callTool).toHaveBeenLastCalledWith('revert_spot_draft', { spotId: 'spt_soup', ifVersion: 7 });
    expect(reloadSpot).toHaveBeenCalledWith(ORG, 'spt_soup');
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['org', ORG, 'proposals'] });
    const done = toastTitled("Rejected the agent's draft");
    const undo = done && 'action' in done ? done.action : undefined;
    if (!undo || typeof undo !== 'object' || !('onClick' in undo)) throw new Error('no Undo');
    vi.mocked(callTool).mockResolvedValue({ spot: { version: 9 }, rejected: false } as never);
    // The call goes as the Undo is pressed, before anything is awaited.
    undo.onClick({} as never);
    expect(callTool).toHaveBeenLastCalledWith('revert_spot_draft', { spotId: 'spt_soup', ifVersion: 8 });
  });

  it("keeps a playlist's at the version shown, and says why one is refused", async () => {
    const { s } = setup();
    vi.mocked(callTool).mockResolvedValue({ playlist: { version: 4 } } as never);
    await s.getState().keepProposal(ORG, 'playlist', 'pls_deli', 4);
    expect(callTool).toHaveBeenLastCalledWith('keep_playlist_draft', { playlistId: 'pls_deli', ifVersion: 4 });
    expect(reloadPlaylist).toHaveBeenCalledWith(ORG, 'pls_deli');
    vi.mocked(callTool).mockRejectedValue(new Refusal('conflict', 'playlist pls_deli changed since'));
    await s.getState().rejectProposal(ORG, 'playlist', 'pls_deli', 4);
    expect(toastTitled('Not rejected')).toMatchObject({ description: 'playlist pls_deli changed since' });
    expect(s.getState().proposals.pending).toBeNull();
  });
});
