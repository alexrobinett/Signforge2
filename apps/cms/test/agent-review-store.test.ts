// The agent's update of a spot in the store (#264): the draft saved before it is read, the review
// held until Keep, Keep at the version it was made on, a save made since refused and offered a
// Reload, and Undo putting back what Keep changed. The API is a stubbed fetch the test answers;
// nothing waits on a clock.
import type { FieldDef } from '@signforge/contract';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type AgentSlice, createAgentSlice } from '../src/state/agent';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
// The org's spots and templates, as the Spots page reads them: nothing else on them here.
vi.mock('~/queries/spots', () => ({
  spotKeys: { all: (o: string) => ['org', o, 'spots'], one: (o: string, s: string) => ['org', o, 'spots', s] },
  spotsQuery: (o: string) => ({ queryKey: ['org', o, 'spots'], queryFn: async () => ({ spots: [] }) }),
  templatesQuery: (o: string) => ({ queryKey: ['org', o, 'templates'], queryFn: async () => ({ templates: [] }) }),
}));

const ORG = 'org_1';
const SPOT = 'spt_breakfast';
const FIELDS: Record<string, FieldDef> = {
  title: { type: 'text', label: 'Title' },
  items: { type: 'list', label: 'Items', item: { name: { type: 'text', label: 'Name' }, price: { type: 'text', label: 'Price' } } },
};
const BEFORE = {
  title: 'Morning',
  items: [
    { name: 'Latte', price: '$4.50' },
    { name: 'Mocha', price: '$5.00' },
  ],
};
const AFTER = {
  title: 'Morning',
  items: [
    { name: 'Latte', price: '$4.75' },
    { name: 'Flat white', price: '$4.00' },
  ],
};

/** Each request to the API, and the answers the test gives in turn. */
const sent: { path: string; body: any }[] = [];
const answers: Response[] = [];

beforeEach(() => {
  sent.length = 0;
  answers.length = 0;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    sent.push({ path, body: JSON.parse(String(init.body)) });
    const res = answers.shift();
    if (!res) throw new Error(`no answer for ${path}`);
    return res;
  });
});
afterEach(() => vi.unstubAllGlobals());

type Store = AgentSlice & {
  saveSpotDraft: (id: string) => Promise<void>;
  redrawStage: () => void;
  reloadSpot: (o: string, id: string) => Promise<void>;
  editSpot: (o: string, id: string, change: (d: { data: Record<string, unknown> }) => { data: Record<string, unknown> }) => void;
  openNewSpot: (open: boolean) => void;
};

function agentStore() {
  const saved: string[] = [];
  const edits: Record<string, unknown>[] = [];
  const queryClient = new QueryClient();
  const store = createStore<Store>()((set, get) => ({
    ...createAgentSlice(set as never, get as never, { router: { navigate: vi.fn() }, queryClient } as never),
    saveSpotDraft: async (id) => void saved.push(id),
    redrawStage: () => {},
    reloadSpot: async () => {},
    editSpot: (_o, _id, change) => void edits.push(change({ data: { ...AFTER, title: 'Edited since' } }).data),
    openNewSpot: () => {},
  }));
  store.getState().editFill({ link: 'https://cafe.example/menu' });
  return { store, saved, edits, queryClient };
}

const review = (version = 7) =>
  Response.json({ review: { spotId: SPOT, version, before: BEFORE, data: AFTER, marks: { items: { state: 'check', note: 'A guess: check it' } } } });

describe('an update from a photo or link, in the store', () => {
  it('saves the draft, then holds what the agent would change, writing nothing', async () => {
    const { store, saved } = agentStore();
    answers.push(review());
    await store.getState().reviewFill(ORG, SPOT, FIELDS);
    expect(saved).toEqual([SPOT]);
    expect(sent).toEqual([{ path: '/api/agent/inline', body: { source: { kind: 'link', url: 'https://cafe.example/menu' }, spotId: SPOT } }]);
    expect(store.getState().agent.reviews[SPOT]).toMatchObject({ version: 7, before: BEFORE, data: AFTER, from: 'link', alsoOn: [] });
  });

  it('keeps exactly the review, at the version it was made on, then offers Undo of what it changed', async () => {
    const { store, edits } = agentStore();
    answers.push(review(), Response.json({ spot: { id: SPOT, data: AFTER, version: 8 } }));
    await store.getState().reviewFill(ORG, SPOT, FIELDS);
    await store.getState().keepReview(SPOT, FIELDS);
    expect(sent[1]).toEqual({ path: '/api/agent/inline/keep', body: { spotId: SPOT, ifVersion: 7, data: AFTER } });
    expect(store.getState().agent.reviews[SPOT]).toBeUndefined();
    expect(store.getState().agent.filled[SPOT]).toMatchObject({ kind: 'update', before: { items: BEFORE.items }, marks: { items: { state: 'check' } } });
    // Undo puts back the items, which the agent changed, and leaves the title someone edited since.
    store.getState().undoUpdate(ORG, SPOT);
    expect(edits).toEqual([{ ...AFTER, title: 'Edited since', items: BEFORE.items }]);
    expect(store.getState().agent.filled[SPOT]).toBeUndefined();
  });

  it("keeps someone else's save made since: Keep is refused, and the review offers Reload", async () => {
    const { store } = agentStore();
    answers.push(review(), Response.json({ error: 'conflict', message: 'spot spt_breakfast changed since version 7' }, { status: 409 }));
    await store.getState().reviewFill(ORG, SPOT, FIELDS);
    await store.getState().keepReview(SPOT, FIELDS);
    expect(store.getState().agent.reviews[SPOT]).toMatchObject({ stale: true, keeping: false, error: expect.stringContaining('Their change is kept') });
    expect(store.getState().agent.filled[SPOT]).toBeUndefined();
    await store.getState().reloadReviewed(SPOT);
    expect(store.getState().agent.reviews[SPOT]).toBeUndefined();
  });

  it('lets a review go with Retake or Discard, writing nothing', async () => {
    const { store } = agentStore();
    answers.push(review(), review());
    await store.getState().reviewFill(ORG, SPOT, FIELDS);
    store.getState().retakeFill(SPOT);
    expect(store.getState().agent).toMatchObject({ reviews: {}, fillingSpot: SPOT });
    await store.getState().reviewFill(ORG, SPOT, FIELDS);
    store.getState().discardReview(SPOT);
    expect(store.getState().agent.reviews).toEqual({});
    expect(sent.map((s) => s.path)).toEqual(['/api/agent/inline', '/api/agent/inline']);
  });
});
