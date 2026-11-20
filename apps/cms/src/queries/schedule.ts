/**
 * Server data for the Schedule page, as TanStack Query options keyed by org like the playlist
 * pages' (src/queries/playlists.ts). The schedule's store actions refresh it after each change.
 */
import { queryOptions } from '@tanstack/react-query';
import { getSchedule } from '~/server/schedule.functions';

export const scheduleKey = (orgId: string) => ['org', orgId, 'schedule'] as const;

export const scheduleQuery = (orgId: string) => queryOptions({ queryKey: scheduleKey(orgId), queryFn: () => getSchedule() });
