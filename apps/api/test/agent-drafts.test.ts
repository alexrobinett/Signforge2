// What reading and deciding an agent's proposal costs (#116, review of #410; the Free plan: 50 D1 queries
// an invocation): get_agent_draft, a Reject, its Undo and a Keep, each through the API as an editor, the
// costliest role (its role check reads the org's settings), on a spot an agent edited over /mcp with a run
// of audit rows behind it.
import { describe, expect, it } from 'vitest';
import { as, measure } from './counting';
import { agentToken, mcpTool, team } from './oauth';

describe('the cost of an agent proposal', () => {
  it('reads it, rejects it, puts it back and keeps it, each within the budget', async () => {
    const t = await team();
    const { access_token } = await agentToken(t.t, t.editor, t.org.id, ['content:read', 'content:draft']);
    const { spot } = await t.owner.ok<{ spot: { id: string; version: number } }>('/api/tools/save_spot', {
      name: 'Soup',
      kind: 'url',
      url: 'https://example.com/soup',
    });
    let version = spot.version;
    // Its audit rows: the person's and the agent's edits, as the strip reads the newest of them.
    for (let i = 0; i < 3; i++) {
      version = (
        await t.owner.ok<{ spot: { version: number } }>('/api/tools/save_spot', { spotId: spot.id, durationMs: 10_000 + i * 1000, ifVersion: version })
      ).spot.version;
      const edited = await mcpTool(access_token, 'save_spot', { spotId: spot.id, url: `https://example.com/soup-${i}`, ifVersion: version });
      expect(edited.isError, JSON.stringify(edited)).toBeUndefined();
      version = edited.structuredContent.spot.version;
    }
    const reading = await measure((b) => as(t.editor, b).ok('/api/tools/get_agent_draft', { spotId: spot.id }));
    const rejecting = await measure((b) => as(t.editor, b).ok('/api/tools/revert_spot_draft', { spotId: spot.id, ifVersion: version }));
    const undoing = await measure((b) => as(t.editor, b).ok('/api/tools/revert_spot_draft', { spotId: spot.id, ifVersion: version + 1 }));
    const keeping = await measure((b) => as(t.editor, b).ok('/api/tools/keep_spot_draft', { spotId: spot.id, ifVersion: version + 2 }));
    // Measured, as the most each may take. A new statement fails this on purpose: look at the budget, then raise it.
    // Reading: the session and the editor's role check (the settings), the spot, what is kept, its newest audit rows and the connected agents.
    expect(reading).toEqual({ statements: 7, queries: 7, rpcs: [] });
    // Deciding reads the session, settings, the spot and what is kept, then writes in one batch: a Reject its guards,
    // the swap, the draft and the audit row; a Keep its guards, the clear and the audit row.
    expect(rejecting).toEqual({ statements: 11, queries: 6, rpcs: [] });
    expect(undoing).toEqual(rejecting);
    expect(keeping).toEqual({ statements: 9, queries: 6, rpcs: [] });
    for (const path of [reading, rejecting, undoing, keeping]) expect(path.queries).toBeLessThan(50);
  });
});
