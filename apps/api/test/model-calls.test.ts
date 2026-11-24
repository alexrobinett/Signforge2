// The model calls on TanStack AI (#349): every request of a fill or a drawer step goes through the
// guards (`guardedStream`) as the call's `wrapFetch`. Nothing in process.env adds a header or moves
// the key; the key is opened from the vault for each call; an endpoint's key goes only to its own
// origin; nothing is retried; one deadline covers the whole call, its streamed answer included; and a
// failure comes back as one word, with no key or body in it. Which path a model id takes is shown
// too. No network: fetch and DNS are stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiProviders, chatWith, type ChatRequest, fillWith, type FillRequest } from '../src/agent/provider';
import { type FetchGuards, guardedStream } from '../src/data/fetch';
import { anthropicStream, completionStream } from './model-streams';

const DEV = { ENVIRONMENT: 'dev', CONNECTION_KEY: undefined, ANTHROPIC_BASE_URL: undefined, FEED_STUB_URL: undefined };
const KEY = 'sk-ant-api03-SECRETKEYSECRETKEYSECRET-0349';
const ANTHROPIC = { orgId: 'org-calls', provider: 'anthropic' as const, baseUrl: null };
const BASE = 'https://models.example.com/v1';
const ENDPOINT = { orgId: 'org-calls', provider: 'openai-compatible' as const, baseUrl: BASE };
const PUBLIC = '93.184.215.14';

const SCHEMA = { type: 'object', additionalProperties: false, required: ['headline'], properties: { headline: { type: 'string' } } };
const fill = (model = 'claude-haiku-5-5'): FillRequest => ({ model, system: 'Fill the spot.', text: 'Bake sale', schema: SCHEMA });
const step: ChatRequest = {
  model: 'claude-sonnet-5-5',
  system: 'Answer about screens.',
  turns: [{ role: 'user', text: 'Why are 2 screens behind?' }],
  tools: [{ name: 'list_screens', description: 'List the screens.', schema: { type: 'object', properties: {} } }],
};

/** Every request a model call made: where it went and every header it carried. */
type Seen = { url: string; headers: Record<string, string>; body: any };
const seen = async (input: RequestInfo | URL, init: RequestInit | undefined, into: Seen[]) => {
  const request = new Request(input, init);
  const text = await request.text();
  into.push({ url: request.url, headers: Object.fromEntries(request.headers), body: text ? JSON.parse(text) : undefined });
  return request;
};

/** Anthropic answering each call with `answer`, recording it. */
function anthropic(
  answer: (body: any) => Response | Promise<Response> = (b) => anthropicStream('m', b.model, [{ type: 'text', text: '{"headline":"Bake sale"}' }], 'end_turn'),
) {
  const asked: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    await seen(input, init, asked);
    return answer(asked.at(-1)!.body);
  };
  // Anthropic is not resolved: its address is fixed.
  const guards: FetchGuards = {
    fetch: () => Promise.reject(new Error('Anthropic goes through reach.fetch')),
    resolve: () => Promise.reject(new Error('not resolved')),
  };
  return { asked, reach: { fetch, guards } };
}

/** An endpoint answering each URL with `answer`, through the guards, recording each request. */
function endpoint(answer: (url: string) => Response) {
  const asked: Seen[] = [];
  const guards: FetchGuards = {
    resolve: async () => [PUBLIC],
    fetch: async (input, init) => answer((await seen(input, init, asked)).url),
  };
  return { asked, reach: { fetch: () => Promise.reject(new Error('fetched outside the guards')), guards } };
}

