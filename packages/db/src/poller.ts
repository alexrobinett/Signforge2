/**
 * The one lookup the data-source poller needs before it knows the org: which sources are due.
 * It returns each due source's org and id, and nothing else; the poll itself goes through
 * `scoped(db, orgId)` with the org this returns.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';

/**
 * Claim up to `limit` sources whose `next_poll_at` has come, the longest due first (returned in no
 * order), by moving it on: a run that overlaps this one does not fetch them too. It moves on by as
 * long as the source's next failure would back it off (its refresh doubled once more than it has
 * failed, at most `backoffMaxMs`), and at least `leaseMs`. A poll that is saved sets its own next
 * time; a run that dies before saving (an isolate out of memory) leaves the source backed off, so
 * a source that kills the run cannot be retried every lease. One statement, so two runs cannot
 * claim the same source.
 *
 * It reads every org's sources (no index leads with `next_poll_at`, as tenant indexes lead with
 * the org): 10 per org, so about 10,000 rows a minute at 1,000 orgs, well inside D1's reads.
 */
export async function claimDueDataSources(
  d1: D1Database,
  now: number,
  { limit, leaseMs, backoffMaxMs }: { limit: number; leaseMs: number; backoffMaxMs: number },
) {
  const t = s.dataSources;
  // The doubling stops at 2^20, past any refresh's 6-hour cap, so the shift never overflows.
  const backoff = sql`MIN(${sql.identifier(t.refreshS.name)} * 1000 * (1 << MIN(${sql.identifier(t.failures.name)} + 1, 20)), ${backoffMaxMs})`;
  const rows = await drizzle(d1).all<{ orgId: string; id: string }>(sql`
    UPDATE ${t} SET ${sql.identifier(t.nextPollAt.name)} = ${now} + MAX(${leaseMs}, ${backoff})
    WHERE (${sql.identifier(t.orgId.name)}, ${sql.identifier(t.id.name)}) IN (
      SELECT ${sql.identifier(t.orgId.name)}, ${sql.identifier(t.id.name)} FROM ${t}
      WHERE ${sql.identifier(t.nextPollAt.name)} <= ${now}
      ORDER BY ${sql.identifier(t.nextPollAt.name)} LIMIT ${limit})
    RETURNING ${sql.identifier(t.orgId.name)} AS orgId, ${sql.identifier(t.id.name)} AS id`);
  return rows;
}
