import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { Spot } from '@signforge/contract';
import { TEMPLATE_KEY, type Content, type FixtureSpot } from './content';
import { png, spotsPlayed, useHarness, visibleFrame, type Player } from './harness';

const h = useHarness();
const BLOBS = /^\/content\/blobs\//;

/** The hash of spot `id`'s own file. */
const assetOf = (c: Content, id: string) => (c.manifest.spots[id] as Extract<Spot, { kind: 'template' }>).assets.file!;
/** The hash of the content's template bundle. */
const bundleOf = (c: Content) => c.manifest.templates[TEMPLATE_KEY]!.html;
/** The comments in the template document on screen: a content `variant` marks its bundle with one. */
const onScreenComments = async (p: Player) => {
  const frame = await visibleFrame(p.page, 'label');
  return frame?.evaluate(() => {
    const walk = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    const found: string[] = [];
    while (walk.nextNode()) found.push(walk.currentNode.textContent?.trim() ?? '');
    return found;
  });
};

/**
 * The player on `content`, counting each read of a file out of its file cache, the only reads of a
 * bundle (`readsOf`), in order (`readOrder`). `more` sets the page up further before it opens.
 */
const openCountingReads = (content: Content, more?: (page: Page) => Promise<unknown>) =>
  h.openPlayer(
    (s) => s.publish(content),
    {},
    {
      before: async (page) => {
        await page.addInitScript(() => {
          const reads: Record<string, number> = {};
          const order: string[] = [];
          Object.assign(window, { sfReads: reads, sfOrder: order });
          const match = Cache.prototype.match;
          Cache.prototype.match = function (request, options) {
            const url = typeof request === 'string' ? request : request instanceof Request ? request.url : String(request);
            reads[url] = (reads[url] ?? 0) + 1;
            order.push(url);
            return match.call(this, request, options);
          };
        });
        await more?.(page);
      },
    },
  );
/** How often the player read the file `sha` from its file cache (not a download's partial copy, which ends in its hash too). */
const readsOf = (p: Player, sha: string) =>
  p.page.evaluate(
    (sha) =>
      Object.entries((window as unknown as { sfReads: Record<string, number> }).sfReads)
        .filter(([url]) => url.endsWith(`/_sf/blob/${sha}`))
        .reduce((n, [, c]) => n + c, 0),
    sha,
  );
/** The order the player first read each of `shas` in. */
const readOrder = async (p: Player, shas: string[]) => {
  const order = await p.page.evaluate(() => (window as unknown as { sfOrder: string[] }).sfOrder);
  return [...new Set(order.flatMap((url) => shas.filter((sha) => url.endsWith(`/_sf/blob/${sha}`))))];
};

/**
 * Content where spot `a` has the fixture's bundle and each of `ids` a spot of its own bundle (a template
 * `<id>/fixture@1.0.0`), added in that order; `playlist` lists the spots that play, `extra` more spots.
 * Returns each spot's bundle hash too.
 */
function ownBundles(ids: string[], playlist: string[], { durationMs = 600, extra = [] as FixtureSpot[] } = {}) {
  const own = ids.map((id) => {
    const c = h.content([{ id, durationMs }], { variant: `bundle-${id}` });
    const spot = c.manifest.spots[id];
    if (spot?.kind !== 'template') throw new Error(`${id} is a template spot`);
    return { id, c, spot, sha: bundleOf(c) };
  });
  const content = h.content([{ id: 'a', durationMs }, ...extra], {
    edit: (m) => {
      for (const o of own) {
        const key = `${o.id}/fixture@1.0.0`;
        m.templates[key] = { ...m.templates[TEMPLATE_KEY]!, html: o.sha };
        m.files[o.sha] = o.c.manifest.files[o.sha]!;
        m.spots[o.id] = { ...o.spot, template: key };
      }
      m.playlists.main!.items = playlist.map((spot) => ({ spot }));
    },
  });
  const bundle: Record<string, string> = { a: bundleOf(content) };
  for (const o of own) {
    content.blobs.set(o.sha, o.c.blobs.get(o.sha)!);
    bundle[o.id] = o.sha;
  }
  return { content, bundle };
}

