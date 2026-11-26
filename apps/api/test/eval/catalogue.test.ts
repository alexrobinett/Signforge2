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
 * Measured with #345 PR 2's read and describe, which stand for each type's own read, and PR 1's trims: no `$schema`, id pattern or safe-integer bound in any input, short ifVersion and
 * idempotencyKey texts, and only the cards a role can press in the drawer. /mcp's is tools/list as the eval's client hands it to Anthropic: name, description and
 * input schema, without the annotations. The drawer's carries TanStack AI's own fields (`type`, `cache_control`) and no
 * `$schema`, so it differs from the audit's count, which was built from chat.ts's lists.
 */
const MODEL_FACING: Record<Arm, Record<Role, Size>> = {
  mcp: {
    owner: { tools: 52, bytes: 73_265, tokens: 17_444 },
    editor: { tools: 49, bytes: 67_271, tokens: 16_008 },
    viewer: { tools: 6, bytes: 7556, tokens: 1726 },
  },
  drawer: {
    owner: { tools: 24, bytes: 35_476, tokens: 8211 },
    editor: { tools: 22, bytes: 34_057, tokens: 7909 },
    viewer: { tools: 11, bytes: 18_683, tokens: 4384 },
  },
};

/** /mcp's tools/list, with PR 1's trims, each tool's title, and each type's own read listed as `read` (#345 PR 2). */
const DISCOVERY: Record<Role, Size> = {
  owner: { tools: 52, bytes: 78_969, tokens: 18_824 },
  editor: { tools: 49, bytes: 72_635, tokens: 17_307 },
  viewer: { tools: 6, bytes: 8184, tokens: 1882 },
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
