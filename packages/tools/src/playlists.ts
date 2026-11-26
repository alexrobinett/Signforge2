/**
 * Playlist tools: making, ordering and deleting playlist drafts. An edit changes the draft only;
 * screens get it at the next publish, which holds a playlist back until every spot in it is
 * published (./publishing.ts).
 *
 * A playlist's spots are an ordered list, so an edit sends the whole order, guarded by the version
 * it was made from: an order made from an old read is refused rather than dropping someone else's
 * change. Deletes and creates go through `packages/db`'s repository, so a playlist made again with
 * a deleted one's id continues its versions (`draft_tombstones`).
 */
import type { Transition } from '@signforge/contract';
import { contentJson, draftChanged, published, StaleVersionError, type OrgScope, type PlaylistRow } from '@signforge/db';
import { z } from 'zod';
import { DECIDING, decidedMeanwhile, keptFor, playlistContent, shownVersion } from './agent-drafts';
import { id, idempotencyKey, ifVersion, name } from './fields';
import { page, pageInput } from './paging';
import { ended } from './schedule';
import { defineTool, invalidFields, isAgent, notFound, ToolError, type ToolContext } from './tool';
import { outputs, transition, type PlaylistView } from './outputs';

/** A new playlist's transition when none is given: fade, the player's default (docs/architecture.md, Transitions). */
const DEFAULT_TRANSITION: Transition = { type: 'fade', ms: 500 };

const spotIds = z.array(id('spot')).max(500).describe("The spots in play order: the whole list, replacing the draft's. A spot may appear more than once");

const playlistView = (row: PlaylistRow, items: string[], defaultId: string | null | undefined): PlaylistView => ({
  id: row.id,
  name: row.name,
  // Written only by these tools and `sf push`, from the contract's `Transition`.
  transition: JSON.parse(row.transitionJson),
  spotIds: items,
  version: row.rowVersion,
  isDefault: row.id === defaultId,
  published: published(row) !== undefined,
  publishedSpotCount: published(row)?.items.length ?? 0,
  draftChanged: draftChanged(row, items),
  publishedAt: row.publishedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** A playlist's view as stored: its items and whether it is the default read now. */
async function viewOf(org: OrgScope, row: PlaylistRow) {
  const [items, settings] = await Promise.all([org.playlists.items(row.id), org.settings.get()]);
  return playlistView(row, items, settings?.defaultPlaylistId);
}

async function requirePlaylist(org: OrgScope, playlistId: string) {
  const row = await org.playlists.get(playlistId);
  if (!row) throw notFound('playlist', playlistId);
  return row;
}

const target = (input: { playlistId: string }) => ({ kind: 'playlist', id: input.playlistId });

const listPlaylists = defineTool({
  name: 'list_playlists',
  description:
    "List the organization's playlists, the drafts as last edited, most recently edited first, a page at a time, each with its spots in play order. Each says whether it is published and whether its draft differs. Filter to the default playlist, or to the unpublished ones. Returns { playlists: Playlist[], next, total }: total counts every playlist the filters match; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({
    ...pageInput,
    isDefault: z.boolean().optional().describe('true: only the default playlist (none while there is none)'),
    unpublished: z.boolean().optional().describe('Only those whose draft differs from what is published (never published included)'),
  }),
  output: outputs.list_playlists,
  example: {},
  handler: async ({ org, input }) => {
    // Rows before items: an edit of the order moves its playlist's version on, so items read after
    // a version are never older than it, and an edit made from this listing's version is safe.
    const rows = await org.playlists.list();
    const [items, settings] = await Promise.all([org.playlists.allItems(), org.settings.get()]);
    const views = rows
      .map((p) => playlistView(p, items.get(p.id) ?? [], settings?.defaultPlaylistId))
      .filter((p) => (input.isDefault === undefined || p.isDefault === input.isDefault) && (!input.unpublished || p.draftChanged));
    const { rows: shown, next } = page(views, (p) => [-p.updatedAt, p.id], input);
    return { playlists: shown, next, total: views.length };
  },
});

