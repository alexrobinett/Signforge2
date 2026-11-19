import { expect, test } from '@playwright/test';
import { fillUntilEnabled, hydrated, signInAs } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.16';

test('a signed-out visit to a page goes to sign-in, which comes back to it', async ({ context }) => {
  // The page's loader and the shell's both find no session, and whichever redirect wins must keep
  // the way back. Six tabs at once, as the race showed up under load (one in four lost it).
  const pages = await Promise.all(Array.from({ length: 6 }, () => context.newPage()));
  await Promise.all(
    pages.map(async (page) => {
      for (const path of ['/settings/members', '/assets', '/screens/abc', '/settings/members', '/assets', '/settings/general']) {
        await page.goto(path);
        await expect(page).toHaveURL(`/sign-in?redirect=${encodeURIComponent(path)}`);
      }
    }),
  );
});

test('a session that ends while the app is open goes to sign-in and back, from a link', async ({ page }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-ended-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Harbour Books', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Harbour Books', level: 1 })).toBeVisible();

  await page.context().clearCookies();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' }).click();
  await expect(page).toHaveURL('/sign-in?redirect=%2Fassets');
});