/** A streamed message's start, as Anthropic sends it. */
const START = {
  id: 'm',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [],
  stop_reason: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const sealed = (key: typeof ANTHROPIC | typeof ENDPOINT, apiKey = KEY) => aiProviders(DEV).seal(key, apiKey);

afterEach(() => vi.restoreAllMocks());

describe('headers and the key, whatever process.env holds', () => {
  const ENV = {
    ANTHROPIC_API_KEY: 'sk-ant-someone-elses-key',
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat-someone-elses-token',
    ANTHROPIC_BASE_URL: 'https://elsewhere.example.net',
    ANTHROPIC_CUSTOM_HEADERS:
      'Authorization: Bearer sk-ant-someone-elses-key\nX-Api-Key: sk-ant-someone-elses-key\nX-Leak: yes\nanthropic-beta: leak-2026\nanthropic-version: 1999-01-01\ncontent-type: text/plain',
    OPENAI_BASE_URL: 'https://elsewhere.example.net/v1',
    OPENAI_API_KEY: 'sk-someone-elses-key',
    OPENAI_CUSTOM_HEADERS: 'Authorization: Bearer sk-someone-elses-key\nX-Leak: yes',
    OPENAI_ORG_ID: 'org-elsewhere',
    OPENAI_PROJECT_ID: 'proj-elsewhere',
  };
  const withEnv = async <T>(run: () => Promise<T>) => {
    Object.assign(process.env, ENV);
    try {
      return await run();
    } finally {
      for (const name of Object.keys(ENV)) delete process.env[name];
    }
  };
  const ANTHROPIC_HEADERS = ['accept', 'anthropic-version', 'authorization', 'content-type', 'user-agent'];

  it("sends a fill and a drawer step only to Anthropic, with only the allowed headers and the org's own key", async () => {
    const a = anthropic((b) =>
      b.tools?.length
        ? anthropicStream('m', b.model, [{ type: 'tool_use', id: 't1', name: 'list_screens', input: {} }], 'tool_use')
        : anthropicStream('m', b.model, [{ type: 'text', text: '{"headline":"Bake sale"}' }], 'end_turn'),
    );
    const key = await sealed(ANTHROPIC);
    const [filled, stepped] = await withEnv(async () => [
      await fillWith(DEV, ANTHROPIC, key, a.reach, fill()),
      await chatWith(DEV, ANTHROPIC, key, a.reach, step, 25_000),
    ]);
    expect(filled).toEqual({ ok: true, text: '{"headline":"Bake sale"}' });
    expect(stepped).toMatchObject({ ok: true, step: { calls: [{ id: 't1', name: 'list_screens', input: {} }], refused: false } });
    expect(a.asked).toHaveLength(2);
    for (const r of a.asked) {
      // The adapter calls the beta Messages endpoint (`?beta=true`).
      expect(`${new URL(r.url).origin}${new URL(r.url).pathname}`).toBe('https://api.anthropic.com/v1/messages');
      expect(Object.keys(r.headers).sort()).toEqual(ANTHROPIC_HEADERS);
      expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
      // Our values, whatever the environment said for an allowed header: no beta added, the version and type not moved.
      expect(r.headers).toMatchObject({ 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'application/json' });
    }
  });

  it("sends an endpoint's calls only to its address, with only the allowed headers and its own key", async () => {
    const e = endpoint(() => completionStream({ content: '{"headline":"Bake sale"}' }, 'stop'));
    const key = await sealed(ENDPOINT);
    expect(await withEnv(() => fillWith(DEV, ENDPOINT, key, e.reach, fill('model-a')))).toEqual({ ok: true, text: '{"headline":"Bake sale"}' });
    expect(e.asked.map((r) => r.url)).toEqual([`${BASE}/chat/completions`]);
    expect(Object.keys(e.asked[0]!.headers).sort()).toEqual(['accept', 'authorization', 'content-type', 'user-agent']);
    expect(e.asked[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe('the key', () => {
  it('is opened from the vault for each call: a key saved again is the next call’s', async () => {
    const a = anthropic();
    await fillWith(DEV, ANTHROPIC, await sealed(ANTHROPIC), a.reach, fill());
    await fillWith(DEV, ANTHROPIC, await sealed(ANTHROPIC, 'sk-ant-api03-NEWKEYNEWKEYNEWKEY-0002'), a.reach, fill());
    expect(a.asked.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY}`, 'Bearer sk-ant-api03-NEWKEYNEWKEYNEWKEY-0002']);
  });

  it('opens only for the org and provider it was sealed for, asking nothing', async () => {
    const a = anthropic();
    const key = await sealed(ANTHROPIC);
    expect(await fillWith(DEV, { ...ANTHROPIC, orgId: 'org-other' }, key, a.reach, fill())).toEqual({ ok: false, problem: 'refused' });
    expect(await chatWith(DEV, { ...ANTHROPIC, orgId: 'org-other' }, key, a.reach, step, 25_000)).toEqual({ ok: false, problem: 'refused' });
    expect(a.asked).toEqual([]);
  });

  it("goes to no origin but the endpoint's: a redirect elsewhere is refused unfollowed, one within it is followed", async () => {
    const elsewhere = endpoint((url) =>
      url.endsWith('/chat/completions') ? Response.redirect('https://elsewhere.example.net/v1/x', 307) : new Response('no'),
    );
    const key = await sealed(ENDPOINT);
    expect(await chatWith(DEV, ENDPOINT, key, elsewhere.reach, { ...step, model: 'model-a' }, 25_000)).toEqual({ ok: false, problem: 'blocked' });
    expect(elsewhere.asked.map((r) => r.url)).toEqual([`${BASE}/chat/completions`]);
    const within = endpoint((url) =>
      url.endsWith('/chat/completions')
        ? Response.redirect(`${BASE}/moved`, 307)
        : completionStream({ toolCalls: [{ id: 'c1', name: 'list_screens', arguments: '{}' }] }, 'tool_calls'),
    );
    expect(await chatWith(DEV, ENDPOINT, key, within.reach, { ...step, model: 'model-a' }, 25_000)).toMatchObject({
      ok: true,
      step: { calls: [{ name: 'list_screens' }] },
    });
    expect(within.asked.map((r) => [r.url, r.headers.authorization])).toEqual([
      [`${BASE}/chat/completions`, `Bearer ${KEY}`],
      [`${BASE}/moved`, `Bearer ${KEY}`],
    ]);
  });
});

describe('failures, each one word', () => {
  it('retries nothing: one request for a refused, busy or failing answer, said as refused, busy or unreachable, never the body or key', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    const key = await sealed(ANTHROPIC);
    for (const [status, problem] of [
      [401, 'refused'],
      [403, 'refused'],
      [429, 'busy'],
      [500, 'busy'],
      [529, 'busy'],
      [404, 'unreachable'],
    ] as const) {
      const a = anthropic(() => Response.json({ type: 'error', error: { message: `refused ${KEY}` } }, { status }));
      const filled = await fillWith(DEV, ANTHROPIC, key, a.reach, fill());
      const stepped = await chatWith(DEV, ANTHROPIC, key, a.reach, step, 25_000);
      expect([filled, stepped], String(status)).toEqual([
        { ok: false, problem },
        { ok: false, problem },
      ]);
      expect(a.asked, String(status)).toHaveLength(2);
      expect(JSON.stringify([filled, stepped])).not.toContain('SECRETKEY');
    }
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain('SECRETKEY');
  });

  it('cuts off an answer still streaming at its deadline, which covers the whole call: unreachable', async () => {
    // Headers and the first event at once; then the deadline fires while the next read waits: injected, so no real time passes.
    const deadline = new AbortController();
    let reads = 0;
    const stalled = anthropic(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: START })}\n\n`));
            },
            pull() {
              // Asked for more once the first event is read: that read is pending when the deadline passes, and nothing more ever comes.
              if (++reads === 1) deadline.abort(new DOMException('the deadline', 'TimeoutError'));
              return new Promise(() => {});
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const reach = { ...stalled.reach, guards: { ...stalled.reach.guards, deadline: () => deadline.signal } };
    expect(await chatWith(DEV, ANTHROPIC, await sealed(ANTHROPIC), reach, step, 25_000)).toEqual({ ok: false, problem: 'unreachable' });
    expect(deadline.signal.aborted).toBe(true);
    expect(stalled.asked).toHaveLength(1);
  });

  it('refuses an answer that closes before its last event: Anthropic with no message_stop, an endpoint with no finish_reason and no [DONE]', async () => {
    const cut = anthropic(async () => {
      const whole = anthropicStream('m', 'claude-sonnet-5-5', [{ type: 'tool_use', id: 't1', name: 'list_screens', input: {} }], 'tool_use');
      // Everything but the last event: its stop reason came, its message_stop did not.
      return new Response((await whole.text()).replace(/event: message_stop[\s\S]*$/, ''), { headers: { 'content-type': 'text/event-stream' } });
    });
    expect(await chatWith(DEV, ANTHROPIC, await sealed(ANTHROPIC), cut.reach, step, 25_000)).toEqual({ ok: false, problem: 'unreachable' });
    const open = endpoint(
      () =>
        new Response(
          // The whole answer, but no finish_reason and no [DONE]: it may have been cut off after it.
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '{"headline":"Bake sale"}' }, finish_reason: null }] })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const key = await sealed(ENDPOINT);
    expect(await fillWith(DEV, ENDPOINT, key, open.reach, fill('model-a'))).toEqual({ ok: false, problem: 'unreachable' });
    expect(await chatWith(DEV, ENDPOINT, key, open.reach, { ...step, model: 'model-a' }, 25_000)).toEqual({ ok: false, problem: 'unreachable' });
  });

  it('refuses it in the guards themselves, whatever an adapter would make of it: the body errors, and the failure is kept', async () => {
    const call = (body: string) => {
      const g = guardedStream({
        origin: 'https://api.anthropic.com',
        headers: {},
        finished: (e) => e.event === 'message_stop',
        key: ['authorization', 'Bearer k'],
        typed: false,
        guards: { fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }), resolve: async () => [] },
      });
      return { g, read: async () => (await g.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })).text() };
    };
    const cut = call('event: message_delta\ndata: {}\n\n');
    await expect(cut.read()).rejects.toMatchObject({ code: 'network' });
    expect(cut.g.failure()).toMatchObject({ code: 'network' });
    // One that ends with its last event passes.
    const whole = call('event: message_delta\ndata: {}\n\nevent: message_stop\ndata: {}\n\n');
    expect(await whole.read()).toContain('message_stop');
    expect(whole.g.failure()).toBeUndefined();
  });

  it("logs nothing of a provider's error event, and says it in one word", async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    const failing = anthropic(
      () =>
        new Response(
          `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: START })}\n\nevent: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: `PROVIDER-TEXT ${KEY}` } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const key = await sealed(ANTHROPIC);
    const results = [await fillWith(DEV, ANTHROPIC, key, failing.reach, fill()), await chatWith(DEV, ANTHROPIC, key, failing.reach, step, 25_000)];
    expect(results).toEqual([
      { ok: false, problem: 'unreachable' },
      { ok: false, problem: 'unreachable' },
    ]);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toMatch(/PROVIDER-TEXT|SECRETKEY/);
  });

  it('refuses an answer that breaks off mid-stream: unreachable, never the bytes it had', async () => {
    const broken = anthropic(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_start\ndata: {"type":"message_start","message":{"id":"m","content":[],"model":"x","usage":{}}}\n\nevent: content_block_delta\ndata: {"partial":"${KEY}`,
                ),
              );
              controller.error(new TypeError('Network connection lost.'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const key = await sealed(ANTHROPIC);
    const results = [await fillWith(DEV, ANTHROPIC, key, broken.reach, fill()), await chatWith(DEV, ANTHROPIC, key, broken.reach, step, 25_000)];
    expect(results).toEqual([
      { ok: false, problem: 'unreachable' },
      { ok: false, problem: 'unreachable' },
    ]);
    expect(JSON.stringify(results)).not.toContain('SECRETKEY');
  });
});

