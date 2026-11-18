/**
 * Server data for the Screens page, as TanStack Query options (docs/research/cms-data-layer.md,
 * Decision). The page reads every screen once, with its settings and what it should be showing,
 * and then polls only what each screen is doing (`list_screen_status`), which reads no manifests.
 * The full list is read again when the poll sees a screen it does not have, or a publish to one.
 */
import { queryOptions } from '@tanstack/react-query';
import type { ScreenStatus, ScreenView } from '~/lib/screen-types';
import { getScreenStatus, getScreens } from '~/server/screens.functions';

/**
 * How often an open Screens page asks what the screens are doing. A screen syncs every 5 minutes
 * and is unreachable after the org's threshold (5 minutes at least), so this shows a change within
 * 15 seconds of the server seeing it. Query does not poll a tab in the background.
 */
const POLL_MS = 15_000;

export const screensQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'screens'], queryFn: () => getScreens() });

/** Which screens there are and what each should play: when it changes, the full list is out of date. */
const fleetOf = (screens: readonly Pick<ScreenView, 'id' | 'desiredManifestId'>[]) => screens.map((s) => `${s.id}:${s.desiredManifestId}`).join();

export const screenStatusQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['org', orgId, 'screenStatus'],
    queryFn: async ({ client }) => {
      const status = await getScreenStatus();
      const list = screensQuery(orgId);
      const known = client.getQueryData(list.queryKey);
      if (known && fleetOf(known.screens) !== fleetOf(status.screens)) void client.invalidateQueries({ queryKey: list.queryKey, exact: true });
      return status;
    },
    refetchInterval: POLL_MS,
  });

/** The screens as last read, with what the poll says each is doing, when the poll is the newer. */
export function withStatus(screens: ScreenView[], at: number, live: { screens: ScreenStatus[]; at: number } | undefined): ScreenView[] {
  if (!live || live.at < at) return screens;
  const byId = new Map(live.screens.map((s) => [s.id, s]));
  return screens.map((s) => ({ ...s, ...byId.get(s.id) }));
}
