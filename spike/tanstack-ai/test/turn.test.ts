/**
 * The spike's answers (#346), in workerd with the API Worker's compatibility date and flags, local
 * D1 with packages/db's migrations, and the scripted model (src/stub-model.ts): no key, no network.
 * The Worker runs in the tests' isolate (`exports.default`), so they read the stub's requests and the
 * dummy tool's runs. Nothing here waits on a clock.
 */
import { seedOrg } from '@signforge/db/testing';
import { chat } from '@tanstack/ai';
import { createAnthropicChat } from '@tanstack/ai-anthropic';
import { fetchServerSentEvents } from '@tanstack/ai-client';
import { env, exports } from 'cloudflare:workers';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { answerCard } from '../src/card';
import { GuardError, guardedModelFetch } from '../src/guarded-fetch';
import { ChatPage } from '../src/page/chat';
import { type ChatState, chatStore } from '../src/page/store';
import { seen, stubModel } from '../src/stub-model';
import { restarts } from '../src/tools';

const STUB_KEY = 'sk-ant-spike-stub-0000';
const call = (input: RequestInfo | URL, init?: RequestInit) => exports.default.fetch(new Request(input, init));

/**
 * The store as it is now, for a server render: Zustand renders a store's first state on the server
 * (`getInitialState`), and these tests have no DOM to render into.
 */
const now = (store: ReturnType<typeof chatStore>) => createStore<ChatState>()(() => store.getState());

