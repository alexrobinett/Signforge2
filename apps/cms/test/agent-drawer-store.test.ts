// The agent's drawer in the store (#267): it opens on the page shown, sends the conversation with
// the question, reads the turn's stream line by line however it arrives, and says why a turn gave
// no answer. The API is a stubbed fetch; nothing waits on a clock.
import type { ChatEvent } from '@signforge/api/agent-chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type AgentDrawerSlice, createAgentDrawerSlice } from '../src/state/agent-drawer';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));

const sent: unknown[] = [];
let answer: () => Response = () => new Response('');

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return answer();
  });
});
afterEach(() => vi.unstubAllGlobals());

/** A stream that arrives in these chunks, split wherever they are, as a network splits it. */
const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  );

const line = (e: ChatEvent) => `${JSON.stringify(e)}\n`;
const CARD = { text: 'Both Bayside screens went quiet at 09:14.', groups: [], steps: [], trace: [{ name: 'list_screens', summary: 'Listed 2 screens' }] };

function drawerStore() {
  const panel: boolean[] = [];
  const router = { state: { location: { pathname: '/screens/scr_1' }, matches: [{ params: { screenId: 'scr_1' } }] } };
  const store = createStore<AgentDrawerSlice & { setRightPanel: (open: boolean) => void }>()((set, get) => ({
    ...createAgentDrawerSlice(set as never, get as never, { router, queryClient: {} } as never),
    setRightPanel: (open) => void panel.push(open),
  }));
  return { store, panel };
}

describe('the agent drawer, in the store', () => {
  it('opens on the page shown, folding the sidebar, and closes', () => {
    const { store, panel } = drawerStore();
    store.getState().openAgentDrawer(null);
    expect(store.getState().agentDrawer).toMatchObject({ open: true, page: { path: '/screens/scr_1', ids: { screenId: 'scr_1' } } });
    store.getState().closeAgentDrawer();
    expect(store.getState().agentDrawer.open).toBe(false);
    expect(panel).toEqual([true, false]);
  });

  it('reads the stream line by line, however it is split, then holds the answer', async () => {
    const { store } = drawerStore();
    const whole = line({ type: 'call', item: CARD.trace[0]! }) + line({ type: 'answer', card: CARD });
    answer = () => stream(whole.slice(0, 7), whole.slice(7, 60), whole.slice(60));
    store.getState().openAgentDrawer(null);
    store.getState().editQuestion('Why are 2 screens behind?');
    await store.getState().askAgent();
    expect(sent).toEqual([{ messages: [{ role: 'user', text: 'Why are 2 screens behind?' }], page: { path: '/screens/scr_1', ids: { screenId: 'scr_1' } } }]);
    expect(store.getState().agentDrawer).toMatchObject({
      asking: false,
      question: '',
      progress: [],
      messages: [
        { role: 'user', text: 'Why are 2 screens behind?' },
        { role: 'assistant', card: CARD },
      ],
    });
  });

  it('sends the conversation so far with the next question, leaving out the errors', async () => {
    const { store } = drawerStore();
    answer = () => stream(line({ type: 'error', error: 'over_budget', message: 'This needed more than 8 lookups, so I stopped.' }));
    await store.getState().askAgent('First?');
    answer = () => stream(line({ type: 'answer', card: CARD }));
    await store.getState().askAgent('Second?');
    answer = () => stream(line({ type: 'answer', card: CARD }));
    await store.getState().askAgent('Third?');
    expect(sent.at(-1)).toMatchObject({
      messages: [
        { role: 'user', text: 'First?' },
        { role: 'user', text: 'Second?' },
        { role: 'assistant', text: CARD.text },
        { role: 'user', text: 'Third?' },
      ],
    });
    expect(store.getState().agentDrawer.messages[1]).toEqual({ role: 'error', text: 'This needed more than 8 lookups, so I stopped.', inSettings: false });
  });

  it('says why a turn did not run, with the way to Settings when an owner mends it', async () => {
    const { store } = drawerStore();
    answer = () => Response.json({ error: 'no_model', message: 'No model is set up for the agent yet.' }, { status: 409 });
    await store.getState().askAgent('Hi');
    expect(store.getState().agentDrawer.messages.at(-1)).toEqual({ role: 'error', text: 'No model is set up for the agent yet.', inSettings: true });
  });
});
