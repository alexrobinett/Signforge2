import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SCHEMA, type Spot } from '@signforge/contract';
import type { FixtureServer } from './fixture-server';
import type { Player } from './harness';
import { useHarness } from './harness';

const h = useHarness();
/** Content on another origin is the API: the player syncs, and checks files on the sync's word. */
const api = (s: FixtureServer) => ({ content: `${s.localUrl}/content` });

/** The content server stops answering, as when the screen's network goes. */
const cutNetwork = (p: Player) => p.server.intercept(/^\/content\//, { status: 503 });
/** A player whose last good manifest is `good`, and a video manifest to publish next. */
async function goodThenVideo() {
  const good = h.content([{ id: 'a', durationMs: 600 }], { variant: 'good' });
  const video = h.content([{ id: 'v', video: readFileSync(join(import.meta.dirname, 'fixtures/clip.webm')), durationMs: 600 }], { variant: 'video' });
  const p = await h.openPlayer((s) => s.publish(good));
  await p.until((s) => s.lastGood === good.manifest.id);
  return { p, good, video };
}

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

  it('fetches back an evicted file of the last good manifest while falling back to it past two broken ones', async () => {
    const good = h.content(
      [
        { id: 'a', asset: randomBytes(4096), durationMs: 600 },
        { id: 'b', durationMs: 600 },
      ],
      { variant: 'good' },
    );
    const broken = (variant: string) => h.content([{ id: 'x', mode: 'throw', durationMs: 600 }], { variant });
    const [b, c] = [broken('b'), broken('c')];
    const asset = (good.manifest.spots.a as Extract<Spot, { kind: 'template' }>).assets.file!;
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(good);
    }, api);
    await p.until((s) => s.lastGood === good.manifest.id && s.log.some((l) => l.spot === 'a'));

    p.server.publish(b);
    await p.until((s) => s.fallback === b.manifest.id);
    // The browser evicts A's own file; A stays on screen through its other spot.
    const assetRequests = () => p.server.requestsTo(new RegExp(`^/content/blobs/${asset}$`)).length;
    const before = assetRequests();
    await p.page.evaluate(async (sha) => (await caches.open('sf-blobs-v1')).delete(`/_sf/blob/${sha}`), asset);
    p.server.serveLastGood(good);
    p.server.publish(c);
    await p.until((s) => s.fallback === c.manifest.id);
    const mark = (await p.state()).log.length;

    await expect.poll(assetRequests, { timeout: 15_000 }).toBeGreaterThan(before);
    const s = await p.until((s) => s.log.slice(mark).some((l) => l.spot === 'a' && l.manifest === good.manifest.id), 15_000);
    expect(s.fallback).toBe(c.manifest.id);
  });

  it('takes a healthy publish at once while a file only the last good manifest uses cannot be fetched', async () => {
    const good = h.content(
      [
        { id: 'a', asset: randomBytes(4096), durationMs: 600 },
        { id: 'b', durationMs: 600 },
      ],
      { variant: 'good' },
    );
    const broken = h.content([{ id: 'x', mode: 'throw', durationMs: 600 }], { variant: 'broken' });
    // Its one file, the template, is A's: already held.
    const healthy = h.content([{ id: 'd', durationMs: 600 }], { variant: 'good' });
    const asset = (good.manifest.spots.a as Extract<Spot, { kind: 'template' }>).assets.file!;
    const p = await h.openPlayer((s) => {
      s.nextSyncS = 1;
      s.publish(good);
    }, api);
    await p.until((s) => s.lastGood === good.manifest.id && s.log.some((l) => l.spot === 'a'));
    p.server.publish(broken);
    await p.until((s) => s.fallback === broken.manifest.id);
    // A's own file is evicted, and the server no longer has it (a static deploy deleted it).
    await p.page.evaluate(async (sha) => (await caches.open('sf-blobs-v1')).delete(`/_sf/blob/${sha}`), asset);
    p.server.intercept(new RegExp(`^/content/blobs/${asset}$`), { status: 404 });

    p.server.publish(healthy);
    const s = await p.until((s) => s.manifestId === healthy.manifest.id && s.log.some((l) => l.spot === 'd'), 15_000);
    expect(s.fallback).toBe('');
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

  it('falls back from a video manifest whose videos the browser refuses to play, offline too', async () => {
    const { p, good, video } = await goodThenVideo();

    // The browser refuses to play, as it may refuse autoplay or a decoder; after a reload too.
    const refuse = () => {
      HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('refused', 'NotAllowedError'));
    };
    await p.page.addInitScript(refuse);
    await p.page.evaluate(refuse);
    p.server.publish(video);
    let s = await p.until((s) => s.fallback === video.manifest.id);
    const before = s.log.length;
    s = await p.until((s) => s.log.length >= before + 2);
    expect(s.log.filter((l) => l.manifest === video.manifest.id)).toEqual([]);
    expect(s.log.slice(before).map((l) => l.manifest)).toEqual([good.manifest.id, good.manifest.id]);
    expect(s.lastGood).toBe(good.manifest.id);
    expect(s.skipped).toBeGreaterThanOrEqual(1);

    // Restarted with no network: the video manifest again, refused again, then the good one.
    cutNetwork(p);
    await restart(p);
    s = await p.until((s) => s.fallback === video.manifest.id && s.log.length >= 2, 15_000);
    expect(s.log.map((l) => l.manifest)).toEqual([good.manifest.id, good.manifest.id]);
  });

  it('takes a video manifest as the last good one once a video has started playing', async () => {
    const { p, video } = await goodThenVideo();

    p.server.publish(video);
    const s = await p.until((s) => s.lastGood === video.manifest.id);
    expect(s.fallback).toBe('');
    expect(s.log.at(-1)?.manifest).toBe(video.manifest.id);
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
