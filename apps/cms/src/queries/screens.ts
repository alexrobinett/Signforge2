/**
 * Server data for the Screens page, as TanStack Query options (docs/research/cms-data-layer.md,
 * Decision). The page reads every screen once, with its settings and what it should be showing,
 * and then polls only what each screen is doing (`list_screen_status`), which reads no manifests.
 * The full list is read again when the poll sees what it does not have (`listOutOfDate`).
 */
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { listOutOfDate, rosterOutOfDate } from '~/lib/fleet-status';
import type { GroupView } from '~/lib/screen-types';
import { getLabelKeys, getScreenStatus, getScreens } from '~/server/screens.functions';
import { retryUnlessRedirect } from './retry';

/**
 * How often an open Screens page asks what the screens are doing. A screen syncs every 5 minutes
 * and is unreachable after the org's threshold (5 minutes at least), so this shows a change within
 * 15 seconds of the server seeing it. Query does not poll a tab in the background.
 */
const POLL_MS = 15_000;

export const screensQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'screens'], queryFn: () => getScreens() });

/** The org's label keys and their values (`list_label_keys`): what the label editors suggest, and warn by (#185). */
export const labelKeysQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'label-keys'], queryFn: () => getLabelKeys() });

/** A group as a tool answered with it, or its deletion, into the list the Screens pages read. */
export function putGroup(client: QueryClient, orgId: string, change: GroupView | { deleted: string }) {
  client.setQueryData(screensQuery(orgId).queryKey, (list) => {
    if (!list) return list;
    if ('deleted' in change) return { ...list, groups: list.groups.filter((g) => g.id !== change.deleted) };
    return { ...list, groups: list.groups.map((g) => (g.id === change.id ? change : g)) };
  });
}

/**
 * The fleet poll, which reads the full list again when `outOfDate` says the list no longer matches.
 * Query polls only while a page shows it and the tab is visible.
 */
const fleetPoll = (orgId: string, key: string[], outOfDate: typeof listOutOfDate) =>
  queryOptions({
    queryKey: ['org', orgId, ...key],
    queryFn: async ({ client }) => {
      const status = await getScreenStatus();
      const list = screensQuery(orgId);
      const known = client.getQueryData(list.queryKey);
      if (known && outOfDate(known.screens, status.screens)) void client.invalidateQueries({ queryKey: list.queryKey, exact: true });
      return status;
    },
    refetchInterval: POLL_MS,
    // A poll fails when two tries in a row do, a second apart; the page then says its status is not current.
    retry: retryUnlessRedirect(1),
  });

/** The Screens page's poll: the list is read again for any change it shows (a screen, what it plays, its state). */
export const screenStatusQuery = (orgId: string) => fleetPoll(orgId, ['screenStatus'], listOutOfDate);

/**
 * For a page that needs only which screens there are and whether each is retired (Settings' Groups),
 * which the poll's own answer says: the list is read again only when a screen comes or goes.
 */
export const screenRosterQuery = (orgId: string) => fleetPoll(orgId, ['screenRoster'], rosterOutOfDate);