describe('which path a model id takes (condition 3 of #346, one cast)', () => {
  it('fills with a known id in one streamed call to the schema, and with a dated or newer id in one call to a forced tool', async () => {
    const a = anthropic((b) =>
      b.stream
        ? anthropicStream('m', b.model, [{ type: 'text', text: '{"headline":"Bake sale"}' }], 'end_turn')
        : Response.json({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: b.model,
            content: [{ type: 'tool_use', id: 't', name: 'structured_output', input: { headline: 'Bake sale' } }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
    );
    const key = await sealed(ANTHROPIC);
    for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5-20261201']) {
      expect(await fillWith(DEV, ANTHROPIC, key, a.reach, fill(model)), model).toEqual({ ok: true, text: '{"headline":"Bake sale"}' });
    }
    expect(a.asked.map((r) => [r.body.model, r.body.stream, r.body.output_config?.format?.type ?? null, r.body.tool_choice?.name ?? null])).toEqual([
      ['claude-haiku-5-5', true, 'json_schema', null],
      ['claude-haiku-5-5-20261201', false, null, 'structured_output'],
    ]);
  });
});

describe('the words a fill says, the same as before on both paths (review of #391)', () => {
  /** Anthropic answering a known id streamed and a dated one whole, as each path asks, with `text` and `stop`. */
  const answering = (text: string, stop: string) =>
    anthropic((b) =>
      b.stream
        ? anthropicStream('m', b.model, [{ type: 'text', text }], stop)
        : Response.json({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: b.model,
            content: [{ type: 'text', text }],
            stop_reason: stop,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
    );
  const PATHS = ['claude-haiku-5-5', 'claude-haiku-5-5-20261201'];

  it('says a refusal is unreadable, with no second try', async () => {
    const key = await sealed(ANTHROPIC);
    for (const model of PATHS) {
      const a = answering('I cannot help with that.', 'refusal');
      expect(await fillWith(DEV, ANTHROPIC, key, a.reach, fill(model)), model).toEqual({ ok: false, problem: 'unreadable' });
      expect(a.asked, model).toHaveLength(1);
    }
  });

  it('hands prose back as the text, for the inline route to refuse and ask again', async () => {
    const key = await sealed(ANTHROPIC);
    for (const model of PATHS) {
      const a = answering('Here is a bake sale flyer.', 'end_turn');
      expect(await fillWith(DEV, ANTHROPIC, key, a.reach, fill(model)), model).toEqual({ ok: true, text: 'Here is a bake sale flyer.' });
    }
  });
});

describe("a tool call's input (review of #391)", () => {
  it("passes an endpoint's empty arguments as they came, for the tool to refuse, and Anthropic's empty input as {}", async () => {
    const e = endpoint(() => completionStream({ toolCalls: [{ id: 'c1', name: 'list_screens', arguments: '' }] }, 'tool_calls'));
    expect(await chatWith(DEV, ENDPOINT, await sealed(ENDPOINT), e.reach, { ...step, model: 'model-a' }, 25_000)).toMatchObject({
      ok: true,
      step: { calls: [{ id: 'c1', name: 'list_screens', input: '' }] },
    });
    const a = anthropic((b) => anthropicStream('m', b.model, [{ type: 'tool_use', id: 't1', name: 'list_screens', input: {} }], 'tool_use'));
    expect(await chatWith(DEV, ANTHROPIC, await sealed(ANTHROPIC), a.reach, step, 25_000)).toMatchObject({
      ok: true,
      step: { calls: [{ id: 't1', name: 'list_screens', input: {} }] },
    });
  });
});

describe('the final re-check of #391', () => {
  /** An Anthropic stream of `blocks` stopping for `stop`, cut before its message_stop, with `type` as its content type. */
  const cutStream = async (blocks: Parameters<typeof anthropicStream>[2], type: string) =>
    new Response((await anthropicStream('m', 'claude-sonnet-5-5', blocks, 'end_turn').text()).replace(/event: message_stop[\s\S]*$/, ''), {
      headers: { 'content-type': type },
    });

  it('refuses a cut stream whose text only mentions its last event, and one whose media type is in capitals', async () => {
    const key = await sealed(ANTHROPIC);
    const mentions = anthropic(() => cutStream([{ type: 'text', text: '{"headline":"event: message_stop"}' }], 'text/event-stream'));
    expect(await fillWith(DEV, ANTHROPIC, key, mentions.reach, fill())).toEqual({ ok: false, problem: 'unreachable' });
    const capitals = anthropic(() => cutStream([{ type: 'tool_use', id: 't1', name: 'list_screens', input: {} }], 'Text/Event-Stream; charset=utf-8'));
    expect(await chatWith(DEV, ANTHROPIC, key, capitals.reach, step, 25_000)).toEqual({ ok: false, problem: 'unreachable' });
  });

  it("hands back a known id's fill cut short by its token limit, for the inline route to ask again, as the dated path does", async () => {
    const partial = '{"headline":"Bake sa';
    const key = await sealed(ANTHROPIC);
    const a = anthropic((b) =>
      b.stream
        ? anthropicStream('m', b.model, [{ type: 'text', text: partial }], 'max_tokens')
        : Response.json({
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: b.model,
            content: [{ type: 'text', text: partial }],
            stop_reason: 'max_tokens',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
    );
    for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5-20261201'])
      expect(await fillWith(DEV, ANTHROPIC, key, a.reach, fill(model)), model).toEqual({ ok: true, text: partial });
  });

  it('says an empty answer is unreadable, with no second try, on both paths', async () => {
    const key = await sealed(ANTHROPIC);
    for (const model of ['claude-haiku-5-5', 'claude-haiku-5-5-20261201']) {
      const a = anthropic((b) =>
        b.stream
          ? anthropicStream('m', b.model, [], 'end_turn')
          : Response.json({
              id: 'm',
              type: 'message',
              role: 'assistant',
              model: b.model,
              content: [],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
      );
      expect(await fillWith(DEV, ANTHROPIC, key, a.reach, fill(model)), model).toEqual({ ok: false, problem: 'unreadable' });
      expect(a.asked, model).toHaveLength(1);
    }
  });
});
