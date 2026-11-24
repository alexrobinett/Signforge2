/**
 * The sidebar's counts (#361), through the tool registry as the signed-in member: how many spots,
 * playlists and schedule entries have unpublished changes (`count_drafts`, one SQL count each), and,
 * with `fleet`, the screens that need someone (`list_screen_status`, which reads no manifests). On
 * Overview and Screens the sidebar takes those from the page's own poll and asks without `fleet`.
 * With `approvals`, for a member who may approve, the publish requests waiting (#115).
 */
import { createServerFn } from '@tanstack/react-start';
import { needingYou } from '~/lib/screen-status';
import { all, inOrg, tool } from './tools.server';

export const getNavCounts = createServerFn({ method: 'GET' })
  .validator((want: { fleet: boolean; approvals: boolean }) => ({ fleet: want.fleet === true, approvals: want.approvals === true }))
  .handler(({ data: { fleet, approvals } }) =>
    inOrg(
      async () => {
        const [drafts, screens, waiting] = await Promise.all([
          tool('count_drafts', {}),
          fleet ? all('list_screen_status', (p) => p.screens) : null,
          approvals ? all('list_publish_requests', (p) => p.requests, { pending: true }) : null,
        ]);
        return {
          needsYou: screens && needingYou(screens),
          spots: drafts.spots,
          playlists: drafts.playlists,
          schedule: drafts.scheduleEntries,
          approvals: waiting?.length ?? 0,
        };
      },
      { needsYou: 0, spots: 0, playlists: 0, schedule: 0, approvals: 0 },
    ),
  );
