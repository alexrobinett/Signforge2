// The daily feed-photo sweep keeps up with orgs at their photo cap (#481, review of #490): each day it forgets what
// expired and deletes those blobs, so neither the rows nor the blobs pile up. Run on the test's own clock.
import { FEED_IMAGE_TTL_MS, NEW_PER_ORG_PER_DAY, RECHECK_MS } from '@signforge/db';
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

it('keeps up with three orgs at the cap for 30 days: what is left after each sweep stays the same, not growing', async () => {
  const orgs = await Promise.all([0, 1, 2].map(async (i) => testScope(env.DB, (await seedOrg(env.DB, `sweep-${i}`)).orgId)));
  let deleted = 0;
  const blobs: PhotoBlobs = { put: async () => undefined, delete: async (keys) => void (deleted += keys.length) };
  const left: Record<number, { due: number; queued: number }> = {};
  for (let day = 0; day < 30; day++) {
    // A day at the cap: each photo a file and a thumbnail of its own, never named again after it was made.
    const made = T0 + day * DAY + 9 * HOUR;
    for (const org of orgs)
      for (let k = 0; k < NEW_PER_ORG_PER_DAY; k++) {
        const key = `${org.orgId}-${day}-${k}`;
        await org.feedPhotos.put({
          url: `https://p.example/${key}.jpg`,
          sourceId: 'src',
          fileSha256: `f-${key}`,
          thumbSha256: `t-${key}`,
          nextCheckAt: made + RECHECK_MS,
          createdAt: made,
        });
      }
    const sweepAt = T0 + (day + 1) * DAY + HOUR;
    await sweepFeedPhotos(env.DB, blobs, sweepAt);
    left[day + 1] = {
      due: await count('SELECT count(*) AS n FROM feed_images WHERE next_check_at < ?', sweepAt - FEED_IMAGE_TTL_MS),
      queued: await count('SELECT count(*) AS n FROM feed_image_deletes'),
    };
  }
  // A day's rows expire in the 15th sweep after, and their blobs go in the next: from the 16th, each sweep takes one day's.
  expect(left[20]).toEqual({ due: 0, queued: 3 * 2 * NEW_PER_ORG_PER_DAY });
  expect(left[30]).toEqual(left[20]);
  expect(deleted).toBe(15 * 3 * 2 * NEW_PER_ORG_PER_DAY);
}, 300_000);
