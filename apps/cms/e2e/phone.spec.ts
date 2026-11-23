import { expect, test } from '@playwright/test';
import { axe, createOrg, fromAddress, orgSwitcher, screenshot, signIn } from './helpers';

/** This spec's own client address, for its own sign-in rate limit. */
const ADDRESS = '192.0.2.124';

test('at phone width, navigation is a drawer and the dashboard works', async ({ page }) => {
  const email = `e2e-phone-${Date.now()}@example.com`;
  await fromAddress(page, ADDRESS);
  await page.goto('/sign-in');
  await signIn(page, email);
  // Signed in once the first page asks for an org: the session cookie is set by then.
  await expect(page.getByRole('heading', { name: 'Welcome to SignForge' })).toBeVisible();
  await createOrg(page, 'Pocket Signs', ADDRESS);

  // No horizontal scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await screenshot(page, '08-phone-overview');

  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  // One org: its name, with no menu to switch.
  await expect(drawer.getByText('Pocket Signs')).toBeVisible();
  await expect(orgSwitcher(page)).toHaveCount(0);
  await axe(page);
  await screenshot(page, '09-phone-drawer');
  await drawer.getByRole('link', { name: 'Playlists' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Playlists', level: 1 })).toBeVisible();
});
