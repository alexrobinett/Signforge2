import { expect, test } from '@playwright/test';
import { orgSwitcher, screenshot, signIn } from './helpers';

test('at phone width, navigation is a drawer and the dashboard works', async ({ page }) => {
  const email = `e2e-phone-${Date.now()}@example.com`;
  await page.goto('/sign-in');
  await signIn(page, email);
  await page.getByLabel('Organization name').fill('Pocket Signs');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Pocket Signs', level: 1 })).toBeVisible();

  // No horizontal scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, '08-phone-overview');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(orgSwitcher(page)).toContainText('Pocket Signs');
  await screenshot(page, '09-phone-drawer');
  await drawer.getByRole('link', { name: 'Playlists' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Playlists', level: 1 })).toBeVisible();
});
