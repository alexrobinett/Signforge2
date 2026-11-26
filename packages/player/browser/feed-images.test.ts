// Feed images end-to-end in the real browser player (#196):
// - a snapshot with images plays them (lead and thumb via data-sf-src on rows)
// - a missing blob means no image (never an empty frame or spot failure)
// - eviction after the snapshot moves on
// - offline replay with pinned images
// - each pin on its own: a held snapshot's, and the spot on screen's
// - cleanup while falling back keeps the synced manifest's files
// - images still arrive while the manifest cannot be fetched
// - falling back, only the photos of the manifest playing are fetched, and an adoption keeps every waiting snapshot's
// - editor preview shows snapshot images and tolerates missing blobs
// - the shipped news (2.0) plays the feed's photos, a story without one with its initial
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buildTemplate } from '@signforge/template-build';
import { MANIFEST_SCHEMA, MIN_REFRESH_S, manifestIdInput, templateKey, type DataSnapshot, type ScreenManifest } from '@signforge/contract';
import type { Frame } from 'playwright';
import { describe, expect, inject, it } from 'vitest';
import type { Content } from './content';
import type { FixtureServer } from './fixture-server';
import { png, useHarness, visibleFrame, type Player } from './harness';

const h = useHarness();
const CMS = inject('cmsOrigin');
const api = (s: FixtureServer) => ({ content: `${s.localUrl}/content` });

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const cached = (p: Player) => p.page.evaluate(async () => (await (await caches.open('sf-blobs-v1')).keys()).map((r) => new URL(r.url).pathname));

interface RowView {
  title: string;
  hasImage: boolean;
  lead: { src: boolean; hidden: boolean; w: number; h: number };
  thumb: { src: boolean; hidden: boolean; w: number; h: number };
}

const NO_IMG = { src: false, hidden: true, w: 0, h: 0 };
const rowView = (title: string, lead?: [number, number], thumb?: [number, number]): RowView => ({
  title,
  hasImage: Boolean(lead && thumb),
  lead: lead ? { src: true, hidden: false, w: lead[0], h: lead[1] } : NO_IMG,
  thumb: thumb ? { src: true, hidden: false, w: thumb[0], h: thumb[1] } : NO_IMG,
});

/** Read the `#rows` list rendered inside a fixture template frame. */
async function readRows(frame: Frame): Promise<RowView[] | undefined> {
  return frame
    .evaluate(() => {
      const list = document.getElementById('rows');
      if (!list) return undefined;
      return [...list.querySelectorAll('li')].map((li) => {
        const lead = li.querySelector<HTMLImageElement>('img.lead')!;
        const thumb = li.querySelector<HTMLImageElement>('img.thumb')!;
        const info = (img: HTMLImageElement) => ({ src: img.hasAttribute('src'), hidden: img.hidden === true, w: img.naturalWidth, h: img.naturalHeight });
        return { title: li.querySelector('[data-sf="title"]')?.textContent ?? '', hasImage: li.dataset.hasImage === '1', lead: info(lead), thumb: info(thumb) };
      });
    })
    .catch(() => undefined);
}

/** Read `#rows` from the currently visible slot. */
async function onScreenRows(p: Player): Promise<RowView[] | undefined> {
  const frame = await visibleFrame(p.page, 'rows');
  return frame ? readRows(frame) : undefined;
}

const newsSpot = () =>
  h.content([
    {
      id: 'news',
      durationMs: 600,
      items: [{ title: 'Fallback' }],
      bindings: { items: { source: 'news', path: 'items' } },
    },
  ]);

const makeSnap = (version: number, items: unknown[]): DataSnapshot => ({
  id: 'news',
  version,
  fetchedAt: new Date(version).toISOString(),
  checkedAt: new Date().toISOString(),
  data: { title: 'News', language: 'en', items },
});

/**
 * A JPEG cut short where its image data starts: every header whole, as a pass-through photo whose
 * fetch ended early could be. Chromium refuses to decode it (one cut inside the data decodes in part).
 */
