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

test('a session that ends on Spots or in the spot editor goes to sign-in at once, without a storm of requests', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-ended-spots-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Quay Florist', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Quay Florist', level: 1 })).toBeVisible();
  const spotsLink = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Spots' });
  await spotsLink.click();
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('combobox', { name: 'Template' }).selectOption({ label: 'Clock' });
  await page.getByLabel('Name').fill('Window clock');
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page).toHaveURL(/\/spots\/[^/?]+$/);
  const editor = new URL(page.url()).pathname;
  const session = await page.context().cookies();

  // Every call the browser makes to a server function, from when the session ends.
  let calls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/_serverFn/')) calls++;
  });
  /** End the session, do `then`, and land on sign-in with the way back, in a handful of calls that then stop. */
  async function ends(then: () => Promise<unknown>, back: string) {
    await page.context().clearCookies();
    calls = 0;
    await then();
    await expect(page).toHaveURL(`/sign-in?redirect=${encodeURIComponent(back)}`);
    await page.waitForTimeout(2_000);
    expect(calls).toBeLessThan(20);
    await page.context().addCookies(session);
  }

  // From Overview, follow the link to Spots.
  await page.goto('/');
  await hydrated(page);
  await ends(() => spotsLink.click(), '/spots');

  // From Spots, open the editor.
  await page.goto('/spots');
  await hydrated(page);
  await ends(() => page.getByRole('link', { name: 'Window clock' }).click(), editor);

  // Spots left open until its reads are stale, then the tab is shown again (Query refetches on focus).
  await page.goto('/spots');
  await hydrated(page);
  await page.waitForTimeout(11_000);
  await ends(() => page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))), '/spots');
});
