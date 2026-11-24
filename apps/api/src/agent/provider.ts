/**
 * The model providers behind the built-in agent (docs/proposals/cms-agent.md, Providers): one
 * interface, so the inline and chat routes (#263, #267) do not know which provider answers. Both are
 * TanStack AI adapters (#349): Anthropic's, and `openaiCompatibleText` for an OpenAI-compatible
 * endpoint (#262) at the address its owner gave. Model ids are never in code: an org chooses exact
 * ids from its provider's list, and the API's configuration names the demo model (#265).
 *
 * Every request of a model call goes through the guards (`guardedStream`, src/data/fetch.ts), as the
 * call's `wrapFetch`: only to the provider's origin (an endpoint's, every hop checked as a typed URL
 * is), its headers rebuilt from a short list and the key set there, so nothing an adapter or its SDK
 * reads from `process.env` changes where a request goes or what it carries; a redirect only within
 * that origin; one deadline over the call, its streamed answer included. No retries.
 *
 * An org's key is opened only here, from the vault, for one call. A failure is reported in a word
 * (`problem`): never the provider's body, never the key.
 */
import type { AiKey, AiProviders, AiProviderTest } from '@signforge/tools';
import { type AnyTextAdapter, chat, type ChatMiddleware, maxIterations, type ModelMessage, type StreamChunk } from '@tanstack/ai';
import { type AnthropicChatModel, createAnthropicChat } from '@tanstack/ai-anthropic';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';
import { workerFetch } from '../connectors';
import { openAiKey, sealAiKey } from '../connectors/vault';
import { FetchError, type FetchErrorCode, type FetchGuards, feedGuards, guardedStream, type ModelCall } from '../data/fetch';

/** What the agent's routes ask of a provider. */
interface ModelProvider {
  /** The model ids the key may use: the cheapest request that proves the key works, costing no tokens. */
  listModels(): Promise<string[]>;
  /** One structured call (#263): the model's answer to `request`, as JSON text to its schema; null when it gave none (it refused). */
  fill(request: FillRequest): Promise<string | null>;
  /** One step of a tool loop (#267): the model's text and the tools it calls next, none when it is done. */
  chat(request: ChatRequest): Promise<ChatStep>;
}

/** A tool the model is offered: its name, what it does, and its input's JSON schema. */
export interface ChatTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  name: string;
  /** As the model wrote it: parsed by the tool it names, never trusted here. */
  input: unknown;
}

/** A conversation as both providers are told it: the person's words, the model's steps, and the tools' results. */
export type ChatTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; calls: ToolCall[] }
  | { role: 'tool'; results: { id: string; content: string; error: boolean }[] };

export interface ChatRequest {
  model: string;
  system: string;
  turns: ChatTurn[];
  tools: ChatTool[];
}

/** The model's step: its text, and the tools it calls; `refused` when it would not answer. */
export interface ChatStep {
  text: string;
  calls: ToolCall[];
  refused: boolean;
}

/** The most one step of the drawer's loop may be, in tokens. */
const CHAT_MAX_TOKENS = 2048;

/** What an inline call asks a model: our instructions, the material as fenced text and maybe an image, and the answer's JSON schema. */
export interface FillRequest {
  model: string;
  system: string;
  text: string;
  image?: { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };
  schema: Record<string, unknown>;
}

/** The most an inline answer may be, in tokens. */
const FILL_MAX_TOKENS = 4096;
/** How long a model has to answer an inline call: the drawer's per-turn cap (docs/proposals/cms-agent.md). */
const FILL_TIMEOUT_MS = 25_000;

type Problem = Extract<AiProviderTest, { ok: false }>['problem'];

/** How long a provider has to answer a test. */
const TEST_TIMEOUT_MS = 10_000;

/** Where a deployed API sends an org's key: Anthropic's API and nowhere else. */
const ANTHROPIC_API = 'https://api.anthropic.com';

