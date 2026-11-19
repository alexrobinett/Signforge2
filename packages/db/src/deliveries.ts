/**
 * The delivery run's cross-org steps (#88): claim the alert deliveries due in any org, read the
 * channels they go to, and record what each attempt came to. Each is one D1 query however many
 * deliveries a run takes, as the Free plan allows 50 queries an invocation. Every row is named by
 * its org as well as its id, so nothing here reaches past the org a claimed row belongs to.
 */
import { and, asc, eq, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as s from './schema';

type Db = DrizzleD1Database<Record<string, never>>;
type Delivery = typeof s.alertDeliveries.$inferSelect;

/** What an attempt came to: delivered, to be tried again at `retryAt`, or given up on (no `retryAt`). */
export type AttemptResult = { ok: true; httpStatus: number | null } | { ok: false; httpStatus: number | null; error: string; retryAt?: number };

/**
 * Claim up to `limit` pending deliveries whose next attempt has come, the longest due first, by
 * counting the attempt and holding it for `leaseMs` (`leased_until`, and the next attempt moved on
 * as far): an overlapping run does not send them too, and a run that dies mid-send leaves them to
 * the next once the lease ends. One statement, through `alert_deliveries_due_idx`; it returns the
 * claimed rows as they now are.
 */
export async function claimDueAlertDeliveries(d1: D1Database, now: number, { limit, leaseMs }: { limit: number; leaseMs: number }): Promise<Delivery[]> {
  const db = drizzle(d1);
  const t = s.alertDeliveries;
  const due = db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.status, 'pending'), lte(t.nextAttemptAt, now)))
    .orderBy(asc(t.nextAttemptAt))
    .limit(limit);
  return db
    .update(t)
    .set({ attempts: sql`${t.attempts} + 1`, lastAttemptAt: now, nextAttemptAt: now + leaseMs, leasedUntil: now + leaseMs, updatedAt: now })
    .where(inArray(t.id, due))
    .returning()
    .all();
}

/** The channels the given deliveries go to, in one query; email deliveries name none. */
export async function alertChannelsOf(d1: D1Database, deliveries: readonly Pick<Delivery, 'orgId' | 'channel'>[]) {
  const c = s.alertChannels;
  const pairs: SQL[] = [];
  for (const d of deliveries) if (d.channel !== 'email') pairs.push(and(eq(c.orgId, d.orgId), eq(c.kind, d.channel))!);
  if (!pairs.length) return [];
  return drizzle(d1)
    .select()
    .from(c)
    .where(or(...pairs))
    .all();
}

/**
 * The statement recording what attempt `attempt` (its `attempts` once claimed) came to, which ends
 * its claim. An attempt that is no longer the latest settles nothing, so a late answer cannot
 * overwrite a newer one.
 */
export function settleStatement(db: Db, orgId: string, id: string, attempt: number, now: number, result: AttemptResult) {
  const t = s.alertDeliveries;
  const set = result.ok
    ? { status: 'delivered' as const, lastHttpStatus: result.httpStatus, lastError: null }
    : result.retryAt === undefined
      ? { status: 'failed' as const, lastHttpStatus: result.httpStatus, lastError: result.error }
      : { nextAttemptAt: result.retryAt, lastHttpStatus: result.httpStatus, lastError: result.error };
  return db
    .update(t)
    .set({ ...set, leasedUntil: null, updatedAt: now })
    .where(and(eq(t.orgId, orgId), eq(t.id, id), eq(t.attempts, attempt), eq(t.status, 'pending')));
}

/** Record a run's attempts in one batch (one query). */
export async function settleAlertDeliveries(
  d1: D1Database,
  now: number,
  settled: readonly { orgId: string; id: string; attempt: number; result: AttemptResult }[],
): Promise<void> {
  const db = drizzle(d1);
  const [first, ...rest] = settled.map((x) => settleStatement(db, x.orgId, x.id, x.attempt, now, x.result));
  if (first) await db.batch([first, ...rest]);
}
