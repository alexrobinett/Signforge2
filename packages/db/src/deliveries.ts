/**
 * The delivery run's one cross-org step (#88): which alert deliveries, in any org, are due for an
 * attempt. It returns each one's org and id; the attempt and its result go through
 * `scoped(db, orgId).alertDeliveries` with the org this returns.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';

/**
 * Claim up to `limit` pending deliveries whose next attempt has come, the longest due first, by
 * counting the attempt and moving the next one on by `leaseMs`: an overlapping run does not send
 * them too, and a run that dies mid-send leaves them to the next once the lease ends. One
 * statement, so two runs cannot claim the same delivery. Reads `alert_deliveries_due_idx`.
 */
export async function claimDueAlertDeliveries(d1: D1Database, now: number, { limit, leaseMs }: { limit: number; leaseMs: number }) {
  const t = s.alertDeliveries;
  const col = (c: { name: string }) => sql.identifier(c.name);
  return drizzle(d1).all<{ orgId: string; id: string }>(sql`
    UPDATE ${t} SET ${col(t.attempts)} = ${col(t.attempts)} + 1, ${col(t.lastAttemptAt)} = ${now},
      ${col(t.nextAttemptAt)} = ${now + leaseMs}, ${col(t.leasedUntil)} = ${now + leaseMs}, ${col(t.updatedAt)} = ${now}
    WHERE ${col(t.id)} IN (
      SELECT ${col(t.id)} FROM ${t}
      WHERE ${col(t.status)} = 'pending' AND ${col(t.nextAttemptAt)} <= ${now}
      ORDER BY ${col(t.nextAttemptAt)} LIMIT ${limit})
    RETURNING ${col(t.orgId)} AS orgId, ${col(t.id)} AS id`);
}
