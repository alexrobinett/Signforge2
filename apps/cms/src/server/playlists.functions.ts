/**
 * The playlist pages' reads, through the tool registry as the signed-in member (`list_playlists`,
 * `get_playlist`). The query keys and options over them are in src/queries/playlists.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import { all, inOrg, tool } from './tools.server';

export const getPlaylists = createServerFn({ method: 'GET' }).handler(async () => ({
  playlists: await inOrg(() => all('list_playlists', (p) => p.playlists), []),
}));

export const getPlaylist = createServerFn({ method: 'GET' })
  .validator((playlistId: string) => playlistId)
  .handler(async ({ data: playlistId }) => (await inOrg(() => tool('get_playlist', { playlistId }, { missing: 'null' }), null))?.playlist ?? null);
