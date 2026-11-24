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

/** The org the tab shows, as the app shell's loader says it (`orgOnScreen`). */
let onScreen = ORG;
const router = {
  get state() {
    return { matches: [{ routeId: '/_app', loaderData: { organization: { id: onScreen } } }] };
  },
};

function setup() {
  const { queryClient, invalidated } = watchedQueries();
  const store = createStore<ProposalsSlice & { reloadSpot: typeof reloadSpot; reloadPlaylist: typeof reloadPlaylist }>()((set, get) => ({
    reloadSpot,
    reloadPlaylist,
    ...createProposalsSlice(set as never, get as never, { router, queryClient } as never),
  }));
  return { s: store, invalidated };
}

beforeEach(() => {
  toast.dismiss();
  vi.mocked(callTool).mockReset();
  reloadSpot.mockReset().mockImplementation(async () => {});
  reloadPlaylist.mockClear();
  onScreen = ORG;
});

describe("an agent's proposal", () => {
  it('is rejected at the version shown, its Undo at the version the Reject made; the editor reads it again', async () => {
    const { s, invalidated } = setup();
    vi.mocked(callTool).mockResolvedValue({ spot: { version: 8 }, rejected: true } as never);
    await s.getState().rejectProposal(ORG, 'spot', 'spt_soup', 7);
    // For the org it was pressed in: one the tab has left is refused by the API (ORG_CHANGED).
    expect(callTool).toHaveBeenLastCalledWith('revert_spot_draft', { spotId: 'spt_soup', ifVersion: 7 }, ORG);
    expect(reloadSpot).toHaveBeenCalledWith(ORG, 'spt_soup');
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['org', ORG, 'proposals'] });
    const done = toastTitled("Rejected the agent's draft");
    const undo = done && 'action' in done ? done.action : undefined;
    if (!undo || typeof undo !== 'object' || !('onClick' in undo)) throw new Error('no Undo');
    vi.mocked(callTool).mockResolvedValue({ spot: { version: 9 }, rejected: false } as never);
    // The call goes as the Undo is pressed, before anything is awaited.
    undo.onClick({} as never);
    expect(callTool).toHaveBeenLastCalledWith('revert_spot_draft', { spotId: 'spt_soup', ifVersion: 8 }, ORG);
  });

  it("keeps a playlist's at the version shown, and says why one is refused", async () => {
    const { s } = setup();
    vi.mocked(callTool).mockResolvedValue({ playlist: { version: 4 } } as never);
    await s.getState().keepProposal(ORG, 'playlist', 'pls_deli', 4);
    expect(callTool).toHaveBeenLastCalledWith('keep_playlist_draft', { playlistId: 'pls_deli', ifVersion: 4 }, ORG);
    expect(reloadPlaylist).toHaveBeenCalledWith(ORG, 'pls_deli');
    vi.mocked(callTool).mockRejectedValue(new Refusal('conflict', 'playlist pls_deli changed since'));
    await s.getState().rejectProposal(ORG, 'playlist', 'pls_deli', 4);
    expect(toastTitled('Not rejected')).toMatchObject({ description: 'playlist pls_deli changed since' });
    expect(s.getState().proposals.pending).toBeNull();
  });

  it('stays pending until the editor has read the draft again: a second press meanwhile sends nothing', async () => {
    const { s } = setup();
    vi.mocked(callTool).mockResolvedValue({ spot: { version: 8 }, rejected: true } as never);
    // The editor's read held open until released; and a promise that it has started.
    let reread = () => {};
    let started = () => {};
    const rereading = new Promise<void>((go) => (started = go));
    reloadSpot.mockImplementation(() => {
      started();
      return new Promise<void>((done) => (reread = done));
    });
    const first = s.getState().rejectProposal(ORG, 'spot', 'spt_soup', 7);
    await rereading;
    expect(s.getState().proposals.pending).toBe('spot:spt_soup');
    await s.getState().keepProposal(ORG, 'spot', 'spt_soup', 7);
    expect(callTool).toHaveBeenCalledTimes(1);
    reread();
    await first;
    expect(s.getState().proposals.pending).toBeNull();
  });

  it('acts on no other org: an Undo pressed after the tab moved sends nothing, and an answer that comes after says nothing there', async () => {
    const { s } = setup();
    vi.mocked(callTool).mockResolvedValue({ spot: { version: 8 }, rejected: true } as never);
    await s.getState().rejectProposal(ORG, 'spot', 'spt_soup', 7);
    const done = toastTitled("Rejected the agent's draft");
    const undo = done && 'action' in done ? done.action : undefined;
    if (!undo || typeof undo !== 'object' || !('onClick' in undo)) throw new Error('no Undo');
    onScreen = 'org_2';
    undo.onClick({} as never);
    expect(callTool).toHaveBeenCalledTimes(1);
    // A Keep whose answer comes once the tab has moved: no toast, and the other org's editor is not read again.
    onScreen = ORG;
    // Sonner keeps every toast it was given: counted, not looked for.
    const kept = () => toast.getToasts().filter((t) => 'title' in t && t.title === "Kept the agent's draft").length;
    const before = kept();
    reloadSpot.mockClear();
    vi.mocked(callTool).mockImplementation(async () => {
      onScreen = 'org_2';
      return { spot: { version: 8 } } as never;
    });
    await s.getState().keepProposal(ORG, 'spot', 'spt_soup', 8);
    expect(kept()).toBe(before);
    expect(reloadSpot).not.toHaveBeenCalled();
  });

  it('runs an Undo pressed while the Reject is still read again once it is, and is never left pending by a read that fails', async () => {
    const { s } = setup();
    vi.mocked(callTool).mockResolvedValue({ spot: { version: 8 }, rejected: true } as never);
    let reread = () => {};
    let started = () => {};
    const rereading = new Promise<void>((go) => (started = go));
    reloadSpot.mockImplementation(() => {
      started();
      return new Promise<void>((done) => (reread = done));
    });
    const first = s.getState().rejectProposal(ORG, 'spot', 'spt_soup', 7);
    await rereading;
    // This Reject's toast: sonner keeps the earlier tests' too.
    const done = toast.getToasts().filter((t) => 'title' in t && t.title === "Rejected the agent's draft").at(-1);
    const undo = done && 'action' in done ? done.action : undefined;
    if (!undo || typeof undo !== 'object' || !('onClick' in undo)) throw new Error('no Undo');
    // Pressed now, it waits: nothing more is sent until the read again is done.
    reloadSpot.mockImplementation(async () => {});
    undo.onClick({} as never);
    expect(callTool).toHaveBeenCalledTimes(1);
    reread();
    await first;
    // The Undo goes once the Reject's run is over: a few turns of the microtask queue, no clock.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(callTool).toHaveBeenLastCalledWith('revert_spot_draft', { spotId: 'spt_soup', ifVersion: 8 }, ORG);
    // A read again that fails: the slice is free again for the next press.
    reloadSpot.mockRejectedValueOnce(new Error('offline'));
    await s.getState().keepProposal(ORG, 'spot', 'spt_soup', 9).catch(() => {});
    expect(s.getState().proposals.pending).toBeNull();
  });
});
