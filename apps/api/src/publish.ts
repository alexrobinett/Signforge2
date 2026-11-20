/**
 * What a publish needs from the platform (docs/backend-plan.md#publishing): one at a time per
 * org, and screens told through a queue.
 *
 * - **The org's Durable Object** (`OrgObject`, one per org, named by org id) holds the publish
 *   lock: a lease in its storage, so it outlives an eviction, and long enough for a 1,000-screen
 *   publish. A holder that dies leaves it to run out. The lock saves overlapping publishes the
 *   work of compiling twice and retrying; their order does not depend on it, since the publish
 *   revision's guard commits them in order anyway. M3-20's timed publish will keep its alarm here.
 * - **The fan-out**: a publish's switched screens go to the `PUBLISH_NOTICES` queue, 50 screens a
 *   message, and the consumer tells each screen's Durable Object, all of a message's at once. A
 *   batch of 10 messages is at most 500 calls, under even the Free plan's 1,000 per invocation.
 *   A message with a call that failed is retried; a screen told twice syncs twice, and one never
 *   told syncs within 5 minutes anyway.
 */
import { DurableObject } from 'cloudflare:workers';
import { screenObject, type PublishNotice } from './device/screens';

/** How long a publish may hold the lock before another may take it. */
const LEASE_MS = 60_000;

interface Lease {
  token: string;
  until: number;
}

export class OrgObject extends DurableObject<Env> {
  /** Calls waiting for the lock, woken when it is released. */
  private waiting: (() => void)[] = [];

  /** Wait until no publish of the org holds the lock, take it, and return its token. */
  async acquire(): Promise<string> {
    for (;;) {
      // Read and written with no other await between: the input gate lets no other call in.
      const held = await this.ctx.storage.get<Lease>('publish');
      const now = Date.now();
      if (!held || held.until <= now) {
        const token = crypto.randomUUID();
        await this.ctx.storage.put('publish', { token, until: now + LEASE_MS } satisfies Lease);
        return token;
      }
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        setTimeout(resolve, held.until - now);
      });
    }
  }

  /** Give the lock back. A token whose lease ran out and was taken releases nothing. */
  async release(token: string): Promise<void> {
    if ((await this.ctx.storage.get<Lease>('publish'))?.token === token) await this.ctx.storage.delete('publish');
    for (const wake of this.waiting.splice(0)) wake();
  }
}

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
