/**
 * Agent drafts in the editors (M4-11, #116): an agent's edit of a spot or playlist is its proposal,
 * never a silent change. An agent's first write over a draft (over /mcp, or saved from the CMS's
 * agent drawer) keeps the draft it replaces beside it, in the same batch (`draft_snapshots`, held for
 * the person); a person's edit of it, a Keep and a publish end the proposal. Reject (`revert_*_draft`)
 * swaps the two: the person's draft back, the agent's kept beside it, and pressed again (its Undo)
 * the agent's back. Who proposed it comes from the audit log (owner decision on #116: a draft older
 * than the org's retention shows no author).
 */
import { contentJson, type OrgScope, type PlaylistRow, type SpotRow, type Staged } from '@signforge/db';
import { z } from 'zod';
import { grantClient } from './agent-grants';
import { id } from './fields';
import { outputs } from './outputs';
import { type Actor, CMS_AGENT_CLIENT_ID, defineTool, isAgent, notFound, ToolError } from './tool';

export type KeptKind = 'spot' | 'playlist';

/**
 * What a write of a draft does to the draft kept beside it: an agent's first write over the person's
 * draft keeps it (one set aside by a Reject is replaced: the person's draft is the one there now); an
 * agent's next write leaves it; a person's write clears it, the draft being theirs again. Stage it in
 * the same batch as the write, which is held to the version read so what is kept is what was replaced.
 */
export async function keptFor(
  org: OrgScope,
  actor: Actor,
  kind: KeptKind,
  row: SpotRow | PlaylistRow,
  items?: () => Promise<readonly string[]>,
): Promise<Staged> {
  if (!isAgent(actor)) return org.draftSnapshots.stage.clear(kind, row.id);
  // Held to the draft's version as read, in the same batch, as every write of a kept draft is.
  return org.draftSnapshots.stage.propose(kind, row, {
    contentJson: contentJson(row, await items?.()),
    sampleFieldsJson: 'sampleFieldsJson' in row ? row.sampleFieldsJson : null,
  });
}

/** The tools that write a draft's content: the audit rows that say who wrote it. */
const WRITES: Record<KeptKind, readonly string[]> = { spot: ['create_spot', 'update_spot'], playlist: ['create_playlist', 'update_playlist'] };

/** The audit rows read for the author: an agent's proposal is the newest writes of it, after a person's Reject at most. */
const AUTHOR_ROWS = 20;

/**
 * The draft's newest audit rows, with every agent grant among them named as a page names it: its client's
 * plain name, null when the name may not be shown, and `gone` once it is no longer connected (as the
 * approvals queue names an asker). One read of the connected grants, however many.
 */
async function authorsOf(org: OrgScope, kind: KeptKind, draftId: string) {
  const rows = await org.auditLog.list({ limit: AUTHOR_ROWS, target: { kind, id: draftId } });
  const ids = [...new Set(rows.filter((r) => r.actorKind === 'agent').map((r) => r.actorId))];
  const connected = ids.length ? new Map((await org.agentGrants.connected()).map((c) => [c.grant.id, grantClient(c).name])) : new Map<string, string | null>();
  return { rows, agents: ids.map((id) => ({ id, name: connected.get(id) ?? null, gone: !connected.has(id) })) };
}

/** Who proposed the draft: the newest of its audit rows by an agent that wrote it, named as a page names it; null if the log no longer has one. */
async function proposedBy(org: OrgScope, kind: KeptKind, authors: Awaited<ReturnType<typeof authorsOf>>) {
  const row = authors.rows.find((r) => WRITES[kind].includes(r.action) && (r.actorKind === 'agent' || r.clientId === CMS_AGENT_CLIENT_ID));
  if (!row) return null;
  const agent = row.actorKind === 'agent' ? authors.agents.find((a) => a.id === row.actorId) : undefined;
  const name = agent ? agent.name : (await org.members.list()).find((m) => m.userId === row.actorId)?.name || null;
  return {
    kind: row.actorKind === 'agent' ? ('mcp' as const) : ('drawer' as const),
    id: row.actorId,
    clientId: row.clientId,
    name,
    gone: agent?.gone ?? false,
    at: row.at,
  };
}

