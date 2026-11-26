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
 * Measured with the description pass (publish, save_spot, save_brand_kit, start_upload and start_takeover's rules in describe), #345 PR 6's reference text moved into describe's rules, PR 5's delete, takeover, start_upload and finalize_upload, publish_manifest_to_screen made people-only and the connection tools listed only where a provider can be connected, PR 4's save_spot, save_playlist, save_schedule_entry, save_brand_kit and save_data_source, PR 3's update_screen, screen_command and save_group, PR 2's read and describe, which stand for each type's own read, and PR 1's trims: no `$schema`, id pattern or safe-integer bound in any input, short ifVersion and
 * idempotencyKey texts, and only the cards a role can press in the drawer. /mcp's is tools/list as the eval's client hands it to Anthropic: name, description and
 * input schema, without the annotations. The drawer's carries TanStack AI's own fields (`type`, `cache_control`) and no
 * `$schema`, so it differs from the audit's count, which was built from chat.ts's lists.
 */
const MODEL_FACING: Record<Arm, Record<Role, Size>> = {
  mcp: {
    owner: { tools: 30, bytes: 55_580, tokens: 13_200 },
    editor: { tools: 27, bytes: 49_642, tokens: 11_780 },
    viewer: { tools: 6, bytes: 7456, tokens: 1708 },
  },
  drawer: {
    owner: { tools: 18, bytes: 27_140, tokens: 6274 },
    editor: { tools: 16, bytes: 25_721, tokens: 5972 },
    viewer: { tools: 10, bytes: 14_905, tokens: 3496 },
  },
};

/** /mcp's tools/list, with PR 1's trims, each tool's title, each type's own read listed as `read` (#345 PR 2), PR 3's screen writes, PR 4's content saves and PR 5's merges. */
const DISCOVERY: Record<Role, Size> = {
  owner: { tools: 30, bytes: 58_804, tokens: 13_990 },
  editor: { tools: 27, bytes: 52_526, tokens: 12_489 },
  viewer: { tools: 6, bytes: 8084, tokens: 1864 },
};

/**
 * The words each arm's first request carries beside its tools (review of #470): /mcp's server instructions with the
 * eval's own lines; the drawer's system prompt, its first message's context around the question (the role, what it
 * may not do, the page) and its answer's schema (`output_config`, review of #566). Text moved out of a tool's description
 * into any of them is counted here, so the catalogue pins
 * cannot shrink by moving words out of their sight.
 */
const PROMPT: Record<Arm, Record<Role, { bytes: number; tokens: number }>> = {
  mcp: { owner: { bytes: 1415, tokens: 329 }, editor: { bytes: 1415, tokens: 329 }, viewer: { bytes: 1415, tokens: 329 } },
  drawer: { owner: { bytes: 3452, tokens: 846 }, editor: { bytes: 3576, tokens: 876 }, viewer: { bytes: 3864, tokens: 940 } },
};

const ROLES = ['owner', 'editor', 'viewer'] as const;

describe('the agent tool catalogue', () => {
  it.for((['mcp', 'drawer'] as const).flatMap((arm) => ROLES.map((role) => [arm, role] as const)))('%s, %s: as the model is sent it', async ([arm, role]) => {
    const task = hello(role);
    const record = await runTask(task, arm, scriptedModel(task, arm, NOON));
    expect(record.errors).toEqual([]);
    expect(record.catalogue).toEqual(MODEL_FACING[arm][role]);
    expect(record.prompt).toEqual(PROMPT[arm][role]);
    if (arm === 'mcp') expect(record.discovery).toEqual(DISCOVERY[role]);
  });
});