const getPlaylist = defineTool({
  name: 'get_playlist',
  description: "Get one playlist's draft, with its spots in play order. Returns { playlist }; pass its version as ifVersion to save_playlist.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ playlistId: id('playlist') }),
  output: outputs.get_playlist,
  example: { playlistId: 'pls_example' },
  handler: async ({ org, input }) => {
    const row = await requirePlaylist(org, input.playlistId);
    return { playlist: await viewOf(org, row) };
  },
});

const savePlaylist = defineTool({
  name: 'save_playlist',
  description:
    "Create a playlist as a draft, or change one's draft. Without playlistId it creates one: a name, optionally its spots in play order (any of the organization's spots, published or not), and transition, by default a 500 ms fade; pass an idempotencyKey so a retry cannot create it twice. With playlistId it changes what you give: name, transition, spotIds (the whole play order, replacing the draft's); pass the version you read as ifVersion so a change made since, such as someone else's reorder, is not overwritten. Nothing reaches a screen until it is published and scheduled, or made the default playlist. Returns { playlist }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  partialAgents: "an agent's edit is its proposal (#116), held to the version it read",
  // Strict, as every save is: a field it does not take is refused by name, not dropped (review of #499).
  input: z.strictObject({
    playlistId: id('playlist').optional().describe('The playlist to change; omit to create one'),
    name: name('playlist').optional(),
    transition: transition.optional(),
    spotIds: spotIds.optional(),
    ifVersion,
    idempotencyKey,
  }),
  output: outputs.save_playlist,
  example: { name: 'Weekend promos', transition: { type: 'fade', ms: 600 }, spotIds: ['spt_example'] },
  target: (input, output) => ({ kind: 'playlist', id: input.playlistId ?? output.playlist.id }),
  handler: async ({ org, actor, input, write }) => {
    const { playlistId, name } = input;
    if (playlistId === undefined) {
      if (input.ifVersion !== undefined) throw invalidFields('a new playlist has no version yet: ifVersion is for a change', 'ifVersion');
      if (name === undefined) throw invalidFields('a new playlist needs a name; give playlistId to change one', 'name');
      const items = input.spotIds ?? [];
      const row = write(await org.playlists.stage.insert({ name, transitionJson: JSON.stringify(input.transition ?? DEFAULT_TRANSITION) }, items));
      return { playlist: playlistView(row, items, null) };
    }
    if (name === undefined && input.transition === undefined && input.spotIds === undefined) throw new ToolError('invalid_input', 'nothing to change');
    const current = await requirePlaylist(org, playlistId);
    const patch = { name, transitionJson: input.transition && JSON.stringify(input.transition) };
    // An agent's edit is its proposal (#116): the draft it replaces, items and all, is kept beside it, so it is held to the version read.
    write(await keptFor(org, actor, 'playlist', current, () => org.playlists.items(current.id)));
    const guard = input.ifVersion ?? (isAgent(actor) ? current.rowVersion : undefined);
    const row = write(await org.playlists.stage.update(current, patch, guard, input.spotIds));
    const [items, settings] = await Promise.all([input.spotIds ?? org.playlists.items(row.id), org.settings.get()]);
    return { playlist: playlistView(row, items, settings?.defaultPlaylistId) };
  },
  // The order's rows name the playlist: deleted between the read and the commit, they fail the batch.
  refuseFailedCommit: async ({ org, input }) =>
    input.playlistId === undefined || (await org.playlists.get(input.playlistId)) ? undefined : notFound('playlist', input.playlistId),
});

/** The playlist at the version shown, or refused as changed since. */
async function playlistAt(org: OrgScope, playlistId: string, version: number) {
  const row = await requirePlaylist(org, playlistId);
  if (row.rowVersion !== version) throw new StaleVersionError(row.id, row.rowVersion);
  return row;
}

/** Reject's and Keep's input: the playlist, at the version shown. */
const decidePlaylistInput = z.object({ playlistId: id('playlist'), ifVersion: shownVersion });

