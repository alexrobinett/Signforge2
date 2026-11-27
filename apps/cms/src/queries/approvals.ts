/**
 * The approvals queue as TanStack Query options (#115), keyed by org, so every publish (which
 * invalidates the org's keys) reads what approving each request would do again.
 */
import { queryOptions } from '@tanstack/react-query';
import { getApprovals } from '~/server/approvals.functions';

export const approvalsQuery = (orgId: string) => queryOptions({ queryKey: ['org', orgId, 'approvals'], queryFn: () => getApprovals() });
