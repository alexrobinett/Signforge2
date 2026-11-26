/**
 * The publish pages' reads, through the tool registry as the signed-in member (`list_publishes`,
 * `get_publish`). The query keys and options over them are in src/queries/publishes.ts.
 */
import { createServerFn } from '@tanstack/react-start';
import type { PublishDetail } from '~/lib/publishes';
import { inOrg, tool } from './tools.server';

const NONE: PublishDetail = { publish: null, screens: [], targets: null };

/** The newest publishes: the history a person reads, not every one. */
export const getPublishes = createServerFn({ method: 'GET' }).handler(async () => ({
  publishes: await inOrg(async () => (await tool('list_publishes', { limit: 20 })).publishes, []),
}));

/** One publish with its rollout; the latest when no id is given. */
export const getPublish = createServerFn({ method: 'GET' })
  .validator((publishId: string | null) => publishId)
  .handler(async ({ data: publishId }) => (await inOrg(() => tool('get_publish', publishId ? { publishId } : {}, { missing: 'null' }), NONE)) ?? NONE);

/**
 * Whom each group reached at a publish, the latest without an id (#187): read once by the Publishes page, apart from the
 * rollout it polls, as every group's screen ids are large (review of #620). Null without a record, or a publish.
 */
export const getPublishTargets = createServerFn({ method: 'GET' })
  .validator((publishId: string | null) => publishId)
  .handler(({ data: publishId }) =>
    inOrg(async () => (await tool('get_publish', { ...(publishId ? { publishId } : {}), targets: true }, { missing: 'null' }))?.targets ?? null, null),
  );
