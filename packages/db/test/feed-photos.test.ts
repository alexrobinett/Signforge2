// Feed photos (#329): each race fixed in #195's follow-ups, written as a sequence of the module's
// verbs. D1 is real; a blob store is a Set the deliveries write to and the sweep deletes from.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PHOTO_BUDGET,
  DELETE_LEASE_MS,
  DeleteInFlightError,
  expiredFeedImages,
  FEED_IMAGE_DELETE_GRACE_MS,
  FEED_IMAGE_TTL_MS,
  HOLD_MS,
  pendingFeedImageDeletes,
  type PhotoRead,
  photoRead,
  RECHECK_MS,
} from '../src/index';
import { seedOrg, type SeededOrg, testScope } from '../src/testing';

const NOW = Date.UTC(2026, 10, 23, 9);
const MIN = 60_000;
const sha = (c: string) => c.repeat(64);
const copy = (c: string) => ({ file: sha(c), thumb: sha(c) });
const validators = { etag: null, lastModified: null, validatedFrom: 'https://cdn.example/a.jpg' };

let o: SeededOrg;
let n = 0;
const blobs = new Set<string>();
beforeAll(async () => {
  o = await seedOrg(env.DB, 'feed-photos-races');
});

/** A news source with photos on, as a poll last left it: its feed's ETag, and the photo URL of each story it saw. */
async function news({ photos = true, stories = null as (string | null)[] | null } = {}) {
  const id = `news-${++n}`;
  await o.scope.dataSources.insert({
    id,
    name: id,
    format: 'rss',
    urlEncrypted: 'unused',
    refreshS: 300,
    photos,
    etag: '"feed"',
    photoUrlsJson: stories && JSON.stringify({ stories }),
    nextPollAt: Number.MAX_SAFE_INTEGER,
  });
  return id;
}

const source = async (id: string) => (await o.scope.dataSources.get(id))!;
const snapshot = async (id: string) => JSON.parse((await o.scope.dataSources.snapshot(id))!.dataJson);
/** A poll of `id` starts: it takes its read token from the row it claimed. */
const pollReads = async (id: string, at: number, shown = true) => photoRead(await source(id), shown, at);

/** A poll saves a full read: its stories (with the copies it found), the photo URL of each, and optional URLs to hold. */
function pollSaves(
  id: string,
  read: PhotoRead,
  stories: { url: string | null; image?: { file: string; thumb: string } }[],
  hold?: { again: readonly string[]; fresh: readonly string[] },
) {
  const dataJson = JSON.stringify({ items: stories.map(({ image }, i) => ({ title: `Story ${i}`, ...(image ? { image } : {}) })) });
  const version = `v-${++n}`;
  return o.scope.dataSources.savePoll(id, {
    source: { nextPollAt: read.now + 5 * MIN, failures: 0, lastError: null, etag: '"feed"', lastModified: null },
    snapshot: { version, fetchedAt: read.now, checkedAt: read.now, dataJson },
    photos: { read, stories: { version, urls: stories.map((s) => s.url) }, hold: hold && { ...hold, budget: DEFAULT_PHOTO_BUDGET } },
  });
}

/** A delivery stored new copies of `url`'s photo for `sourceId`. */
const stored = (url: string, sourceId: string, c: string, now: number) =>
  o.scope.feedPhotos.delivered(url, {
    result: 'stored',
    now,
    sourceId,
    sourceSha256: sha(c),
    copy: copy(c),
    validators,
    write: async () => void blobs.add(sha(c)),
  });

/** The sweep deletes these queued hashes' blobs. */
const deleteBlobs = (shas: string[], now: number, during?: () => Promise<void>) =>
  o.scope.feedPhotos.deleteBlobs(shas, now, async (leased) => {
    await during?.();
    for (const h of leased) blobs.delete(h);
  });