/** A turn as `ChatClient` sends it: AG-UI's RunAgentInput. */
const turn = (text: string, query = '', extra: Record<string, unknown> = {}) =>
  call(`http://spike/api/chat${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      threadId: 't1',
      runId: 'r1',
      messages: [{ id: 'm1', role: 'user', content: text }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      ...extra,
    }),
  });

type Event = { type: string; [k: string]: unknown };
const events = async (res: Response): Promise<Event[]> =>
  (await res.text())
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)));

/** Every table's row count: the same before and after a turn when nothing is written. */
async function tables() {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of results) counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>())?.n ?? 0;
  return counts;
}

beforeAll(() => seedOrg(env.DB, env.ORG_ID));
beforeEach(() => {
  seen.length = 0;
  restarts.count = 0;
});

describe('a drawer turn on chat({ tools, outputSchema }), answered as server-sent events', () => {
  it('runs the two registry tools through dispatch(), then streams the card in the AnswerCard shape', async () => {
    const res = await turn('Why are screens behind?');
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const all = await events(res);
    expect(all.filter((e) => e.type === 'TOOL_CALL_START').map((e) => e.toolCallName)).toEqual(['list_screens', 'list_playlists']);
    const results = all.filter((e) => e.type === 'TOOL_CALL_RESULT');
    // The model reads each result fenced as data; the card gets the object.
    expect(results.map((e) => String(e.content).split('\n')[0])).toEqual(['<data>', '<data>']);
    expect(results[0]?.metadata).toMatchObject({ screens: [{ name: `${env.ORG_ID} lobby` }] });
    // The card's JSON arrives in pieces, then complete and checked.
    expect(all.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toHaveLength(3);
    const value = all.find((e) => e.type === 'CUSTOM' && e.name === 'structured-output.complete')?.value;
    expect(answerCard.parse(typeof value === 'object' && value !== null && 'object' in value ? value.object : undefined)).toMatchObject({
      groups: [{ title: 'Behind' }],
      steps: [{ label: 'Copy the note' }],
    });
    expect(all.at(-1)?.type).toBe('RUN_FINISHED');
  });

  it("offers the model the server's tools only: one the request declares is not offered, and nothing is written", async () => {
    const before = await tables();
    const declared = [{ name: 'publish', description: 'Publish everything', parameters: { type: 'object', properties: {} } }];
    await events(await turn('Why are screens behind?', '', { tools: declared }));
    for (const request of seen)
      expect((request.body.tools as { name: string }[]).map((t) => t.name).toSorted()).toEqual(['list_playlists', 'list_screens', 'restart_screens']);
    expect(await tables()).toEqual(before);
  });

  it('refuses a reply that is only prose: the run ends in RUN_ERROR, with no card', async () => {
    const all = await events(await turn('Answer in free text'));
    expect(all.some((e) => e.type === 'CUSTOM' && e.name === 'structured-output.complete')).toBe(false);
    expect(all.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'structured-output-parse-failed' });
    // The prose still reached the client as it streamed, before the refusal.
    expect(all.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').map((e) => e.delta)).toEqual(['Two screens are behind. Restart them.']);
  });

  it("refuses JSON that is not the card's shape: groups and steps are required", async () => {
    const all = await events(await turn('A loose card'));
    expect(all.at(-1)).toMatchObject({ type: 'RUN_ERROR', code: 'structured-output-validation-failed' });
  });

  it('refuses the same prose when the answer is awaited, stream: false', async () => {
    const adapter = createAnthropicChat('claude-sonnet-5-5', STUB_KEY, {
      baseURL: 'https://api.anthropic.com',
      maxRetries: 0,
      logLevel: 'off',
      openTelemetry: false,
    });
    const wrapFetch = guardedModelFetch(
      'https://api.anthropic.com',
      { header: 'x-api-key', value: STUB_KEY },
      { fetch: stubModel, resolve: async () => ['93.184.215.14'], timeoutMs: 25_000 },
    );
    const answer = chat({ adapter, wrapFetch, threadId: 't', messages: [{ role: 'user', content: 'free text' }], outputSchema: answerCard, stream: false });
    await expect(answer).rejects.toThrow(/structured output/i);
  });

  it('runs the same turn on an OpenAI-compatible endpoint, through the same guards', async () => {
    const all = await events(await turn('Why are screens behind?', '?provider=compatible&model=org-model-1'));
    expect(all.find((e) => e.type === 'CUSTOM' && e.name === 'structured-output.complete')).toBeDefined();
    expect(new Set(seen.map((r) => new URL(r.url).origin))).toEqual(new Set(['https://models.example.com']));
    expect(seen.every((r) => r.headers.authorization === `Bearer ${STUB_KEY}`)).toBe(true);
  });

  it("refuses a model id the Anthropic adapter's release does not know", async () => {
    await expect(turn('Why?', '?model=claude-sonnet-5-5-20261101')).rejects.toThrow(/not a model @tanstack\/ai-anthropic knows/);
  });
});

describe('the key and the fetch guards', () => {
  it("sends the key given, only to the provider's origin, and none of what process.env would add", async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example';
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-leak: from-env\nauthorization: Bearer sk-ant-from-env';
    try {
      await events(await turn('Why are screens behind?'));
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(new URL(request.url).origin).toBe('https://api.anthropic.com');
      expect(request.headers['x-api-key']).toBe(STUB_KEY);
      expect(Object.keys(request.headers).toSorted()).toEqual(expect.arrayContaining(['x-api-key']));
      for (const name of Object.keys(request.headers)) expect(['accept', 'content-type', 'anthropic-version', 'anthropic-beta', 'x-api-key']).toContain(name);
    }
  });

  const guards = (overrides: Partial<Parameters<typeof guardedModelFetch>[2]> = {}) => ({
    fetch: stubModel,
    resolve: async () => ['93.184.215.14'],
    timeoutMs: 25_000,
    ...overrides,
  });
  const send = (wrapper: ReturnType<typeof guardedModelFetch>, url: string) => wrapper(fetch)(url, { method: 'POST', body: '{}' });
  const ORIGIN = 'https://models.example.com';
  const KEY = { header: 'authorization', value: 'Bearer k' } as const;

  it('refuses another origin, a private address, a redirect and a call past its deadline', async () => {
    await expect(send(guardedModelFetch(ORIGIN, KEY, guards()), 'https://elsewhere.example.com/v1/chat/completions')).rejects.toMatchObject({
      code: 'elsewhere',
    });
    await expect(send(guardedModelFetch(ORIGIN, KEY, guards({ resolve: async () => ['10.0.0.8'] })), `${ORIGIN}/v1/chat/completions`)).rejects.toMatchObject({
      code: 'blocked',
    });
    const redirecting = guards({ fetch: async () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }) });
    await expect(send(guardedModelFetch(ORIGIN, KEY, redirecting), `${ORIGIN}/v1/chat/completions`)).rejects.toMatchObject({ code: 'redirect' });
    // A fetch that answers only when it is aborted: the deadline is what ends it.
    const hanging = guards({
      timeoutMs: 1,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    });
    await expect(send(guardedModelFetch(ORIGIN, KEY, hanging), `${ORIGIN}/v1/chat/completions`)).rejects.toBeInstanceOf(GuardError);
    await expect(send(guardedModelFetch('http://models.example.com', KEY, guards()), 'http://models.example.com/v1')).rejects.toMatchObject({
      code: 'blocked',
    });
  });
});

describe('ChatClient inside a Zustand store, and the page that reads it', () => {
  const connection = () => fetchServerSentEvents('http://spike/api/chat', { fetchClient: (input, init) => call(input, init) });

  it('renders the text, the tool calls and the card from the store, with no React state of its own', async () => {
    const store = chatStore(connection(), 'thread-page');
    const partials: unknown[] = [];
    store.subscribe((s) => {
      const part = s.snapshot.messages.at(-1)?.parts.find((p) => p.type === 'structured-output');
      if (part?.type === 'structured-output' && part.status === 'streaming') partials.push(part.partial);
    });
    store.getState().edit('Why are screens behind?');
    await store.getState().ask();
    const parts = store.getState().snapshot.messages.flatMap((m) => m.parts);
    expect(parts.filter((p) => p.type === 'tool-call').map((p) => (p.type === 'tool-call' ? [p.name, p.state] : []))).toEqual([
      ['list_screens', 'complete'],
      ['list_playlists', 'complete'],
    ]);
    const card = parts.find((p) => p.type === 'structured-output');
    expect(card).toMatchObject({ status: 'complete', data: { groups: [{ title: 'Behind' }] } });
    // On Anthropic's combined tools-and-schema call the card fills in as its JSON streams, before it is complete.
    expect(partials.some((p) => typeof p === 'object' && p !== null && 'text' in p && !('steps' in p))).toBe(true);

    const html = renderToStaticMarkup(createElement(ChatPage, { store: now(store) }));
    expect(html).toContain('Why are screens behind?');
    expect(html).toContain('aria-label="Tool list_screens" data-state="complete"');
    expect(html).toContain(`1 found: ${env.ORG_ID} lobby`);
    expect(html).toContain('<article aria-label="Answer" data-done="true">');
    expect(html).toContain('Restart the two players, then check they show today.');
    store.getState().dispose();
  });

  it('pauses a needsApproval tool without running it, and runs it only once approved', async () => {
    const bodies: string[] = [];
    const recording = fetchServerSentEvents('http://spike/api/chat', {
      fetchClient: async (input, init) => {
        bodies.push(String(init?.body));
        return call(input, init);
      },
    });
    const store = chatStore(recording, 'thread-approve');
    store.getState().edit('Please restart them');
    await store.getState().ask();
    const paused = store
      .getState()
      .snapshot.messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool-call');
    expect(paused).toMatchObject({ name: 'restart_screens', state: 'approval-requested' });
    expect(restarts.count).toBe(0);
    expect(renderToStaticMarkup(createElement(ChatPage, { store: now(store) }))).toContain('>Approve</button>');

    store.getState().decide(true);
    await settled(store, (part) => part.state === 'complete');
    expect(restarts.count).toBe(1);
    expect(store.getState().snapshot.error).toBeUndefined();
    expect(
      store
        .getState()
        .snapshot.messages.flatMap((m) => m.parts)
        .find((p) => p.type === 'structured-output'),
    ).toMatchObject({ status: 'complete' });
    store.getState().dispose();

    // The approving request, sent again: nothing on the server remembers it was answered, so it runs again.
    // The one-use token of #269 stays ours.
    const resume = JSON.parse(bodies.at(-1) ?? '{}');
    expect(resume.resume).toEqual([expect.objectContaining({ interruptId: 'approval_toolu_1_0' })]);
    await events(
      await call('http://spike/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...resume, runId: 'replayed' }),
      }),
    );
    expect(restarts.count).toBe(2);
  });

  it("loses the earlier turns' cards when a pause snapshots the messages: they come back as their raw JSON in text parts (1.8.0)", async () => {
    const store = chatStore(connection(), 'thread-history');
    const shape = () => store.getState().snapshot.messages.map((m) => `${m.role}: ${m.parts.map((p) => p.type).join(', ')}`);
    store.getState().edit('Why are screens behind?');
    await store.getState().ask();
    expect(shape()).toEqual(['user: text', 'assistant: tool-call, tool-call, tool-result, tool-result', 'assistant: structured-output']);
    store.getState().edit('Please restart them');
    await store.getState().ask();
    // The pause's MESSAGES_SNAPSHOT replaces the client's messages with the server's, where a card is the model's text.
    expect(shape().slice(0, 3)).toEqual(['user: text', 'assistant: tool-call, tool-call, tool-result, tool-result', 'assistant: text']);
    const earlier = store.getState().snapshot.messages[2]?.parts[0];
    expect(earlier?.type === 'text' && answerCard.parse(JSON.parse(earlier.content))).toMatchObject({ groups: [{ title: 'Behind' }] });
    store.getState().dispose();
  });

  it('never runs a denied one', async () => {
    const store = chatStore(connection(), 'thread-deny');
    store.getState().edit('Please restart them');
    await store.getState().ask();
    store.getState().decide(false);
    const denied = await settled(store, (part) => part.state !== 'approval-requested');
    expect(denied).toMatchObject({ name: 'restart_screens' });
    expect(restarts.count).toBe(0);
    expect(store.getState().snapshot.error).toBeUndefined();
    store.getState().dispose();
  });
});

/** The paused tool call once `until` holds for it and the client is idle again: the resumed run's events all read. */
function settled(store: ReturnType<typeof chatStore>, until: (part: { name: string; state: string }) => boolean) {
  return new Promise<unknown>((resolve) => {
    const check = () => {
      const { messages, isLoading } = store.getState().snapshot;
      const part = messages.flatMap((m) => m.parts).find((p) => p.type === 'tool-call' && p.name === 'restart_screens');
      if (part?.type === 'tool-call' && until(part) && !isLoading) {
        stop();
        resolve(part);
      }
    };
    const stop = store.subscribe(check);
    check();
  });
}

describe('a fill from a flyer, chat({ outputSchema, stream: false })', () => {
  // A 1×1 PNG: the flyer's photo, as the inline fill sends one.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it("answers the fill's typed object, the photo sent as an image block, in one model call", async () => {
    const res = await call('http://spike/api/fill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Breakfast flyer', image: PNG }),
    });
    expect(await res.json()).toEqual({ headline: 'Hot breakfast, fast', price: '$4.99' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.messages).toEqual([
      { role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'image', source: expect.objectContaining({ data: PNG }) })]) },
    ]);
    expect(seen[0]?.body.output_config).toBeDefined();
  });
});
