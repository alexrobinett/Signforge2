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
import { draftChanged, published, type OrgScope, type PlaylistRow } from '@signforge/db';
import { z } from 'zod';
import { draftOutput, id, idempotencyKey, ifVersion, name, version } from './fields';
import { nextOutput, page, pageInput } from './paging';
import { defineTool, notFound, ToolError } from './tool';

/** A new playlist's transition when none is given: fade, the player's default (docs/architecture.md, Transitions). */
const DEFAULT_TRANSITION: Transition = { type: 'fade', ms: 500 };

const ms = z.number().int().min(1).max(10_000).describe('How long the transition takes, in ms');
const transition = z
  .discriminatedUnion('type', [z.object({ type: z.literal('cut') }), z.object({ type: z.literal('fade'), ms }), z.object({ type: z.literal('crossfade'), ms })])
  .describe(
    'How one spot gives way to the next. cut: instant. fade: out to black, then in, one spot on screen at a time. crossfade: both spots on screen while one fades over the other, which doubles the GPU work for its length (about 10% dropped frames on a Raspberry Pi 4)',
  );
const spotIds = z.array(id('spot')).max(500).describe("The spots in play order: the whole list, replacing the draft's. A spot may appear more than once");

const playlistOutput = z.object({
  id: z.string(),
  name: z.string(),
  transition,
  spotIds: z.array(z.string()).describe('The spots in play order'),
  version: version.describe('Moves on with every edit of the draft, its spots too; pass it as ifVersion to update only what you read'),
  isDefault: z.boolean().describe('Whether it is the default playlist: what every screen plays when no schedule entry says otherwise'),
  ...draftOutput,
});
type PlaylistView = z.infer<typeof playlistOutput>;
const playlistResult = z.object({ playlist: playlistOutput });

