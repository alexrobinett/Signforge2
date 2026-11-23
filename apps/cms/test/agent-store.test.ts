// The agent's fill in the store (#263, #316): its idempotency key is kept for a retry of the same
// material and template pick, and made anew when either changes, since the API refuses a replay
// under a key whose spot has another template (#314). The API is a stubbed fetch whose answers are
// lost; nothing waits on a clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type AgentSlice, createAgentSlice } from '../src/state/agent';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
// The spots' queries read through server functions, which only the Worker has; no fill here gets that far.
vi.mock('~/queries/spots', () => ({ spotKeys: {} }));

const ORG = 'org_1';
const LINK = 'https://bakery.example/flyer';

/** Every fill's request; each answer is lost on the way, as a dropped connection loses it. */
const sent: { idempotencyKey: string; templateVersionId?: string }[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    throw new TypeError('the connection dropped');
  });
});
afterEach(() => vi.unstubAllGlobals());

function agentStore() {
  const store = createStore<AgentSlice>()((set, get) => createAgentSlice(set as never, get as never, { router: {}, queryClient: {} } as never));
  store.getState().editFill({ link: LINK });
  return store;
}

const keys = () => sent.map((r) => r.idempotencyKey);

describe('the fill in the store', () => {
  it('sends a retry of the same material and pick under the same key', async () => {
    const store = agentStore();
    await store.getState().fillNewSpot(ORG);
    await store.getState().fillNewSpot(ORG);
    await store.getState().fillNewSpot(ORG, 'tpv_menu');
    await store.getState().fillNewSpot(ORG, 'tpv_menu');
    expect(store.getState().agent.fill.error).toMatch(/Could not reach SignForge/);
    const [first, second, third, fourth] = keys();
    expect(second).toBe(first);
    expect(fourth).toBe(third);
  });

  it('makes a new key when the template pick changes, so a lost answer then another pick is a new fill, not a refused replay (#316)', async () => {
    const store = agentStore();
    await store.getState().fillNewSpot(ORG);
    await store.getState().fillNewSpot(ORG, 'tpv_menu');
    await store.getState().fillNewSpot(ORG, 'tpv_promo');
    // Back to the agent's choice: another pick again.
    await store.getState().fillNewSpot(ORG);
    expect(sent.map((r) => r.templateVersionId)).toEqual([undefined, 'tpv_menu', 'tpv_promo', undefined]);
    expect(new Set(keys()).size).toBe(4);
  });

  it('makes a new key when the material changes', async () => {
    const store = agentStore();
    await store.getState().fillNewSpot(ORG);
    store.getState().editFill({ link: 'https://bakery.example/menu' });
    await store.getState().fillNewSpot(ORG);
    expect(new Set(keys()).size).toBe(2);
  });
});
