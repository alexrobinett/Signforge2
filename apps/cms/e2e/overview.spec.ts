// Overview (#357, #334): a new org's setup checklist ticks each step off from its data (a spot from
// a template, a default playlist with it, a screen) and goes once all are done; then the page shows
// the org's status: a screen that needs someone, what plays now with its template's thumbnail, the
// drafts not published, and the latest publish. Hiding the checklist is kept on a reload. Axe at
// desktop and phone width, light and dark.
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, d1, hydrated, shots, signInAs, tool } from './helpers';

/** This spec's own client address, so its sign-ins and claims have their own rate limits. */
const ADDRESS = '192.0.2.211';

/** What the player in the tab says it plays (`window.__sf`). */
const player = (tab: Page) =>
  tab.evaluate(() => {
    const s = (window as Window & { __sf?: { pairing: string; playlist: string } }).__sf;
    return { pairing: s?.pairing ?? '', playlist: s?.playlist ?? '' };
  });

async function bothWidths(page: Page, name: string) {
  await axe(page);
  await shots(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, `${name}-phone`);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('a new org follows the setup checklist to a playing screen, and Overview shows its status', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, `e2e-overview-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Kestrel Lane', ADDRESS);

  const setup = page.getByRole('region', { name: 'Get your first spot on a screen' });
  await expect(setup).toContainText('0 of 3 done');
  await expect(setup.getByRole('listitem')).toHaveText([
    /Make a spot from a template \(to do\)/,
    /make that the default \(to do\)/,
    /Pair a screen.*\(to do\)/,
  ]);
  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('No screens are paired yet.');
  await expect(page.getByRole('region', { name: 'Unpublished drafts' })).toContainText('Everything is published.');
  await expect(page.getByRole('heading', { name: 'Sections' })).toHaveCount(0);
  await bothWidths(page, '110-overview-setup');

  // Step 1 opens New spot where spots are made.
  await setup.getByRole('link', { name: 'New spot' }).click();
  const dialog = page.getByRole('dialog', { name: 'New spot' });
  await expect(dialog).toBeVisible();
  await hydrated(page);
  await dialog.getByRole('radio', { name: 'Clock', exact: true }).check();
  await dialog.getByLabel('Name').fill('Opening');
  await dialog.getByRole('button', { name: 'Create spot' }).click();
  await expect(page.getByRole('heading', { name: 'Opening', level: 1 })).toBeVisible();
  const spotId = new URL(page.url()).pathname.split('/').at(-1);

  await page.goto('/');
  await expect(setup).toContainText('1 of 3 done');
  await expect(setup.getByRole('listitem').first()).toHaveText(/Make a spot from a template \(done\)/);
  await expect(page.getByRole('region', { name: 'Unpublished drafts' }).getByRole('link')).toHaveText([/Opening.*Spot · never published/]);

  // Step 2 ticks once a playlist with the spot is the default, however it was made.
  const { playlist } = await tool(page, 'create_playlist', { name: 'Opening week', transition: { type: 'cut' }, spotIds: [spotId] });
  await tool(page, 'set_default_playlist', { playlistId: playlist.id });
  await page.reload();
  await expect(setup).toContainText('2 of 3 done');

  // Step 3: a test screen, paired by its code. Every step is done, so the checklist goes.
  const screen = await (await browser.newContext()).newPage();
  await screen.goto('/test-screen/?kind=browser&content=/v1/device');
  await expect.poll(async () => (await player(screen)).pairing, { timeout: 20_000 }).not.toBe('');
  const claimed = await page.request.post('/api/tools/claim_screen', {
    headers: { 'cf-connecting-ip': ADDRESS },
    data: { code: (await player(screen)).pairing, name: 'Door', timezone: 'UTC', orientation: 'landscape' },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  const { screen: door } = (await claimed.json()) as { screen: { id: string } };
  await page.reload();
  await expect(setup).toBeHidden();

  // Published: the screen plays the spot, shown by its template's thumbnail, and the drafts are gone.
  await tool(page, 'publish', {});
  await expect.poll(async () => (await player(screen)).playlist, { timeout: 30_000 }).not.toBe('');
  await page.reload();
  const playing = page.getByRole('region', { name: 'Playing now' });
  await expect(playing.getByRole('link')).toHaveText([/Opening\s*On 1 screen · Opening week/]);
  await expect(playing.locator('img')).toHaveAttribute('src', '/template-thumbnails/clock.webp');
  await expect(page.getByRole('region', { name: 'Unpublished drafts' })).toContainText('Everything is published.');
  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Nothing needs you.');

  // The screen goes quiet and misses the next publish (its last sync moved back in the run's local
  // D1, as screens.spec.ts does): it needs someone, and the page says why.
  await screen.context().close();
  await tool(page, 'update_spot', { spotId, name: 'Opening hours' });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Unpublished drafts' }).getByRole('link')).toHaveText([/Opening hours.*Spot · changes not published/]);
  await tool(page, 'publish', {});
  await d1(`UPDATE screens SET last_seen_at = last_seen_at - ${30 * 60_000} WHERE id = '${door.id}'`);
  await page.reload();
  await expect(page.getByRole('region', { name: /Needs you/ }).getByRole('link')).toHaveText([/Door.*Unreachable and behind/]);
  await expect(page.getByRole('region', { name: 'Latest publish' })).toBeVisible();
  await bothWidths(page, '111-overview-status');
});

test('hiding the setup checklist keeps it hidden on a reload', async ({ page }) => {
  await signInAs(page, `e2e-overview-hide-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Kestrel Annex', ADDRESS);
  const setup = page.getByRole('region', { name: 'Get your first spot on a screen' });
  await expect(setup).toBeVisible();
  await page.getByRole('button', { name: 'Hide the setup checklist' }).click();
  await expect(setup).toBeHidden();
  await page.reload();
  await hydrated(page);
  await expect(setup).toBeHidden();
  await expect(page.getByRole('region', { name: 'Playing now' })).toContainText('No screen is playing anything yet.');
});
