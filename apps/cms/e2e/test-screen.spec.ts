import { createServer } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, hydrated, publishImage, shots, signInAs } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.131';

/** What the player in the tab says about itself (`window.__sf`). */
const player = (tab: Page) =>
  tab.evaluate(() => {
    const s = (window as Window & { __sf?: { pairing: string; manifestId: string; played: number; socket: boolean } }).__sf;
    return s ? { pairing: s.pairing, manifestId: s.manifestId, played: s.played, socket: s.socket } : undefined;
  });

/** What the tab keeps: its credential (IndexedDB) and its files (Cache Storage). */
const kept = (tab: Page) =>
  tab.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('sf-device');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const credential = db.objectStoreNames.contains('credential')
      ? await new Promise<unknown>((resolve) => {
          const get = db.transaction('credential').objectStore('credential').get('credential');
          get.onsuccess = () => resolve(get.result);
        })
      : undefined;
    db.close();
    return { credential: credential !== undefined, files: (await (await caches.open('sf-blobs-v1')).keys()).length };
  });

test('a new org opens a test screen, pairs it, publishes to it and sees it play; a revoke wipes it', async ({ page }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-test-screen-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Test Kitchen', ADDRESS);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await hydrated(page);
  await axe(page);
  await shots(page, '41-empty-fleet-test-screen');
  await page.setViewportSize({ width: 412, height: 915 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '44-phone-empty-fleet-test-screen');
  await page.setViewportSize({ width: 1280, height: 720 });

  // From here, the minute.
  const started = Date.now();
  const opened = page.waitForEvent('popup');
  await page.getByRole('link', { name: /Open a test screen/ }).click();
  const tab = await opened;
  // A separate window: neither tab holds the other.
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await expect.poll(async () => (await player(tab))?.pairing ?? '', { timeout: 20_000 }).not.toBe('');
  const code = (await player(tab))!.pairing;
  await expect(tab.getByText('Pair this screen')).toBeVisible();

  await expect(page.getByLabel('Name it')).toHaveValue('Test screen');
  await page.getByLabel('Character 1 of 6').fill(code);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Test screen', level: 1 })).toBeVisible();
  await expect(page.getByTitle('The player in a browser tab')).toHaveText('Test screen');
  const screenId = new URL(page.url()).pathname.split('/').at(-1)!;

  const manifestId = await publishImage(page, screenId);
  await expect
    .poll(
      async () => {
        const s = await player(tab);
        return !!s && s.manifestId === manifestId && s.played > 0;
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  const elapsed = Date.now() - started;
  // Logged, not asserted: a runner's speed is not the CMS's. The polls' limits are the bound.
  console.info(`test screen: opened, paired, published and playing in ${(elapsed / 1000).toFixed(1)} s`);
  await expect(tab.locator('.slot img')).toBeVisible();
  // The nudge socket is up through the CMS's origin, beside the session cookie.
  await expect.poll(async () => (await player(tab))?.socket).toBe(true);
  expect(await kept(tab)).toEqual({ credential: true, files: 1 });

  // The screen's page: a test screen, with no wake or sleep (a tab has no panel).
  await page.reload();
  await hydrated(page);
  await expect(page.getByRole('button', { name: 'Identify (10 s)' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sleep now|Wake now/ })).toHaveCount(0);
  await axe(page);
  await shots(page, '42-test-screen-detail');
  await page.getByRole('link', { name: 'Screens', exact: true }).first().click();
  await expect(page.getByText(/^Test screen · /)).toBeVisible();
  await axe(page);
  await shots(page, '43-test-screen-tile');
  await page.getByRole('link', { name: 'Test screen' }).click();

  // Revoked from its page: the tab wipes its credential and files, and shows a code again.
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Revoke…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText(/credential was revoked/)).toBeVisible();
  await expect.poll(async () => (await player(tab))?.pairing ?? '', { timeout: 20_000 }).not.toBe('');
  expect(await player(tab)).toMatchObject({ manifestId: '', played: 0 });
  expect(await kept(tab)).toEqual({ credential: false, files: 0 });
});

// The player takes its content base and supervisor from its address, which on the CMS's hostname anyone can
// write into a link. The other site hands over a credential for its own device API, as a supervisor would; a
// browser screen asks no supervisor and pairs with that API.
for (const player of ['/test-screen/?', '/player/?', '/test-screen/?kind=browser&']) {
  test(`the player at ${player} reaches no other site its address names`, async ({ page }) => {
    const reached: string[] = [];
    const other = createServer((req, res) => {
      reached.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' });
      res.end(JSON.stringify({ credential: `sfd_scr_other.${'a'.repeat(43)}`, api: `http://${req.headers.host}/v1/device`, token: 'other' }));
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const address = other.address();
    if (typeof address !== 'object' || !address) throw new Error('the other site is not listening');
    const site = `http://127.0.0.1:${address.port}`;
    try {
      // Each request the browser refuses under the page's policy, by its address.
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) =>
          Reflect.set(window, 'sfRefused', [...(Reflect.get(window, 'sfRefused') ?? []), e.blockedURI]),
        );
      });
      await page.goto(`${player}content=${site}/v1/device&supervisor=${site}/supervisor`);
      // The player asked for the other site and the browser refused it there: a refusal comes before any request leaves.
      await expect
        .poll(async () => {
          const refused: string[] = (await page.evaluate(() => Reflect.get(window, 'sfRefused'))) ?? [];
          return { refused: refused.some((url) => url.startsWith(site)), reached };
        })
        .toEqual({ refused: true, reached: [] });
    } finally {
      other.close();
    }
  });
}