describe('a poll and a delivery at once', () => {
  it("keeps the source's reread when a delivery stores its photo while the poll is in flight", async () => {
    const url = 'https://in-flight.test/photo.jpg';
    const id = await news({ stories: [url] });
    await o.scope.feedPhotos.put({ url, sourceId: id, nextCheckAt: NOW + HOLD_MS });
    const read = await pollReads(id, NOW);
    expect((await o.scope.feedPhotos.plan([url], NOW)).copies.size).toBe(0);
    await stored(url, id, 'a', NOW);
    expect((await pollSaves(id, read, [{ url }])).stood).toBe(true);

    expect((await snapshot(id)).items[0].image).toBeUndefined();
    expect(await source(id)).toMatchObject({ etag: null, lastModified: null, nextPollAt: NOW });
    const next = await pollReads(id, NOW + MIN);
    expect((await o.scope.feedPhotos.plan([url], next.now)).copies.get(url)).toEqual(copy('a'));
  });

  it('pulls nextPollAt back on a 304 poll when a delivery stored its photo while the poll was in flight', async () => {
    const url = 'https://in-flight-304.test/photo.jpg';
    const id = await news({ stories: [url] });
    await o.scope.dataSources.putSnapshot(id, { version: 'before', fetchedAt: NOW - MIN, checkedAt: NOW - MIN, dataJson: JSON.stringify({ items: [{}] }) });
    await o.scope.feedPhotos.put({ url, sourceId: id, nextCheckAt: NOW + HOLD_MS });
    const read = await pollReads(id, NOW);
    // Delivery bumps photoGeneration while the 304 poll (which has no `stories` / `changedCopy` and same `rowVersion`) is in flight.
    await stored(url, id, 'q', NOW);
    const saved = await o.scope.dataSources.savePoll(id, {
      source: { nextPollAt: NOW + 5 * MIN, failures: 0, lastError: null },
      checkedAt: NOW,
      photos: { read },
    });
    expect(saved).toEqual({ stood: true, held: [] });
    expect(await source(id)).toMatchObject({ etag: null, lastModified: null, nextPollAt: NOW, photoGeneration: read.generation + 1 });
  });

  it('leaves a reread due when a photo first seen by this poll was stored for another source meanwhile', async () => {
    const url = 'https://first-seen.test/photo.jpg';
    const owner = await news({ stories: [url] });
    const reader = await news();
    await o.scope.feedPhotos.put({ url, sourceId: owner, nextCheckAt: NOW + HOLD_MS });
    const read = await pollReads(reader, NOW);
    // The reader names no photo yet, so the delivery cannot know it uses this one.
    await stored(url, owner, 'b', NOW);
    expect((await pollSaves(reader, read, [{ url }])).stood).toBe(true);

    expect(await source(reader)).toMatchObject({ etag: null, photoGeneration: read.generation, nextPollAt: NOW });
  });

  it('asks again for the story missing its copy on a weekly 304, even when another story already shows the same one', async () => {
    const urls = ['https://same-bytes.test/a.jpg', 'https://same-bytes.test/b.jpg'];
    const id = await news();
    for (const url of urls)
      await o.scope.feedPhotos.put({ url, sourceId: id, sourceSha256: sha('c'), fileSha256: sha('c'), thumbSha256: sha('c'), nextCheckAt: NOW });
    expect(
      (
        await pollSaves(id, await pollReads(id, NOW), [
          { url: urls[0]!, image: copy('c') },
          { url: urls[1]!, image: copy('c') },
        ])
      ).stood,
    ).toBe(true);
    // An older poller left the feed's validators on a snapshot that lost the second story's copy.
    await o.scope.dataSources.putSnapshot(id, {
      version: 'stale',
      fetchedAt: NOW,
      checkedAt: NOW,
      dataJson: JSON.stringify({ items: [{ image: copy('c') }, {}] }),
    });
    const [checked] = await o.scope.feedPhotos.get([urls[1]!]);
    expect((await source(id)).etag).toBe('"feed"');

    await o.scope.feedPhotos.delivered(urls[1]!, { result: 'unchanged', now: NOW, sourceId: id, checked: checked! });
    expect(await source(id)).toMatchObject({ etag: null });
    expect(await o.scope.feedPhotos.get([urls[1]!])).toEqual([expect.objectContaining({ nextCheckAt: NOW + RECHECK_MS })]);
  });

  it('ignores a stale unchanged or failed delivery once another poll moved nextCheckAt on', async () => {
    const url = 'https://stale-next-check.test/photo.jpg';
    const id = await news({ stories: [url] });
    await o.scope.feedPhotos.put({ url, sourceId: id, sourceSha256: sha('x'), fileSha256: sha('x'), thumbSha256: sha('x'), nextCheckAt: NOW });
    const [checked] = await o.scope.feedPhotos.get([url]);
    // A poll holds the row, moving only `nextCheckAt` while `sourceSha256`, `etag` and `lastModified` stay identical.
    const held = await o.scope.dataSources.savePoll(id, {
      source: { nextPollAt: NOW + 5 * MIN, failures: 0, lastError: null },
      checkedAt: NOW,
      photos: { read: await pollReads(id, NOW), hold: { again: [url], fresh: [], budget: DEFAULT_PHOTO_BUDGET } },
    });
    expect(held).toEqual({ stood: true, held: [url] });

    await o.scope.feedPhotos.delivered(url, { result: 'failed', now: NOW + 1, checked: checked!, error: 'timeout', passing: true });
    await o.scope.feedPhotos.delivered(url, { result: 'unchanged', now: NOW + 1, sourceId: id, checked: checked! });
    expect(await o.scope.feedPhotos.get([url])).toEqual([expect.objectContaining({ nextCheckAt: NOW + HOLD_MS, failures: 0, lastError: null })]);
  });

  it('queues every copy displaced by overlapping deliveries, and a repeated delivery queues nothing more', async () => {
    const url = 'https://overlap.test/photo.jpg';
    const id = await news();
    await o.scope.feedPhotos.put({ url, sourceId: id, nextCheckAt: NOW });
    await stored(url, id, 'l', NOW);
    await stored(url, id, 'm', NOW + MIN);
    await stored(url, id, 'p', NOW + MIN);
    const queued = await o.scope.feedPhotos.deletes();
    expect(queued.map((d) => d.sha256)).toEqual([sha('l'), sha('m')]);
    await stored(url, id, 'p', NOW + 2 * MIN);
    expect(await o.scope.feedPhotos.deletes()).toEqual(queued);
    expect(await deleteBlobs([sha('l'), sha('m')], NOW + MIN + FEED_IMAGE_DELETE_GRACE_MS)).toBe(2);
    expect([...blobs].filter((h) => [sha('l'), sha('m'), sha('p')].includes(h))).toEqual([sha('p')]);
  });
});

