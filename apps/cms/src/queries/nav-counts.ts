/**
 * The sidebar's counts as TanStack Query options (#361). Keyed under Overview's key, so every save
 * of a spot, playlist or schedule entry that invalidates Overview (`overviewKey`) counts again, as
 * does a publish (which invalidates the org). Read again each minute while the tab is visible, for
 * screens that start or stop needing someone and changes made in another tab.
 */
import { queryOptions } from '@tanstack/react-query';
import { overviewKey } from '~/lib/overview';
import { getNavCounts } from '~/server/nav-counts.functions';
import { retryUnlessRedirect } from './retry';

export const navCountsQuery = (orgId: string) =>
  queryOptions({ queryKey: [...overviewKey(orgId), 'counts'], queryFn: () => getNavCounts(), refetchInterval: 60_000, retry: retryUnlessRedirect(1) });
