import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { manifestIdInput, MANIFEST_SCHEMA, type ScreenManifest } from '@signforge/contract';
import { png } from '@signforge/media/testing';
import { fillUntilEnabled, hydrated, shots, signInAs } from './helpers';
import { ADMIN_TOKEN, API_PORT } from './servers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.31';

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

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
    return { credential: typeof credential === 'string', files: (await (await caches.open('sf-blobs-v1')).keys()).length };
  });

/** Publish one image spot to the screen, as `sf push` does until the CMS publishes (M3-18). */
async function publishImage(page: Page, screenId: string): Promise<string> {
  const admin = `http://127.0.0.1:${API_PORT}/admin/screens/${screenId}`;
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const image = await png(640, 360);
  const file = sha256(image);
  const body: Omit<ScreenManifest, 'id'> = {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    screen: { id: screenId, name: 'Test screen', timezone: 'UTC', orientation: 'landscape' },
    files: { [file]: { size: image.byteLength, type: 'image/png' } },
    templates: {},
    spots: { welcome: { id: 'welcome', name: 'Welcome', kind: 'image', file, fit: 'cover', durationMs: 5000 } },
    playlists: { main: { id: 'main', name: 'Main', transition: { type: 'cut' }, items: [{ spot: 'welcome' }] } },
    dataSources: {},
    schedule: [],
    defaultPlaylist: 'main',
  };
  const manifest = { ...body, id: sha256(manifestIdInput(body)) };
  const put = await page.request.put(`${admin}/blobs/${file}`, { headers: { ...headers, 'content-type': 'image/png' }, data: image });
  expect(put.status(), await put.text()).toBe(200);
  const published = await page.request.put(`${admin}/manifest`, { headers, data: JSON.stringify(manifest) });
  expect(published.status(), await published.text()).toBe(200);
  return manifest.id;
}

test('a new org opens a test screen, pairs it, publishes to it and sees it play in under a minute; a revoke wipes it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-test-screen-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Test Kitchen', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Test Kitchen', level: 1 })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await hydrated(page);
  await shots(page, '41-empty-fleet-test-screen');
  await page.setViewportSize({ width: 412, height: 915 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
  console.info(`test screen: opened, paired, published and playing in ${(elapsed / 1000).toFixed(1)} s`);
  expect(elapsed).toBeLessThan(60_000);
  await expect(tab.locator('.slot img')).toBeVisible();
  // The nudge socket is up through the CMS's origin, beside the session cookie.
  await expect.poll(async () => (await player(tab))?.socket).toBe(true);
  expect(await kept(tab)).toEqual({ credential: true, files: 1 });

  // The screen's page: a test screen, with no wake or sleep (a tab has no panel).
  await page.reload();
  await hydrated(page);
  await expect(page.getByRole('button', { name: 'Identify (10 s)' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sleep now|Wake now/ })).toHaveCount(0);
  await shots(page, '42-test-screen-detail');
  await page.getByRole('link', { name: 'Screens', exact: true }).first().click();
  await expect(page.getByText(/^Test screen · /)).toBeVisible();
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