const revertPlaylistDraft = defineTool({
  name: 'revert_playlist_draft',
  description:
    "Reject an agent's draft of a playlist (#116): its name, transition and play order go back to the draft the agent wrote over (the person's, or as published), and the agent's is kept beside it; the same call again puts the agent's back (its Undo). Refused with a conflict if neither is kept, and if the playlist changed since ifVersion. People only. Returns { playlist, rejected }.",
  ...DECIDING,
  input: decidePlaylistInput,
  output: outputs.revert_playlist_draft,
  example: { playlistId: 'pls_example', ifVersion: 3 },
  target,
  handler: async ({ org, input, write }) => {
    const row = await playlistAt(org, input.playlistId, input.ifVersion);
    const kept = await org.draftSnapshots.get('playlist', row.id);
    if (!kept) throw new ToolError('conflict', `playlist ${row.id} has no agent's draft to reject`, { kept: null });
    const back = playlistContent.parse(JSON.parse(kept.contentJson));
    const items = await org.playlists.items(row.id);
    // The two swap: the draft there now is kept beside the one put back.
    const rejected = kept.holds === 'person';
    // Still kept as read when the batch runs: a Keep, Reject or publish committed first refuses this one.
    write(org.draftSnapshots.stage.holding('playlist', row.id, kept.holds));
    write(org.draftSnapshots.stage.keep('playlist', row, rejected ? 'agent' : 'person', { contentJson: contentJson(row, items), sampleFieldsJson: null }));
    const playlist = write(await org.playlists.stage.update(row, { name: back.name, transitionJson: back.transitionJson }, input.ifVersion, back.items));
    return { playlist: playlistView(playlist, back.items, (await org.settings.get())?.defaultPlaylistId), rejected };
  },
  // A spot it puts back was deleted since: its item fails the batch.
  refuseFailedCommit: ({ org, input }) => decidedMeanwhile(org, 'playlist', input.playlistId, input.ifVersion),
});

const keepPlaylistDraft = defineTool({
  name: 'keep_playlist_draft',
  description:
    "Keep an agent's draft of a playlist as the draft (#116): it is no longer a proposal, and the draft it was written over is let go. The draft is not changed and not published. Refused with a conflict if it is not an agent's proposal, or the playlist changed since ifVersion. People only. Returns { playlist }.",
  ...DECIDING,
  input: decidePlaylistInput,
  output: outputs.keep_playlist_draft,
  example: { playlistId: 'pls_example', ifVersion: 3 },
  target,
  handler: async ({ org, input, write }) => {
    const row = await playlistAt(org, input.playlistId, input.ifVersion);
    if ((await org.draftSnapshots.get('playlist', row.id))?.holds !== 'person')
      throw new ToolError('conflict', `playlist ${row.id} is not an agent's proposal`);
    // Held to the version shown, and to the agent's proposal, in the batch too: an edit, a Reject, a Keep or a publish landing first refuses it.
    write(org.playlists.stage.unchanged(row));
    write(org.draftSnapshots.stage.holding('playlist', row.id, 'person'));
    write(org.draftSnapshots.stage.clear('playlist', row.id));
    return { playlist: await viewOf(org, row) };
  },
  refuseFailedCommit: ({ org, input }) => decidedMeanwhile(org, 'playlist', input.playlistId, input.ifVersion),
});

/**
 * `set_default_playlist`'s `ifDefault`: refused as a conflict naming the default now unless it is
 * `playlistId` (null: none); else the guard that holds it so as the batch runs, so a default chosen
 * between this read and the commit fails it.
 */
async function stillDefault(org: OrgScope, playlistId: string | null) {
  const moved = await defaultMoved(org, playlistId);
  if (moved) throw moved;
  return org.settings.stage.defaultIs(playlistId);
}

/** `ifDefault` refused when the default is `now`, not `playlistId` (null: none): a conflict naming the default now. */
export const defaultConflict = (now: string | null, playlistId: string | null) =>
  now === playlistId
    ? undefined
    : new ToolError('conflict', now ? `the default playlist is now ${now}` : 'the organization has no default playlist now', { defaultPlaylistId: now });