/**
 * Every header a model call sends besides the key and a user agent (`ModelCall.headers`), fixed here:
 * nothing an adapter or its SDK takes from `process.env` (`ANTHROPIC_CUSTOM_HEADERS`) adds one or
 * changes one. No `anthropic-beta`: no call of ours needs one.
 */
const ANTHROPIC_HEADERS = { accept: 'application/json', 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
const ENDPOINT_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };

/** A model list, as Anthropic's Models API and an OpenAI-compatible endpoint both answer it. */
const modelList = z.object({ data: z.array(z.object({ id: z.string() })) });

/** One model call's adapter for `model`, given to `use`: each provider's adapter is its own type, which `chat()` needs whole. */
type WithAdapter = <T>(model: string, use: <A extends AnyTextAdapter>(adapter: A) => Promise<T>) => Promise<T>;

/** An org's provider, opened with its key: where its calls go, and how its adapter is made. */
interface Opened {
  /** The base its paths are under: Anthropic's API (or dev's stub), or the endpoint's address. */
  base: string;
  /** Where the model list is, under `base`. */
  modelsPath: string;
  /** A call's limits, for a call given `timeoutMs`. */
  call: (timeoutMs: number) => ModelCall;
  adapter: WithAdapter;
  /**
   * A tool call's input as the provider's protocol has it: Anthropic's starts as `{}`, so one with no
   * input streamed is `{}` (the adapter's parse); an endpoint's is the text it sent, `''` included,
   * for the tool to refuse what is not JSON.
   */
  toolInput: 'parsed' | 'text';
}

function anthropic(apiKey: string, base: string, reach: ModelReach): Opened {
  return {
    base,
    modelsPath: '/v1/models?limit=100',
    toolInput: 'parsed',
    // Anthropic's own fixed address (in dev, the e2e's stub): only its origin, as it is not an address a person typed.
    call: (timeoutMs) => ({
      origin: new URL(base).origin,
      headers: ANTHROPIC_HEADERS,
      finished: /event:\s*message_stop/,
      key: ['authorization', `Bearer ${apiKey}`],
      typed: false,
      guards: { fetch: reach.fetch, resolve: () => Promise.reject(new Error('Anthropic is not resolved')), timeoutMs, deadline: reach.guards.deadline },
    }),
    adapter: (model, use) =>
      use(
        // The adapter's types take only the ids its release knows (#346, condition 3); an org may choose a dated or
        // newer one from Anthropic's list, which the API takes as well. Owner decision on #349: one cast, not a narrower picker.
        // biome-ignore lint/nursery/noUnsafeTypeAssertion: the one model-id cast #349 allows; Anthropic's API checks the id.
        createAnthropicChat(model as AnthropicChatModel, apiKey, {
          baseURL: base,
          // As a Bearer token, never `x-api-key`, and never the OAuth identity a key's text could otherwise switch on.
          auth: 'bearer',
          maxRetries: 0,
          logLevel: 'off',
          openTelemetry: false,
        }),
      ),
  };
}

function endpoint(apiKey: string, baseUrl: string, guards: FetchGuards): Opened {
  return {
    base: baseUrl,
    modelsPath: '/models',
    toolInput: 'text',
    call: (timeoutMs) => ({
      origin: URL.canParse(baseUrl) ? new URL(baseUrl).origin : baseUrl,
      headers: ENDPOINT_HEADERS,
      // Its last chunk says why it stopped, and `[DONE]` follows; an endpoint may send either alone.
      finished: /data:\s*\[DONE\]|"finish_reason"\s*:\s*"[a-z_]+"/,
      key: ['authorization', `Bearer ${apiKey}`],
      typed: true,
      guards: { ...guards, timeoutMs },
    }),
    adapter: (model, use) =>
      use(
        openaiCompatibleText(model, {
          baseURL: baseUrl,
          apiKey,
          api: 'chat-completions',
          // Given, so the SDK reads no OPENAI_ORG_ID or OPENAI_PROJECT_ID from process.env.
          organization: null,
          project: null,
          maxRetries: 0,
          logLevel: 'off',
        }),
      ),
  };
}

