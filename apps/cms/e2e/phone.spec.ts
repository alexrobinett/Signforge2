import { expect, test } from '@playwright/test';
import { accountMenu, axe, createOrg, fromAddress, orgSwitcher, screenshot, shots, signIn } from './helpers';

/** This spec's own client address, for its own sign-in rate limit. */
const ADDRESS = '192.0.2.124';

test('at phone width, navigation is a drawer and the dashboard works', async ({ page }) => {
  const email = `e2e-phone-${Date.now()}@example.com`;
  await fromAddress(page, ADDRESS);
  await page.goto('/sign-in');
  await signIn(page, email);
  // Signed in once the first page asks for an org: the session cookie is set by then.
  await expect(page.getByRole('heading', { name: 'Welcome to SignForge' })).toBeVisible();
  // No org yet: no navigation to open, only the account menu (#379).
  await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
  await expect(accountMenu(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '03-first-org-phone');
  await createOrg(page, 'Pocket Signs', ADDRESS);

  // No horizontal scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // The top bar is plain: no blur, and the page does not show through it (#384).
  const topBar = page.locator('header').filter({ has: page.getByRole('button', { name: 'Open navigation' }) });
  expect(await topBar.evaluate((h) => ({ blur: getComputedStyle(h).backdropFilter, background: getComputedStyle(h).backgroundColor }))).toEqual({
    blur: 'none',
    background: await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  });
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
