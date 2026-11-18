import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SCHEMA } from '@signforge/contract';
import type { Player } from './harness';
import { useHarness } from './harness';

const h = useHarness();

/** The content server stops answering, as when the screen's network goes. */
const cutNetwork = (p: Player) => p.server.intercept(/^\/content\//, { status: 503 });

/** Reload the page (the cache survives) and wait for the player to start again. */
async function restart(p: Player): Promise<void> {
  await p.page.reload();
  await p.until(() => true);
}

describe('last known good', () => {
  it('falls back to the last manifest that played when every spot of a new one fails, and stays there offline', async () => {
    const good = h.content(
      [
        { id: 'a', durationMs: 600 },
        { id: 'b', durationMs: 600 },
      ],
      { variant: 'good' },
    );
    const broken = h.content(
      [
        { id: 'x', mode: 'throw', durationMs: 600 },
        { id: 'y', mode: 'throw', durationMs: 600 },
      ],
      { variant: 'broken' },
    );
    const p = await h.openPlayer((s) => s.publish(good));
    await p.until((s) => s.lastGood === good.manifest.id);

    p.server.publish(broken);
    let s = await p.until((s) => s.fallback === broken.manifest.id);
    expect(s.manifestId).toBe(good.manifest.id);
    const before = s.log.length;
    s = await p.until((s) => s.log.length >= before + 2);
    expect(s.log.slice(before).map((l) => l.manifest)).toEqual([good.manifest.id, good.manifest.id]);
    expect((await p.onScreen())?.label).toMatch(/^[ab]$/);

    // Restarted, the player tries the broken manifest again, then falls back to the good one. Its
    // files were kept through the sync that ran first, although the broken manifest does not use them.
    await restart(p);
    s = await p.until((s) => s.fallback === broken.manifest.id && s.log.length >= 2, 15_000);
    expect(s.log.map((l) => l.manifest)).toEqual([good.manifest.id, good.manifest.id]);

    // And again with no network.
    cutNetwork(p);
    await restart(p);
    s = await p.until((s) => s.fallback === broken.manifest.id && s.log.length >= 2, 15_000);
    expect(s.log.map((l) => l.manifest)).toEqual([good.manifest.id, good.manifest.id]);
  });

  it('plays a new manifest once one of its spots plays, and adopts it as the last good one', async () => {
    const first = h.content([{ id: 'a', durationMs: 600 }], { variant: 'first' });
    const second = h.content(
      [
        { id: 'x', mode: 'throw', durationMs: 600 },
        { id: 'c', durationMs: 600 },
      ],
      { variant: 'second' },
    );
    const p = await h.openPlayer((s) => s.publish(first));
    await p.until((s) => s.lastGood === first.manifest.id);

    p.server.publish(second);
    const s = await p.until((s) => s.lastGood === second.manifest.id && s.log.at(-1)?.spot === 'c');
    expect(s.fallback).toBe('');
    expect(s.manifestId).toBe(second.manifest.id);
  });

  it('keeps the last good manifest when a URL-only one shows a page that failed to load', async () => {
    const good = h.content([{ id: 'a', durationMs: 600 }], { variant: 'good' });
    const page = h.content([{ id: 'u', url: 'https://down.test/', durationMs: 600 }], { variant: 'url' });
    const p = await h.openPlayer((s) => s.publish(good));
    // The page's server refuses the connection: the frame shows the browser's error page, and loads.
    await p.page.context().route(/^https:\/\/down\.test\//, (route) => route.abort('connectionrefused'));
    await p.until((s) => s.lastGood === good.manifest.id);

    p.server.publish(page);
    const s = await p.until((s) => s.log.filter((l) => l.manifest === page.manifest.id).length >= 2);
    expect(s.manifestId).toBe(page.manifest.id);
    expect(s.lastGood).toBe(good.manifest.id);
  });

  it('takes a video manifest as the last good one only once a video has started playing', async () => {
    const good = h.content([{ id: 'a', durationMs: 600 }], { variant: 'good' });
    const clip = readFileSync(join(import.meta.dirname, 'fixtures/clip.webm'));
    const video = h.content([{ id: 'v', video: clip, durationMs: 600 }], { variant: 'video' });
    const p = await h.openPlayer((s) => s.publish(good));
    await p.until((s) => s.lastGood === good.manifest.id);

    // The browser refuses to play, as it may refuse autoplay or a decoder.
    await p.page.evaluate(() => {
      const w = window as unknown as { realPlay: typeof HTMLMediaElement.prototype.play };
      w.realPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('refused', 'NotAllowedError'));
    });
    p.server.publish(video);
    const s = await p.until((s) => s.log.filter((l) => l.manifest === video.manifest.id).length >= 2);
    expect(s.lastGood).toBe(good.manifest.id);

    await p.page.evaluate(() => {
      HTMLMediaElement.prototype.play = (window as unknown as { realPlay: typeof HTMLMediaElement.prototype.play }).realPlay;
    });
    await p.until((s) => s.lastGood === video.manifest.id);
  });

  it('plays a cached schema N-1 manifest after a restart with no network', async () => {
    const old = h.content(
      [
        { id: 'a', durationMs: 600 },
        { id: 'b', durationMs: 600 },
      ],
      { schema: MANIFEST_SCHEMA - 1 },
    );
    expect(old.manifest.schema).toBe(MANIFEST_SCHEMA - 1);
    const p = await h.openPlayer((s) => s.publish(old));
    await p.until((s) => s.log.length >= 1);

    cutNetwork(p);
    await restart(p);
    const s = await p.until((s) => s.log.length >= 2);
    expect(s.log.map((l) => l.manifest)).toEqual([old.manifest.id, old.manifest.id]);
    expect(s.online).toBe(false);
  });

  it('plays a cached manifest this release rejects when it is all the screen has', async () => {
    const content = h.content([{ id: 'a', durationMs: 600 }]);
    const p = await h.openPlayer((s) => s.publish(content));
    await p.until((s) => s.log.length >= 1);

    // What an older release stored: a schema this one no longer plays, with nothing newer to replace it.
    cutNetwork(p);
    await rewriteCache(p, 'schema0');
    await restart(p);
    const s = await p.until((s) => s.log.length >= 2);
    expect(s.manifestId).toBe(content.manifest.id);
    expect(p.console.some((l) => l.includes('schema 0 is not one this player can play'))).toBe(true);
  });

  it('survives a corrupt cached manifest, playing the last good one', async () => {
    const content = h.content([{ id: 'a', durationMs: 600 }]);
    const p = await h.openPlayer((s) => s.publish(content));
    await p.until((s) => s.lastGood === content.manifest.id);

    cutNetwork(p);
    await rewriteCache(p, 'torn');
    await restart(p);
    const s = await p.until((s) => s.log.length >= 2);
    expect(s.manifestId).toBe(content.manifest.id);
    expect(p.console.filter((l) => l.startsWith('pageerror'))).toEqual([]);
  });

  it('survives corrupt cached manifests with nothing to fall back to', async () => {
    const content = h.content([{ id: 'a', durationMs: 600 }]);
    const p = await h.openPlayer((s) => s.publish(content));
    await p.until((s) => s.lastGood === content.manifest.id);

    cutNetwork(p);
    await rewriteCache(p, 'null', true);
    await restart(p);
    await expect.poll(() => p.page.locator('#status').textContent()).toContain('Waiting for content');
    expect(p.console.filter((l) => l.startsWith('pageerror'))).toEqual([]);
  });
});

/**
 * Rewrite the stored manifests the way an older release, or a torn write, might have left them:
 * `schema0` marks the manifest with a schema this release does not play, `torn` cuts the JSON
 * short, `null` stores valid JSON that is no manifest. This is the player's on-device storage
 * format, which every release must read.
 */
async function rewriteCache(p: Player, how: 'schema0' | 'torn' | 'null', lastGoodToo = false): Promise<void> {
  await p.page.evaluate(
    async ({ how, lastGoodToo }) => {
      const state = await caches.open('sf-state-v1');
      const keys = ['/_sf/manifest/active', ...(lastGoodToo ? ['/_sf/manifest/last-good'] : [])];
      for (const key of keys) {
        const text = (await (await state.match(key))?.text()) ?? '{}';
        const next = how === 'schema0' ? JSON.stringify({ ...JSON.parse(text), schema: 0 }) : how === 'torn' ? text.slice(0, 20) : 'null';
        await state.put(key, new Response(next, { headers: { 'content-type': 'application/json' } }));
      }
    },
    { how, lastGoodToo },
  );
}
