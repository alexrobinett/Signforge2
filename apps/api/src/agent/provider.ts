/**
 * The model providers behind the built-in agent (docs/proposals/cms-agent.md, Providers): one
 * interface, so the inline and chat routes (#263, #267) do not know which provider answers.
 * Anthropic, through its SDK, for now; an OpenAI-compatible endpoint is #262. Model ids are never
 * in code: an org chooses exact ids from its provider's list, and the API's configuration names
 * the demo model (#265).
 *
 * An org's key is opened only here, from the vault, to call its provider. A failure is reported in
 * a word (`problem`): never the provider's body, never the key.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AiProviders, AiProviderTest } from '@signforge/tools';
import { workerFetch } from '../connectors';
import { openAiKey, sealAiKey } from '../connectors/vault';

/** What the agent's routes ask of a provider. */
interface ModelProvider {
  /** The model ids the key may use: the cheapest request that proves the key works, costing no tokens. */
  listModels(): Promise<string[]>;
}

type Problem = Extract<AiProviderTest, { ok: false }>['problem'];

/** How long a provider has to answer a test. */
const TEST_TIMEOUT_MS = 10_000;

function anthropicProvider(apiKey: string, options: { baseURL?: string; fetch: typeof fetch }): ModelProvider {
  // No retries (the person presses Test again), and no SDK logging: nothing it could log reaches the Worker's logs.
  const client = new Anthropic({ apiKey, baseURL: options.baseURL, fetch: options.fetch, maxRetries: 0, timeout: TEST_TIMEOUT_MS, logLevel: 'off' });
  return {
    listModels: async () => (await client.models.list({ limit: 100 })).data.map((m) => m.id),
  };
}

/** A provider's refusal in a word: its key refused, busy (429, 5xx, overloaded), or not reached. Anything else is a bug and propagates. */
function problemOf(err: unknown): Problem {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'refused';
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return 'busy';
  if (err instanceof Anthropic.APIError) return 'unreachable';
  throw err;
}

/**
 * The AI provider tools' service. In dev only, `ANTHROPIC_BASE_URL` names another endpoint (the CMS
 * e2e's stub), as `GEOCODING_URL` does for places; a deployed API never sends a key elsewhere.
 */
export function aiProviders(env: Pick<Env, 'CONNECTION_KEY' | 'ENVIRONMENT' | 'ANTHROPIC_BASE_URL'>, fetcher: typeof fetch = workerFetch): AiProviders {
  const baseURL = (env.ENVIRONMENT === 'dev' && env.ANTHROPIC_BASE_URL) || undefined;
  return {
    seal: (key, apiKey) => sealAiKey(env, key, apiKey),
    test: async (key, sealed) => {
      const apiKey = await openAiKey(env, key, sealed);
      // Sealed under a CONNECTION_KEY since rotated: as good as refused, and saving the key again mends it.
      if (apiKey === undefined) return { ok: false, problem: 'refused' };
      try {
        return { ok: true, models: await anthropicProvider(apiKey, { baseURL, fetch: fetcher }).listModels() };
      } catch (err) {
        return { ok: false, problem: problemOf(err) };
      }
    },
  };
}