const TRUNCATED_JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAYACADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAEC/8QAJBAAAgICAgEDBQAAAAAAAAAAAQIDBBESABMhIjFxIyRBQ3T/xAAWAQEBAQAAAAAAAAAAAAAAAAABAgD/xAAqEQABAgMFBwUAAAAAAAAAAAABAhEAMUEDEiFRgSJSYXGi4fATQpGxwQ==',
  'base64',
);

/** Two stories' photos, a lead and a thumbnail each: `shas` are `images`' hashes, in order (f1, t1, f2, t2). */
const twoPhotos = () => {
  const images = [png(12, 8, 200), png(4, 3, 180), png(10, 6, 90), png(5, 4, 70)];
  return { images, shas: images.map((b) => sha256(b)) as [string, string, string, string] };
};

/** Serves `images` as feed blobs, then the news snapshot at `version`. */
function feed(s: FixtureServer, version: number, items: unknown[], images: Buffer[]) {
  for (const b of images) s.setFeedBlob(sha256(b), b);
  s.setData('news', makeSnap(version, items));
}

describe('feed images on screens (#196)', () => {
  it('plays snapshot images via data-sf-src on rows, handles a missing blob with no image, evicts after moving on, and replays offline', async () => {
    const lead1 = png(12, 8, 200);
    const thumb1 = png(4, 3, 180);
    const lead2 = png(10, 6, 90);
    const thumb2 = png(5, 4, 70);
    const missingSha = '0'.repeat(64);

    const f1 = sha256(lead1);
    const t1 = sha256(thumb1);
    const f2 = sha256(lead2);
    const t2 = sha256(thumb2);

    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(newsSpot());
      s.setFeedBlob(f1, lead1, 'image/png');
      s.setFeedBlob(t1, thumb1, 'image/png');
      // Story 2 names missingSha, which is NOT served (404): must play as a story with no image.
      s.setData(
        'news',
        makeSnap(1000, [
          { title: 'Photo story', image: { file: f1, thumb: t1 } },
          { title: 'Missing blob story', image: { file: missingSha, thumb: missingSha } },
          { title: 'Text story' },
        ]),
      );
    }, api);

    await expect
      .poll(() => onScreenRows(p), { timeout: 10_000 })
      .toEqual([rowView('Photo story', [12, 8], [4, 3]), rowView('Missing blob story'), rowView('Text story')]);
    expect((await p.state()).skipped).toBe(0);

    // Sync reports the held feed blobs, and the server stops asking for them.
    await expect.poll(() => p.server.syncs.at(-1)?.blobs?.slice().sort(), { timeout: 10_000 }).toEqual([f1, t1].sort());
    expect(await cached(p)).toEqual(expect.arrayContaining([`/_sf/blob/${f1}`, `/_sf/blob/${t1}`]));

    // Snapshot moves on to v2 (with new photo f2/t2): v1's blobs are evicted once no spot holds them, and v2 plays.
    p.server.setFeedBlob(f2, lead2, 'image/png');
    p.server.setFeedBlob(t2, thumb2, 'image/png');
    p.server.setData('news', makeSnap(2000, [{ title: 'Next story', image: { file: f2, thumb: t2 } }]));

    const nextExpected = [rowView('Next story', [10, 6], [5, 4])];
    await expect.poll(() => onScreenRows(p), { timeout: 10_000 }).toEqual(nextExpected);
    await expect.poll(() => cached(p), { timeout: 10_000 }).not.toContain(`/_sf/blob/${f1}`);
    expect(await cached(p)).not.toContain(`/_sf/blob/${t1}`);
    expect(await cached(p)).toEqual(expect.arrayContaining([`/_sf/blob/${f2}`, `/_sf/blob/${t2}`]));

    // Offline replay with pinned images: cut the network completely and reload the player.
    p.server.intercept(/^\/content\//, { status: 503 });
    await p.page.reload();
    await expect.poll(() => onScreenRows(p), { timeout: 10_000 }).toEqual(nextExpected);
    expect((await p.state()).skipped).toBe(0);
  }, 30_000);

  /** The feed images the last sync reported holding, sorted. */
  const reported = (p: Player) => p.server.syncs.at(-1)?.blobs?.slice().sort();
  /** GETs of a file (not the CORS preflight the device credential brings). */
  const requestsFor = (p: Player, sha: string) => p.server.requestsTo(new RegExp(`^/content/blobs/${sha}$`)).filter((r) => r.status !== 204);
  const photo = (title: string, file: string, thumb: string) => ({ title, image: { file, thumb } });
  const bound = { items: { source: 'news', path: 'items' } };
  /** A player on `spots`, its news snapshot one story with the first photo. */
  const withOnePhoto = (spots: Parameters<typeof h.content>[0], [f1, t1]: string[], images: Buffer[]) =>
    h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(h.content(spots));
      feed(s, 1000, [photo('One', f1!, t1!)], images.slice(0, 2));
    }, api);

  it('keeps the images of a held snapshot while no spot on screen or loading uses them (the snapshots pin)', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1, f2, t2] = shas;
    // `other` stays on screen throughout: `news`, the only spot to use the images, never loads.
    const p = await withOnePhoto(
      [
        { id: 'other', durationMs: 600_000 },
        { id: 'news', durationMs: 600, items: [{ title: 'Fallback' }], bindings: bound },
      ],
      shas,
      images,
    );
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f1, t1].sort());

    // A second photo story: its pass cleans up before it fetches f2 and t2, and f1 and t1 have only their snapshot to keep them.
    feed(p.server, 2000, [photo('One', f1, t1), photo('Two', f2, t2)], images.slice(2));
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f1, t1, f2, t2].sort());
    // Never deleted and fetched again.
    expect(requestsFor(p, f1)).toHaveLength(1);
    expect(requestsFor(p, t1)).toHaveLength(1);
    const s = await p.state();
    expect(s.spot).toBe('other');
    expect(s.log.map((l) => l.spot)).toEqual(['other']);
  }, 30_000);

  it('keeps the images of the spot on screen after its snapshot moves on (the playing pin)', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1, f2, t2] = shas;
    const p = await withOnePhoto([{ id: 'news', durationMs: 600_000, items: [{ title: 'Fallback' }], bindings: bound }], shas, images);
    await expect.poll(() => onScreenRows(p), { timeout: 10_000 }).toEqual([rowView('One', [12, 8], [4, 3])]);

    // The snapshot drops f1 and t1 while they are on screen. The pass that fetches f2 and t2 cleans up first.
    feed(p.server, 2000, [photo('Two', f2, t2)], images.slice(2));
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f2, t2].sort());
    expect(await cached(p)).toEqual(expect.arrayContaining([`/_sf/blob/${f1}`, `/_sf/blob/${t1}`]));
    expect(await onScreenRows(p)).toEqual([rowView('One', [12, 8], [4, 3])]);
  }, 30_000);

  /** A player that played a manifest whose one spot binds `news`, then fell back to it from `broken`. */
  async function fallenBack(broken: Content, first?: (p: Player) => Promise<void>) {
    const good = h.content([{ id: 'news', durationMs: 600, items: [{ title: 'Fallback' }], bindings: bound }], { variant: 'good' });
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(good);
    }, api);
    await p.until((s) => s.lastGood === good.manifest.id);
    await first?.(p);
    p.server.publish(broken);
    await p.until((s) => s.fallback === broken.manifest.id && s.manifestId === good.manifest.id);
    return p;
  }

  it('keeps the files of the manifest it falls back from when feed images come', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1] = shas;
    const asset = randomBytes(4096);
    // Bound to the same source, so the server sends its images while the screen falls back from it.
    const broken = h.content([{ id: 'x', mode: 'throw', asset, durationMs: 600, bindings: bound }], { variant: 'broken' });
    const p = await fallenBack(broken);

    feed(p.server, 1000, [photo('One', f1, t1)], images.slice(0, 2));
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f1, t1].sort());
    // The pass cleaned up against the synced manifest, not the one playing: its file was neither deleted nor fetched again.
    expect(await cached(p)).toContain(`/_sf/blob/${sha256(asset)}`);
    expect(requestsFor(p, sha256(asset))).toHaveLength(1);
    expect((await p.state()).fallback).toBe(broken.manifest.id);
  }, 30_000);

  // While it falls back, the screen plays the last good manifest until a newer publish (#460).
  it('fetches only the photos of the manifest it falls back to, none of the one it fell back from', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1, f2, t2] = shas;
    // The broken one binds `news2` too, which the good one does not: its photos would be fetched and evicted at every sync.
    const broken = h.content(
      [
        { id: 'x', mode: 'throw', durationMs: 600, bindings: bound },
        { id: 'y', mode: 'throw', durationMs: 600, bindings: { items: { source: 'news2', path: 'items' } } },
      ],
      { variant: 'broken' },
    );
    const p = await fallenBack(broken);

    feed(p.server, 1000, [photo('One', f1, t1)], images);
    p.server.setData('news2', { ...makeSnap(1000, [photo('Two', f2, t2)]), id: 'news2' });
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f1, t1].sort());
    // Two more syncs the player has finished with, each naming news2's photos.
    const { syncs } = await p.state();
    await p.until((s) => s.syncs > syncs + 1);
    expect(requestsFor(p, f2)).toEqual([]);
    expect(requestsFor(p, t2)).toEqual([]);
  }, 30_000);

  // Two snapshots refused for the manifest playing wait for the next; adopting it stores them one by one, and the
  // cleanup after the adoption waits for both, or the second one's photos would be evicted and fetched again (#460).
  it('keeps the photos of every snapshot waiting for the manifest it adopts', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1, f2, t2] = shas;
    const stories = (source: string) => ({ items: { source, path: 'stories' } });
    const snap = (id: string, title: string, file: string, thumb: string) => ({
      id,
      version: 1000,
      fetchedAt: new Date(1000).toISOString(),
      checkedAt: new Date().toISOString(),
      data: { stories: [photo(title, file, thumb)] },
    });
    // The first manifest binds `items`, which the snapshots do not have: both are refused for it and wait.
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(
        h.content([
          { id: 'news', durationMs: 600, items: [{ title: 'Fallback' }], bindings: bound },
          { id: 'news2', durationMs: 600, items: [{ title: 'Fallback' }], bindings: { items: { source: 'news2', path: 'items' } } },
        ]),
      );
    }, api);
    await p.until((s) => s.played >= 1);
    const failing = p.server.intercept(/^\/content\/manifest\.json$/, { status: 503 });
    const next = h.content(
      [
        { id: 'news', durationMs: 600, items: [{ title: 'Fallback' }], bindings: stories('news') },
        { id: 'news2', durationMs: 600, items: [{ title: 'Fallback' }], bindings: stories('news2') },
      ],
      { variant: 'stories' },
    );
    p.server.publish(next);
    for (const b of images) p.server.setFeedBlob(sha256(b), b);
    p.server.setData('news', snap('news', 'One', f1, t1));
    p.server.setData('news2', snap('news2', 'Two', f2, t2));
    await expect.poll(() => cached(p), { timeout: 10_000 }).toEqual(expect.arrayContaining(shas.map((sha) => `/_sf/blob/${sha}`)));
    // Storing the first waiting snapshot is held until the test lets it go, so the second is not stored meanwhile.
    await p.page.evaluate(() => {
      const put = Cache.prototype.put;
      let release = () => {};
      const held = new Promise<void>((r) => (release = r));
      Reflect.set(window, 'sfReleaseStore', release);
      Cache.prototype.put = function (request, response) {
        const url = request instanceof Request ? request.url : String(request);
        return url.endsWith('/_sf/data/news') ? held.then(() => put.call(this, request, response)) : put.call(this, request, response);
      };
    });
    failing();
    await p.until((s) => s.manifestId === next.manifest.id);
    // A sync the player has finished with after the adoption, then the store goes on.
    const { syncs } = await p.state();
    await p.until((s) => s.syncs > syncs);
    await p.page.evaluate(() => {
      const release: unknown = Reflect.get(window, 'sfReleaseStore');
      if (typeof release === 'function') release();
    });
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([...shas].sort());
    // Never evicted and fetched again.
    for (const sha of shas) expect(requestsFor(p, sha), sha).toHaveLength(1);
  }, 40_000);

  // Restarted while falling back, its last good manifest's photos are kept, not deleted and fetched again (#464).
  it('keeps the photos of the manifest it falls back to across a restart', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1] = shas;
    // A spot that never gets ready: after the restart, the first sync's cleanup runs before the player falls back again.
    const broken = h.content([{ id: 'y', mode: 'hang', durationMs: 600, bindings: { items: { source: 'news2', path: 'items' } } }], { variant: 'broken' });
    // Its photos come while the good one is the one synced: the broken one binds another feed.
    const p = await fallenBack(broken, async (p) => {
      feed(p.server, 1000, [photo('One', f1, t1)], images.slice(0, 2));
      await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f1, t1].sort());
    });
    await p.page.reload();
    await p.until((s) => s.fallback === broken.manifest.id && s.syncs > 1, 20_000);
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f1, t1].sort());
    for (const sha of [f1, t1]) expect(requestsFor(p, sha), sha).toHaveLength(1);
  }, 40_000);

  // A broken image would show where the photo was: the row goes without one instead (review of #240).
  it('plays a story whose photo cannot be decoded as one with no image', async () => {
    const [f, t] = [sha256(TRUNCATED_JPEG), sha256(Buffer.concat([TRUNCATED_JPEG, Buffer.from([0])]))];
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(newsSpot());
      s.setFeedBlob(f, TRUNCATED_JPEG, 'image/jpeg');
      s.setFeedBlob(t, Buffer.concat([TRUNCATED_JPEG, Buffer.from([0])]), 'image/jpeg');
      s.setData('news', makeSnap(1000, [photo('Cut short', f, t), { title: 'Text story' }]));
    }, api);
    // Its photo arrived (the row has one), but neither of its images draws.
    await expect.poll(() => onScreenRows(p), { timeout: 10_000 }).toEqual([{ ...rowView('Cut short'), hasImage: true }, rowView('Text story')]);
    expect((await p.state()).skipped).toBe(0);
  }, 30_000);

  // The images of a manifest not yet adopted are pinned until it is: the cleanup that adopts it must not take them
  // (review of #240). The server would send them again on a later sync, so syncs stop once they are sent.
  it('keeps the images a sync sent for a manifest it cannot fetch yet, until that manifest is in', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1] = shas;
    // On screen: a manifest that binds no feed, so no snapshot of the one on screen names these images.
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(h.content([{ id: 'other', durationMs: 600 }]));
    }, api);
    await p.until((s) => s.played >= 1);
    const failing = p.server.intercept(/^\/content\/manifest\.json$/, { status: 503 });
    p.server.nextSyncS = 600;
    p.server.publish(h.content([{ id: 'news', durationMs: 600_000, items: [{ title: 'Fallback' }], bindings: bound }], { variant: 'news' }));
    feed(p.server, 1000, [photo('One', f1, t1)], images.slice(0, 2));
    // Fetched while the manifest is not: in the cache, though not reported, as a screen reports only its own manifests'.
    await expect.poll(() => cached(p), { timeout: 10_000 }).toEqual(expect.arrayContaining([`/_sf/blob/${f1}`, `/_sf/blob/${t1}`]));
    const syncs = p.server.syncs.length;
    failing();
    await expect.poll(async () => (await p.state()).spot, { timeout: 20_000 }).toBe('news');
    expect(p.server.syncs).toHaveLength(syncs);
    await expect.poll(() => onScreenRows(p), { timeout: 10_000 }).toEqual([rowView('One', [12, 8], [4, 3])]);
    for (const sha of [f1, t1]) expect(requestsFor(p, sha), sha).toHaveLength(1);
  }, 40_000);

  // And the pin goes once that manifest is in (review of #240, round 2): photos it does not name, or a later snapshot
  // drops, are evicted like any other.
  describe('once the manifest the images came for is in', () => {
    /** A player on a feedless manifest whose next one's images arrive while it cannot be fetched. */
    async function sentWhileFailing(
      spots: Parameters<typeof h.content>[0] = [{ id: 'news', durationMs: 600, items: [{ title: 'Fallback' }], bindings: bound }],
    ) {
      const { images, shas } = twoPhotos();
      const [f1, t1] = shas;
      const p = await h.openPlayer((s) => {
        s.nextSyncS = 1;
        s.publish(h.content([{ id: 'other', durationMs: 600 }]));
      }, api);
      await p.until((s) => s.played >= 1);
      const failing = p.server.intercept(/^\/content\/manifest\.json$/, { status: 503 });
      p.server.publish(h.content(spots, { variant: 'news' }));
      feed(p.server, 1000, [photo('One', f1, t1)], images.slice(0, 2));
      await expect.poll(() => cached(p), { timeout: 10_000 }).toEqual(expect.arrayContaining([`/_sf/blob/${f1}`, `/_sf/blob/${t1}`]));
      return { p, f1, t1, failing };
    }
    const gone = (p: Player, ...shas: string[]) =>
      expect.poll(async () => (await cached(p)).filter((k) => shas.some((sha) => k.endsWith(sha))), { timeout: 15_000 }).toEqual([]);

    it('lets go of those a newer snapshot dropped while the manifest is still on its way (#464)', async () => {
      const { p, f1, t1 } = await sentWhileFailing();
      const { images, shas } = twoPhotos();
      const [, , f2, t2] = shas;
      feed(p.server, 2000, [photo('Two', f2, t2)], images.slice(2));
      await expect.poll(() => cached(p), { timeout: 10_000 }).toEqual(expect.arrayContaining([`/_sf/blob/${f2}`, `/_sf/blob/${t2}`]));
      await gone(p, f1, t1);
    }, 40_000);

    it('evicts them when it recovers onto a manifest that does not name them', async () => {
      const { p, f1, t1, failing } = await sentWhileFailing();
      const other = h.content([{ id: 'other', durationMs: 600 }], { variant: 'other' });
      p.server.publish(other);
      failing();
      await p.until((s) => s.manifestId === other.manifest.id);
      await gone(p, f1, t1);
    }, 40_000);

    it('evicts them when it recovers onto the manifest that names them, and a later snapshot drops them', async () => {
      // Another spot stays on screen: when the snapshot drops the images, nothing on screen or loading holds them, and the
      // first pass after evicts them.
      const { p, f1, t1, failing } = await sentWhileFailing([
        { id: 'news', durationMs: 600, items: [{ title: 'Fallback' }], bindings: bound },
        { id: 'still', durationMs: 600_000 },
      ]);
      // No sync while it recovers: one would send the images again, and its pass let the pin go anyway.
      p.server.nextSyncS = 600;
      const syncs = p.server.syncs.length;
      await expect.poll(() => p.server.syncs.length, { timeout: 10_000 }).toBeGreaterThan(syncs);
      failing();
      await p.until((s) => s.spot === 'still');
      expect(await cached(p)).toEqual(expect.arrayContaining([`/_sf/blob/${f1}`, `/_sf/blob/${t1}`]));
      // The snapshot drops them, and a nudge brings it: its pass evicts them.
      p.server.setData('news', makeSnap(2000, [{ title: 'Text only' }]));
      p.server.push({ type: 'manifest', id: 'nudge' });
      await gone(p, f1, t1);
    }, 40_000);
  });

  it('fetches feed images while the manifest cannot be fetched', async () => {
    const { images, shas } = twoPhotos();
    const [f1, t1] = shas;
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(newsSpot());
    }, api);
    await p.until((s) => s.played >= 1);
    p.server.intercept(/^\/content\/manifest\.json$/, { status: 503 });
    feed(p.server, 1000, [photo('One', f1, t1)], images.slice(0, 2));
    // Restarted, the first sync asks for the manifest's files to be checked, and that keeps failing.
    await p.page.reload();
    await expect.poll(() => reported(p), { timeout: 10_000 }).toEqual([f1, t1].sort());
    expect(p.server.requestsTo(/^\/content\/manifest\.json$/).at(-1)?.status).toBe(503);
  }, 30_000);

  it('shows snapshot images in editor preview and tolerates a missing blob without failing the preview', async () => {
    const server = await h.playerServer();
    const page = await h.blankPage();
    const lead = png(14, 9, 160);
    const thumb = png(6, 4, 140);
    const f1 = sha256(lead);
    const t1 = sha256(thumb);
    const missing = '0'.repeat(64);
    const c: Content = h.content([{ id: 'draft', durationMs: 60_000, items: [{ title: 'Fallback' }], bindings: { items: { source: 'news', path: 'items' } } }]);
    const allBlobs = new Map<string, Buffer>([...c.blobs, [f1, lead], [t1, thumb]]);

    await page.context().route(/^http:\/\/cms\.test\//, (route) => {
      const url = new URL(route.request().url());
      const m = /^\/api\/blobs\/v2\/([0-9a-f]{64})$/.exec(url.pathname);
      if (m) {
        const body = allBlobs.get(m[1]!);
        const cors = { 'access-control-allow-origin': server.url, 'access-control-allow-credentials': 'true' };
        return body ? route.fulfill({ status: 200, body, headers: { ...cors, 'content-type': 'image/png' } }) : route.fulfill({ status: 404, headers: cors });
      }
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>editor</title><body style="margin:0">' });
    });

    await page.goto(`${CMS}/editor`);
    await page.evaluate((src) => {
      const w = window as unknown as { msgs: unknown[] };
      w.msgs = [];
      const frame = Object.assign(document.createElement('iframe'), { name: 'player', src });
      frame.style.cssText = 'width:960px;height:540px;border:0';
      window.addEventListener('message', (ev) => ev.source === frame.contentWindow && w.msgs.push(ev.data));
      document.body.append(frame);
    }, `${server.url}/?source=preview`);
    await expect.poll(() => page.evaluate(() => (window as unknown as { msgs: unknown[] }).msgs)).toContainEqual({ sfPreview: 1, type: 'listening' });

    const snap = makeSnap(1000, [
      { title: 'Preview photo', image: { file: f1, thumb: t1 } },
      { title: 'Preview missing', image: { file: missing, thumb: missing } },
    ]);
    await page.evaluate(
      ({ manifest, data }) => {
        (document.querySelector('iframe[name=player]') as HTMLIFrameElement).contentWindow!.postMessage({ sfPreview: 1, type: 'draft', manifest, data }, '*');
      },
      { manifest: c.manifest, data: [snap] },
    );

    const playerFrame = (): Frame => page.frames().find((f) => f.url().startsWith(server.url))!;
    const previewRows = async () => {
      for (const wrapper of playerFrame().childFrames()) {
        const inner = wrapper.childFrames()[0];
        const rows = inner ? await readRows(inner) : undefined;
        if (rows) return rows;
      }
      return undefined;
    };

    await expect.poll(previewRows, { timeout: 10_000 }).toEqual([rowView('Preview photo', [14, 9], [6, 4]), rowView('Preview missing')]);
    const msgs = await page.evaluate(() => (window as unknown as { msgs: { type: string }[] }).msgs);
    expect(msgs.some((m) => m.type === 'error')).toBe(false);
  }, 30_000);

  it("plays the shipped news template with the feed's photos, a story without one with its initial", async () => {
    const built = await buildTemplate(resolve(import.meta.dirname, '../../../templates/news'));
    const htmlBuf = Buffer.from(built.html);
    const htmlSha = sha256(htmlBuf);
    const key = templateKey(built.manifest);
    const [lead, thumb] = [png(32, 18, 200), png(16, 9, 120)];
    const body: Omit<ScreenManifest, 'id'> = {
      schema: MANIFEST_SCHEMA,
      generatedAt: new Date().toISOString(),
      screen: { id: 'test-screen', name: 'Test', timezone: 'UTC', orientation: 'landscape' },
      files: { [htmlSha]: { size: htmlBuf.byteLength, type: 'text/html' } },
      templates: { [key]: { manifest: built.manifest, html: htmlSha } },
      spots: {
        news: {
          id: 'news',
          name: 'News',
          kind: 'template',
          template: key,
          durationMs: 10_000,
          data: {
            title: 'Headlines',
            source: '',
            items: [],
            language: '',
            rotationSeconds: 30,
            look: 'pop',
            showImages: true,
            showSummary: true,
            showList: true,
            showMeta: true,
            showCrawl: true,
          },
          assets: {},
          bindings: { items: { source: 'feed', path: 'items' }, language: { source: 'feed', path: 'language' } },
        },
      },
      playlists: { main: { id: 'main', name: 'Main', transition: { type: 'cut' }, items: [{ spot: 'news' }] } },
      dataSources: { feed: { id: 'feed', refreshS: MIN_REFRESH_S } },
      schedule: [],
      defaultPlaylist: 'main',
    };
    const manifest: ScreenManifest = { ...body, id: sha256(manifestIdInput(body)) };
    const content: Content = { manifest, blobs: new Map([[htmlSha, htmlBuf]]) };

    const p = await h.openPlayer((s) => {
      s.publish(content);
      s.setFeedBlob(sha256(lead), lead);
      s.setFeedBlob(sha256(thumb), thumb);
      s.setData('feed', {
        id: 'feed',
        version: 1000,
        fetchedAt: new Date(1000).toISOString(),
        checkedAt: new Date().toISOString(),
        data: {
          title: 'NPR',
          language: 'en-US',
          items: [
            { title: 'Lead story with photo', published: new Date().toISOString(), source: 'NPR', image: { file: sha256(lead), thumb: sha256(thumb) } },
            { title: 'Second headline', published: new Date().toISOString(), source: 'NPR' },
          ],
        },
      });
    }, api);

    await p.until((s) => s.played >= 1);
    expect((await p.state()).skipped).toBe(0);
    expect((await p.state()).dataRejected).toEqual({});
    const shown = async () => {
      const frame = await visibleFrame(p.page, 'leads');
      return frame?.evaluate(() => ({
        lead: document.querySelector('.headline')!.textContent,
        photo: document.querySelector<HTMLImageElement>('.story .photo')?.naturalWidth ?? 0,
        thumbs: [...document.querySelectorAll('.row')].map(
          (r) => r.querySelector<HTMLImageElement>('img')?.naturalWidth ?? r.querySelector('.initial')!.textContent,
        ),
      }));
    };
    await expect.poll(shown, { timeout: 10_000 }).toEqual({ lead: 'Lead story with photo', photo: 32, thumbs: [16, 'N'] });
    // Each photo fetched once.
    for (const sha of [sha256(lead), sha256(thumb)]) expect(requestsFor(p, sha), sha).toHaveLength(1);
  }, 30_000);
});