const defaultMoved = async (org: OrgScope, playlistId: string | null) => defaultConflict((await org.settings.get())?.defaultPlaylistId ?? null, playlistId);

/** The playlist's takeovers that have ended for good: they play nowhere again, and go with it. */
const endedWith = async (org: OrgScope, playlistId: string, now: number) =>
  (await org.scheduleEntries.list()).filter((e) => ended(e, now) && (e.playlistId === playlistId || published(e)?.playlistId === playlistId));

/** Why a playlist cannot be deleted now (it is the default, or a schedule entry plays it), or undefined. An ended takeover does not count. */
export async function playlistInUse(org: OrgScope, playlistId: string): Promise<ToolError | undefined> {
  if ((await org.settings.get())?.defaultPlaylistId === playlistId)
    return new ToolError('conflict', `playlist ${playlistId} is the default playlist; choose another default first`);
  const now = Date.now();
  const entries = (await org.scheduleEntries.list())
    .filter((e) => !ended(e, now) && (e.playlistId === playlistId || published(e)?.playlistId === playlistId))
    .map((e) => e.id);
  if (entries.length) return new ToolError('conflict', `playlist ${playlistId} is played by ${entries.length} schedule entries`, { scheduleEntryIds: entries });
  return undefined;
}

/**
 * Delete a playlist, its draft and its published version, not its spots (the `delete` tool, ./delete.ts): refused with a
 * conflict while it is the default or a schedule entry plays it. Takeovers of it that have ended go with it.
 */
export async function deletePlaylist({ org, write }: Pick<ToolContext<unknown>, 'org' | 'write'>, playlistId: string) {
  await requirePlaylist(org, playlistId);
  const used = await playlistInUse(org, playlistId);
  if (used) throw used;
  for (const e of await endedWith(org, playlistId, Date.now())) write(org.scheduleEntries.stage.remove(e));
  write(org.playlists.stage.delete(playlistId));
}

const setDefaultPlaylist = defineTool({
  name: 'set_default_playlist',
  description:
    "Make a playlist the organization's default: what every screen plays when no schedule entry says otherwise. Until there is one, no screen can be published to. It is not a draft: it takes effect at the next publish, whatever that publish pins, so it needs the right to publish (refused to editors where only owners publish). That publish must also publish the playlist and its spots if they are drafts. Pass the organization settings' version you read (get_org_settings) as ifVersion so a default someone else chose since is not replaced: refused with a conflict if they changed. Or pass ifDefault, the default you saw (null for none): refused with a conflict, details { defaultPlaylistId }, unless it is still that, checked again as it is saved. Returns { playlist }.",
  scope: 'content:publish',
  minRole: 'editor',
  mutates: true,
  input: z.object({
    playlistId: id('playlist'),
    ifVersion: ifVersion.optional().describe("The organization settings' version you read (get_org_settings): refused with a conflict if they changed since"),
    ifDefault: id('playlist')
      .nullable()
      .optional()
      .describe('Set it only if the default is still this playlist; null: only if there is none. Refused with a conflict otherwise'),
  }),
  output: outputs.set_default_playlist,
  example: { playlistId: 'pls_example' },
  target,
  handler: async ({ org, input, write }) => {
    const row = await requirePlaylist(org, input.playlistId);
    if (input.ifDefault !== undefined) write(await stillDefault(org, input.ifDefault));
    write(await org.settings.stage.set({ defaultPlaylistId: row.id }, input.ifVersion));
    return { playlist: playlistView(row, await org.playlists.items(row.id), row.id) };
  },
  // Deleted between the read and the commit, the setting's foreign key fails the batch; a default chosen
  // meanwhile fails `ifDefault`'s guard, said as the read says it.
  refuseFailedCommit: async ({ org, input }) => {
    if (!(await org.playlists.get(input.playlistId))) return notFound('playlist', input.playlistId);
    return input.ifDefault === undefined ? undefined : defaultMoved(org, input.ifDefault);
  },
});

export const playlistTools = [listPlaylists, getPlaylist, savePlaylist, revertPlaylistDraft, keepPlaylistDraft, setDefaultPlaylist];
