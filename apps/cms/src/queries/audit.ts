/**
 * The Audit log page's entries as an infinite query: the first page for the filters in the URL,
 * and each Load older adds the page after it. Keyed by org and filters, so another org's or
 * another filter's rows never show.
 */
import { infiniteQueryOptions, type InfiniteData } from '@tanstack/react-query';
import type { AuditFilters, AuditPage } from '~/lib/audit';
import { getAuditPage } from '~/server/audit.functions';

/** A page's cursor: null for the first. */
type Cursor = string | null;

export const auditQuery = (orgId: string, filters: AuditFilters) =>
  infiniteQueryOptions<AuditPage, Error, InfiniteData<AuditPage, Cursor>, readonly ['org', string, 'audit', AuditFilters], Cursor>({
    queryKey: ['org', orgId, 'audit', filters],
    queryFn: ({ pageParam }) => getAuditPage({ data: { filters, cursor: pageParam } }),
    initialPageParam: null,
    getNextPageParam: (page) => page.next,
  });
