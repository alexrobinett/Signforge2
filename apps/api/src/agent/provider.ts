/**
 * The model providers behind the built-in agent (docs/proposals/cms-agent.md, Providers): one
 * interface, so the inline and chat routes (#263, #267) do not know which provider answers.
 * Anthropic, through its SDK; and an OpenAI-compatible endpoint (#262) at an address its owner
 * gave, through the fetch guards on every hop with plain fetch: no SDK, so nothing in process.env
 * can change where its requests go or what they carry. Model ids are never in code: an org chooses
 * exact ids from its provider's list, and the API's configuration names the demo model (#265).
 *
 * An org's key is opened only here, from the vault, to call its provider. A failure is reported in
 * a word (`problem`): never the provider's body, never the key.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AiKey, AiProviders, AiProviderTest } from '@signforge/tools';
import { z } from 'zod';
import { workerFetch } from '../connectors';
import { openAiKey, sealAiKey } from '../connectors/vault';
import { FetchError, type FetchErrorCode, type FetchGuards, feedGuards, guardedKeyedJson } from '../data/fetch';

/** What the agent's routes ask of a provider. */
interface ModelProvider {
  /** The model ids the key may use: the cheapest request that proves the key works, costing no tokens. */
  listModels(): Promise<string[]>;
  /** One structured call (#263): the model's answer to `request`, as JSON text to its schema; null when it gave none (it refused). */
  fill(request: FillRequest): Promise<string | null>;
}

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

function anthropicProvider(apiKey: string, options: { baseURL: string; fetch: typeof fetch; timeout: number }): ModelProvider {
  // No retries (the person presses Test again), and no SDK logging: nothing it could log reaches the Worker's logs.
  // The SDK reads what it is not given from process.env, where Workers puts the deployment's vars and secrets: the
  // address is always given (ANTHROPIC_BASE_URL), and so is the Authorization header, which ANTHROPIC_CUSTOM_HEADERS
  // could otherwise replace with another key; an X-Api-Key it names is removed (null), so no second key rides along.
  // Other headers that variable names are still added to each request.
  const client = new Anthropic({
    apiKey,
    baseURL: options.baseURL,
    defaultHeaders: { Authorization: `Bearer ${apiKey}`, 'X-Api-Key': null },
    fetch: options.fetch,
    maxRetries: 0,
    timeout: options.timeout,
    logLevel: 'off',
  });
  return {
    listModels: async () => (await client.models.list({ limit: 100 })).data.map((m) => m.id),
    fill: async ({ model, system, text, image, schema }) => {
      const message = await client.messages.create({
        model,
        max_tokens: FILL_MAX_TOKENS,
        system,
        messages: [
          {
            role: 'user',
            content: [
              ...(image ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } }] : []),
              { type: 'text', text },
            ],
          },
        ],
        output_config: { format: { type: 'json_schema', schema } },
      });
      if (message.stop_reason === 'refusal') return null;
      return message.content.find((b) => b.type === 'text')?.text ?? null;
    },
  };
}

/** An OpenAI-compatible endpoint's model list (GET <base>/models), as the OpenAI API answers it. */
const modelList = z.object({ data: z.array(z.object({ id: z.string() })) });

/** An endpoint's chat completion, as the OpenAI API answers it: the first choice's text, or null. */
const completion = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })) });

function endpointProvider(apiKey: string, baseUrl: string, guards: FetchGuards): ModelProvider {
  return {
    listModels: async () => {
      const answer = modelList.safeParse(await guardedKeyedJson(`${baseUrl}/models`, apiKey, guards));
      if (!answer.success) throw new FetchError('its model list is not an OpenAI-style list', { code: 'http-status' });
      return answer.data.data.map((m) => m.id);
    },
    fill: async ({ model, system, text, image, schema }) => {
      const body = {
        model,
        max_tokens: FILL_MAX_TOKENS,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [{ type: 'text', text }, ...(image ? [{ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } }] : [])],
          },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'spot_fill', strict: true, schema } },
      };
      const answer = completion.safeParse(await guardedKeyedJson(`${baseUrl}/chat/completions`, apiKey, { ...guards, timeoutMs: FILL_TIMEOUT_MS }, body));
      if (!answer.success) throw new FetchError('its answer is not an OpenAI-style completion', { code: 'http-status' });
      return answer.data.choices[0]?.message.content ?? null;
    },
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

/** An endpoint's failure in a word, as `problemOf` says Anthropic's. */
function endpointProblemOf(err: unknown): Problem {
  if (!(err instanceof FetchError)) throw err;
  if (BLOCKED.includes(err.code)) return 'blocked';
  if (err.code === 'http-status' && (err.status === 401 || err.status === 403)) return 'refused';
  if (err.code === 'http-status' && err.status !== undefined && (err.status === 429 || err.status >= 500)) return 'busy';
  return 'unreachable';
}

/** A provider's refusal in a word: its key refused, busy (429, 5xx, overloaded), or not reached. Anything else is a bug and propagates. */
function problemOf(err: unknown): Problem {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'refused';
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return 'busy';
  if (err instanceof Anthropic.APIError) return 'unreachable';
  throw err;
}

/** Where a provider is reached from: the Worker's fetch, and the fetch guards for an endpoint. */
export interface ModelReach {
  fetch: typeof fetch;
  guards: FetchGuards;
}

/** An org's provider, opened with its key, and how its failures read; undefined when the key does not open. */
async function openModel(
  env: Pick<Env, 'CONNECTION_KEY' | 'ENVIRONMENT' | 'ANTHROPIC_BASE_URL'>,
  key: AiKey,
  sealed: string,
  reach: ModelReach,
  timeout: number,
): Promise<{ provider: ModelProvider; problemOf: (err: unknown) => Problem } | undefined> {
  const apiKey = await openAiKey(env, key, sealed);
  if (apiKey === undefined) return undefined;
  if (key.provider === 'openai-compatible') {
    // The tool never saves an endpoint without its address; a row without one is a bug.
    if (key.baseUrl === null) throw new Error('an OpenAI-compatible endpoint with no address');
    return { provider: endpointProvider(apiKey, key.baseUrl, reach.guards), problemOf: endpointProblemOf };
  }
  const baseURL = env.ENVIRONMENT === 'dev' && env.ANTHROPIC_BASE_URL ? env.ANTHROPIC_BASE_URL : ANTHROPIC_API;
  return { provider: anthropicProvider(apiKey, { baseURL, fetch: reach.fetch, timeout }), problemOf };
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
  const model = await openModel(env, key, sealed, reach, FILL_TIMEOUT_MS);
  if (!model) return { ok: false, problem: 'refused' };
  try {
    const text = await model.provider.fill(request);
    return text === null ? { ok: false, problem: 'unreadable' } : { ok: true, text };
  } catch (err) {
    return { ok: false, problem: model.problemOf(err) };
  }
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
      const model = await openModel(env, key, sealed, { fetch: fetcher, guards }, TEST_TIMEOUT_MS);
      // Sealed under a CONNECTION_KEY since rotated: as good as refused, and saving the key again mends it.
      if (!model) return { ok: false, problem: 'refused' };
      try {
        return { ok: true, models: await model.provider.listModels() };
      } catch (err) {
        return { ok: false, problem: model.problemOf(err) };
      }
    },
  };
}
