import { expect, test, type Page } from '@playwright/test';
import { fillUntilEnabled, orgSwitcher, requestCode, screenshot } from './helpers';
import { codeFor } from './servers';

async function activeOrgId(page: Page) {
  const res = await page.request.get('/api/session');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { organization: { id: string } | null }).organization?.id ?? null;
}

test('sign in with an email code, create two orgs and switch between them', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;

  // Signed out: a dashboard page sends you to sign-in, and remembers where you were going.
  await page.goto('/screens');
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fscreens$/);
  await expect(page.getByRole('heading', { name: 'Sign in to SignForge' })).toBeVisible();
  await expect(page.getByText('The code is printed in the terminal running the API')).toBeVisible();
  // GitHub is not configured locally, so it is not offered.
  await expect(page.getByRole('button', { name: /GitHub/ })).toHaveCount(0);
  await screenshot(page, '01-sign-in');

  await requestCode(page, email);
  const code = await codeFor(email);

  // A wrong code is refused, and you can try again.
  await page.getByLabel('Sign-in code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|code/i);
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fscreens$/);

  await page.getByLabel('Sign-in code').fill(code);
  await screenshot(page, '02-code');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Signed in with no org yet: back on the page asked for, offered to create the first org.
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.getByRole('heading', { name: 'Welcome to SignForge' })).toBeVisible();
  await screenshot(page, '03-first-org');
  await fillUntilEnabled(page, 'Organization name', 'Acme Coffee', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Screens', level: 1 })).toBeVisible();
  const switcher = orgSwitcher(page);
  await expect(switcher).toContainText('Acme Coffee');
  const acme = await activeOrgId(page);
  expect(acme).toMatch(/^org_/);

  // A second org, created from the switcher, becomes active.
  await switcher.click();
  await page.getByRole('menuitem', { name: 'Create organization' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create organization' });
  await dialog.getByLabel('Organization name').fill('Blue Harbour Cinemas');
  await screenshot(page, '04-create-org-dialog');
  await dialog.getByRole('button', { name: 'Create organization' }).click();
  await expect(dialog).toBeHidden();
  await expect(switcher).toContainText('Blue Harbour Cinemas');
  const blue = await activeOrgId(page);
  expect(blue).not.toBe(acme);

  // Switch back to the first.
  await switcher.click();
  await expect(page.getByRole('menuitemradio', { name: 'Blue Harbour Cinemas' })).toHaveAttribute('aria-checked', 'true');
  await screenshot(page, '05-switcher');
  await page.getByRole('menuitemradio', { name: 'Acme Coffee' }).click();
  await expect(switcher).toContainText('Acme Coffee');
  expect(await activeOrgId(page)).toBe(acme);

  // The switch is held by the session, not the page.
  await page.reload();
  await expect(switcher).toContainText('Acme Coffee');

  // Every section is reachable from the navigation.
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Spots', 'Playlists', 'Schedule', 'Assets', 'Screens']) {
    await nav.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
  }
  await nav.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Acme Coffee', level: 1 })).toBeVisible();
  await screenshot(page, '06-overview');

  // Dark theme, from the account menu; it survives a reload.
  const account = page.getByRole('button', { name: /account and settings$/ });
  await account.click();
  await page.getByRole('menuitem', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await screenshot(page, '07-overview-dark');

  // Sign out, and the dashboard is closed again.
  await account.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});
