// The hourly feed-photo sweep keeps up with orgs at their photo cap (#481, review of #490): each day it forgets what
// expired and deletes those blobs, so neither the rows nor the blobs pile up, at today's cap and at the demo's lifted
// one (wrangler.jsonc `env.demo`). Run on the test's own clock.
import { DEFAULT_PHOTO_BUDGET, FEED_IMAGE_TTL_MS, type PhotoBudget, RECHECK_MS } from '@signforge/db';
import { seedOrg, testScope } from '@signforge/db/testing';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { type PhotoBlobs, sweepFeedPhotos } from '../src/data/feed-photos';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2027, 0, 1);

const count = async (sql: string, ...binds: number[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n;

const DAYS = 19;
const CAPS: [string, PhotoBudget, number][] = [
  ['default', DEFAULT_PHOTO_BUDGET, 0],
  // Its own days, after the default case's: the sweep reads across orgs, and the cases share the file's database.
  ['demo', { perOrg: 1800, perSource: 300, queuedPerDay: 2000 }, 60],
];

it.for(CAPS)(
  'keeps up with three orgs at the %s cap, swept every hour: what is left at the end of each day stays the same, not growing',
  { timeout: 300_000 },
  async ([tag, budget, startDay]) => {
    const perDay = budget.perOrg;
    const start = T0 + startDay * DAY;
    const orgs = await Promise.all([0, 1, 2].map(async (i) => testScope(env.DB, (await seedOrg(env.DB, `sweep-${tag}-${i}`)).orgId)));
    const mine = `(${orgs.map((o) => `'${o.orgId}'`).join(', ')})`;
    let deleted = 0;
    const blobs: PhotoBlobs = { put: async () => undefined, delete: async (keys) => void (deleted += keys.length) };
    const left: Record<number, { due: number; queued: number; deleted: number }> = {};
    for (let day = 0; day < DAYS; day++) {
      // A day at the cap: each photo a file and a thumbnail of its own, never named again after it was made.
      const made = start + day * DAY + 9 * HOUR;
      for (const org of orgs)
        await org.feedPhotos.putMany(
          Array.from({ length: perDay }, (_, k) => {
            const key = `${org.orgId}-${day}-${k}`;
            return {
              url: `https://p.example/${key}.jpg`,
              sourceId: 'src',
              fileSha256: `f-${key}`,
              thumbSha256: `t-${key}`,
              nextCheckAt: made + RECHECK_MS,
              createdAt: made,
            };
          }),
        );
      // At half past each hour, as the minute Cron Trigger runs it.
      for (let hour = 0; hour < 24; hour++) await sweepFeedPhotos(env.DB, blobs, start + day * DAY + hour * HOUR + 30 * 60_000);
      const end = start + (day + 1) * DAY;
      left[day + 1] = {
        due: await count(`SELECT count(*) AS n FROM feed_images WHERE org_id IN ${mine} AND next_check_at < ?`, end - FEED_IMAGE_TTL_MS),
        queued: await count(`SELECT count(*) AS n FROM feed_image_deletes WHERE org_id IN ${mine}`),
        deleted,
      };
    }
    // A day's rows are due 14 days after they are made, so from the 16th each day forgets one day's and deletes its blobs.
    for (const day of [17, 18, DAYS]) {
      expect({ ...left[day], deleted: 0 }, `day ${day}`).toEqual({ ...left[16], deleted: 0 });
      expect(left[day]!.deleted - left[day - 1]!.deleted, `day ${day}`).toBe(3 * 2 * perDay);
    }
    // What a day's last runs had no time for, less than a day's, goes in the next morning's.
    expect(left[DAYS]!.due).toBeLessThan(3 * perDay);
  },
);
