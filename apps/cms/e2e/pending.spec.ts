// Between pages (#376): while a navigation waits on its loader, a bar at the top past 300 ms and the
// page's skeleton in its place. The loader's read is held here until the test lets it go, so the wait
// lasts exactly as long as the checks need, whatever the machine.
import { expect, test } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit. */
const ADDRESS = '192.0.2.233';

test('a slow page shows the pending bar and its skeleton, then the page', async ({ page }) => {
  await signInAs(page, `e2e-pending-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Larkspur Depot', ADDRESS);
  await page.goto('/spots');
  await hydrated(page);

  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith('/_serverFn/getPlaylists'),
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Playlists' }).click();

  // The bar fades in past its delay; the skeleton stands in for the page and says it is loading.
  const bar = page.getByRole('progressbar', { name: 'Loading the page' });
  await expect.poll(() => bar.evaluate((b) => getComputedStyle(b).opacity)).toBe('1');
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading…' })).toBeAttached();
  await axe(page);
  await shots(page, '99-pending');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await axe(page);
  await shots(page, '99-pending-phone');

  release();
  await expect(page.getByRole('heading', { name: 'Playlists', level: 1 })).toBeVisible();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.unroute((url) => url.pathname.startsWith('/_serverFn/getPlaylists'));
});
