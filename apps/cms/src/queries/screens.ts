/**
 * Server data for the Screens page, as TanStack Query options (docs/research/cms-data-layer.md,
 * Decision). The page reads every screen once, with its settings and what it should be showing,
 * and then polls only what each screen is doing (`list_screen_status`), which reads no manifests.
 * The full list is read again when the poll sees what it does not have (`listOutOfDate`).
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { listOutOfDate } from '~/lib/fleet-status';
import type { GroupView } from '~/lib/screen-types';
import { getScreenStatus, getScreens } from '~/server/screens.functions';
import { retryUnlessRedirect } from './retry';

/**
 * How often an open Screens page asks what the screens are doing. A screen syncs every 5 minutes
 * and is unreachable after the org's threshold (5 minutes at least), so this shows a change within
 * 15 seconds of the server seeing it. Query does not poll a tab in the background.
 */
const POLL_MS = 15_000;

export const screensQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'screens'], queryFn: () => getScreens() });

/** A group as a tool answered with it, or its deletion, into the list the Screens pages read. */
export function putGroup(client: QueryClient, orgId: string, change: GroupView | { deleted: string }) {
  client.setQueryData(screensQuery(orgId).queryKey, (list) => {
    if (!list) return list;
    if ('deleted' in change) return { ...list, groups: list.groups.filter((g) => g.id !== change.deleted) };
    return { ...list, groups: list.groups.map((g) => (g.id === change.id ? change : g)) };
  });
}

export const screenStatusQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['org', orgId, 'screenStatus'],
    queryFn: async ({ client }) => {
      const status = await getScreenStatus();
      const list = screensQuery(orgId);
      const known = client.getQueryData(list.queryKey);
      if (known && listOutOfDate(known.screens, status.screens)) void client.invalidateQueries({ queryKey: list.queryKey, exact: true });
      return status;
    },
    refetchInterval: POLL_MS,
    // A poll fails when two tries in a row do, a second apart; the page then says its status is not current.
    retry: retryUnlessRedirect(1),
  });
