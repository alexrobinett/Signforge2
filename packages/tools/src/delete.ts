/**
 * One tool deletes each kind of content that goes for good from the library (#345): an asset, a data source, a playlist
 * or a schedule entry. Each kind's own rules live with it; a kind that is not content (a group, a spot, a credential)
 * keeps its own tool, with its own scope or its `people` rule.
 */
import { z } from 'zod';
import { assetTakenUp, deleteAsset } from './assets';
import { deleteDataSource } from './data-sources';
import { ID_PATTERN } from '@signforge/contract';
import { ifVersion } from './fields';
import { deletePlaylist, playlistChangedSince, playlistInUse } from './playlists';
import { deleteScheduleEntry } from './schedule';
import { defineTool } from './tool';
import { outputs } from './outputs';

const deleteTool = defineTool({
  name: 'delete',
  description:
    'Delete one thing by type and id. An asset: refused with a conflict while a spot uses it or a brand kit has it as its logo (details list them); screens playing it keep their copy until their next publish. A data source and its snapshot: refused while a spot, drafted or published, binds it (details.spotIds). A playlist, its draft and its published version, not its spots: refused while it is the default or a schedule entry plays it; takeovers of it that have ended go with it. A schedule entry or takeover, unless it changed since ifVersion: one never published goes at once; a published one needs the right to publish and waits like an edit, listed with deleted: true until a publish of every change, or one pinning it (kind schedule_entry at the version returned), applies it. To end a takeover now, use takeover (action end). Returns { deleted, version }, version null when it went at once.',
  scope: 'content:draft',
  minRole: 'editor',
  mutates: true,
  input: z
    .strictObject({
      type: z.enum(['asset', 'data_source', 'playlist', 'schedule_entry']),
      id: z.string().regex(ID_PATTERN, 'not a valid id').describe("The thing's id"),
      ifVersion: ifVersion.describe('playlist or schedule_entry: the version you read; a conflict means it changed since'),
    })
    .refine((v) => v.ifVersion === undefined || v.type === 'schedule_entry' || v.type === 'playlist', {
      message: 'ifVersion is for a playlist or a schedule entry',
      path: ['ifVersion'],
    }),
  output: outputs.delete,
  example: { type: 'playlist', id: 'pls_example' },
  target: (input) => ({ kind: input.type, id: input.id }),
  handler: async (ctx) => {
    const { input } = ctx;
    switch (input.type) {
      case 'asset':
        await deleteAsset(ctx, input.id);
        return { deleted: input.id, version: null };
      case 'data_source':
        await deleteDataSource(ctx, input.id);
        return { deleted: input.id, version: null };
      case 'playlist':
        await deletePlaylist(ctx, input.id, input.ifVersion);
        return { deleted: input.id, version: null };
      case 'schedule_entry':
        return { deleted: input.id, version: await deleteScheduleEntry(ctx, input.id, input.ifVersion) };
    }
  },
  // Taken up meanwhile (an asset by a spot or a brand kit; a playlist made the default or scheduled): the foreign keys or
  // the usage guard fail the batch, said as the check before it says it.
  refuseFailedCommit: async ({ org, input }) =>
    input.type === 'asset'
      ? assetTakenUp(org, input.id)
      : input.type === 'playlist'
        ? ((await playlistInUse(org, input.id)) ?? playlistChangedSince(org, input.id, input.ifVersion))
        : undefined,
});

export const deleteTools = [deleteTool];
