/**
 * Retention (F13, #41): cross-org deletes by age, run daily from the API's Cron Trigger. They
 * read no row and name no org: idempotency keys go after 7 days, audit rows after each org's
 * `org_settings.audit_retention_days`.
 */
import { lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A retry this long after the call gets no stored answer: about 7 days, as the review asked. */
const IDEMPOTENCY_KEY_TTL_MS = 7 * DAY_MS;

/** Delete every org's idempotency keys older than the TTL at `now`. */
export async function expireIdempotencyKeys(d1: D1Database, now: number): Promise<void> {
  await drizzle(d1)
    .delete(s.idempotencyKeys)
    .where(lt(s.idempotencyKeys.createdAt, now - IDEMPOTENCY_KEY_TTL_MS));
}

/** An org with no setting keeps its audit rows a year (owner decision, 2026-11-18). */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

/**
 * One run deletes at most AUDIT_BATCHES batches of AUDIT_BATCH rows, so a run stays well inside a
 * Worker's limits (D1 queries per invocation, 30 s per query) however long a log has grown; a
 * backlog goes over the next nights.
 */
const AUDIT_BATCH = 1000;
const AUDIT_BATCHES = 10;
/** The most audit rows one run deletes; a run that deletes this many may have left a backlog. */
export const AUDIT_ROWS_PER_RUN = AUDIT_BATCH * AUDIT_BATCHES;

/** Delete every org's audit rows older than its retention at `now`; returns how many went. */
export async function expireAuditRows(d1: D1Database, now: number): Promise<number> {
  const db = drizzle(d1);
  const a = s.auditLog;
  const os = s.orgSettings;
  const o = s.organization;
  // Org by org through audit_log_org_at_idx, so a batch reads only the rows it deletes. CROSS JOIN
  // keeps SQLite from putting audit_log outermost, which scans its whole index on every batch.
  const batch = sql`DELETE FROM ${a} WHERE rowid IN (
    SELECT ${a}.rowid FROM ${o}
    LEFT JOIN ${os} ON ${os.orgId} = ${o.id}
    CROSS JOIN ${a}
    WHERE ${a.orgId} = ${o.id} AND ${a.at} < ${now} - COALESCE(${os.auditRetentionDays}, ${DEFAULT_AUDIT_RETENTION_DAYS}) * ${DAY_MS}
    LIMIT ${AUDIT_BATCH})`;
  let deleted = 0;
  for (let i = 0; i < AUDIT_BATCHES; i++) {
    const { meta } = await db.run(batch);
    deleted += meta.changes;
    if (meta.changes < AUDIT_BATCH) break;
  }
  return deleted;
}
