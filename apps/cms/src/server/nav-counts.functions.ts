/**
 * The sidebar's counts (#361), through the tool registry as the signed-in member: the screens that
 * need someone (`list_screen_status`, which reads no manifests) and how many spots, playlists and
 * schedule entries have unpublished changes (the list tools' `total`, one row each).
 */
import { createServerFn } from '@tanstack/react-start';
import { isRetired } from '~/lib/screen-status';
import { all, inOrg, tool } from './tools.server';

export const getNavCounts = createServerFn({ method: 'GET' }).handler(() =>
  inOrg(
    async () => {
      const unpublished = { unpublished: true, limit: 1 };
      const [screens, spots, playlists, entries] = await Promise.all([
        all('list_screen_status', (p) => p.screens),
        tool('list_spots', unpublished),
        tool('list_playlists', unpublished),
        tool('list_schedule_entries', unpublished),
      ]);
      return {
        needsYou: screens.filter((s) => s.state.kind === 'needs_you' && !isRetired(s)).length,
        spots: spots.total,
        playlists: playlists.total,
        schedule: entries.total,
      };
    },
    { needsYou: 0, spots: 0, playlists: 0, schedule: 0 },
  ),
);
