import { expect, type Request, test } from '@playwright/test';
import { createOrg, hydrated, signInAs } from './helpers';
import { CMS_URL } from './servers';

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
  await createOrg(page, 'Harbour Books');

  await page.context().clearCookies();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' }).click();
  await expect(page).toHaveURL('/sign-in?redirect=%2Fassets');
});

test('a session that ends on Spots or in the spot editor goes to sign-in at once, without a storm of requests', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-ended-spots-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Quay Florist');
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

  // Every call the browser makes to a server function, from when the session ends; those not yet
  // answered; and when one last started or ended.
  let calls = 0;
  const open = new Set<Request>();
  let moved = 0;
  const isFn = (r: Request) => r.url().includes('/_serverFn/');
  page.on('request', (r) => {
    if (!isFn(r)) return;
    calls++;
    open.add(r);
    moved = Date.now();
  });
  const ended = (r: Request) => {
    if (!isFn(r)) return;
    open.delete(r);
    moved = Date.now();
  };
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  /** End the session, do `then`, and land on sign-in with the way back, in a handful of calls that then stop. */
  async function ends(then: () => Promise<unknown>, back: string) {
    await page.context().clearCookies();
    calls = 0;
    await then();
    // At once: a read that found the session ended is not retried first (Query's retries took 7s).
    const signIn = `/sign-in?redirect=${encodeURIComponent(back)}`;
    await expect(page).toHaveURL(signIn, { timeout: 5_000 });
    // Settled: every call answered, the slowed ones too, and none for a second.
    await expect.poll(() => open.size === 0 && Date.now() - moved >= 1_000, { timeout: 15_000 }).toBe(true);
    expect(calls).toBeLessThan(20);
    // And still there once every read has ended: a late one did not send it on to another sign-in.
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(signIn);
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
  // As on CI (run 44575937095), assets is slower and sign-in slow to check the session: reads
  // ending once the address is sign-in's must not nest sign-in. A function id is its name (vite.config.ts).
  await page.route('**/_serverFn/**', async (route) => {
    const fn = new URL(route.request().url()).pathname;
    const fromSignIn = new URL(route.request().headers().referer ?? CMS_URL).pathname === '/sign-in';
    if (fn.includes('getAssets')) await new Promise((r) => setTimeout(r, 300));
    if (fn.includes('getShell') && fromSignIn) await new Promise((r) => setTimeout(r, 2_500));
    await route.continue();
  });
  await page.goto('/spots');
  await hydrated(page);
  await page.waitForTimeout(11_000);
  await ends(() => page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))), '/spots');
});
