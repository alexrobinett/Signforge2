import { expect, type Page, test } from '@playwright/test';
import { axe, createOrg, hydrated, orgSwitcher, signInAs } from './helpers';
import { CMS_URL } from './servers';

/**
 * Two tabs on one session (#129): one browser context, so they share its cookies as a browser's
 * tabs do. Separate contexts would each keep their own session cache cookie, which is not what a
 * member with two tabs has. The member switches org in one tab; the other, still showing the old
 * org, is refused what it tries and told to reload, rather than acting on the org it does not show.
 */

const refusal = 'This tab is on Northside Florist; you switched to Southside Deli in another tab. Reload.';

/** A member in Northside Florist (active) and Southside Deli, with `stale` open on `path` in Northside. */
async function twoOrgs(page: Page, address: string, path: string) {
  await signInAs(page, `e2e-tab-org-${address}-${Date.now()}@example.com`, address);
  await createOrg(page, 'Northside Florist');
  const south = await page.request.post('/api/auth/organization/create', {
    data: { name: 'Southside Deli', slug: `southside-${Date.now()}`, keepCurrentActiveOrganization: true },
    headers: { origin: CMS_URL },
  });
  expect(south.status(), await south.text()).toBe(200);
  await page.goto(path);
  await hydrated(page);
  await expect(orgSwitcher(page)).toContainText('Northside Florist');
}

/** In a second tab, switch to Southside Deli from the switcher: that tab's own switch goes through. */
async function switchInAnotherTab(page: Page) {
  const other = await page.context().newPage();
  await other.goto('/settings/general');
  await hydrated(other);
  await orgSwitcher(other).click();
  await other.getByRole('menuitemradio', { name: 'Southside Deli' }).click();
  await expect(orgSwitcher(other)).toContainText('Southside Deli');
  await expect(other.getByLabel('Time zone')).toBeVisible();
  await other.close();
}

test('a save from a tab left on the old org is refused, and the new org is not changed', async ({ page }) => {
  await twoOrgs(page, '192.0.2.61', '/settings/general');
  const zone = page.getByLabel('Time zone');
  const before = await zone.inputValue();
  await switchInAnotherTab(page);

  await zone.selectOption('Europe/London');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(refusal)).toBeVisible();

  // Reloaded, the tab shows Southside Deli, untouched by the refused save.
  await page.reload();
  await hydrated(page);
  await expect(orgSwitcher(page)).toContainText('Southside Deli');
  await expect(zone).toHaveValue(before);
});

test("an audit export from a tab left on the old org is refused, with no file of the new org's log", async ({ page }) => {
  await twoOrgs(page, '192.0.2.62', '/audit');
  let downloads = 0;
  page.on('download', () => downloads++);
  await switchInAnotherTab(page);

  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByRole('status').filter({ hasText: refusal })).toBeVisible();
  expect(downloads).toBe(0);
});

test('a tab left on the old org that navigates says to reload, and Reload shows the new org', async ({ page }) => {
  await twoOrgs(page, '192.0.2.63', '/settings/general');
  await switchInAnotherTab(page);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await expect(page.getByRole('alert')).toHaveText(refusal);
  await axe(page);
  await page.getByRole('button', { name: 'Reload' }).click();
  await hydrated(page);
  await expect(orgSwitcher(page)).toContainText('Southside Deli');
  await expect(page.getByRole('heading', { name: 'Screens', level: 1 })).toBeVisible();
});
