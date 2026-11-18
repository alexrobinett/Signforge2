/**
 * The one lookup the data-source poller needs before it knows the org: which sources are due.
 * It returns each due source's org and id, and nothing else; the poll itself goes through
 * `scoped(db, orgId)` with the org this returns.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';

/**
 * Claim up to `limit` sources whose `next_poll_at` has come, the longest due first (returned in no order), by moving it on by
 * `leaseMs`: a run that overlaps this one does not fetch them too, and a run that dies before
 * saving its poll leaves them to be retried once the lease ends. One statement, so two runs
 * cannot claim the same source.
 *
 * It reads every org's sources (no index leads with `next_poll_at`, as tenant indexes lead with
 * the org): 10 per org, so about 10,000 rows a minute at 1,000 orgs, well inside D1's reads.
 */
export async function claimDueDataSources(d1: D1Database, now: number, { limit, leaseMs }: { limit: number; leaseMs: number }) {
  const t = s.dataSources;
  const rows = await drizzle(d1).all<{ orgId: string; id: string }>(sql`
    UPDATE ${t} SET ${sql.identifier(t.nextPollAt.name)} = ${now + leaseMs}
    WHERE (${sql.identifier(t.orgId.name)}, ${sql.identifier(t.id.name)}) IN (
      SELECT ${sql.identifier(t.orgId.name)}, ${sql.identifier(t.id.name)} FROM ${t}
      WHERE ${sql.identifier(t.nextPollAt.name)} <= ${now}
      ORDER BY ${sql.identifier(t.nextPollAt.name)} LIMIT ${limit})
    RETURNING ${sql.identifier(t.orgId.name)} AS orgId, ${sql.identifier(t.id.name)} AS id`);
  return rows;
}
