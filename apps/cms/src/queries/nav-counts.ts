/**
 * The sidebar's counts as TanStack Query options (#361). Keyed under Overview's key, so every save
 * of a spot, playlist or schedule entry that invalidates Overview (`overviewKey`) counts again, as
 * does every publish (the org's keys, or Overview's from ⌘K). Read again each minute while the tab
 * is visible, for screens that start or stop needing someone and changes made in another tab.
 * `fleet`: whether to read the screens too; Overview and Screens poll them already.
 */
import { queryOptions } from '@tanstack/react-query';
import { overviewKey } from '~/lib/overview';
import { getNavCounts } from '~/server/nav-counts.functions';
import { retryUnlessRedirect } from './retry';

export const navCountsQuery = (orgId: string, fleet: boolean) =>
  queryOptions({
    queryKey: [...overviewKey(orgId), 'counts', fleet],
    queryFn: () => getNavCounts({ data: fleet }),
    refetchInterval: 60_000,
    retry: retryUnlessRedirect(1),
  });
