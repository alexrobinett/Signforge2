/**
 * The session blob URL's cache key (#43). Until then `/api/blobs/<sha256>` was answered
 * `private, max-age=31536000, immutable`, so a shared browser may still hold a fresh copy that it
 * would hand out after a sign-out without asking. The preview's fetches and the CMS's images
 * (`sessionBlobPath`) must miss that copy and reach the server.
 *
 * Playwright's routing turns Chromium's HTTP cache off, so here a real server plays the CMS origin
 * (`http://cms.test`, through the browser's proxy setting): the old URL is cached under the old
 * policy while signed in, and after the sign-out every `/api/` request is a 401.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sessionBlobPath } from '@signforge/contract';
import { chromium, type Browser } from 'playwright';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { useHarness } from './harness';

const h = useHarness();
const CMS = inject('cmsOrigin');
/** A 1×1 PNG, so an `<img>` loads it. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const IMAGE = 'd'.repeat(64);
/** The URL every client used before #43. */
const oldPath = (sha: string) => `/api/blobs/${sha}`;

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** The CMS origin: an editor page at `/editor`, and the blob routes, by either URL. */
async function cmsOrigin(files: Map<string, Buffer>, playerOrigin: string) {
  const state = { signedIn: true, requests: [] as string[] };
  const server = createServer((req, res) => {
    // A proxy request names the whole URL.
    const url = new URL(req.url ?? '/', CMS);
    state.requests.push(url.pathname);
    if (url.pathname === '/editor') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>editor</title>');
    const cors = { 'access-control-allow-origin': playerOrigin, 'access-control-allow-credentials': 'true' };
    const sha = /^\/api\/blobs\/(?:v2\/)?([0-9a-f]{64})$/.exec(url.pathname)?.[1];
    const body = sha === IMAGE ? PNG : sha && files.get(sha);
    if (!state.signedIn || !body) return res.writeHead(state.signedIn ? 404 : 401, { ...cors, 'cache-control': 'no-store' }).end();
    const cacheControl = url.pathname === oldPath(sha!) ? 'private, max-age=31536000, immutable' : 'private, no-cache';
    return res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream', 'cache-control': cacheControl, etag: `"${sha}"` }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { state, proxy: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('session blobs after the cache policy changed', () => {
  it('never reuse a copy the browser cached under the old immutable policy', async () => {
    const c = h.content([{ id: 'draft', durationMs: 60_000, label: 'Saved draft', asset: Buffer.from('a saved image') }]);
    const player = await h.playerServer();
    const cms = await cmsOrigin(c.blobs, player.url);
    // Its own browser, to send cms.test to the server above; loopback (the player) goes direct.
    const browser: Browser = await chromium.launch({
      args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessForNavigations,BlockInsecurePrivateNetworkRequests'],
      proxy: { server: cms.proxy, bypass: '127.0.0.1' },
    });
    cleanups.push(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${CMS}/editor`);
    await page.evaluate(
      (src) =>
        new Promise<void>((resolve) => {
          const w = window as unknown as { previewMessages: unknown[] };
          w.previewMessages = [];
          const f = document.createElement('iframe');
          f.name = 'player';
          addEventListener('message', (e) => e.source === f.contentWindow && w.previewMessages.push(e.data));
          f.addEventListener('load', () => resolve(), { once: true });
          f.src = src;
          document.body.appendChild(f);
        }),
      `${player.url}/?source=preview`,
    );
    const frame = page.frames().find((f) => f.url().startsWith(player.url))!;
    const messages = () => page.evaluate(() => (window as unknown as { previewMessages: { type: string; message?: string }[] }).previewMessages);
    await expect.poll(messages).toContainEqual(expect.objectContaining({ type: 'listening' }));
    // What the player fetches, from the player's frame; what the CMS shows, as an image on its page.
    const fetchStatus = (path: string) => frame.evaluate(async (u) => (await fetch(u, { credentials: 'include' })).status, `${CMS}${path}`);
    const imageLoads = (path: string) =>
      page.evaluate(
        (p) =>
          new Promise<boolean>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = p;
          }),
        path,
      );

    // Before the change: signed in, the old URLs are fetched and cached for a year.
    for (const sha of c.blobs.keys()) expect(await fetchStatus(oldPath(sha))).toBe(200);
    expect(await imageLoads(oldPath(IMAGE))).toBe(true);
    cms.state.signedIn = false;
    cms.state.requests.length = 0;
    // Those entries are live: signed out, the browser still answers them without asking.
    for (const sha of c.blobs.keys()) expect(await fetchStatus(oldPath(sha))).toBe(200);
    expect(await imageLoads(oldPath(IMAGE))).toBe(true);
    expect(cms.state.requests).toEqual([]);

    // A draft whose files were not posted: the player asks the server, which refuses it.
    await page.evaluate((manifest) => {
      const target = (document.querySelector('iframe[name=player]') as HTMLIFrameElement).contentWindow!;
      target.postMessage({ sfPreview: 1, type: 'draft', manifest, files: {} }, '*');
    }, c.manifest);
    await expect.poll(messages).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringMatching(/: 401$/) }));
    expect(cms.state.requests.length).toBeGreaterThan(0);
    expect(cms.state.requests.every((p) => [...c.blobs.keys()].some((sha) => p === sessionBlobPath(sha)))).toBe(true);
    // And the URL the CMS's images use reaches the server too.
    expect(await imageLoads(sessionBlobPath(IMAGE))).toBe(false);
    expect(cms.state.requests).toContain(sessionBlobPath(IMAGE));
  });
});
