/**
 * What a publish needs from the platform (docs/backend-plan.md#publishing): one at a time per
 * org, and screens told through a queue.
 *
 * - **The lock**: the org's Durable Object holds it (src/org-object.ts), and `publishLock` holds it
 *   while a publish runs.
 * - **The fan-out**: a publish's switched screens go to the `PUBLISH_NOTICES` queue, 50 screens a
 *   message, and the consumer tells each screen's Durable Object, all of a message's at once. A
 *   batch of 10 messages is at most 500 calls, under even the Free plan's 1,000 per invocation.
 *   A message with a call that failed is retried; a screen told twice syncs twice, and one never
 *   told syncs within 5 minutes anyway.
 */
import { screenObject, type PublishNotice } from './device/screens';

/** The dispatcher's `publishLock` for an org: hold the org's lock while `run` runs. */
export function publishLock(env: Pick<Env, 'ORGS'>, orgId: string) {
  return async <T>(run: () => Promise<T>): Promise<T> => {
    const org = env.ORGS.get(env.ORGS.idFromName(orgId));
    const token = await org.acquire();
    try {
      return await run();
    } finally {
      // Not released, it runs out in a minute.
      await org.release(token).catch((err: unknown) => console.warn('[publish] could not release the lock', err));
    }
  };
}

/** The queue's consumer: tell every screen of a message at once, and retry a message whose calls did not all reach their screen. */
export async function deliverNotices(batch: MessageBatch<PublishNotice>, env: Pick<Env, 'SCREENS'>): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      const told = await Promise.allSettled(message.body.screens.map((s) => screenObject(env, s.screenId).manifest(s.manifestId)));
      const failed = told.filter((t) => t.status === 'rejected');
      if (!failed.length) return message.ack();
      console.warn(`[publish] ${failed.length} of ${told.length} screens could not be told; retrying`, failed[0]?.reason);
      message.retry();
    }),
  );
}
