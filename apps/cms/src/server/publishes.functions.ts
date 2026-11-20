/**
 * The publish pages' reads, through the tool registry as the signed-in member (`list_publishes`,
 * `get_publish`). The query keys and options over them are in src/queries/publishes.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import type { PublishDetail, PublishView } from '~/lib/publishes';
import { inOrg, tool } from './tools.server';

const NONE: PublishDetail = { publish: null, screens: [] };

/** The newest publishes: the history a person reads, not every one. */
export const getPublishes = createServerFn({ method: 'GET' }).handler(async () => ({
  publishes: await inOrg(async () => (await tool<{ publishes: PublishView[] }>('list_publishes', { limit: 20 })).publishes, []),
}));

/** One publish with its rollout; the latest when no id is given. */
export const getPublish = createServerFn({ method: 'GET' })
  .validator((publishId: string | null) => publishId)
  .handler(
    async ({ data: publishId }) => (await inOrg(() => tool<PublishDetail>('get_publish', publishId ? { publishId } : {}, { missing: 'null' }), NONE)) ?? NONE,
  );