describe('the photos switch during a poll', () => {
  it("drops a poll's save and holds nothing when Photos is switched off while it is in flight, leaving an unconditional reread due", async () => {
    const url = 'https://switch.test/photo.jpg';
    const fresh = 'https://switch.test/new.jpg';
    const id = await news({ stories: [url] });
    await o.scope.feedPhotos.put({ url, sourceId: id, fileSha256: sha('d'), thumbSha256: sha('d'), nextCheckAt: NOW + RECHECK_MS });
    expect((await pollSaves(id, await pollReads(id, NOW), [{ url, image: copy('d') }])).stood).toBe(true);
    const before = await o.scope.dataSources.snapshot(id);

    const read = await pollReads(id, NOW + 5 * MIN);
    await o.scope.dataSources.update(id, { photos: false });
    expect(await pollSaves(id, read, [{ url, image: copy('d') }], { again: [], fresh: [fresh] })).toEqual({ stood: false, held: [] });

    expect(await o.scope.feedPhotos.get([fresh])).toEqual([]);
    expect(await o.scope.dataSources.snapshot(id)).toEqual(before);
    const after = await source(id);
    expect(after).toMatchObject({ photos: false, etag: null, lastModified: null, photoUrlsJson: null });
    expect(after.nextPollAt).toBeLessThanOrEqual(read.now);
  });

  it('keeps the forced reread after Photos changes off, on, and off during a poll that read it off', async () => {
    const id = await news({ photos: false });
    const read = await pollReads(id, NOW, false);
    await o.scope.dataSources.update(id, { photos: true });
    await o.scope.dataSources.update(id, { photos: false });
    // The setting is as the poll read it, but the source is not.
    expect((await pollSaves(id, read, [{ url: null }])).stood).toBe(false);

    const after = await source(id);
    expect(after).toMatchObject({ photos: false, etag: null, lastModified: null, photoUrlsJson: null });
    expect(after.nextPollAt).toBeLessThanOrEqual(NOW);
    expect(await o.scope.dataSources.snapshot(id)).toBeUndefined();
  });

  it('reads the feed whole once its photos are shown and no story was recorded, and from then on with its validators', async () => {
    const id = await news();
    expect(await pollReads(id, NOW)).toMatchObject({ readWhole: true, lastSeen: [] });
    expect(await pollReads(id, NOW, false)).toMatchObject({ readWhole: false, lastSeen: [] });
    const url = 'https://whole.test/photo.jpg';
    await pollSaves(id, await pollReads(id, NOW), [{ url }, { url: null }, { url }]);
    expect(await pollReads(id, NOW + MIN)).toMatchObject({ readWhole: false, lastSeen: [url] });
  });
});

