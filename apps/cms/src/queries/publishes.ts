/**
 * Server data for publishing, as TanStack Query options keyed by org (src/queries/spots.ts). A
 * rollout moves on as screens report, so an open rollout is read again as often as the Screens
 * page polls; the store's publish actions invalidate both after a publish.
 */
import { queryOptions } from '@tanstack/react-query';
import { getPublish, getPublishes, getPublishTargets } from '~/server/publishes.functions';

const POLL_MS = 15_000;

const publishKeys = {
  all: (orgId: string) => ['org', orgId, 'publishes'] as const,
  /** null: the latest publish. */
  one: (orgId: string, publishId: string | null) => ['org', orgId, 'publishes', publishId ?? 'latest'] as const,
};

export const publishesQuery = (orgId: string) =>
  queryOptions({ queryKey: [...publishKeys.all(orgId), 'history'], queryFn: () => getPublishes(), refetchInterval: POLL_MS });

export const publishQuery = (orgId: string, publishId: string | null) =>
  queryOptions({ queryKey: publishKeys.one(orgId, publishId), queryFn: () => getPublish({ data: publishId }), refetchInterval: POLL_MS });

/** Whom each group reached at a publish (#187): read once, not polled, as it is large and never changes. */
export const publishTargetsQuery = (orgId: string, publishId: string | null) =>
  queryOptions({
    queryKey: [...publishKeys.one(orgId, publishId), 'targets'],
    queryFn: () => getPublishTargets({ data: publishId }),
    staleTime: Number.POSITIVE_INFINITY,
  });
