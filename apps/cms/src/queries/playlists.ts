/**
 * Server data for the playlist pages, as TanStack Query options, keyed by org like the spot
 * pages' (src/queries/spots.ts). The editor's store actions write what they save back into these
 * entries (src/state/playlist-editor.ts).
 */
import { queryOptions } from '@tanstack/react-query';
import { getPlaylist, getPlaylists } from '~/server/playlists.functions';

export const playlistKeys = {
  all: (orgId: string) => ['org', orgId, 'playlists'] as const,
  one: (orgId: string, playlistId: string) => ['org', orgId, 'playlists', playlistId] as const,
};

export const playlistsQuery = (orgId: string) => queryOptions({ queryKey: playlistKeys.all(orgId), queryFn: () => getPlaylists() });

export const playlistQuery = (orgId: string, playlistId: string) =>
  queryOptions({ queryKey: playlistKeys.one(orgId, playlistId), queryFn: () => getPlaylist({ data: playlistId }) });