describe('the sweep and a delivery at once', () => {
  it('keeps a replaced copy and a newly shown one when expiry already scanned their rows', async () => {
    const id = await news();
    const replaced = 'https://expiry-race.test/replaced.jpg';
    const shown = 'https://expiry-race.test/shown.jpg';
    const old = NOW - RECHECK_MS - FEED_IMAGE_TTL_MS - 1;
    await o.scope.feedPhotos.put({ url: replaced, sourceId: id, fileSha256: sha('e'), thumbSha256: sha('e'), nextCheckAt: old });
    await o.scope.feedPhotos.put({ url: shown, sourceId: id, fileSha256: sha('f'), thumbSha256: sha('f'), nextCheckAt: old });
    const scanned = (await expiredFeedImages(env.DB, NOW, 100)).filter((r) => r.orgId === o.orgId).map((r) => r.url);
    expect(scanned).toEqual(expect.arrayContaining([replaced, shown]));

    expect(
      await o.scope.dataSources.savePoll(id, {
        source: { nextPollAt: NOW + 5 * MIN, failures: 0, lastError: null },
        photos: { read: await pollReads(id, NOW), hold: { again: [replaced], fresh: [], budget: DEFAULT_PHOTO_BUDGET } },
      }),
    ).toEqual({ stood: true, held: [replaced] });
    await stored(replaced, id, 'g', NOW);
    await o.scope.dataSources.putSnapshot(id, {
      version: 'shown',
      fetchedAt: NOW,
      checkedAt: NOW,
      dataJson: JSON.stringify({ items: [{ image: copy('f') }] }),
    });
    expect(await o.scope.feedPhotos.expire(scanned, NOW)).toBe(0);

    expect(await o.scope.feedPhotos.get([replaced, shown])).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: replaced, fileSha256: sha('g') }), expect.objectContaining({ url: shown, fileSha256: sha('f') })]),
    );
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).toContain(sha('e'));
  });

  it('keeps a blob queued again or newly shown after the sweep found it due, restarting the grace window for a shown copy', async () => {
    const id = await news();
    const requeued = 'https://claim-race.test/requeued.jpg';
    const at = NOW + FEED_IMAGE_DELETE_GRACE_MS;
    // Two copies, expired and queued for delete.
    for (const [url, c] of [
      [requeued, 'h'],
      ['https://claim-race.test/shown.jpg', 'i'],
    ] as const) {
      blobs.add(sha(c));
      await o.scope.feedPhotos.put({ url, sourceId: id, fileSha256: sha(c), thumbSha256: sha(c), nextCheckAt: NOW - FEED_IMAGE_TTL_MS - 1 });
      await o.scope.feedPhotos.expire([url], NOW);
    }
    const due = (await pendingFeedImageDeletes(env.DB, at, 100)).filter((d) => d.orgId === o.orgId).map((d) => d.sha256);
    expect(due).toEqual(expect.arrayContaining([sha('h'), sha('i')]));

    // Named again and displaced again at `at`, so its grace starts over; and a snapshot shows the other.
    await o.scope.feedPhotos.put({ url: requeued, sourceId: id, nextCheckAt: at });
    await stored(requeued, id, 'h', at - MIN);
    await stored(requeued, id, 'j', at);
    await o.scope.dataSources.putSnapshot(id, {
      version: 'claim-race',
      fetchedAt: at,
      checkedAt: at,
      dataJson: JSON.stringify({ items: [{ image: copy('i') }] }),
    });
    expect(await deleteBlobs([sha('h'), sha('i')], at)).toBe(0);

    for (const c of ['h', 'i']) {
      expect(blobs.has(sha(c))).toBe(true);
      expect(await o.scope.feedPhotos.deletes()).toContainEqual(expect.objectContaining({ sha256: sha(c), queuedAt: at, deletingUntil: 0 }));
    }
    // Even after the snapshot drops sha('i'), its grace window restarted from `at`.
    await o.scope.dataSources.putSnapshot(id, { version: 'claim-race-cleared', fetchedAt: at + 1, checkedAt: at + 1, dataJson: JSON.stringify({ items: [] }) });
    expect(await deleteBlobs([sha('i')], at + FEED_IMAGE_DELETE_GRACE_MS - 1)).toBe(0);
    expect(blobs.has(sha('i'))).toBe(true);
    expect(await deleteBlobs([sha('i')], at + FEED_IMAGE_DELETE_GRACE_MS)).toBe(1);
    expect(blobs.has(sha('i'))).toBe(false);
  });

  it('claims pending deletes before writing blobs so a sweep running during write cannot delete the new blob', async () => {
    const id = await news();
    const gone = 'https://claim-order.test/gone.jpg';
    const again = 'https://claim-order.test/again.jpg';
    await o.scope.feedPhotos.put({ url: gone, sourceId: id, fileSha256: sha('w'), thumbSha256: sha('w'), nextCheckAt: NOW - FEED_IMAGE_TTL_MS - 1 });
    await o.scope.feedPhotos.put({ url: again, sourceId: id, nextCheckAt: NOW });
    await o.scope.feedPhotos.expire([gone], NOW);
    const at = NOW + FEED_IMAGE_DELETE_GRACE_MS;

    await o.scope.feedPhotos.delivered(again, {
      result: 'stored',
      now: at,
      sourceId: id,
      sourceSha256: sha('w'),
      copy: copy('w'),
      validators,
      write: async () => {
        blobs.add(sha('w'));
        expect(await deleteBlobs([sha('w')], at)).toBe(0);
      },
    });
    expect(blobs.has(sha('w'))).toBe(true);
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).not.toContain(sha('w'));
  });

  it('clears a hash queued for delete while a delivery was writing the same copy', async () => {
    const id = await news();
    const expiring = 'https://clear-active.test/expiring.jpg';
    const writer = 'https://clear-active.test/writer.jpg';
    await o.scope.feedPhotos.put({ url: expiring, sourceId: id, fileSha256: sha('y'), thumbSha256: sha('y'), nextCheckAt: NOW - FEED_IMAGE_TTL_MS - 1 });
    await o.scope.feedPhotos.put({ url: writer, sourceId: id, nextCheckAt: NOW });

    await o.scope.feedPhotos.delivered(writer, {
      result: 'stored',
      now: NOW,
      sourceId: id,
      sourceSha256: sha('y'),
      copy: copy('y'),
      validators,
      write: async () => {
        blobs.add(sha('y'));
        // Expiring after `claimForWrite` queues `sha('y')`; `save`'s `clearActive` removes it again.
        expect(await o.scope.feedPhotos.expire([expiring], NOW)).toBe(1);
      },
    });
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).not.toContain(sha('y'));
  });

  it('refuses a delivery storing or reusing a copy whose delete lease the sweep holds, and succeeds once the delete is done', async () => {
    const id = await news();
    const gone = 'https://lease.test/gone.jpg';
    const again = 'https://lease.test/again.jpg';
    const reused = 'https://lease.test/reused.jpg';
    blobs.add(sha('k'));
    await o.scope.feedPhotos.put({ url: gone, sourceId: id, fileSha256: sha('k'), thumbSha256: sha('k'), nextCheckAt: NOW - FEED_IMAGE_TTL_MS - 1 });
    await o.scope.feedPhotos.put({ url: again, sourceId: id, nextCheckAt: NOW });
    await o.scope.feedPhotos.put({ url: reused, sourceId: id, nextCheckAt: NOW });
    await o.scope.feedPhotos.expire([gone], NOW);
    const at = NOW + FEED_IMAGE_DELETE_GRACE_MS;

    let storeRefused: unknown;
    let reuseRefused: unknown;
    expect(
      await deleteBlobs([sha('k')], at, async () => {
        storeRefused = await stored(again, id, 'k', at + MIN).catch((e: unknown) => e);
        reuseRefused = await o.scope.feedPhotos
          .delivered(reused, { result: 'reused', now: at + MIN, sourceId: id, sourceSha256: sha('k'), copy: copy('k'), validators })
          .catch((e: unknown) => e);
      }),
    ).toBe(1);
    expect(storeRefused).toBeInstanceOf(DeleteInFlightError);
    expect(reuseRefused).toBeInstanceOf(DeleteInFlightError);
    expect(blobs.has(sha('k'))).toBe(false);

    // The queue tries again after the delete: stored, and nothing left to delete.
    await stored(again, id, 'k', at + DELETE_LEASE_MS);
    expect(blobs.has(sha('k'))).toBe(true);
    expect((await o.scope.feedPhotos.deletes()).map((d) => d.sha256)).not.toContain(sha('k'));
  });
});

