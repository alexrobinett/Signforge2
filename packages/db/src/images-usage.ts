/**
 * The month's Images transformations (#500), counted for the environment, not an org: the feed photos' consumer takes what
 * a photo needs before it asks Images, all or none, and stops once a ceiling is reached rather than meet 9422 mid-month.
 * A named exception to org isolation, as ./retention.ts's finders are: the table holds no org's data.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as s from './schema';

const u = s.imagesUsage;

/** The UTC month `now` is in, as the count keys it. */
export const imagesMonth = (now: number) => new Date(now).toISOString().slice(0, 7);

/** The transformations counted for `month`. */
export async function imagesTransformsUsed(d1: D1Database, month: string): Promise<number> {
  const row = await drizzle(d1).select({ transforms: u.transforms }).from(u).where(sql`${u.month} = ${month}`).get();
  return row?.transforms ?? 0;
}

/** Counts `n` more for `month` if they keep it within `ceiling`, in one statement; whether they were. */
export async function takeImagesTransforms(d1: D1Database, month: string, n: number, ceiling: number): Promise<boolean> {
  const rows = await drizzle(d1).all<{ transforms: number }>(sql`INSERT INTO ${u} (month, transforms) SELECT ${month}, ${n} WHERE ${n} <= ${ceiling}
    ON CONFLICT (month) DO UPDATE SET transforms = transforms + excluded.transforms WHERE transforms + excluded.transforms <= ${ceiling}
    RETURNING transforms`);
  return rows.length > 0;
}
