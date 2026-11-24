/**
 * Overview's drafts and setup data as TanStack Query options, keyed by org. Read again on every
 * visit: it is a status page, and spots or playlists made elsewhere (an agent, another tab) must show.
 */
import { queryOptions } from '@tanstack/react-query';
import { getOverview } from '~/server/overview.functions';

export const overviewQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'overview'], queryFn: () => getOverview(), staleTime: 0 });
