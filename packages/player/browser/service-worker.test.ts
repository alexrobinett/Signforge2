// The service worker (public/sw.js): it keeps the player shell, so a screen that restarts with no
// network boots the player and plays the content it has stored (review A7).
import { expect, it } from 'vitest';
import { useHarness } from './harness';

const h = useHarness();

it('boots the cached shell and plays stored content when the server is gone', async () => {
  const content = h.content([
    { id: 'a', durationMs: 600 },
    { id: 'b', durationMs: 600 },
  ]);
  const p = await h.openPlayer((s) => s.publish(content));
  await p.until((s) => s.played >= 2 && s.manifestId === content.manifest.id);
  // Once the worker controls the page, the shell it fetched next is in its cache: reload once
  // under its control so every shell file has gone through it.
  await p.page.evaluate(() => navigator.serviceWorker.ready);
  await p.page.reload();
  await p.until((s) => s.played >= 1);
  expect(await p.page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await p.page.evaluate(async () => (await (await caches.open('sf-shell-v1')).keys()).length)).toBeGreaterThan(0);

  // The server stops: every request fails at the network, shell and content alike.
  await p.server.close();
  await p.page.reload();
  const s = await p.until((s) => s.played >= 2, 15_000);
  expect(s.manifestId).toBe(content.manifest.id);
  expect(s.online).toBe(false);
});

it('leaves content and the device API to the page', async () => {
  const content = h.content([{ id: 'a', durationMs: 600 }]);
  const p = await h.openPlayer((s) => s.publish(content));
  await p.until((s) => s.played >= 1);
  await p.page.evaluate(() => navigator.serviceWorker.ready);
  await p.page.reload();
  await p.until((s) => s.played >= 1);
  const cached = await p.page.evaluate(async () => (await (await caches.open('sf-shell-v1')).keys()).map((r) => new URL(r.url).pathname));
  expect(cached.filter((path) => path.includes('/content/') || path.includes('/_sf/'))).toEqual([]);
});
