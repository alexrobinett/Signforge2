/**
 * An editor's agent proposal (#116) as TanStack Query options. Keyed by the draft's version too, so a
 * save, a Reject or a Keep, which each move it on or end the proposal, reads it again.
 */
import { queryOptions } from '@tanstack/react-query';
import { getProposal } from '~/server/proposals.functions';

export const proposalKeys = { all: (orgId: string) => ['org', orgId, 'proposals'] as const };

export const proposalQuery = (orgId: string, kind: 'spot' | 'playlist', id: string, version: number) =>
  queryOptions({ queryKey: [...proposalKeys.all(orgId), kind, id, version], queryFn: () => getProposal({ data: { kind, id } }) });
