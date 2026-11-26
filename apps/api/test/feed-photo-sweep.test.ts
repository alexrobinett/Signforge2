// The daily feed-photo sweep keeps up with orgs at their photo cap (#481, review of #490): each day it forgets what
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
const CAPS: [string, PhotoBudget][] = [
  ['default', DEFAULT_PHOTO_BUDGET],
  ['demo', { perOrg: 1800, perSource: 300 }],
];

it.for(CAPS)(
  'keeps up with three orgs at the %s cap: what is left after each sweep stays the same, not growing',
  { timeout: 300_000 },
  async ([tag, budget]) => {
    const perDay = budget.perOrg;
    const orgs = await Promise.all([0, 1, 2].map(async (i) => testScope(env.DB, (await seedOrg(env.DB, `sweep-${tag}-${i}`)).orgId)));
    // This case's orgs alone: the cases share the file's database.
    const mine = `(${orgs.map((o) => `'${o.orgId}'`).join(', ')})`;
    let deleted = 0;
    const blobs: PhotoBlobs = { put: async () => undefined, delete: async (keys) => void (deleted += keys.length) };
    const left: Record<number, { due: number; queued: number }> = {};
    for (let day = 0; day < DAYS; day++) {
      // A day at the cap: each photo a file and a thumbnail of its own, never named again after it was made.
      const made = T0 + day * DAY + 9 * HOUR;
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
      const sweepAt = T0 + (day + 1) * DAY + HOUR;
      await sweepFeedPhotos(env.DB, blobs, sweepAt, budget);
      left[day + 1] = {
        due: await count(`SELECT count(*) AS n FROM feed_images WHERE org_id IN ${mine} AND next_check_at < ?`, sweepAt - FEED_IMAGE_TTL_MS),
        queued: await count(`SELECT count(*) AS n FROM feed_image_deletes WHERE org_id IN ${mine}`),
      };
    }
    // A day's rows expire in the 15th sweep after, and their blobs go in the next: from the 16th, each sweep takes one day's.
    expect(left[16]).toEqual({ due: 0, queued: 3 * 2 * perDay });
    for (const day of [17, 18, DAYS]) expect(left[day], `day ${day}`).toEqual(left[16]);
    expect(deleted).toBe((DAYS - 15) * 3 * 2 * perDay);
  },
);
