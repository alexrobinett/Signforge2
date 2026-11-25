// The agent tool catalogue's size, pinned (#345), per role, in o200k tokens and bytes as the tool audit counted them
// (harness.ts, `catalogueSize`). The budget is what the model's request carries: the `tools` array of its first call,
// in each arm. /mcp's tools/list, what a client receives before it makes them the model's tools, is pinned apart as
// discovery. Each consolidation PR tightens these: a change that grows one fails here, and one that shrinks it lowers the pin.
import { describe, expect, it } from 'vitest';
import { type Arm, type Role, runTask, type Size, scriptedModel, type Task } from './harness';

const NOON = Date.UTC(2026, 10, 25, 12);

/** A question that calls no tool: its run is only the catalogue the model is sent. */
const hello = (role: Role): Task => ({ id: 'catalogue', prompt: 'Hello', role, script: { mcp: () => [], drawer: () => [] }, check: () => undefined });

/**
 * Measured at master 041eada4. /mcp's is tools/list as the eval's client hands it to Anthropic: name, description and
 * input schema, without the annotations. The drawer's carries TanStack AI's own fields (`type`, `cache_control`) and no
 * `$schema`, so it is not the audit's 13,908, which was built from chat.ts's lists.
 */
const MODEL_FACING: Record<Arm, Record<Role, Size>> = {
  mcp: {
    owner: { tools: 83, bytes: 101_583, tokens: 25_388 },
    editor: { tools: 79, bytes: 94_638, tokens: 23_667 },
    viewer: { tools: 36, bytes: 26_559, tokens: 6472 },
  },
  drawer: {
    owner: { tools: 52, bytes: 55_809, tokens: 13_548 },
    editor: { tools: 51, bytes: 55_311, tokens: 13_429 },
    viewer: { tools: 51, bytes: 55_311, tokens: 13_429 },
  },
};

/** /mcp's tools/list, as the audit measured it (the same JSON, its keys in another order). */
const DISCOVERY: Record<Role, Size> = {
  owner: { tools: 83, bytes: 108_418, tokens: 27_214 },
  editor: { tools: 79, bytes: 101_144, tokens: 25_405 },
  viewer: { tools: 36, bytes: 29_511, tokens: 7264 },
};

const ROLES = ['owner', 'editor', 'viewer'] as const;

describe('the agent tool catalogue', () => {
  it.for((['mcp', 'drawer'] as const).flatMap((arm) => ROLES.map((role) => [arm, role] as const)))('%s, %s: as the model is sent it', async ([arm, role]) => {
    const task = hello(role);
    const record = await runTask(task, arm, scriptedModel(task, arm, NOON));
    expect(record.errors).toEqual([]);
    expect(record.catalogue).toEqual(MODEL_FACING[arm][role]);
    if (arm === 'mcp') expect(record.discovery).toEqual(DISCOVERY[role]);
  });
});
