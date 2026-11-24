// The agent's drawer in the store (#267, #350): it opens on the page shown, asks through TanStack AI's
// ChatClient driven from the store, reads the turn's server-sent events however they are split,
// streams the answer's text and drops it when the turn fails, keeps each answer's whole card and sends
// them back with the next question, and says why a turn gave no answer. The API is a stubbed fetch;
// nothing waits on a clock.
import { type AnswerCard, CHAT_EVENTS, type ToolCard } from '@signforge/api/agent-chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { type AgentDrawerSlice, createAgentDrawerSlice } from '../src/state/agent-drawer';

vi.mock('~/lib/tab-org', () => ({ tabOrgHeaders: async () => ({}) }));
// The pages' reads the drafts' summaries use (#268): none is drafted here.
vi.mock('~/queries/screens', () => ({ screensQuery: vi.fn() }));
vi.mock('~/queries/schedule', () => ({ scheduleQuery: vi.fn() }));
vi.mock('~/queries/playlists', () => ({ playlistsQuery: vi.fn() }));
vi.mock('~/queries/spots', () => ({ spotsQuery: vi.fn(), templatesQuery: vi.fn() }));

/** Each request the drawer made: its body, and whether it was aborted. */
const sent: { body: any; signal: AbortSignal | undefined }[] = [];
/** The answer to a request, given its run's ids: the client keeps only its own run's events. */
let answer: (run: { runId: string; threadId: string }, signal?: AbortSignal) => Response = () => new Response('');

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', async (_path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ body, signal: init.signal ?? undefined });
    return answer(body, init.signal ?? undefined);
  });
});
afterEach(() => vi.unstubAllGlobals());

const CALL: ToolCard = { tool: 'list_screens', title: 'Screens', summary: 'Listed 2 screens', ok: true };
const CARD: AnswerCard = {
  text: 'Both Bayside screens went quiet at 09:14.',
  groups: [{ title: 'Bayside', screens: ['Bayside door', 'Bayside till'], why: 'Same minute' }],
  steps: [],
  trace: [CALL],
  drafts: [],
};

/** The turn's events as the API streams them (TanStack AI's, and ours): `answered` the card, else `error` why not. */
function events(run: { runId: string; threadId: string }, turn: { text: string; answered?: AnswerCard; error?: { code: string; message: string } }) {
  const id = 'msg_1';
  // Cut within the card's text, as a model writes it: `{"text":"` and a few words, then the rest.
  const half = 20;
  return [
    { type: 'RUN_STARTED', ...run },
    { type: 'CUSTOM', name: CHAT_EVENTS.call, value: CALL },
    { type: 'CUSTOM', name: 'structured-output.start', value: { messageId: id } },
    { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: turn.text.slice(0, half) },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: turn.text.slice(half) },
    { type: 'TEXT_MESSAGE_END', messageId: id },
    ...(turn.answered
      ? [
          { type: 'CUSTOM', name: 'structured-output.complete', value: { object: JSON.parse(turn.text), raw: turn.text } },
          { type: 'CUSTOM', name: CHAT_EVENTS.answer, value: turn.answered },
          { type: 'RUN_FINISHED', ...run, finishReason: 'stop' },
        ]
      : [{ type: 'RUN_ERROR', ...turn.error }]),
  ].map((e) => `data: ${JSON.stringify({ timestamp: 1, ...e })}\n\n`);
}

/** A stream of server-sent events that arrives in these chunks, split wherever they are, as a network splits it. */
const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

/** The model answers with `card`: its JSON streamed, then the card. */
const answering = (card: AnswerCard) => (run: { runId: string; threadId: string }) =>
  stream(...events(run, { text: JSON.stringify({ text: card.text, groups: card.groups, steps: card.steps }), answered: card }));