/** Every key in the player's file cache. */
const cached = (p: Player) => p.page.evaluate(async () => (await (await caches.open('sf-blobs-v1')).keys()).map((r) => new URL(r.url).pathname));

describe('content files', () => {
  it("hands a template an image's sample beside the image, and none to one without", async () => {
    const content = h.content([
      { id: 'a', asset: randomBytes(4096), sample: png(3, 2), durationMs: 600 },
      { id: 'b', asset: randomBytes(4096), durationMs: 600 },
    ]);
    const p = await h.openPlayer((s) => s.publish(content));
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'a', sample: '3x2' });
    await expect.poll(() => p.onScreen()).toMatchObject({ label: 'b', sample: '' });
  });

  it('keeps the files of a spot preparing under a replaced manifest, plays it, then drops them', async () => {
    // `a` is bound to a feed that never answers, so it sits in the player's 3 s data wait,
    // its step already chosen under `first`, while `second` arrives and replaces `first`.
    const first = h.content([{ id: 'a', asset: randomBytes(4096), bindings: { label: { source: 'feed', path: 'label' } }, durationMs: 800 }]);
    const p = await h.openPlayer((s) => {
      s.publish(first);
      s.setData('feed', { id: 'feed', version: 1, fetchedAt: '2026-11-17T00:00:00Z', checkedAt: new Date().toISOString(), data: { label: 'a' } });
      s.intercept(/^\/content\/data\//, 'stall');
    });
    await p.until((s) => s.manifestId === first.manifest.id);
    const second = h.content([{ id: 'b', asset: randomBytes(4096), durationMs: 800 }]);
    p.server.publish(second);
    await p.until((s) => s.manifestId === second.manifest.id);
    expect(spotsPlayed(await p.state())).toEqual([]); // still preparing `a`

    const s = await p.until((s) => s.log.some((l) => l.spot === 'b'));
    expect(s.log[0]).toMatchObject({ spot: 'a', manifest: first.manifest.id });
    expect(s.skipped).toBe(0);
    // Once `a` has left the screen, its file goes at the next sync.
    await expect.poll(() => cached(p), { timeout: 5000 }).not.toContain(`/_sf/blob/${assetOf(first, 'a')}`);
    expect(await cached(p)).toContain(`/_sf/blob/${assetOf(second, 'b')}`);
  });

  it('reads a template bundle once, however often its spots play (#213)', async () => {
    // Two spots of one template, so each plays the bundle the other loaded.
    const content = h.content(['a', 'b'].map((id) => ({ id, durationMs: 600 })));
    const p = await openCountingReads(content);
    await p.until((s) => s.log.length >= 5);
    expect(await readsOf(p, bundleOf(content))).toBe(1);
  });

  it('reads the bundles still to come while a spot plays, once each (#232)', async () => {
    // `b` is in the manifest but not the playlist: only the read-ahead reads its bundle.
    const { content, bundle } = ownBundles(['b'], ['a']);
    const p = await openCountingReads(content);
    await p.until((s) => s.log.length >= 1);
    await expect.poll(() => readsOf(p, bundle.b!)).toBe(1);
    // And not again, however often a plays.
    await p.until((s) => s.log.length >= 4);
    expect(await readsOf(p, bundle.b!)).toBe(1);
    expect(await readsOf(p, bundle.a!)).toBe(1);
    expect(spotsPlayed(await p.state()).every((id) => id === 'a')).toBe(true);
  });

  it("reads the playlist's next spots' bundles first, then the rest of the manifest's (#232)", async () => {
    // `d`'s template comes first in the manifest, but no spot of the playlist uses it.
    const { content, bundle } = ownBundles(['d', 'c', 'b'], ['a', 'c', 'b'], { durationMs: 60_000 });
    const p = await openCountingReads(content);
    await p.until((s) => s.log.length >= 1);
    const read = [bundle.c!, bundle.b!, bundle.d!];
    await expect.poll(() => readOrder(p, read)).toHaveLength(3);
    expect(await readOrder(p, read)).toEqual(read);
  });

  it('reads ahead when the playlist opens with a spot that is not a template (#232)', async () => {
    const { content, bundle } = ownBundles(['b'], ['u'], { durationMs: 60_000, extra: [{ id: 'u', url: 'https://first.test/', durationMs: 60_000 }] });
    const p = await openCountingReads(content, (page) =>
      page.context().route(/^https:\/\/first\.test\//, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>First</title>' })),
    );
    await p.until((s) => s.log.length >= 1);
    await expect.poll(() => Promise.all([readsOf(p, bundle.a!), readsOf(p, bundle.b!)])).toEqual([1, 1]);
  });

  it('plays and logs every spot in a browser without requestIdleCallback (Safari), reading nothing ahead (#232)', async () => {
    const { content, bundle } = ownBundles(['b'], ['a']);
    const p = await openCountingReads(content, (page) => page.addInitScript(() => Reflect.deleteProperty(window, 'requestIdleCallback')));
    const s = await p.until((s) => s.played >= 3);
    expect(s.lastError).toBe('');
    expect(s.log.length).toBe(s.played);
    expect(await readsOf(p, bundle.b!)).toBe(0);
  });

  it('plays, and reads ahead, where no worker can be made: the bundles are contained on the page (#561)', async () => {
    const { content, bundle } = ownBundles(['b'], ['a']);
    const p = await openCountingReads(content, (page) => page.addInitScript(() => Reflect.deleteProperty(window, 'Worker')));
    const s = await p.until((s) => s.played >= 3);
    expect(s.lastError).toBe('');
    expect(s.log.length).toBe(s.played);
    await expect.poll(() => readsOf(p, bundle.b!)).toBe(1);
  });

  it('tries a bundle it cannot read ahead once, not again at every play (#561)', async () => {
    const { content, bundle } = ownBundles(['b'], ['a']);
    // b's file misses in the cache, as one the browser evicted does; its reads are still counted.
    const p = await openCountingReads(content, (page) =>
      page.addInitScript((sha) => {
        const match = Cache.prototype.match;
        Cache.prototype.match = function (request, options) {
          const url = typeof request === 'string' ? request : request instanceof Request ? request.url : String(request);
          // Through the counting wrapper, so the read is counted, then a miss.
          return url.endsWith(`/_sf/blob/${sha}`) ? match.call(this, request, options).then(() => undefined) : match.call(this, request, options);
        };
      }, bundle.b!),
    );
    await p.until((s) => s.log.length >= 1);
    await expect.poll(() => readsOf(p, bundle.b!)).toBe(1);
    await p.until((s) => s.log.length >= 5);
    expect(await readsOf(p, bundle.b!)).toBe(1);
  });

  it('drops a read that failed after the manifest changed, so the next prepare reads again (#232)', async () => {
    const one = h.content([{ id: 'a', durationMs: 600 }]);
    const two = h.content([{ id: 'a', durationMs: 700 }]);
    expect(bundleOf(two)).toBe(bundleOf(one));
    const p = await h.openPlayer(
      (s) => s.publish(one),
      {},
      {
        before: (page) =>
          page.addInitScript((sha) => {
            // While held, a read of the bundle waits, then misses, as a file the browser evicted does.
            const w = window as unknown as { sfHold: boolean; sfHeld: (() => void)[] };
            w.sfHold = true;
            w.sfHeld = [];
            const match = Cache.prototype.match;
            Cache.prototype.match = function (request, options) {
              const url = typeof request === 'string' ? request : request instanceof Request ? request.url : String(request);
              if (w.sfHold && url.endsWith(sha)) return new Promise((resolve) => w.sfHeld.push(() => resolve(undefined)));
              return match.call(this, request, options);
            };
          }, bundleOf(one)),
      },
    );
    // The first prepare's read is held, so it times out; the next manifest's prepares join that read.
    await p.until((s) => s.skipped >= 1);
    p.server.publish(two);
    const adopted = await p.until((s) => s.manifestId === two.manifest.id);
    await p.until((s) => s.skipped >= adopted.skipped + 1);
    // The read misses; from here the file reads as it is, in the cache.
    await p.page.evaluate(() => {
      const w = window as unknown as { sfHold: boolean; sfHeld: (() => void)[] };
      w.sfHold = false;
      w.sfHeld.splice(0).forEach((f) => f());
    });
    expect((await p.until((s) => s.log.length >= 1)).log[0]).toMatchObject({ spot: 'a', manifest: two.manifest.id });
  });

  it("stops reading ahead for a manifest once another is prepared, and never puts the old one's back (#232)", async () => {
    const { content: one, bundle } = ownBundles(['b'], ['a']);
    const two = h.content([{ id: 'c', durationMs: 600 }], { variant: 'bundle-third' });
    const p = await openCountingReads(one, (page) =>
      page.addInitScript(() => {
        // Idle callbacks wait until the test lets them go.
        const w = window as unknown as { sfIdle: IdleRequestCallback[] };
        w.sfIdle = [];
        window.requestIdleCallback = (cb) => w.sfIdle.push(cb);
      }),
    );
    await p.until((s) => s.log.length >= 1);
    await expect.poll(() => p.page.evaluate(() => (window as unknown as { sfIdle: unknown[] }).sfIdle.length)).toBe(1);
    p.server.publish(two);
    await p.until((s) => s.log.some((l) => l.manifest === two.manifest.id));
    // `one`'s read-ahead, held across the change, runs now; `two`'s own is still held.
    await p.page.evaluate(() => (window as unknown as { sfIdle: IdleRequestCallback[] }).sfIdle.shift()!({ didTimeout: false, timeRemaining: () => 50 }));
    const before = (await p.state()).log.length;
    await p.until((s) => s.log.length >= before + 3);
    expect(await readsOf(p, bundle.b!)).toBe(0);
    expect(await readsOf(p, bundleOf(two))).toBe(1);
  });

  /** Reload, play `a` and `b` once each, and count the reads of their bundles in the new page. */
  const reloadAndRead = async (p: Player, bundle: Record<string, string>) => {
    await p.page.reload();
    await p.until((s) => s.log.some((l) => l.spot === 'a') && s.log.some((l) => l.spot === 'b'));
    return [await readsOf(p, bundle.a!), await readsOf(p, bundle.b!)];
  };

  it('keeps its bundles as contained, so a later page load plays them without reading a bundle (#232)', async () => {
    const { content, bundle } = ownBundles(['b'], ['a', 'b']);
    const p = await openCountingReads(content);
    // The read-ahead keeps them while a spot plays, some time after the first plays.
    await expect.poll(() => reloadAndRead(p, bundle), { timeout: 20_000 }).toEqual([0, 0]);
  });

  it('contains a bundle again when what it kept cannot be read, and keeps it anew (#232)', async () => {
    const { content, bundle } = ownBundles(['b'], ['a', 'b']);
    const p = await openCountingReads(content);
    await expect.poll(() => reloadAndRead(p, bundle), { timeout: 20_000 }).toEqual([0, 0]);
    // Each kept entry turned into something that is not frames: one not JSON, one of the wrong shape.
    await p.page.evaluate(async () => {
      const frames = await caches.open('sf-frames-v1');
      const [one, two] = await frames.keys();
      await frames.put(one!, new Response('not frames'));
      await frames.put(two!, Response.json({ wrapper: 1 }));
    });
    expect(await reloadAndRead(p, bundle)).toEqual([1, 1]);
    await expect.poll(() => reloadAndRead(p, bundle), { timeout: 20_000 }).toEqual([0, 0]);
  });

  it('never shows a template from the bundle it had for another hash (#213)', async () => {
    const one = h.content([{ id: 'a', durationMs: 600 }], { variant: 'bundle-one' });
    const p = await h.openPlayer((s) => s.publish(one));
    await expect.poll(() => onScreenComments(p)).toContain('bundle-one');
    // The same template key and spot, built into another bundle: a new hash.
    const two = h.content([{ id: 'a', durationMs: 600 }], { variant: 'bundle-two' });
    expect(bundleOf(two)).not.toBe(bundleOf(one));
    p.server.publish(two);
    await p.until((s) => s.log.some((l) => l.manifest === two.manifest.id));
    await expect.poll(() => onScreenComments(p)).toContain('bundle-two');
    expect(await onScreenComments(p)).not.toContain('bundle-one');
  });

  it('never uses a file whose hash does not match', async () => {
    const content = h.content([{ id: 'a', asset: randomBytes(4096), durationMs: 600 }]);
    const sha = assetOf(content, 'a');
    const good = content.blobs.get(sha)!;
    content.blobs.set(sha, randomBytes(4096));
    const p = await h.openPlayer((s) => s.publish(content));

    await expect.poll(() => p.page.locator('#status').textContent()).toContain(`file ${sha.slice(0, 12)}: failed verification`);
    expect((await p.state()).manifestId).toBe('');
    expect((await cached(p)).filter((k) => k.includes(sha))).toEqual([]);

    content.blobs.set(sha, good);
    const s = await p.until((s) => s.log.length >= 1);
    expect(s.manifestId).toBe(content.manifest.id);
  });

  it('downloads a large file with flat memory', async () => {
    const small = h.content([{ id: 'a', durationMs: 600 }]);
    const p = await h.openPlayer((s) => s.publish(small));
    await p.until((s) => s.log.length >= 1);
    const page = await p.page.context().newCDPSession(p.page);
    const browser = await p.page.context().browser()!.newBrowserCDPSession();
    const MB = 1024 * 1024;
    // JS heap plus ArrayBuffer backing stores (where a buffered download lands), of the page and
    // of the download worker while one runs. The worker is sampled after a forced collection: what
    // it retains. Uncollected, its chunks pile up to V8's external-memory trigger (about 60 MB,
    // the same for a 64 or 160 MB file) before they are collected.
    const usage = (u: { usedSize: number; backingStorageSize?: number }) => u.usedSize + (u.backingStorageSize ?? 0);
    let workerSession: string | undefined;
    let msgId = 0;
    const workerHeap = async (gc = false): Promise<number> => {
      if (!workerSession) {
        const { targetInfos } = await browser.send('Target.getTargets');
        const w = targetInfos.find((t) => t.type === 'worker' && t.url.includes('download-worker'));
        if (!w) return 0;
        workerSession = (await browser.send('Target.attachToTarget', { targetId: w.targetId, flatten: false })).sessionId;
      }
      const id = ++msgId;
      if (gc)
        await browser
          .send('Target.sendMessageToTarget', { sessionId: workerSession, message: JSON.stringify({ id: ++msgId, method: 'HeapProfiler.collectGarbage' }) })
          .catch(() => undefined);
      const reply = new Promise<number>((resolve) => {
        const on = (e: { sessionId: string; message: string }) => {
          const m = JSON.parse(e.message) as { id: number; result?: { usedSize: number; backingStorageSize?: number } };
          if (e.sessionId !== workerSession || m.id !== id) return;
          browser.off('Target.receivedMessageFromTarget', on);
          resolve(m.result ? usage(m.result) : 0);
        };
        browser.on('Target.receivedMessageFromTarget', on);
        setTimeout(() => resolve(0), 500);
      });
      await browser
        .send('Target.sendMessageToTarget', { sessionId: workerSession, message: JSON.stringify({ id, method: 'Runtime.getHeapUsage' }) })
        .catch(() => (workerSession = undefined));
      return reply;
    };
    const pageHeap = async () => usage(await page.send('Runtime.getHeapUsage'));
    await page.send('HeapProfiler.collectGarbage');
    const before = await pageHeap();

    const big = h.content([{ id: 'v', asset: randomBytes(64 * MB), durationMs: 600 }]);
    p.server.intercept(BLOBS, { bytesPerSecond: 32 * MB });
    p.server.publish(big);
    let pagePeak = before;
    let workerPeak = 0;
    while ((await p.state()).manifestId !== big.manifest.id) {
      pagePeak = Math.max(pagePeak, await pageHeap());
      workerPeak = Math.max(workerPeak, await workerHeap(true));
      await new Promise((r) => setTimeout(r, 50));
    }
    await page.send('HeapProfiler.collectGarbage');
    const after = await pageHeap();
    console.info(
      `page heap before ${(before / MB).toFixed(1)} MB, peak ${(pagePeak / MB).toFixed(1)} MB, after ${(after / MB).toFixed(1)} MB; download worker retained at most ${(workerPeak / MB).toFixed(1)} MB`,
    );
    expect(workerPeak).toBeGreaterThan(0); // it was measured
    // Streamed, a few MB; buffered, the whole file.
    expect(workerPeak).toBeLessThan(16 * MB);
    expect(pagePeak - before).toBeLessThan(16 * MB);
    expect(after - before).toBeLessThan(4 * MB);
    await p.until((s) => s.log.some((l) => l.spot === 'v'));
  }, 30_000);
});
