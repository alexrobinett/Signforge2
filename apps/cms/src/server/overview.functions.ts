/**
 * Overview's read, through the tool registry as the signed-in member: only what the page shows.
 * The newest unpublished spots, playlists and schedule entries (`SHOWN_DRAFTS` of each, with how
 * many there are), the playlist names those entries play, and for the setup checklist whether a
 * template spot exists and the default playlist. Its own, so a status read on Overview never stands
 * in for the lists the editors read (src/queries/).
 */
import { createServerFn } from '@tanstack/react-start';
import { SHOWN_DRAFTS } from '~/lib/overview';
import { inOrg, tool } from './tools.server';

const EMPTY = { spots: [], playlists: [], entries: [], drafts: 0, templateSpot: false, defaultPlaylist: null };

export const getOverview = createServerFn({ method: 'GET', strict: { output: false } }).handler(() =>
  inOrg(async () => {
    const unpublished = { unpublished: true, limit: SHOWN_DRAFTS };
    const [spots, playlists, entries, templateSpots, defaults] = await Promise.all([
      tool('list_spots', unpublished),
      tool('list_playlists', unpublished),
      tool('list_schedule_entries', unpublished),
      tool('list_spots', { kind: 'template', limit: 1 }),
      tool('list_playlists', { isDefault: true, limit: 1 }),
    ]);
    const names = new Map(
      await Promise.all(
        [...new Set(entries.entries.map((e) => e.playlistId))].map(
          async (playlistId) => [playlistId, (await tool('get_playlist', { playlistId }, { missing: 'null' }))?.playlist.name ?? null] as const,
        ),
      ),
    );
    return {
      spots: spots.spots,
      playlists: playlists.playlists,
      entries: entries.entries.map((e) => ({ ...e, playlistName: names.get(e.playlistId) ?? null })),
      drafts: spots.total + playlists.total + entries.total,
      templateSpot: templateSpots.total > 0,
      defaultPlaylist: defaults.playlists[0] ?? null,
    };
  }, EMPTY),
);
