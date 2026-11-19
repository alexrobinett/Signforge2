/**
 * Server data for the Integrations page, as TanStack Query options, keyed by org
 * (docs/research/cms-data-layer.md, Decision). The store's integration actions invalidate them
 * after a change (src/state/integrations.ts).
 */
import { queryOptions } from '@tanstack/react-query';
import { getConnections, getDataSources } from '~/server/integrations.functions';

export const integrationKeys = {
  dataSources: (orgId: string) => ['org', orgId, 'dataSources'] as const,
  connections: (orgId: string) => ['org', orgId, 'connections'] as const,
};

/**
 * The org's data sources, with their health and the spots that bind them. Read again every 30
 * seconds while the page is open, so a poll's result (a fixed URL's first good check) shows.
 */
export const dataSourcesQuery = (orgId: string) =>
  queryOptions({ queryKey: integrationKeys.dataSources(orgId), queryFn: () => getDataSources(), refetchInterval: 30_000 });

export const connectionsQuery = (orgId: string) => queryOptions({ queryKey: integrationKeys.connections(orgId), queryFn: () => getConnections() });
