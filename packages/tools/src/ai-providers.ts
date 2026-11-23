/**
 * The org's own model provider for its built-in agent (#261, docs/proposals/cms-agent.md): an owner
 * saves, tests and removes its key and chooses its models; every member reads which provider and
 * models it uses, never the key. The provider is Anthropic, or an OpenAI-compatible endpoint at an
 * https address the owner gives (#262): checked here as a feed URL is, and by the API's fetch guards
 * on every request; its key is sealed for that address, so a new address needs the key again. The key is sealed by the API before it is stored (`AiProviders`)
 * and only the API opens it, to call the provider. Saving, testing and removing it refuse an agent,
 * a Milestone 4 grant and the in-CMS agent alike: a key decides who pays and what data leaves
 * SignForge, so only a person sets it.
 */
import { type AiProviderRow, StaleVersionError } from '@signforge/db';
import { z } from 'zod';
import { ifVersion } from './fields';
import { AI_PROVIDERS, type aiProviderView, outputs } from './outputs';
import { feedUrlProblem, type FeedUrlProblem } from '@signforge/feeds';
import { type Actor, defineTool, isAgent, ToolError } from './tool';

const viewOf = (p: AiProviderRow): z.infer<typeof aiProviderView> => ({
  provider: p.provider,
  baseUrl: p.baseUrl,
  supports: p.provider === 'anthropic' ? { images: true, jsonSchema: true } : { images: p.acceptsImages, jsonSchema: p.jsonSchemaOutput },
  keyLast4: p.keyLast4,
  keySavedBy: p.keySavedBy,
  keySavedAt: p.keySavedAt,
  verifiedAt: p.verifiedAt,
  fastModel: p.fastModel,
  capableModel: p.capableModel,
  dailyTurnCeiling: p.dailyTurnCeiling,
  version: p.rowVersion,
});

const target = (provider: string) => ({ kind: 'ai_provider', id: provider });

function refuseAgents(actor: Actor) {
  if (isAgent(actor))
    throw new ToolError(
      'forbidden',
      "Only a person signed in to the CMS can change the organization's model key: it decides who pays and what data leaves SignForge. Ask an owner to do it in Settings, AI & agents",
    );
}

const apiKey = z
  .string()
  .trim()
  .min(20, 'that is too short to be an API key')
  .max(512, 'that is too long to be an API key')
  .regex(/^\S+$/, 'an API key has no spaces')
  .describe("The provider's API key. Stored encrypted and never shown again");

const modelId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, 'not a model id')
  .nullable()
  .describe("An exact model id from the provider's list (test_ai_provider), never an alias; null to unset");

const URL_PROBLEMS: Record<FeedUrlProblem, string> = {
  'bad-url': 'not a URL',
  'not-https': 'the endpoint must be https',
  port: 'the endpoint must use the default https port',
  'ip-literal': 'the endpoint must name a host, not an IP address',
  'private-address': 'the host is a local name',
};