const playlistView = (row: PlaylistRow, items: string[], defaultId: string | null | undefined): PlaylistView => ({
  id: row.id,
  name: row.name,
  // Written only by these tools and `sf push`, from the contract's `Transition`.
  transition: JSON.parse(row.transitionJson),
  spotIds: items,
  version: row.rowVersion,
  isDefault: row.id === defaultId,
  published: published(row) !== undefined,
  draftChanged: draftChanged(row, items),
  publishedAt: row.publishedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

async function requirePlaylist(org: OrgScope, playlistId: string) {
  const row = await org.playlists.get(playlistId);
  if (!row) throw notFound('playlist', playlistId);
  return row;
}

const target = (input: { playlistId: string }) => ({ kind: 'playlist', id: input.playlistId });

const listPlaylists = defineTool({
  name: 'list_playlists',
  description:
    "List the organization's playlists, the drafts as last edited, most recently edited first, a page at a time, each with its spots in play order. Each says whether it is published and whether its draft differs. Returns { playlists: Playlist[], next }; pass next as cursor for the following page.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ ...pageInput }),
  output: z.object({ playlists: z.array(playlistOutput), next: nextOutput }),
  example: {},
  handler: async ({ org, input }) => {
    // Rows before items: an edit of the order moves its playlist's version on, so items read after
    // a version are never older than it, and an edit made from this listing's version is safe.
    const rows = await org.playlists.list();
    const [items, settings] = await Promise.all([org.playlists.allItems(), org.settings.get()]);
    const { rows: shown, next } = page(rows, (p) => [-p.updatedAt, p.id], input);
    return { playlists: shown.map((p) => playlistView(p, items.get(p.id) ?? [], settings?.defaultPlaylistId)), next };
  },
});

const getPlaylist = defineTool({
  name: 'get_playlist',
  description: "Get one playlist's draft, with its spots in play order. Returns { playlist }; pass its version as ifVersion to update_playlist.",
  scope: 'content:read',
  minRole: 'viewer',
  mutates: false,
  input: z.object({ playlistId: id('playlist') }),
  output: playlistResult,
  example: { playlistId: 'pls_example' },
  handler: async ({ org, input }) => {
    const row = await requirePlaylist(org, input.playlistId);
    const [items, settings] = await Promise.all([org.playlists.items(row.id), org.settings.get()]);
    return { playlist: playlistView(row, items, settings?.defaultPlaylistId) };
  },
});

const createPlaylist = defineTool({
  name: 'create_playlist',
  description:
    "Create a playlist as a draft, optionally with its spots in play order (any of the organization's spots, published or not). transition defaults to a 500 ms fade. Nothing reaches a screen until it is published and scheduled, or made the default playlist. Pass an idempotencyKey so a retry cannot create it twice. Returns { playlist }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  idempotent: true,
  input: z.object({ name: name('playlist'), transition: transition.optional(), spotIds: spotIds.optional(), idempotencyKey }),
  output: playlistResult,
  example: { name: 'Weekend promos', transition: { type: 'fade', ms: 600 }, spotIds: ['spt_example'] },
  target: (_input, output) => ({ kind: 'playlist', id: output.playlist.id }),
  handler: async ({ org, input, write }) => {
    const items = input.spotIds ?? [];
    const row = write(await org.playlists.stage.insert({ name: input.name, transitionJson: JSON.stringify(input.transition ?? DEFAULT_TRANSITION) }, items));
    return { playlist: playlistView(row, items, null) };
  },
});

const updatePlaylist = defineTool({
  name: 'update_playlist',
  description:
    "Change a playlist's draft. Give only what changes: name, transition, spotIds (the whole play order, replacing the draft's). Screens keep the published version until the next publish. Pass the version you read as ifVersion so a change made since, such as someone else's reorder, is not overwritten. Returns { playlist }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z
    .object({ playlistId: id('playlist'), name: name('playlist').optional(), transition: transition.optional(), spotIds: spotIds.optional(), ifVersion })
    .refine((v) => v.name !== undefined || v.transition !== undefined || v.spotIds !== undefined, 'nothing to change'),
  output: playlistResult,
  example: { playlistId: 'pls_example', spotIds: ['spt_example'], ifVersion: 2 },
  target,
  handler: async ({ org, input, write }) => {
    const current = await requirePlaylist(org, input.playlistId);
    const patch = { name: input.name, transitionJson: input.transition && JSON.stringify(input.transition) };
    const row = write(await org.playlists.stage.update(current, patch, input.ifVersion, input.spotIds));
    const [items, settings] = await Promise.all([input.spotIds ?? org.playlists.items(row.id), org.settings.get()]);
    return { playlist: playlistView(row, items, settings?.defaultPlaylistId) };
  },
  // The order's rows name the playlist: deleted between the read and the commit, they fail the batch.
  refuseFailedCommit: async ({ org, input }) => ((await org.playlists.get(input.playlistId)) ? undefined : notFound('playlist', input.playlistId)),
});

/** Why a playlist cannot be deleted now (it is the default, or a schedule entry plays it), or undefined. */
async function inUse(org: OrgScope, playlistId: string): Promise<ToolError | undefined> {
  if ((await org.settings.get())?.defaultPlaylistId === playlistId)
    return new ToolError('conflict', `playlist ${playlistId} is the default playlist; choose another default first`);
  const entries = (await org.scheduleEntries.list()).filter((e) => e.playlistId === playlistId || published(e)?.playlistId === playlistId).map((e) => e.id);
  if (entries.length) return new ToolError('conflict', `playlist ${playlistId} is played by ${entries.length} schedule entries`, { scheduleEntryIds: entries });
  return undefined;
}

const deletePlaylist = defineTool({
  name: 'delete_playlist',
  description:
    'Delete a playlist, its draft and its published version. Its spots are not deleted. Refused with a conflict while it is the default playlist or a schedule entry plays it, in its draft or its published version: change those first, since screens play them. Returns { deleted: playlistId }.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ playlistId: id('playlist') }),
  output: z.object({ deleted: z.string().describe("The deleted playlist's id") }),
  example: { playlistId: 'pls_example' },
  target,
  handler: async ({ org, input, write }) => {
    await requirePlaylist(org, input.playlistId);
    const used = await inUse(org, input.playlistId);
    if (used) throw used;
    write(org.playlists.stage.delete(input.playlistId));
    return { deleted: input.playlistId };
  },
  // Made the default or scheduled since the check, the foreign keys fail the batch: the same refusal.
  refuseFailedCommit: async ({ org, input }) => inUse(org, input.playlistId),
});

const setDefaultPlaylist = defineTool({
  name: 'set_default_playlist',
  description:
    "Make a playlist the organization's default: what every screen plays when no schedule entry says otherwise. Until there is one, no screen can be published to. Takes effect at the next publish, which must also publish the playlist and its spots if they are drafts. Returns { playlist }.",
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z.object({ playlistId: id('playlist') }),
  output: playlistResult,
  example: { playlistId: 'pls_example' },
  target,
  handler: async ({ org, input, write }) => {
    const row = await requirePlaylist(org, input.playlistId);
    write(await org.settings.stage.set({ defaultPlaylistId: row.id }));
    return { playlist: playlistView(row, await org.playlists.items(row.id), row.id) };
  },
  // Deleted between the read and the commit, the setting's foreign key fails the batch.
  refuseFailedCommit: async ({ org, input }) => ((await org.playlists.get(input.playlistId)) ? undefined : notFound('playlist', input.playlistId)),
});

export const playlistTools = [listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist, setDefaultPlaylist];
