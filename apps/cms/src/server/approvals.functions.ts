/**
 * The approvals queue's read (#115), through the tool registry as the signed-in member: every
 * request waiting (`list_publish_requests`), what approving each would do now
 * (`check_publish_request`), and for its first spots both the draft it pins and what screens have
 * (`get_spot`, published or not). The query over it is in src/queries/approvals.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import { type ApprovalItem, MAX_STAGES } from '~/lib/approvals';
import { all, inOrg, tool } from './tools.server';

/**
 * Every request waiting, with what approving it would do and its stages. Tool outputs are JSON from `/api/tools`; a spot's
 * template data is typed `unknown`, which Start's type check cannot prove serializes (as src/server/spots.functions.ts says).
 */
export const getApprovals = createServerFn({ method: 'GET', strict: { output: false } }).handler(() =>
  inOrg(
    async () => {
      const waiting = await all('list_publish_requests', (p) => p.requests, { pending: true });
      const items: ApprovalItem[] = await Promise.all(
        waiting.map(async (r) => {
          const spots = r.drafts.filter((d) => d.kind === 'spot').slice(0, MAX_STAGES);
          const [check, ...stages] = await Promise.all([
            tool('check_publish_request', { publishRequestId: r.id }),
            ...spots.map(async (p) => {
              const [after, now] = await Promise.all([
                tool('get_spot', { spotId: p.id }, { missing: 'null' }),
                tool('get_spot', { spotId: p.id, published: true }, { missing: 'null' }),
              ]);
              return after && { after: after.spot, now: now?.spot ?? null, pinned: p.version };
            }),
          ]);
          return { check, stages: stages.flatMap((s) => (s ? [s] : [])) };
        }),
      );
      return { items };
    },
    { items: [] },
  ),
);
