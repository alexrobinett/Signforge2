// The agent's drawer in the store (#267, #350): it opens on the page shown, asks through TanStack AI's
// ChatClient driven from the store, reads the turn's server-sent events however they are split,
// streams the answer's text and drops it when the turn fails, keeps each answer's whole card and sends
// them back with the next question, and says why a turn gave no answer. The API is a stubbed fetch;
// nothing waits on a clock.
import { type AnswerCard, CHAT_EVENTS, type ConfirmCard, type ToolCard } from '@signforge/api/agent-chat';
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

/**
 * The turn's events as the API streams them (#350): its start, a tool's card, the card's text as it is
 * written (`signforge.text`, read by the API from the answer alone), then `answered` the card, else
 * `error` why not. Nothing else of the run reaches the browser.
 */
function events(run: { runId: string; threadId: string }, turn: { text: string; answered?: AnswerCard; error?: { code: string; message: string } }) {
  return [
    { type: 'RUN_STARTED', ...run },
    { type: 'CUSTOM', name: CHAT_EVENTS.call, value: CALL },
    { type: 'CUSTOM', name: CHAT_EVENTS.text, value: { text: turn.text.slice(0, 12) } },
    { type: 'CUSTOM', name: CHAT_EVENTS.text, value: { text: turn.text } },
    ...(turn.answered
      ? [
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
const answering = (card: AnswerCard) => (run: { runId: string; threadId: string }) => stream(...events(run, { text: card.text, answered: card }));

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
          text: 'Restart every screen now',
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
            c.enqueue(new TextEncoder().encode(events(run, { text: 'Late', answered: CARD }).slice(0, 3).join('')));
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
                events(run, { text: 'Half', error: { code: 'unused', message: 'unused' } })
                  .slice(0, 3)
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

  describe('a confirmation card (#269)', () => {
    const CONFIRM: ConfirmCard = {
      tool: 'restart_screen',
      title: 'Restart a screen',
      lines: ['Bayside door restarts now: it goes blank for a moment, then plays again.'],
      address: null,
      when: 'Now, on the live screen',
      undo: 'Nothing to undo.',
      press: 'Restart',
      token: 'tok_1',
      why: null,
      expiresAt: 1,
    };
    const sse = (run: { runId: string; threadId: string }, ...events: object[]) =>
      stream(...events.map((e) => `data: ${JSON.stringify({ timestamp: 1, ...run, ...e })}\n\n`));
    /** A turn that pauses at the card: the card, then the run's end, which carries no pause and no model input. */
    const pausing = (run: { runId: string; threadId: string }) =>
      sse(run, { type: 'RUN_STARTED' }, { type: 'CUSTOM', name: CHAT_EVENTS.confirm, value: CONFIRM }, { type: 'RUN_FINISHED', finishReason: 'tool_calls' });
    const DONE: AnswerCard = { ...CARD, text: 'Bayside door restarted.', trace: [{ tool: 'restart_screen', title: 'Restart screen', summary: 'Restarted a screen', ok: true }] };
    /** A press's run: what the action did (`done`), then the model's answer, or its end without one. */
    const pressed = (done: { ok: boolean; message: string }, answered: boolean) => (run: { runId: string; threadId: string }) =>
      sse(
        run,
        { type: 'RUN_STARTED' },
        { type: 'CUSTOM', name: CHAT_EVENTS.done, value: { tool: 'restart_screen', ...done } },
        ...(answered
          ? [{ type: 'CUSTOM', name: CHAT_EVENTS.answer, value: DONE }, { type: 'RUN_FINISHED', finishReason: 'stop' }]
          : [{ type: 'RUN_ERROR', code: 'unreadable', message: 'The model gave no answer it could show. Ask again.' }]),
      );

    it('pressed, sends the question again with the card\'s token and nothing of the call, once, and shows the answer', async () => {
      const { store } = drawerStore();
      answer = pausing;
      await store.getState().askAgent('Restart the Bayside door');
      expect(store.getState().agentDrawer).toMatchObject({ asking: false, messages: [{ role: 'user' }, { role: 'confirm', card: CONFIRM, press: 'offered' }] });
      answer = pressed({ ok: true, message: 'Restarted a screen' }, true);
      await store.getState().pressConfirm(1);
      const body = sent.at(-1)?.body;
      expect(body).toMatchObject({ messages: [{ role: 'user', content: 'Restart the Bayside door' }], forwardedProps: { confirm: 'tok_1', page: { path: '/screens/scr_1' } } });
      expect(body).not.toHaveProperty('resume');
      expect(body.messages).toHaveLength(1);
      expect(store.getState().agentDrawer).toMatchObject({
        asking: false,
        messages: [{ role: 'user' }, { role: 'confirm', press: 'done' }, { role: 'assistant', card: DONE }],
      });
      // Pressed once: again, nothing is sent.
      await store.getState().pressConfirm(1);
      expect(sent).toHaveLength(2);
    });

    it('says done or not from what the action did, never from the model: refused with an answer after it, done with none (review of #406)', async () => {
      const { store } = drawerStore();
      answer = pausing;
      await store.getState().askAgent('Restart it');
      answer = pressed({ ok: false, message: 'Not done: the screen is gone. This card is spent: ask again for a new one.' }, true);
      await store.getState().pressConfirm(1);
      expect(store.getState().agentDrawer.messages[1]).toMatchObject({ press: 'refused', error: 'Not done: the screen is gone. This card is spent: ask again for a new one.' });

      answer = pausing;
      await store.getState().askAgent('Restart it');
      answer = pressed({ ok: true, message: 'Restarted a screen' }, false);
      await store.getState().pressConfirm(4);
      expect(store.getState().agentDrawer.messages[4]).toMatchObject({ press: 'done', error: null });
      expect(store.getState().agentDrawer.asking).toBe(false);
    });

    it('sends nothing when let go, and says why a press was refused before it ran', async () => {
      const { store } = drawerStore();
      answer = pausing;
      await store.getState().askAgent('Restart it');
      store.getState().dismissConfirm(1);
      await store.getState().pressConfirm(1);
      expect(sent).toHaveLength(1);
      expect(store.getState().agentDrawer.messages[1]).toMatchObject({ role: 'confirm', press: 'dismissed' });

      await store.getState().askAgent('Restart it');
      answer = () => Response.json({ error: 'stale_card', message: 'This card has run out. Ask again for a new one.' }, { status: 409 });
      await store.getState().pressConfirm(3);
      expect(store.getState().agentDrawer.messages[3]).toMatchObject({ role: 'confirm', press: 'refused', error: 'This card has run out. Ask again for a new one.' });
      expect(store.getState().agentDrawer.asking).toBe(false);
    });

    it('lets a card waiting for its press go when the org changes: pressed after, it sends nothing', async () => {
      const { store } = drawerStore();
      answer = pausing;
      await store.getState().askAgent('Restart it');
      store.getState().forgetAgentDrawer();
      await store.getState().pressConfirm(1);
      expect(sent).toHaveLength(1);
      expect(store.getState().agentDrawer.messages).toEqual([]);
    });
  });

  it('says why a turn did not run, with the way to Settings when an owner mends it', async () => {
    const { store } = drawerStore();
    answer = () => Response.json({ error: 'no_model', message: 'No model is set up for the agent yet.' }, { status: 409 });
    await store.getState().askAgent('Hi');
    expect(store.getState().agentDrawer.messages.at(-1)).toEqual({ role: 'error', text: 'No model is set up for the agent yet.', inSettings: true });
  });
});