function drawerStore() {
  const panel: boolean[] = [];
  const router = { state: { location: { pathname: '/screens/scr_1' }, matches: [{ params: { screenId: 'scr_1' } as Record<string, string> }] } };
  const store = createStore<AgentDrawerSlice & { setRightPanel: (open: boolean) => void }>()((set, get) => ({
    ...createAgentDrawerSlice(set as never, get as never, { router, queryClient: {} } as never),
    setRightPanel: (open) => void panel.push(open),
  }));
  return { store, panel, router };
}

describe('the agent drawer, in the store', () => {
  it('opens, folding the sidebar, and closes', () => {
    const { store, panel } = drawerStore();
    store.getState().openAgentDrawer('sidebar');
    expect(store.getState().agentDrawer).toMatchObject({ open: true, opener: 'sidebar' });
    store.getState().closeAgentDrawer();
    expect(store.getState().agentDrawer.open).toBe(false);
    expect(panel).toEqual([true, false]);
  });

  it('asks as AG-UI, the question its one message, with the page shown when it asks, not the one it opened on (review of #327)', async () => {
    const { store, router } = drawerStore();
    answer = answering(CARD);
    store.getState().openAgentDrawer(null);
    router.state = { location: { pathname: '/playlists/pls_2' }, matches: [{ params: { playlistId: 'pls_2' } }] };
    await store.getState().askAgent('What plays?');
    expect(sent.at(-1)?.body).toMatchObject({
      messages: [{ role: 'user', content: 'What plays?' }],
      forwardedProps: { history: [], page: { path: '/playlists/pls_2', ids: { playlistId: 'pls_2' } } },
    });
  });

  it('reads the stream however it is split: each tool card as it runs, the text as it is written, then holds the answer', async () => {
    const { store } = drawerStore();
    const seen: { progress: ToolCard[]; streaming: string }[] = [];
    store.subscribe((s) => seen.push({ progress: s.agentDrawer.progress, streaming: s.agentDrawer.streaming }));
    answer = (run) => {
      const whole = answering(CARD)(run);
      return new Response(
        whole.body!.pipeThrough(
          new TransformStream({
            // Every chunk cut in three, mid-event.
            transform(chunk: Uint8Array, c) {
              const third = Math.ceil(chunk.length / 3);
              for (let i = 0; i < chunk.length; i += third) c.enqueue(chunk.slice(i, i + third));
            },
          }),
        ),
        { headers: whole.headers },
      );
    };
    store.getState().editQuestion('Why are 2 screens behind?');
    await store.getState().askAgent();
    expect(seen.some((s) => s.progress.length === 1 && s.progress[0]?.title === 'Screens')).toBe(true);
    // Part of the text, before the whole of it.
    expect(seen.some((s) => s.streaming !== '' && CARD.text.startsWith(s.streaming) && s.streaming !== CARD.text)).toBe(true);
    expect(store.getState().agentDrawer).toMatchObject({
      asking: false,
      question: '',
      progress: [],
      streaming: '',
      messages: [
        { role: 'user', text: 'Why are 2 screens behind?' },
        { role: 'assistant', card: CARD },
      ],
    });
  });

  it('drops the text it showed of a turn that then fails, keeping no card, and says why (#350)', async () => {
    const { store } = drawerStore();
    const streamed: string[] = [];
    store.subscribe((s) => s.agentDrawer.streaming && streamed.push(s.agentDrawer.streaming));
    answer = (run) =>
      stream(
        ...events(run, {
          text: '{"text":"Restart every screen now","groups":',
          error: { code: 'unreadable', message: 'The model gave no answer it could show. Ask again.' },
        }),
      );
    await store.getState().askAgent('Why?');
    expect(streamed.length).toBeGreaterThan(0);
    expect(store.getState().agentDrawer).toMatchObject({
      streaming: '',
      asking: false,
      messages: [
        { role: 'user', text: 'Why?' },
        { role: 'error', text: 'The model gave no answer it could show. Ask again.', inSettings: false },
      ],
    });
  });

  it("sends the conversation so far with the next question, each answer its card's answer, leaving out the errors", async () => {
    const { store } = drawerStore();
    answer = (run) => stream(...events(run, { text: '', error: { code: 'over_budget', message: 'This needed more than 8 lookups, so I stopped.' } }));
    await store.getState().askAgent('First?');
    answer = answering(CARD);
    await store.getState().askAgent('Second?');
    await store.getState().askAgent('Third?');
    expect(sent.at(-1)?.body).toMatchObject({
      messages: [{ role: 'user', content: 'Third?' }],
      forwardedProps: {
        history: [
          { role: 'user', text: 'First?' },
          { role: 'user', text: 'Second?' },
          // The card's answer: never its trace or drafts (review of #402).
          { role: 'assistant', card: { text: CARD.text, groups: CARD.groups, steps: CARD.steps } },
        ],
      },
    });
    expect(JSON.stringify(sent.at(-1)?.body.forwardedProps)).not.toContain('trace');
    // One thread for the conversation.
    expect(new Set(sent.map((s) => s.body.threadId)).size).toBe(1);
    expect(store.getState().agentDrawer.messages[1]).toEqual({ role: 'error', text: 'This needed more than 8 lookups, so I stopped.', inSettings: false });
  });

  it('forgets the conversation when the org changes, stops the turn on its way, and drops what it would still say (#335, review of #327)', async () => {
    const { store, panel } = drawerStore();
    answer = answering(CARD);
    store.getState().openAgentDrawer(null);
    await store.getState().askAgent('First?');
    const first = sent[0]!.body.threadId;
    // A turn on its way: it answers its first events, then waits.
    answer = (run, signal) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(events(run, { text: '{"text":"Late"}', answered: CARD }).slice(0, 5).join('')));
            // As fetch does: its body fails once the request is aborted.
            signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const late = store.getState().askAgent('Second?');
    await vi.waitFor(() => expect(store.getState().agentDrawer.progress).toHaveLength(1));
    store.getState().forgetAgentDrawer();
    await late;
    // Its request aborted: the API stops the turn when its stream is cancelled.
    expect(sent[1]?.signal?.aborted).toBe(true);
    expect(store.getState().agentDrawer).toEqual({ open: false, messages: [], question: '', asking: false, progress: [], streaming: '', opener: null });
    expect(panel).toEqual([true, false]);
    // The next question is the new org's alone, on a thread of its own.
    answer = answering(CARD);
    await store.getState().askAgent('Third?');
    expect(sent.at(-1)?.body).toMatchObject({ messages: [{ role: 'user', content: 'Third?' }], forwardedProps: { history: [] } });
    expect(sent.at(-1)?.body.threadId).not.toBe(first);
  });

  it("says a turn whose stream broke off was cut off, in its own words, not the client's", async () => {
    const { store } = drawerStore();
    answer = (run) =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                events(run, { text: '{"text":"Half', error: { code: 'unused', message: 'unused' } })
                  .slice(0, 5)
                  .join(''),
              ),
            );
          },
          // Read once its first events are: the connection is lost.
          pull(c) {
            c.error(new TypeError('network connection was lost'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    await store.getState().askAgent('Why?');
    expect(store.getState().agentDrawer).toMatchObject({
      streaming: '',
      messages: [
        { role: 'user', text: 'Why?' },
        { role: 'error', text: 'The answer was cut off. Check your connection and ask again.', inSettings: false },
      ],
    });
  });

  it('says why a turn did not run, with the way to Settings when an owner mends it', async () => {
    const { store } = drawerStore();
    answer = () => Response.json({ error: 'no_model', message: 'No model is set up for the agent yet.' }, { status: 409 });
    await store.getState().askAgent('Hi');
    expect(store.getState().agentDrawer.messages.at(-1)).toEqual({ role: 'error', text: 'No model is set up for the agent yet.', inSettings: true });
  });
});