/** An endpoint's base address: the fetch-safety rules of feed URLs, no user name or password, no query or fragment, kept without a trailing slash. */
const baseUrl = z
  .string()
  .trim()
  .max(2048)
  .superRefine((url, ctx) => {
    const problem = feedUrlProblem(url);
    if (problem) ctx.addIssue({ code: 'custom', message: URL_PROBLEMS[problem] });
    // A user name makes `https://api.openai.com@evil.example/v1` read as one host and go to another, and a
    // password would be kept in clear, shown to every member and in the audit log.
    else if (new URL(url).username || new URL(url).password) ctx.addIssue({ code: 'custom', message: "the endpoint's address has no user name or password" });
    else if (/[?#]/.test(url)) ctx.addIssue({ code: 'custom', message: 'the endpoint is a base address, with no query or fragment' });
  })
  .transform((url) => url.replace(/\/+$/, ''))
  .describe(
    "An OpenAI-compatible endpoint's base address, such as https://api.openai.com/v1 or https://generativelanguage.googleapis.com/v1beta/openai: https, the default port, a public host. Its models are at <base>/models",
  );

const getAiProvider = defineTool({
  name: 'get_ai_provider',
  description:
    "Read which model provider the organization's agent uses with its own key, and its models and daily ceiling: null while it uses SignForge's demo model. Shows the key's last four characters, never the key. Returns { provider }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({}),
  output: outputs.get_ai_provider,
  example: {},
  handler: async ({ org }) => {
    const row = await org.aiProvider.get();
    return { provider: row ? viewOf(row) : null };
  },
});

const saveAiProvider = defineTool({
  name: 'save_ai_provider',
  description:
    "Set the organization's own model provider for its agent, owners only, and only a person: Anthropic, or an OpenAI-compatible endpoint at baseUrl, its API key (stored encrypted, never shown again), the fast and capable models, a daily ceiling of agent turns, and for an endpoint whether it takes images and returns JSON-schema output. The first save of a provider, and a new baseUrl, need apiKey; afterwards give only what changes. Pass the version you read as ifVersion to change only that one. Returns { provider }.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['aiProviders'],
  input: z.object({
    provider: z.enum(AI_PROVIDERS),
    apiKey: apiKey.optional(),
    fastModel: modelId.optional(),
    capableModel: modelId.optional(),
    dailyTurnCeiling: z.number().int().min(1).max(100_000).nullable().optional().describe('Agent turns a day across the org; null for none'),
    baseUrl: baseUrl.optional(),
    acceptsImages: z.boolean().optional().describe('An endpoint: whether its models take images (Fill from a flyer needs it)'),
    jsonSchemaOutput: z.boolean().optional().describe('An endpoint: whether it returns output to a JSON schema (response_format json_schema; Fill needs it)'),
    ifVersion,
  }),
  output: outputs.save_ai_provider,
  example: { provider: 'anthropic', apiKey: 'sk-ant-api03-example-key-0000000000000000' },
  target: (input) => target(input.provider),
  handler: async ({ org, actor, input, write, services: { aiProviders } }) => {
    refuseAgents(actor);
    const current = await org.aiProvider.get();
    const endpoint = input.provider === 'openai-compatible';
    if (!endpoint && (input.baseUrl !== undefined || input.acceptsImages !== undefined || input.jsonSchemaOutput !== undefined))
      throw new ToolError(
        'invalid_input',
        "Anthropic's address and features are fixed: baseUrl, acceptsImages and jsonSchemaOutput are for an OpenAI-compatible endpoint",
      );
    const switching = current?.provider !== input.provider;
    // The key goes only to the address it was saved for: one at a new address is given again.
    const address = endpoint ? (input.baseUrl ?? (switching ? null : (current?.baseUrl ?? null))) : null;
    if (endpoint && !address) throw new ToolError('invalid_input', 'an OpenAI-compatible endpoint needs its baseUrl');
    const moved = !switching && address !== (current?.baseUrl ?? null);
    if (!input.apiKey && (switching || moved))
      throw new ToolError(
        'invalid_input',
        switching
          ? `saving ${input.provider} the first time needs its apiKey`
          : 'a new baseUrl needs the apiKey again: a key is sent only to the address it was saved for',
      );
    const key = input.apiKey && {
      keySealed: await aiProviders.seal({ orgId: org.orgId, provider: input.provider, baseUrl: address }, input.apiKey),
      keyLast4: input.apiKey.slice(-4),
      keySavedBy: actor.id,
      keySavedAt: Date.now(),
      // A new key has not reached the provider yet.
      verifiedAt: null,
    };
    // Only what was given: a field left out keeps its value. Another provider's models and features do not carry over.
    const { fastModel, capableModel, dailyTurnCeiling, acceptsImages, jsonSchemaOutput } = input;
    const choices = {
      ...(switching && { fastModel: null, capableModel: null, acceptsImages: false, jsonSchemaOutput: false }),
      ...(fastModel !== undefined && { fastModel }),
      ...(capableModel !== undefined && { capableModel }),
      ...(dailyTurnCeiling !== undefined && { dailyTurnCeiling }),
      ...(acceptsImages !== undefined && { acceptsImages }),
      ...(jsonSchemaOutput !== undefined && { jsonSchemaOutput }),
    };
    const row = write(await org.aiProvider.stage.put({ provider: input.provider, baseUrl: address, ...key, ...choices }, input.ifVersion));
    return { provider: viewOf(row) };
  },
});

const testAiProvider = defineTool({
  name: 'test_ai_provider',
  description:
    "Test the organization's saved model key, owners only, and only a person: a minimal request to the provider, which costs no tokens, that lists the models the key may use. A key that works is marked verified, and one the provider refuses is no longer, unless the key was replaced while it ran. Returns { ok, models, problem, provider }: the provider as stored now.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  needs: ['aiProviders'],
  input: z.object({}),
  output: outputs.test_ai_provider,
  example: {},
  target: (_input, output) => target(output.provider.provider),
  handler: async ({ org, actor, write, services: { aiProviders } }) => {
    refuseAgents(actor);
    const current = await org.aiProvider.get();
    if (!current) throw new ToolError('not_found', 'no model key is saved: save one first');
    const result = await aiProviders.test({ orgId: org.orgId, provider: current.provider, baseUrl: current.baseUrl }, current.keySealed);
    const answer = result.ok ? { ok: true, models: result.models, problem: null } : { ok: false, models: [], problem: result.problem };
    // The mark is for the key tested: only while the row is still the version read and holds that key, so a key
    // replaced while the test ran, or removed and saved again (whose version starts over), is not marked.
    const verifiedAt = result.ok ? Date.now() : result.problem === 'refused' ? null : current.verifiedAt;
    if (verifiedAt === current.verifiedAt) return { ...answer, provider: viewOf(current) };
    try {
      return { ...answer, provider: viewOf(write(await org.aiProvider.stage.put({ verifiedAt }, current.rowVersion, current.keySealed))) };
    } catch (err) {
      if (!(err instanceof StaleVersionError)) throw err;
      const now = await org.aiProvider.get();
      // Removed while it was tested: a conflict, as any change to what was read.
      if (!now) throw err;
      return { ...answer, provider: viewOf(now) };
    }
  },
});

const removeAiProvider = defineTool({
  name: 'remove_ai_provider',
  description:
    "Forget the organization's own model key, its models and ceiling, owners only, and only a person: the agent goes back to SignForge's demo model. Returns { removed, provider }: false and null if none was saved.",
  scope: 'org:manage',
  minRole: 'owner',
  mutates: true,
  input: z.object({}),
  output: outputs.remove_ai_provider,
  example: {},
  target: (_input, output) => (output.provider ? target(output.provider) : undefined),
  handler: async ({ org, actor, write }) => {
    refuseAgents(actor);
    const current = await org.aiProvider.get();
    if (!current) return { removed: false, provider: null };
    write(org.aiProvider.stage.remove());
    return { removed: true, provider: current.provider };
  },
});

export const aiProviderTools = [getAiProvider, saveAiProvider, testAiProvider, removeAiProvider];