/** A guard's refusals: the address is not one SignForge may reach, as opposed to one that did not answer. */
const BLOCKED: readonly FetchErrorCode[] = [
  'bad-url',
  'not-https',
  'port',
  'ip-literal',
  'private-address',
  'blocked-address',
  'redirect-elsewhere',
  'too-many-redirects',
];

/**
 * A call's failure in a word: blocked (an address SignForge may not reach), its key refused (401,
 * 403), busy (429, 5xx), or not reached. Anything the guards did not refuse is an answer the adapter
 * could not read (not its protocol, cut short): the provider did not answer usably.
 */
function problemOf(failure: FetchError | undefined): Problem {
  if (!failure) return 'unreachable';
  if (BLOCKED.includes(failure.code)) return 'blocked';
  if (failure.code === 'http-status' && (failure.status === 401 || failure.status === 403)) return 'refused';
  if (failure.code === 'http-status' && failure.status !== undefined && (failure.status === 429 || failure.status >= 500)) return 'busy';
  return 'unreachable';
}

/** Sees each chunk of a call as `chat()` passes it on: whether the model refused (both adapters say `content_filter`). */
function refusals(): { middleware: ChatMiddleware; refused: () => boolean } {
  let refused = false;
  return {
    middleware: {
      name: 'refusal',
      onChunk: (_ctx, chunk: StreamChunk) => {
        if (chunk.type === 'RUN_FINISHED' && chunk.finishReason === 'content_filter') refused = true;
      },
    },
    refused: () => refused,
  };
}

/** The conversation as TanStack AI's messages: a tool's results one message each, an error marked as one. */
const messagesOf = (turns: ChatTurn[]): ModelMessage[] =>
  turns.flatMap((t): ModelMessage[] => {
    if (t.role === 'user') return [{ role: 'user', content: t.text }];
    if (t.role === 'assistant')
      return [
        {
          role: 'assistant',
          content: t.text || null,
          toolCalls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })),
        },
      ];
    return t.results.map((r) => ({ role: 'tool', toolCallId: r.id, content: r.content, ...(r.error && { error: r.content }) }));
  });

/** A tool call's arguments as the model sent them: parsed if JSON, else as written (`''` too), for the tool to refuse. */
function argumentsOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return text;
    throw err;
  }
}

/** The tool calls a step's chunks hold, in the order the model made them, each input as `toolInput` says. */
function callsOf(chunks: StreamChunk[], toolInput: Opened['toolInput']): ToolCall[] {
  const calls = new Map<string, { name: string; args: string; parsed?: unknown }>();
  for (const chunk of chunks) {
    if (chunk.type === 'TOOL_CALL_START') calls.set(chunk.toolCallId, { name: chunk.toolCallName, args: '' });
    const call = calls.get(('toolCallId' in chunk && chunk.toolCallId) || '');
    if (!call) continue;
    if (chunk.type === 'TOOL_CALL_ARGS') call.args += chunk.delta;
    if (chunk.type === 'TOOL_CALL_END' && chunk.input !== undefined) call.parsed = chunk.input;
  }
  return [...calls].map(([id, c]) => ({ id, name: c.name, input: toolInput === 'parsed' && c.parsed !== undefined ? c.parsed : argumentsOf(c.args) }));
}

/** An answer that came whole, not streamed (Anthropic's to a forced tool, for a model id its adapter does not know). */
const wholeAnswer = z.object({ stop_reason: z.string().nullable(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) });

/** Whether `err` is `chat()`'s refusal of an answer that is not JSON, with the text the model gave. */
const unparsed = (err: unknown): err is Error & { rawText: string } =>
  err instanceof Error && 'code' in err && err.code === 'structured-output-parse-failed' && 'rawText' in err && typeof err.rawText === 'string';

/**
 * An org's provider on one of its calls, given `timeoutMs`: each method one call, through the guards.
 * `problem` says its failure in a word, once it has asked the provider: before that, a failure is a
 * bug of ours, not the provider's answer, and `undefined`.
 */
