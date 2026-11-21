import { expect, test, type Page } from '@playwright/test';
import {
  accountMenu,
  axe,
  createOrg,
  createOrgFromAccountMenu,
  fillUntilEnabled,
  fromAddress,
  hydrated,
  orgSwitcher,
  requestCode,
  screenshot,
  signIn,
  signInAs,
} from './helpers';
import { CMS_URL, codeFor } from './servers';

/** Each test's own client address, for its own sign-in rate limit. */
const ADDRESS = { switching: '192.0.2.121', oneOrg: '192.0.2.122', lastOrg: '192.0.2.123' };

async function activeOrgId(page: Page) {
  const res = await page.request.get('/api/session');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { organization: { id: string } | null }).organization?.id ?? null;
}

test('sign in with an email code, create two orgs and switch between them', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await fromAddress(page, ADDRESS.switching);

  // Signed out: a dashboard page sends you to sign-in, and remembers where you were going.
  await page.goto('/screens');
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fscreens$/);
  await expect(page.getByRole('heading', { name: 'Sign in to SignForge' })).toBeVisible();
  await expect(page.getByText('The code is printed in the terminal running the API')).toBeVisible();
  // GitHub is not configured locally, so it is not offered.
  await expect(page.getByRole('button', { name: /GitHub/ })).toHaveCount(0);
  await axe(page);
  await screenshot(page, '01-sign-in');

  await requestCode(page, email);
  const code = await codeFor(email);

  // A wrong code is refused, and you can try again.
  await page.getByLabel('Sign-in code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/invalid|code/i);
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fscreens$/);

  await page.getByLabel('Sign-in code').fill(code);
  await axe(page);
  await screenshot(page, '02-code');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Signed in with no org yet: back on the page asked for, offered to create the first org.
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.getByRole('heading', { name: 'Welcome to SignForge' })).toBeVisible();
  await axe(page);
  await screenshot(page, '03-first-org');
  await fillUntilEnabled(page, 'Organization name', 'Acme Coffee', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Screens', level: 1 })).toBeVisible();
  // One org: its name under the logo, and no menu to switch.
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  await expect(sidebar.getByText('Acme Coffee', { exact: true })).toBeVisible();
  const switcher = orgSwitcher(page);
  await expect(switcher).toHaveCount(0);
  const acme = await activeOrgId(page);
  expect(acme).toMatch(/^org_/);

  // A second org, created from the account menu, becomes active, and now there is a choice.
  await accountMenu(page).click();
  await page.getByRole('menuitem', { name: 'Create organization…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create organization' });
  await dialog.getByLabel('Organization name').fill('Blue Harbour Cinemas');
  await axe(page);
  await screenshot(page, '04-create-org-dialog');
  await dialog.getByRole('button', { name: 'Create organization' }).click();
  await expect(dialog).toBeHidden();
  await expect(switcher).toContainText('Blue Harbour Cinemas');
  const blue = await activeOrgId(page);
  expect(blue).not.toBe(acme);

  // Switch back to the first.
  await switcher.click();
  await expect(page.getByRole('menuitemradio', { name: 'Blue Harbour Cinemas' })).toHaveAttribute('aria-checked', 'true');
  await axe(page);
  await screenshot(page, '05-switcher');
  await page.getByRole('menuitemradio', { name: 'Acme Coffee' }).click();
  await expect(switcher).toContainText('Acme Coffee');
  expect(await activeOrgId(page)).toBe(acme);

  // ⌘K switches too: "Switch organization…" lists the orgs.
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  await page.keyboard.press('ControlOrMeta+k');
  // The menu opens from a keydown listener and renders a moment later: keys typed before its search has focus are lost.
  await expect(menu.getByRole('combobox', { name: 'Search pages, screens and actions' })).toBeFocused();
  await page.keyboard.type('switch organization');
  await expect(menu.getByRole('option', { selected: true })).toHaveText('Switch organization…');
  await page.keyboard.press('Enter');
  // The other orgs only: the one the tab is on is not offered, as in the switcher.
  const orgs = menu.getByRole('list', { name: 'Switch organization' });
  await expect(orgs.getByRole('button')).toHaveCount(1);
  await expect(orgs.getByRole('button')).toHaveAccessibleName('Blue Harbour Cinemas');
  await expect(orgs.getByRole('button')).toBeFocused();
  await axe(page);
  await screenshot(page, '05b-command-switch-org');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(switcher).toContainText('Blue Harbour Cinemas');
  await orgSwitcher(page).click();
  await page.getByRole('menuitemradio', { name: 'Acme Coffee' }).click();
  await expect(switcher).toContainText('Acme Coffee');

  // The switch is held by the session, not the page.
  await page.reload();
  await hydrated(page);
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
  await axe(page);
  await screenshot(page, '06-overview');

  // Dark theme, from the account menu; it survives a reload.
  const account = accountMenu(page);
  await account.click();
  await page.getByRole('menuitem', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await page.reload();
  await hydrated(page);
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await axe(page);
  await screenshot(page, '07-overview-dark');

  // Sign out, and the dashboard is closed again.
  await account.click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('a member of one org signs in on it: Overview, with its name and no menu to switch', async ({ page }) => {
  const email = `e2e-one-org-${Date.now()}@example.com`;
  await signInAs(page, email, ADDRESS.oneOrg);
  await createOrg(page, 'Solo Bakery');
  await accountMenu(page).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  // A new session: the only org is active at once, not "Choose an organization".
  await signIn(page, email);
  await expect(page).toHaveURL(`${CMS_URL}/`);
  await expect(page.getByRole('heading', { name: 'Solo Bakery', level: 1 })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Sidebar' }).getByText('Solo Bakery', { exact: true })).toBeVisible();
  await expect(orgSwitcher(page)).toHaveCount(0);
  await axe(page);
  await screenshot(page, '06b-one-org');
});

test('a member of two orgs signs in on the one they last switched to', async ({ page }) => {
  const email = `e2e-last-org-${Date.now()}@example.com`;
  await signInAs(page, email, ADDRESS.lastOrg);
  await createOrg(page, 'Northside Market');
  await createOrgFromAccountMenu(page, 'Southside Deli');
  await orgSwitcher(page).click();
  await page.getByRole('menuitemradio', { name: 'Northside Market' }).click();
  await expect(orgSwitcher(page)).toContainText('Northside Market');
  await accountMenu(page).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await signInAs(page, email, ADDRESS.lastOrg);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Northside Market', level: 1 })).toBeVisible();
  await expect(orgSwitcher(page)).toContainText('Northside Market');
});
