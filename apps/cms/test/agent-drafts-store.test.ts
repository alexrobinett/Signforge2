// The drawer's drafts in the store (#268): nothing written until the person saves them; a save as
// the API answers it, a refused one overwriting nothing; Undo putting each back as it was, as the
// person, the last first, at the version the save left. The API and the tools are stubs; nothing
// waits on a clock.
import type { AnswerCard, ChatEvent } from '@signforge/api/agent-chat';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type AgentDrawerSlice, createAgentDrawerSlice } from '../src/state/agent-drawer';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
vi.mock('~/lib/live', () => ({ orgOnScreen: () => 'org_1' }));
// The pages' reads, for the summaries: failing here, so none is worked out, which the card waits out.
const nothing = (key: string) => ({ queryKey: ['org', 'org_1', key], queryFn: async () => Promise.reject(new Error('not read in this test')) });
vi.mock('~/queries/screens', () => ({ screensQuery: () => nothing('screens') }));
vi.mock('~/queries/schedule', () => ({ scheduleQuery: () => nothing('schedule') }));
vi.mock('~/queries/playlists', () => ({ playlistsQuery: () => nothing('playlists') }));
vi.mock('~/queries/spots', () => ({ spotsQuery: () => nothing('spots'), templatesQuery: () => nothing('templates') }));
const tools = vi.hoisted(() => ({ calls: [] as { name: string; input: unknown }[] }));
vi.mock('~/lib/tools', async (actual) => ({
  ...(await actual<object>()),
  callToolByName: async (name: string, input: unknown) => {
    tools.calls.push({ name, input });
    return {};
  },
}));

const sent: { path: string; body: any }[] = [];
const answers: Response[] = [];
beforeEach(() => {
  sent.length = 0;
  answers.length = 0;
  tools.calls.length = 0;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    sent.push({ path, body: JSON.parse(String(init.body)) });
    const res = answers.shift();
    if (!res) throw new Error(`no answer for ${path}`);
    return res;
  });
});
afterEach(() => vi.unstubAllGlobals());

const BEFORE = { id: 'spt_1', name: 'Promo', templateVersionId: 'tpv_card', data: { headline: 'Breakfast served' }, version: 3 };
const CARD: AnswerCard = {
  text: 'A punchier headline, and breakfast on the drive-thrus.',
  groups: [],
  steps: [],
  trace: [],
  drafts: [
    {
      tool: 'update_spot',
      input: { spotId: 'spt_1', data: { headline: 'Hot breakfast, fast' }, ifVersion: 3 },
      target: { kind: 'spot', id: 'spt_1' },
      before: BEFORE,
    },
    { tool: 'create_schedule_entry', input: { playlistId: 'pls_b', target: 'group', groupId: 'grp_dt', idempotencyKey: 'k' }, target: null, before: null },
  ],
};
const turn = () =>
  new Response(`${JSON.stringify({ type: 'answer', card: CARD } satisfies ChatEvent)}\n`, { headers: { 'content-type': 'application/x-ndjson' } });

function draftsStore() {
  const reloaded: string[] = [];
  const store = createStore<any>()((set, get) => ({
    ...createAgentDrawerSlice(set, get, {
      router: { state: { location: { pathname: '/spots/spt_1' }, matches: [] } },
      queryClient: new QueryClient(),
    } as never),
    agent: { filled: {} },
    setRightPanel: () => {},
    reloadSpot: async (_o: string, id: string) => void reloaded.push(id),
    publishSpot: vi.fn(async () => {}),
    publishEntry: vi.fn(async () => {}),
  }));
  const at = () => store.getState().agentDrawer.messages[1];
  return { store: store as unknown as { getState: () => AgentDrawerSlice & Record<string, any> }, reloaded, at };
}

describe("the drawer's drafts, in the store", () => {
  it('writes nothing until saved; a save marks the spot in its editor and reloads it; Undo puts each back, the last first', async () => {
    const { store, reloaded, at } = draftsStore();
    answers.push(turn());
    await store.getState().askAgent('Make the headline punchier, and breakfast weekdays 6-11 on the drive-thrus');
    expect(at()).toMatchObject({ role: 'assistant', drafts: { status: 'proposed' } });
    expect(sent.map((s) => s.path)).toEqual(['/api/agent/chat']);

    answers.push(
      Response.json({
        results: [
          { tool: 'update_spot', ok: true, output: { spot: { ...BEFORE, data: { headline: 'Hot breakfast, fast' }, version: 4 } } },
          { tool: 'create_schedule_entry', ok: true, output: { entry: { id: 'sch_new', version: 1 } } },
        ],
      }),
    );
    await store.getState().saveDrafts(1);
    expect(sent.at(-1)).toEqual({ path: '/api/agent/apply', body: { calls: CARD.drafts.map(({ tool, input }) => ({ tool, input })) } });
    expect(at().drafts).toMatchObject({ status: 'saved', error: null });
    expect(reloaded).toEqual(['spt_1']);
    expect(store.getState().agent.filled.spt_1).toMatchObject({
      kind: 'update',
      before: { headline: 'Breakfast served' },
      wrote: { headline: 'Hot breakfast, fast' },
    });

    await store.getState().undoDrafts(1);
    expect(tools.calls).toEqual([
      { name: 'delete_schedule_entry', input: { scheduleEntryId: 'sch_new' } },
      { name: 'update_spot', input: { spotId: 'spt_1', data: { headline: 'Breakfast served' }, ifVersion: 4 } },
    ]);
    expect(at().drafts.status).toBe('undone');
    expect(store.getState().agent.filled.spt_1).toBeUndefined();
  });

  it('shows a refused save as the refused call, overwriting nothing: someone saved the spot since', async () => {
    const { store, at } = draftsStore();
    answers.push(turn());
    await store.getState().askAgent('Punchier');
    answers.push(
      Response.json({ results: [{ tool: 'update_spot', ok: false, error: 'conflict', message: 'spot spt_1 changed since version 3' }] }, { status: 409 }),
    );
    await store.getState().saveDrafts(1);
    expect(at().drafts).toMatchObject({ status: 'refused', error: 'spot spt_1 changed since version 3' });
    expect(store.getState().agent.filled).toEqual({});
    // Nothing of it was written, so Undo puts nothing back.
    await store.getState().undoDrafts(1);
    expect(tools.calls).toEqual([]);
  });
});
