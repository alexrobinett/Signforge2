/**
 * Overview's read, through the tool registry as the signed-in member: the org's spots, playlists and
 * schedule entries in one call (`list_spots`, `list_playlists`, `list_schedule_entries`). Its own,
 * so a status read on Overview never stands in for the lists the editors read (src/queries/).
 */
import { createServerFn } from '@tanstack/react-start';
import { all, inOrg } from './tools.server';

export const getOverview = createServerFn({ method: 'GET', strict: { output: false } }).handler(async () => {
  const [spots, playlists, entries] = await inOrg(
    () => Promise.all([all('list_spots', (p) => p.spots), all('list_playlists', (p) => p.playlists), all('list_schedule_entries', (p) => p.entries)]),
    [[], [], []],
  );
  return { spots, playlists, entries };
});
