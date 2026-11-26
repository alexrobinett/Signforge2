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
 * Measured with #345 PR 3's update_screen, screen_command and save_group, PR 2's read and describe, which stand for each type's own read, and PR 1's trims: no `$schema`, id pattern or safe-integer bound in any input, short ifVersion and
 * idempotencyKey texts, and only the cards a role can press in the drawer. /mcp's is tools/list as the eval's client hands it to Anthropic: name, description and
 * input schema, without the annotations. The drawer's carries TanStack AI's own fields (`type`, `cache_control`) and no
 * `$schema`, so it differs from the audit's count, which was built from chat.ts's lists.
 */
const MODEL_FACING: Record<Arm, Record<Role, Size>> = {
  mcp: {
    owner: { tools: 45, bytes: 70_929, tokens: 16_886 },
    editor: { tools: 42, bytes: 64_935, tokens: 15_450 },
    viewer: { tools: 6, bytes: 7556, tokens: 1726 },
  },
  drawer: {
    owner: { tools: 22, bytes: 34_593, tokens: 7992 },
    editor: { tools: 20, bytes: 33_174, tokens: 7690 },
    viewer: { tools: 11, bytes: 18_455, tokens: 4334 },
  },
};

/** /mcp's tools/list, with PR 1's trims, each tool's title, each type's own read listed as `read` (#345 PR 2), and PR 3's screen writes. */
const DISCOVERY: Record<Role, Size> = {
  owner: { tools: 45, bytes: 75_850, tokens: 18_079 },
  editor: { tools: 42, bytes: 69_516, tokens: 16_562 },
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
