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
 * Measured with #345 PR 4's save_spot, save_playlist, save_schedule_entry, save_brand_kit and save_data_source, PR 3's update_screen, screen_command and save_group, PR 2's read and describe, which stand for each type's own read, and PR 1's trims: no `$schema`, id pattern or safe-integer bound in any input, short ifVersion and
 * idempotencyKey texts, and only the cards a role can press in the drawer. /mcp's is tools/list as the eval's client hands it to Anthropic: name, description and
 * input schema, without the annotations. The drawer's carries TanStack AI's own fields (`type`, `cache_control`) and no
 * `$schema`, so it differs from the audit's count, which was built from chat.ts's lists.
 */
const MODEL_FACING: Record<Arm, Record<Role, Size>> = {
  mcp: {
    owner: { tools: 39, bytes: 61_982, tokens: 14_616 },
    editor: { tools: 36, bytes: 55_988, tokens: 13_180 },
    viewer: { tools: 6, bytes: 7556, tokens: 1726 },
  },
  drawer: {
    owner: { tools: 20, bytes: 29_988, tokens: 6879 },
    editor: { tools: 18, bytes: 28_569, tokens: 6577 },
    viewer: { tools: 10, bytes: 15_290, tokens: 3573 },
  },
};

/** /mcp's tools/list, with PR 1's trims, each tool's title, each type's own read listed as `read` (#345 PR 2), PR 3's screen writes and PR 4's content saves. */
const DISCOVERY: Record<Role, Size> = {
  owner: { tools: 39, bytes: 66_227, tokens: 15_648 },
  editor: { tools: 36, bytes: 59_893, tokens: 14_131 },
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
