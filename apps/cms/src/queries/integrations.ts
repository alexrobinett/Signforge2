/**
 * The org's connected accounts as TanStack Query options, keyed by org
 * (docs/research/cms-data-layer.md, Decision). Its data sources are `dataSourcesQuery` in
 * src/queries/spots.ts, shared with the spot editor. The store's integration actions invalidate
 * both after a change (src/state/integrations.ts).
 */
import { queryOptions } from '@tanstack/react-query';
import { getConnections } from '~/server/integrations.functions';

export const connectionKeys = { all: (orgId: string) => ['org', orgId, 'connections'] as const };

export const connectionsQuery = (orgId: string) => queryOptions({ queryKey: connectionKeys.all(orgId), queryFn: () => getConnections() });
