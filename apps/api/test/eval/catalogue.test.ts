// The agent tool catalogue's size, pinned (#345): what /mcp's tools/list gives an agent and what the drawer offers its
// model, per role, in o200k tokens and bytes as the tool audit counted them (harness.ts, `catalogueSize`). It is the
// budget each consolidation PR tightens: a change that grows it fails here, and one that shrinks it lowers the pin.
import { describe, expect, it } from 'vitest';
import { type Arm, type Role, runTask, scriptedModel, type Task } from './harness';

const NOON = Date.UTC(2026, 10, 25, 12);

/** A question that calls no tool: its run is only the catalogue the model is sent. */
const hello = (role: Role): Task => ({ id: 'catalogue', prompt: 'Hello', role, script: { mcp: () => [], drawer: () => [] }, check: () => undefined });

/**
 * Measured at master 041eada4. /mcp's is the audit's JSON to the byte, 22 tokens more: tools/list orders the keys in each
 * schema its own way. The drawer's is about 800 tokens under the audit's,
 * which built the tools from chat.ts's lists: TanStack AI's Anthropic adapter drops each input schema's `$schema`
 * before it sends them, and this counts what is sent.
 */
const PINNED: Record<Arm, Record<Role, { tools: number; bytes: number; tokens: number }>> = {
  mcp: {
    owner: { tools: 83, bytes: 108_418, tokens: 27_214 },
    editor: { tools: 79, bytes: 101_144, tokens: 25_405 },
    viewer: { tools: 36, bytes: 29_511, tokens: 7264 },
  },
  drawer: {
    owner: { tools: 52, bytes: 53_869, tokens: 13_105 },
    editor: { tools: 51, bytes: 53_408, tokens: 12_995 },
    viewer: { tools: 51, bytes: 53_408, tokens: 12_995 },
  },
};

describe('the agent tool catalogue', () => {
  it.for((['mcp', 'drawer'] as const).flatMap((arm) => (['owner', 'editor', 'viewer'] as const).map((role) => [arm, role] as const)))(
    '%s, %s: as pinned',
    async ([arm, role]) => {
      const task = hello(role);
      const { catalogue } = await runTask(
        task,
        arm,
        scriptedModel(task, arm, () => NOON),
      );
      expect(catalogue).toEqual(PINNED[arm][role]);
    },
  );
});
