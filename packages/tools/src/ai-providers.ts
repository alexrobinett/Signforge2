/**
 * The org's own model provider for its built-in agent (#261, docs/proposals/cms-agent.md): an owner
 * saves, tests and removes its key and chooses its models; every member reads which provider and
 * models it uses, never the key. The key is sealed by the API before it is stored (`AiProviders`)
 * and only the API opens it, to call the provider. Saving, testing and removing it refuse an agent,
 * a Milestone 4 grant and the in-CMS agent alike: a key decides who pays and what data leaves
 * SignForge, so only a person sets it.
 */
import { type AiProviderRow, StaleVersionError } from '@signforge/db';
import { z } from 'zod';
import { ifVersion } from './fields';
import { AI_PROVIDERS, type aiProviderView, outputs } from './outputs';
import { type Actor, defineTool, isAgent, ToolError } from './tool';

const viewOf = (p: AiProviderRow): z.infer<typeof aiProviderView> => ({
  provider: p.provider,
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
    "Set the organization's own model provider for its agent, owners only, and only a person: its API key (stored encrypted, never shown again), the fast and capable models, and a daily ceiling of agent turns. The first save needs apiKey; afterwards give only what changes. Pass the version you read as ifVersion to change only that one. Returns { provider }.",
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
    ifVersion,
  }),
  output: outputs.save_ai_provider,
  example: { provider: 'anthropic', apiKey: 'sk-ant-api03-example-key-0000000000000000' },
  target: (input) => target(input.provider),
  handler: async ({ org, actor, input, write, services: { aiProviders } }) => {
    refuseAgents(actor);
    const current = await org.aiProvider.get();
    if (!input.apiKey && current?.provider !== input.provider) throw new ToolError('invalid_input', `saving ${input.provider} the first time needs its apiKey`);
    const key = input.apiKey && {
      keySealed: await aiProviders.seal({ orgId: org.orgId, provider: input.provider }, input.apiKey),
      keyLast4: input.apiKey.slice(-4),
      keySavedBy: actor.id,
      keySavedAt: Date.now(),
      // A new key has not reached the provider yet.
      verifiedAt: null,
    };
    // Only what was given: a field left out keeps its value.
    const { fastModel, capableModel, dailyTurnCeiling } = input;
    const choices = {
      ...(fastModel !== undefined && { fastModel }),
      ...(capableModel !== undefined && { capableModel }),
      ...(dailyTurnCeiling !== undefined && { dailyTurnCeiling }),
    };
    const row = write(await org.aiProvider.stage.put({ provider: input.provider, ...key, ...choices }, input.ifVersion));
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
    const result = await aiProviders.test({ orgId: org.orgId, provider: current.provider }, current.keySealed);
    const answer = result.ok ? { ok: true, models: result.models, problem: null } : { ok: false, models: [], problem: result.problem };
    // The mark is for the key tested: only while the row is still the version read, so a key replaced while the test ran is not marked.
    const verifiedAt = result.ok ? Date.now() : result.problem === 'refused' ? null : current.verifiedAt;
    if (verifiedAt === current.verifiedAt) return { ...answer, provider: viewOf(current) };
    try {
      return { ...answer, provider: viewOf(write(await org.aiProvider.stage.put({ verifiedAt }, current.rowVersion))) };
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
