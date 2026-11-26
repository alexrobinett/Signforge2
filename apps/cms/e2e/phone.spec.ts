import { expect, test } from '@playwright/test';
import { accountMenu, axe, createOrg, fromAddress, hydrated, orgSwitcher, screenshot, shots, signIn, signInAs, tool } from './helpers';

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

test('a save that fails says so under the top bar at phone width, in both editors, and a field focused above it is not hidden (#479)', async ({ page }) => {
  await signInAs(page, `e2e-phone-save-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Quayside Ices', ADDRESS);
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key.endsWith('clock'));
  const version = clock.versions.findLast((v: { status: string }) => v.status === 'approved');
  const { spot } = await tool(page, 'save_spot', { name: 'Lobby clock', kind: 'template', templateVersionId: version.id, data: {} });
  const { playlist } = await tool(page, 'save_playlist', { name: 'Morning loop', spotIds: [spot.id] });
  const alert = page.getByRole('alert').filter({ hasText: 'Could not reach SignForge' });
  const bar = page
    .locator('header')
    .filter({ has: page.getByRole('button', { name: /menu|navigation/i }) })
    .first();
  /** The alert's top against the top bar's bottom, both on screen. */
  const underBar = async () => {
    const [a, b] = await Promise.all([alert.boundingBox(), bar.boundingBox()]);
    return a && b ? Math.round(a.y - (b.y + b.height)) : null;
  };

  // The spot editor: its last field, well below the editor's header.
  await page.goto(`/spots/${spot.id}`);
  await hydrated(page);
  await page.route('**/api/tools/save_spot', (route) => route.abort('internetdisconnected'));
  const duration = page.getByLabel('Duration');
  await duration.scrollIntoViewIfNeeded();
  await duration.fill('12');
  await expect(alert).toBeVisible();
  await duration.scrollIntoViewIfNeeded();
  await expect(duration).toBeInViewport();
  await expect.poll(underBar).toBe(0);
  // The field just above, scrolled under the alert, then reached with Shift+Tab: it comes out from under it.
  const above = page.getByLabel('Show seconds');
  await duration.focus();
  await page.evaluate(async () => {
    const field = document.activeElement as HTMLElement;
    const alertBox = document.querySelector('[data-save-alert]')!.getBoundingClientRect();
    window.scrollBy(0, field.getBoundingClientRect().top - alertBox.bottom);
  });
  await page.keyboard.press('Shift+Tab');
  await expect(above).toBeFocused();
  const [field, cover] = await Promise.all([above.boundingBox(), alert.boundingBox()]);
  expect(field!.y).toBeGreaterThanOrEqual(cover!.y + cover!.height - 1);
  await page.unroute('**/api/tools/save_spot');

  // The playlist editor: its alert under the bar too, the page scrolled to its foot.
  await page.goto(`/playlists/${playlist.id}`);
  await hydrated(page);
  await page.route('**/api/tools/save_playlist', (route) => route.abort('internetdisconnected'));
  await page.getByLabel('Name', { exact: true }).fill('Morning loop, weekdays');
  await expect(alert).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(alert).toBeInViewport();
  await expect.poll(underBar).toBe(0);
  await page.unroute('**/api/tools/save_playlist');
});
