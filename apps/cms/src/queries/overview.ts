/**
 * Overview's drafts and setup data as TanStack Query options, keyed by org (`overviewKey`). Its
 * loader reads it fresh on every visit, as it is a status page.
 */
import { queryOptions } from '@tanstack/react-query';
import { overviewKey } from '~/lib/overview';
import { getOverview } from '~/server/overview.functions';

export const overviewQuery = (orgId: string) => queryOptions({ queryKey: overviewKey(orgId), queryFn: () => getOverview() });
