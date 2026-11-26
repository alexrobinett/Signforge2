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
 * Measured with #345 PR 5's delete, takeover, start_upload and finalize_upload, publish_manifest_to_screen made people-only and the connection tools listed only where a provider can be connected, PR 4's save_spot, save_playlist, save_schedule_entry, save_brand_kit and save_data_source, PR 3's update_screen, screen_command and save_group, PR 2's read and describe, which stand for each type's own read, and PR 1's trims: no `$schema`, id pattern or safe-integer bound in any input, short ifVersion and
 * idempotencyKey texts, and only the cards a role can press in the drawer. /mcp's is tools/list as the eval's client hands it to Anthropic: name, description and
 * input schema, without the annotations. The drawer's carries TanStack AI's own fields (`type`, `cache_control`) and no
 * `$schema`, so it differs from the audit's count, which was built from chat.ts's lists.
 */
const MODEL_FACING: Record<Arm, Record<Role, Size>> = {
  mcp: {
    owner: { tools: 30, bytes: 57_649, tokens: 13_645 },
    editor: { tools: 27, bytes: 51_655, tokens: 12_209 },
    viewer: { tools: 6, bytes: 7484, tokens: 1713 },
  },
  drawer: {
    owner: { tools: 18, bytes: 28_307, tokens: 6504 },
    editor: { tools: 16, bytes: 26_888, tokens: 6202 },
    viewer: { tools: 10, bytes: 15_096, tokens: 3533 },
  },
};

/** /mcp's tools/list, with PR 1's trims, each tool's title, each type's own read listed as `read` (#345 PR 2), PR 3's screen writes, PR 4's content saves and PR 5's merges. */
const DISCOVERY: Record<Role, Size> = {
  owner: { tools: 30, bytes: 60_873, tokens: 14_435 },
  editor: { tools: 27, bytes: 54_539, tokens: 12_918 },
  viewer: { tools: 6, bytes: 8112, tokens: 1869 },
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