function providerOf(opened: Opened, timeoutMs: number): { provider: ModelProvider; problem: () => Problem | undefined } {
  const guarded = guardedStream(opened.call(timeoutMs));
  let asked = false;
  /**
   * The last answer that came whole: whether the model refused, and its text. A fill to a forced tool
   * (an id the adapter does not know) reads it as master did a message: a refusal is no answer, and
   * prose is handed back for the inline route to refuse and ask again.
   */
  let whole: { refused: boolean; text: string } | undefined;
  // The adapters' own fetch is never called: every request goes through the guards.
  const fetch: typeof globalThis.fetch = async (input, init) => {
    asked = true;
    const res = await guarded.fetch(input, init);
    if (res.headers.get('content-type')?.includes('application/json')) {
      const answer = wholeAnswer.safeParse(await res.clone().json().catch(() => undefined));
      if (answer.success)
        whole = { refused: answer.data.stop_reason === 'refusal', text: answer.data.content.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('') };
    }
    return res;
  };
  const wrapFetch = () => fetch;
  return {
    problem: () => (asked ? problemOf(guarded.failure()) : undefined),
    provider: {
      listModels: async () => {
        const res = await fetch(`${opened.base}${opened.modelsPath}`, { headers: { accept: 'application/json' } });
        const list = modelList.safeParse(await res.json().catch(() => undefined));
        if (!list.success) throw new FetchError('its model list is not one', { code: 'http-status' });
        return list.data.data.map((m) => m.id);
      },
      fill: ({ model, system, text, image, schema }) =>
        opened.adapter(model, async (adapter) => {
          const seen = refusals();
          try {
            const answer = await chat({
              adapter,
              wrapFetch,
              threadId: crypto.randomUUID(),
              systemPrompts: [system],
              messages: [
                {
                  role: 'user',
                  content: [
                    ...(image ? [{ type: 'image' as const, source: { type: 'data' as const, value: image.data, mimeType: image.mediaType } }] : []),
                    { type: 'text', content: text },
                  ],
                },
              ],
              outputSchema: schema,
              stream: false,
              modelOptions: { max_tokens: FILL_MAX_TOKENS },
              middleware: [seen.middleware],
              // Its logs would carry what a provider answered: the failure is said in a word, and nothing logged.
              debug: false,
            });
            return seen.refused() || whole?.refused ? null : JSON.stringify(answer);
          } catch (err) {
            if (seen.refused() || whole?.refused) return null;
            // Not JSON: as the model wrote it, for the inline route to refuse and ask again, as it does any answer it cannot read.
            if (unparsed(err)) return err.rawText;
            // A forced tool's answer that called no tool: its text, as master's message was read.
            if (whole && !guarded.failure()) return whole.text;
            throw err;
          }
        }),
      chat: ({ model, system, turns, tools }) =>
        opened.adapter(model, async (adapter) => {
          const seen = refusals();
          // One step: the tools have no `execute`, so the model's calls come back to the drawer's loop, which runs them.
          const { text, chunks } = await chat({
            adapter,
            wrapFetch,
            threadId: crypto.randomUUID(),
            systemPrompts: [system],
            messages: messagesOf(turns),
            tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
            stream: false,
            agentLoopStrategy: maxIterations(1),
            modelOptions: { max_tokens: CHAT_MAX_TOKENS },
            middleware: [seen.middleware],
            debug: false,
          });
          return { text, calls: callsOf(chunks, opened.toolInput), refused: seen.refused() };
        }),
    },
  };
}

/** Where a provider is reached from: the Worker's fetch, and the fetch guards for an endpoint. */
export interface ModelReach {
  fetch: typeof fetch;
  guards: FetchGuards;
}