describe("the sweep's lookups (review of #497)", () => {
  it('asks whether a row still names each queued blob on the file and thumbnail indexes, not by reading every row for each', async () => {
    const mine = await seedOrg(env.DB, 'sweep-lookups');
    const scope = testScope(env.DB, mine.orgId);
    const at = 1_000;
    // 2,000 photos still named; 100 forgotten, their 200 blobs queued past their grace.
    await scope.feedPhotos.putMany(
      Array.from({ length: 2100 }, (_, k) => ({
        url: `https://l.example/${k}.jpg`,
        sourceId: 'src',
        fileSha256: `f-${k}`,
        thumbSha256: `t-${k}`,
        nextCheckAt: k < 100 ? at : at + 10 * RECHECK_MS,
        createdAt: at,
      })),
    );
    const due = Array.from({ length: 100 }, (_, k) => `https://l.example/${k}.jpg`);
    const expireAt = at + FEED_IMAGE_TTL_MS + 1;
    expect(await scope.feedPhotos.expire(due, expireAt)).toBe(100);
    const queued = (await scope.feedPhotos.deletes()).map((d) => d.sha256);
    expect(queued).toHaveLength(200);
    const read: number[] = [];
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = async <T = unknown>(q: D1PreparedStatement[]) => {
      const res = await batch<T>(q);
      for (const r of res) read.push(r.meta.rows_read);
      return res;
    };
    try {
      expect(await scope.feedPhotos.deleteBlobs(queued, expireAt + FEED_IMAGE_DELETE_GRACE_MS, async () => undefined)).toBe(200);
    } finally {
      env.DB.batch = batch;
    }
    // A few rows a blob: a scan for each would read 200 × 2,000.
    expect(Math.max(...read)).toBeLessThan(2000);
  });
});