/** A JSON column of fields (a spot's data, assets, bindings) as an object; null when unset. */
const fieldsOf = (v: unknown): Record<string, unknown> | null => {
  if (typeof v !== 'string') return null;
  const parsed: unknown = JSON.parse(v);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : null;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** The columns of a spot's content that hold fields by key. */
const FIELD_COLUMNS = { dataJson: 'data', assetMapJson: 'assets', bindingsJson: 'bindings' } as const;
const isFieldColumn = (k: string): k is keyof typeof FIELD_COLUMNS => k in FIELD_COLUMNS;

/** What the draft changes against the published version, field by field: a spot's data, assets and bindings by key, else by column. */
function changesOf(now: Record<string, unknown>, was: Record<string, unknown>) {
  const out: { field: string; in: 'data' | 'assets' | 'bindings' | null; was: unknown; now: unknown }[] = [];
  for (const key of [...new Set([...Object.keys(now), ...Object.keys(was)])].sort()) {
    if (same(now[key], was[key])) continue;
    if (isFieldColumn(key)) {
      const [a, b] = [fieldsOf(now[key]), fieldsOf(was[key])];
      for (const f of [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort())
        if (!same(a?.[f], b?.[f])) out.push({ field: f, in: FIELD_COLUMNS[key], was: b?.[f] ?? null, now: a?.[f] ?? null });
    } else out.push({ field: key.replace(/Json$/, ''), in: null, was: was[key] ?? null, now: now[key] ?? null });
  }
  return out;
}

const getAgentDraft = defineTool({
  name: 'get_agent_draft',
  description:
    "Whether a spot's or playlist's draft is an agent's proposal (#116), and what it changes: who proposed it (from the audit log: null once the log no longer has it), whether a Reject set an agent's draft aside (rejected: revert_spot_draft or revert_playlist_draft again puts it back), and the draft's changes against its published version, field by field (a template spot's data, assets and bindings by field key; a playlist's items as spot ids); and the agents among its newest audit rows, by name as a page shows it (agents). Give spotId or playlistId. Returns { kind, id, version, proposed, by, rejected, agents, publishedVersion, changes }.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z
    .object({ spotId: id('spot').optional(), playlistId: id('playlist').optional() })
    .refine((v) => (v.spotId === undefined) !== (v.playlistId === undefined), 'give spotId or playlistId, one of them'),
  output: outputs.get_agent_draft,
  example: { spotId: 'spt_example' },
  handler: async ({ org, input }) => {
    const kind: KeptKind = input.spotId !== undefined ? 'spot' : 'playlist';
    const draftId = input.spotId ?? input.playlistId ?? '';
    const row = kind === 'spot' ? await org.spots.get(draftId) : await org.playlists.get(draftId);
    if (!row) throw notFound(kind, draftId);
    const [kept, items] = await Promise.all([
      org.draftSnapshots.get(kind, row.id),
      kind === 'playlist' ? org.playlists.items(row.id) : Promise.resolve(undefined),
    ]);
    const proposed = kept?.holds === 'person';
    const authors = await authorsOf(org, kind, row.id);
    // Both as `published_json` holds content: the draft's now, and the published one's.
    const now: Record<string, unknown> = JSON.parse(contentJson(row, items));
    const was: Record<string, unknown> | null = row.publishedJson ? JSON.parse(row.publishedJson) : null;
    return {
      kind,
      id: row.id,
      version: row.rowVersion,
      proposed,
      by: proposed ? await proposedBy(org, kind, authors) : null,
      agents: authors.agents,
      rejected: kept?.holds === 'agent',
      publishedVersion: row.publishedVersion,
      changes: was ? changesOf(now, was) : [],
    };
  },
});

/** A spot's content as `contentJson` keeps it: what a Reject puts back of it. */
export const spotContent = z.object({
  name: z.string(),
  durationMs: z.number(),
  dataJson: z.string().nullable(),
  assetMapJson: z.string().nullable(),
  bindingsJson: z.string().nullable(),
  assetId: z.string().nullable(),
  fit: z.enum(['cover', 'contain']).nullable(),
  url: z.string().nullable(),
});

/**
 * Why a Reject or Keep's batch was refused when the draft is still the version shown: what is kept beside
 * it changed first, as another Reject, a Keep or a publish decided it (review of #410), or a spot a
 * playlist's Reject puts back was deleted. Else the dispatcher's own word for a stale version.
 */
export async function decidedMeanwhile(org: OrgScope, kind: KeptKind, draftId: string, version: number) {
  const row = kind === 'spot' ? await org.spots.get(draftId) : await org.playlists.get(draftId);
  if (!row) return notFound(kind, draftId);
  if (row.rowVersion !== version) return undefined;
  return new ToolError('conflict', `this ${kind}'s agent draft was kept, rejected or published meanwhile, or what it puts back changed: read it again`, {
    id: draftId,
    version,
  });
}

/** Reject and Keep: a person's decision on a draft, as an editor may change it (`people`: never an agent's own). */
export const DECIDING = { scope: 'content:draft', minRole: 'editor', mutates: true, people: true } as const;

/** Reject's and Keep's: the draft's version as the person was shown it. */
export const shownVersion = z
  .number()
  .int()
  .positive()
  .describe('The version you were shown. If the draft has changed since, nothing is written: conflict, details { id, version }');

/** A playlist's, with its items. */
export const playlistContent = z.object({ name: z.string(), transitionJson: z.string(), items: z.array(z.string()) });

export const agentDraftTools = [getAgentDraft];
