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
  await createOrg(page, 'Harbour Books', ADDRESS);

  await page.context().clearCookies();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Assets' }).click();
  await expect(page).toHaveURL('/sign-in?redirect=%2Fassets');
});

test('a session that ends on Spots or in the spot editor goes to sign-in at once, without a storm of requests', async ({ page }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-ended-spots-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Quay Florist', ADDRESS);
  const spotsLink = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Spots' });
  await spotsLink.click();
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('radio', { name: 'Clock', exact: true }).check();
  await page.getByLabel('Name').fill('Window clock');
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page).toHaveURL(/\/spots\/[^/?]+$/);
  const editor = new URL(page.url()).pathname;
  const session = await page.context().cookies();

  // Every call the browser makes to a server function, from when the session ends; how often each
  // was sent from each page; and those not yet answered.
  let calls = 0;
  const sent = new Map<string, number>();
  const open = new Set<Request>();
  const isFn = (r: Request) => r.url().includes('/_serverFn/');
  page.on('request', (r) => {
    if (!isFn(r)) return;
    calls++;
    const from = `${new URL(r.url()).pathname} from ${new URL(r.headers().referer ?? CMS_URL).pathname}`;
    sent.set(from, (sent.get(from) ?? 0) + 1);
    open.add(r);
  });
  const ended = (r: Request) => void open.delete(r);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  /** End the session, do `then`, and land on sign-in with the way back, in a handful of calls that then stop. */
  async function ends(then: () => Promise<unknown>, back: string) {
    await page.context().clearCookies();
    calls = 0;
    sent.clear();
    await then();
    const signIn = `/sign-in?redirect=${encodeURIComponent(back)}`;
    await expect(page).toHaveURL(signIn);
    // At once: a read that found the session ended is not retried first (Query's retries took 7 s),
    // so no page sent one read twice.
    expect([...sent].filter(([from, n]) => n > 1 && !from.endsWith(' from /sign-in'))).toEqual([]);
    // Settled: every call answered, the held ones too, and sign-in hydrated.
    await hydrated(page);
    await expect.poll(() => open.size).toBe(0);
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

  // Spots left until its reads are stale (its clock moved past Query's 10 s), then shown again.
  // As on CI (run 44575937095), assets answers once the address is sign-in's, and sign-in checks the
  // session after that: such late reads must not nest sign-in. A function id is its name (vite.config.ts).
  await page.clock.install();
  await page.goto('/spots');
  await hydrated(page);
  await page.clock.fastForward(11_000);
  let assetsEnded: () => void = () => {};
  const assets = new Promise<void>((resolve) => {
    assetsEnded = resolve;
  });
  let assetsSent = false;
  const assetsDone = (r: Request) => void (r.url().includes('/_serverFn/getAssets') && assetsEnded());
  page.on('requestfinished', assetsDone);
  page.on('requestfailed', assetsDone);
  await page.route('**/_serverFn/**', async (route) => {
    const fn = new URL(route.request().url()).pathname;
    const fromSignIn = new URL(route.request().headers().referer ?? CMS_URL).pathname === '/sign-in';
    if (fn.includes('getAssets')) {
      assetsSent = true;
      await page.waitForURL(/\/sign-in\?/);
    }
    if (fn.includes('getShell') && fromSignIn && assetsSent) await assets;
    await route.continue();
  });
  await ends(() => page.evaluate(() => window.dispatchEvent(new Event('visibilitychange'))), '/spots');
});