/** An org's provider, opened with its key; undefined when the key does not open. */
async function openModel(
  env: Pick<Env, 'CONNECTION_KEY' | 'ENVIRONMENT' | 'ANTHROPIC_BASE_URL'>,
  key: AiKey,
  sealed: string,
  reach: ModelReach,
): Promise<Opened | undefined> {
  const apiKey = await openAiKey(env, key, sealed);
  if (apiKey === undefined) return undefined;
  if (key.provider === 'openai-compatible') {
    // The tool never saves an endpoint without its address; a row without one is a bug.
    if (key.baseUrl === null) throw new Error('an OpenAI-compatible endpoint with no address');
    return endpoint(apiKey, key.baseUrl, reach.guards);
  }
  const base = env.ENVIRONMENT === 'dev' && env.ANTHROPIC_BASE_URL ? env.ANTHROPIC_BASE_URL : ANTHROPIC_API;
  return anthropic(apiKey, base, reach);
}

/** `run` on an opened provider given `timeoutMs`: its result, or its failure in a word. */
async function attempt<T>(
  opened: Opened,
  timeoutMs: number,
  run: (provider: ModelProvider) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; problem: Problem }> {
  const { provider, problem } = providerOf(opened, timeoutMs);
  try {
    return { ok: true, value: await run(provider) };
  } catch (err) {
    const word = problem();
    if (word === undefined) throw err;
    return { ok: false, problem: word };
  }
}

/**
 * One structured call to an org's provider with its key (#263): the model's JSON text, or why not in
 * a word, `unreadable` when the model gave no answer (it refused). A key sealed under a rotated
 * CONNECTION_KEY reads as refused.
 */
export async function fillWith(
  env: Pick<Env, 'CONNECTION_KEY' | 'ENVIRONMENT' | 'ANTHROPIC_BASE_URL'>,
  key: AiKey,
  sealed: string,
  reach: ModelReach,
  request: FillRequest,
): Promise<{ ok: true; text: string } | { ok: false; problem: Problem | 'unreadable' }> {
  const opened = await openModel(env, key, sealed, reach);
  if (!opened) return { ok: false, problem: 'refused' };
  const answered = await attempt(opened, FILL_TIMEOUT_MS, (p) => p.fill(request));
  if (!answered.ok) return answered;
  return answered.value === null ? { ok: false, problem: 'unreadable' } : { ok: true, text: answered.value };
}

/**
 * One step of the drawer's tool loop with an org's provider and its key (#267), given `timeout` ms:
 * the model's step, or why not in a word. A key sealed under a rotated CONNECTION_KEY reads as refused.
 */
export async function chatWith(
  env: Pick<Env, 'CONNECTION_KEY' | 'ENVIRONMENT' | 'ANTHROPIC_BASE_URL'>,
  key: AiKey,
  sealed: string,
  reach: ModelReach,
  request: ChatRequest,
  timeout: number,
): Promise<{ ok: true; step: ChatStep } | { ok: false; problem: Problem }> {
  const opened = await openModel(env, key, sealed, reach);
  if (!opened) return { ok: false, problem: 'refused' };
  const answered = await attempt(opened, timeout, (p) => p.chat(request));
  return answered.ok ? { ok: true, step: answered.value } : answered;
}

/**
 * The AI provider tools' service. In dev only, `ANTHROPIC_BASE_URL` names another endpoint (the CMS
 * e2e's stub), as `GEOCODING_URL` does for places; a deployed API never sends a key elsewhere.
 */
export function aiProviders(
  env: Pick<Env, 'CONNECTION_KEY' | 'ENVIRONMENT' | 'ANTHROPIC_BASE_URL' | 'FEED_STUB_URL'>,
  fetcher: typeof fetch = workerFetch,
  guards: FetchGuards = feedGuards(env, fetcher),
): AiProviders {
  return {
    seal: (key, apiKey) => sealAiKey(env, key, apiKey),
    test: async (key, sealed) => {
      const opened = await openModel(env, key, sealed, { fetch: fetcher, guards });
      // Sealed under a CONNECTION_KEY since rotated: as good as refused, and saving the key again mends it.
      if (!opened) return { ok: false, problem: 'refused' };
      const listed = await attempt(opened, TEST_TIMEOUT_MS, (p) => p.listModels());
      return listed.ok ? { ok: true, models: listed.value } : listed;
    },
  };
}
