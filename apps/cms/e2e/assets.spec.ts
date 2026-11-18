import { expect, test } from '@playwright/test';
import { png, rotatedPhoto } from '@signforge/media/testing';
import { fillUntilEnabled, hydrated, shots, signInAs } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.21';

test('upload images, search them by name, see which are in use, and delete one no spot uses', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, `e2e-assets-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Northside Market', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' }).click();
  await expect(page.getByRole('heading', { name: 'No images yet' })).toBeVisible();
  await hydrated(page);
  await shots(page, '20-assets-empty');

  // A 4K phone photo held upright, a logo, and a file that is not an image.
  await page.getByLabel('Upload images').setInputFiles([
    { name: 'raspberries-cup.jpg', mimeType: 'image/jpeg', buffer: await rotatedPhoto() },
    { name: 'lobby-logo.png', mimeType: 'image/png', buffer: await png(800, 400) },
    { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not an image') },
  ]);
  await expect(page.getByRole('alert')).toContainText('Could not upload notes.png. The file is not an image this browser can read.', { timeout: 60_000 });
  const tiles = page.getByRole('main').getByRole('listitem');
  await expect(tiles).toHaveCount(2);
  await expect(page.getByText('2 images · none in use')).toBeVisible();
  // Newest first; what a landscape screen gets, scaled to cover 1920x1080 (the photo turned upright).
  await expect(tiles.nth(0)).toContainText('lobby-logo.png');
  await expect(tiles.nth(1)).toContainText('raspberries-cup.jpg');
  await expect(tiles.nth(1)).toContainText('1920×1080 · JPEG');
  await expect(tiles.nth(1).locator('img')).toHaveJSProperty('naturalWidth', 1920);
  await shots(page, '21-assets-library');
  await page.getByRole('button', { name: 'Dismiss notes.png' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Search by name, in any case, carried in the URL.
  await page.getByLabel('Search images').fill('RASP');
  await expect(tiles).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]q=RASP/);
  await page.getByLabel('Search images').fill('menu');
  await expect(page.getByText('No images match. Clear the search to see them all.')).toBeVisible();
  await page.getByLabel('Search images').fill('');
  await expect(tiles).toHaveCount(2);

  // A spot uses the photo: it says so and cannot be deleted; the logo can.
  const listed = await page.request.post('/api/tools/list_assets', { data: { query: 'raspberries' } });
  const { assets } = (await listed.json()) as { assets: { id: string }[] };
  const made = await page.request.post('/api/tools/create_spot', { data: { name: 'Summer menu', kind: 'image', assetId: assets[0]!.id } });
  expect(made.status(), await made.text()).toBe(200);
  await page.reload();
  await hydrated(page);
  await expect(page.getByText('2 images · 1 in use')).toBeVisible();
  await expect(tiles.nth(1)).toContainText('Used by 1 spot');
  await expect(tiles.nth(1).getByRole('button')).toHaveCount(0);
  await expect(tiles.nth(0)).toContainText('Not used');

  await page.getByRole('button', { name: 'Delete lobby-logo.png' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Delete lobby-logo.png?' })).toBeVisible();
  await shots(page, '22-assets-delete');
  await page.getByRole('button', { name: 'Delete image' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(tiles).toHaveCount(1);
  await expect(page.getByText('1 image · 1 in use')).toBeVisible();

  await page.setViewportSize({ width: 412, height: 915 });
  await shots(page, '23-phone-assets');
});
