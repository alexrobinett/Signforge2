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
  spotQuery: (o: string, s: string) => ({ queryKey: ['org', o, 'spots', s], queryFn: async () => server.spots[s] ?? null }),
  templatesQuery: (o: string) => ({ queryKey: ['org', o, 'templates'], queryFn: async () => ({ templates: server.templates }) }),
}));
const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast: toasts }));
/** What the server holds, for the reads the store makes fresh. */
const server = vi.hoisted(() => ({ spots: {} as Record<string, unknown>, templates: [] as unknown[] }));

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

/** The editor's draft, as Undo's edit reads it. */
type Draft = { data: Record<string, unknown>; bindings: Record<string, unknown> };

type Store = AgentSlice & {
  clearSamples: (spotId: string, fields: readonly string[]) => void;
  spotEditor: { drafts: Record<string, { orgId: string; status: string }> };
  saveSpotDraft: (id: string) => Promise<void>;
  redrawStage: () => void;
  reloadSpot: (o: string, id: string) => Promise<void>;
  editSpot: (o: string, id: string, change: (d: Draft) => Draft) => void;
  openNewSpot: (open: boolean) => void;
};

/**
 * A store whose drafts save as `saves` says (saved, unless named), as the editor's versioned drafts
 * leave them; its spot's draft, as an edit sees it, is `draft` (AFTER with its title edited since, unless given).
 */
function agentStore(saves: Record<string, string> = {}, draft: Draft = { data: { ...AFTER, title: 'Edited since' }, bindings: {} }) {
  const saved: string[] = [];
  const edits: Record<string, unknown>[] = [];
  const queryClient = new QueryClient();
  const store = createStore<Store>()((set, get) => ({
    ...createAgentSlice(set as never, get as never, { router: { navigate: vi.fn() }, queryClient } as never),
    spotEditor: { drafts: {} },
    saveSpotDraft: async (id) => {
      saved.push(id);
      set((s) => ({ spotEditor: { drafts: { ...s.spotEditor.drafts, [id]: { orgId: ORG, status: saves[id] ?? 'saved' } } } }));
    },
    redrawStage: () => {},
    reloadSpot: async () => {},
    editSpot: (_o, _id, change) => void edits.push(change(draft).data),
    openNewSpot: () => {},
    clearSamples: () => {},
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

  it("stops, sending nothing, when the draft does not save: what was typed is the person's, and Keep would drop it (review of #319)", async () => {
    const { store } = agentStore({ [SPOT]: 'invalid' });
    await store.getState().reviewFill(ORG, SPOT, FIELDS);
    expect(sent).toEqual([]);
    expect(store.getState().agent.fill.error).toMatch(/fix what is marked/);
    expect(store.getState().agent.reviews).toEqual({});
  });

  describe('Undo leaves what the person changed since Keep, by any path (review of #319)', () => {
    const both = { ...AFTER, title: 'Lunch' };
    const FIXED = [{ name: 'Latte', price: '$4.70' }, ...AFTER.items.slice(1)];
    /** Keep of both the title and the items, then Undo, with the draft as the person left it since. */
    async function keptThenUndone(draft: Draft, edited?: string) {
      const { store, edits } = agentStore({}, draft);
      answers.push(
        Response.json({ review: { spotId: SPOT, version: 7, before: BEFORE, data: both, marks: {} } }),
        Response.json({ spot: { id: SPOT, data: both, version: 8 } }),
      );
      await store.getState().reviewFill(ORG, SPOT, FIELDS);
      await store.getState().keepReview(SPOT, FIELDS);
      expect(store.getState().agent.filled[SPOT]).toMatchObject({ changed: 2, before: { title: 'Morning', items: BEFORE.items }, wrote: both });
      if (edited) store.getState().clearFillMark(SPOT, edited);
      store.getState().undoUpdate(ORG, SPOT);
      return edits;
    }

    it('a row fixed in the Content form: the items stay as fixed, the title goes back', async () => {
      expect(await keptThenUndone({ data: { ...both, items: FIXED }, bindings: {} }, 'items')).toEqual([{ ...both, items: FIXED, title: 'Morning' }]);
    });

    it('the items connected to a source in the Source section, with fallback rows typed there: they stay, though no mark was cleared', async () => {
      const fallback = [{ name: 'Soup', price: '$6' }];
      const bound = { data: { ...both, items: fallback }, bindings: { items: { dataSourceId: 'dsrc_menu', path: 'rows' } } };
      expect(await keptThenUndone(bound)).toEqual([{ ...both, items: fallback, title: 'Morning' }]);
    });

    it('the items bound to a source, still holding what Keep wrote: the source has them now, so they stay', async () => {
      const bound = { data: both, bindings: { items: { dataSourceId: 'dsrc_menu', path: 'rows' } } };
      expect(await keptThenUndone(bound)).toEqual([{ ...both, title: 'Morning' }]);
    });

    it('a field edited by any path whose mark was never cleared: it stays as edited', async () => {
      expect(await keptThenUndone({ data: { ...both, items: FIXED }, bindings: {} })).toEqual([{ ...both, items: FIXED, title: 'Morning' }]);
    });
  });

  it('reviews the same row on another spot from that spot as it is now, after saving its draft, and not while its draft does not save (review of #319)', async () => {
    server.templates = [{ id: 'tpl_menu', versions: [{ id: 'tpv_menu', status: 'approved', manifest: { fields: FIELDS } }] }];
    const offer = { spotId: 'spt_lunch', name: 'Lunch menu', items: ['Latte'], version: 3, before: {}, data: {}, rows: { latte: { price: '$4.75' } } };

    const refused = agentStore({ spt_lunch: 'invalid' });
    await refused.store.getState().reviewAlsoOn(ORG, SPOT, offer);
    expect(refused.saved).toEqual(['spt_lunch']);
    expect(toasts.error).toHaveBeenCalledWith('Not reviewed', { description: expect.stringContaining('fix what is marked') });
    expect(refused.store.getState().agent.reviews).toEqual({});

    // Saved since it was offered: someone retitled it, at version 4. The review is of that.
    server.spots.spt_lunch = {
      id: 'spt_lunch',
      name: 'Lunch menu',
      kind: 'template',
      templateVersionId: 'tpv_menu',
      data: { title: 'Their lunch', items: [{ name: 'Latte', price: '$4.50' }] },
      bindings: null,
      version: 4,
    };
    const { store } = agentStore();
    await store.getState().reviewAlsoOn(ORG, SPOT, offer);
    expect(store.getState().agent.reviews.spt_lunch).toMatchObject({
      version: 4,
      before: { title: 'Their lunch', items: [{ name: 'Latte', price: '$4.50' }] },
      data: { title: 'Their lunch', items: [{ name: 'Latte', price: '$4.75' }] },
      from: 'spot',
    });
  });
});
