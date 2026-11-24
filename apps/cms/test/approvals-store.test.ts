// The approvals queue's actions (#115): Approve publishes exactly what the request pinned, with its
// sample text acknowledged exactly as checked, and its toast's Undo is a roll back to the publish
// before; Decline's Undo puts the request back. The tools are stubbed; toasts read from sonner's store.
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { ApprovalItem } from '../src/lib/approvals';
import { callTool, Refusal } from '../src/lib/tools';
import { type ApprovalsSlice, createApprovalsSlice } from '../src/state/approvals';

// The stages' reads: not reached here, no player being attached.
vi.mock('~/queries/spots', () => ({ assetsQuery: vi.fn(), spotPreviewQuery: vi.fn(), templatesQuery: vi.fn() }));
vi.mock('~/lib/tools', async (original) => ({ ...(await original<typeof import('../src/lib/tools')>()), callTool: vi.fn() }));

const ORG = 'org_1';

const request = {
  id: 'prq_1',
  status: 'pending' as const,
  requestedBy: { kind: 'agent' as const, id: 'agt_1', clientId: 'cli_1', name: 'Kestrel agent', connectedBy: 'Ada', gone: false },
  drafts: [{ kind: 'spot' as const, id: 'spt_soup', version: 7 }],
  reason: 'Tomato basil today',
  createdAt: 0,
  expiresAt: 1,
  decidedBy: null,
  decidedAt: null,
  publishId: null,
  version: 1,
};

/** A request waiting, as the page read it; `samples`, the sample text approving it publishes. */
const item = (samples: ApprovalItem['check']['samples'] = []): ApprovalItem => ({
  check: {
    request,
    refused: null,
    screens: [{ id: 'scr_1', name: 'Deli' }],
    defaultPlaylistId: 'pls_deli',
    madeDefault: null,
    liveOn: [{ spotId: 'spt_soup', screens: 1 }],
    held: [],
    samples,
    changes: [{ kind: 'spot', id: 'spt_soup', name: 'Soup board', fresh: false, fields: ['price', 'title'] }],
  },
  stages: [],
});

const rollBackTo = vi.fn();

function setup() {
  const queryClient = new QueryClient();
  const invalidated = vi.spyOn(queryClient, 'invalidateQueries');
  const store = createStore<ApprovalsSlice & { rollBackTo: typeof rollBackTo }>()((set, get) => ({
    rollBackTo,
    ...createApprovalsSlice(set as never, get as never, { router: { navigate: vi.fn() }, queryClient } as never),
  }));
  return { s: store, invalidated };
}

/** The toast titled `title` as sonner holds it. */
const toastTitled = (title: string) => toast.getToasts().find((t) => 'title' in t && t.title === title);

beforeEach(() => {
  toast.dismiss();
  vi.mocked(callTool).mockReset();
  rollBackTo.mockReset();
});

describe('approving', () => {
  it('publishes the request as checked, its sample text acknowledged exactly as listed; Undo rolls back to the publish before', async () => {
    const { s, invalidated } = setup();
    vi.mocked(callTool).mockResolvedValue({
      request: { ...request, status: 'approved' },
      published: { publish: { id: 'pub_7', revision: 7, screens: 1, previousId: 'pub_6' } },
    } as never);
    const shown = item([{ spotId: 'spt_soup', name: 'Soup board', version: 7, fields: ['title'] }]);
    // The confirmation keeps the request as shown: a read of the queue meanwhile does not change what it approves.
    s.getState().askApprove(shown);
    expect(s.getState().approvals.confirming).toBe(shown);
    await s.getState().approveRequest(ORG, shown);
    expect(callTool).toHaveBeenCalledWith('approve_publish_request', {
      publishRequestId: 'prq_1',
      ifScreens: ['scr_1'],
      ifDefault: 'pls_deli',
      allowSample: [{ spotId: 'spt_soup', version: 7, fields: ['title'] }],
    });
    expect(s.getState().approvals).toMatchObject({ confirming: null, deciding: null });
    const done = toastTitled('Approved. Rollout started.');
    expect(done).toMatchObject({ description: 'Published v7 as you to 1 screen; each switches as it hears of it.' });
    const undo = done && 'action' in done ? done.action : undefined;
    if (!undo || typeof undo !== 'object' || !('onClick' in undo)) throw new Error('no Undo');
    undo.onClick({} as never);
    expect(rollBackTo).toHaveBeenCalledWith(ORG, { id: 'pub_6', revision: 6 }, 'pub_7');
    // The queue, drafts, screens and the sidebar's counts read again.
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['org', ORG] });
  });

  it('acknowledges no sample text when the check listed none', async () => {
    const { s } = setup();
    vi.mocked(callTool).mockResolvedValue({ request, published: { publish: null } } as never);
    await s.getState().approveRequest(ORG, item());
    expect(callTool).toHaveBeenCalledWith('approve_publish_request', { publishRequestId: 'prq_1', ifScreens: ['scr_1'], ifDefault: 'pls_deli' });
    expect(toastTitled('Approved')).toMatchObject({ description: 'Every screen already plays what it asked for.' });
  });

  it('says why when it is refused, and is ready for the next', async () => {
    const { s } = setup();
    vi.mocked(callTool).mockRejectedValue(new Refusal('conflict', 'spot spt_soup is not at version 7; it is now version 8'));
    await s.getState().approveRequest(ORG, item());
    expect(toastTitled('Not approved')).toMatchObject({ description: 'spot spt_soup is not at version 7; it is now version 8' });
    expect(s.getState().approvals.deciding).toBeNull();
  });
});

describe('declining', () => {
  it('tells the person the agent is told, and Undo puts the request back', async () => {
    const { s } = setup();
    vi.mocked(callTool).mockResolvedValue({ request: { ...request, status: 'declined' } } as never);
    await s.getState().declineRequest(ORG, 'prq_1');
    expect(callTool).toHaveBeenLastCalledWith('decline_publish_request', { publishRequestId: 'prq_1' });
    const done = toastTitled('Declined. The agent is told.');
    const undo = done && 'action' in done ? done.action : undefined;
    if (!undo || typeof undo !== 'object' || !('onClick' in undo)) throw new Error('no Undo');
    vi.mocked(callTool).mockResolvedValue({ request } as never);
    // The call goes as the Undo is pressed, before anything is awaited.
    undo.onClick({} as never);
    expect(callTool).toHaveBeenLastCalledWith('reopen_publish_request', { publishRequestId: 'prq_1' });
    expect(s.getState().approvals.deciding).toBe('prq_1');
  });
});
