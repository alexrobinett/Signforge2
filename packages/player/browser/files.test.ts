import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Spot } from '@signforge/contract';
import type { Content } from './content';
import { spotsPlayed, useHarness, type Player } from './harness';

const h = useHarness();
const BLOBS = /^\/content\/blobs\//;

/** The hash of spot `id`'s own file. */
const assetOf = (c: Content, id: string) => (c.manifest.spots[id] as Extract<Spot, { kind: 'template' }>).assets.file!;
/** Every key in the player's file cache. */
const cached = (p: Player) => p.page.evaluate(async () => (await (await caches.open('sf-blobs-v1')).keys()).map((r) => new URL(r.url).pathname));

describe('content files', () => {
  it('keeps the files of a spot preparing under a replaced manifest, plays it, then drops them', async () => {
    // `a` is bound to a feed that never answers, so it sits in the player's 3 s data wait,
    // its step already chosen under `first`, while `second` arrives and replaces `first`.
    const first = h.content([{ id: 'a', asset: randomBytes(4096), bindings: { label: { source: 'feed', path: 'label' } }, durationMs: 800 }]);
    const p = await h.openPlayer((s) => {
      s.publish(first);
      s.setData('feed', { id: 'feed', version: 1, fetchedAt: '2026-11-17T00:00:00Z', data: { label: 'a' } });
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
