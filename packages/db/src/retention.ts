/**
 * Retention (F13): a cross-org delete by age, run daily from the API's Cron Trigger. It reads no
 * row and names no org; the audit log's retention waits on the owner choosing a period.
 */
import { lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';

/** A retry this long after the call gets no stored answer: about 7 days, as the review asked. */
const IDEMPOTENCY_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Delete every org's idempotency keys older than the TTL at `now`. */
export async function expireIdempotencyKeys(d1: D1Database, now: number): Promise<void> {
  await drizzle(d1)
    .delete(s.idempotencyKeys)
    .where(lt(s.idempotencyKeys.createdAt, now - IDEMPOTENCY_KEY_TTL_MS));
}
