// Between pages (#376): while a navigation waits on its loader, a bar at the top past 300 ms and the
// page's skeleton in its place. A loader's read is held here until the test lets it go, so the wait
// lasts exactly as long as the checks need, whatever the machine.
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit. */
const ADDRESS = '192.0.2.233';

/** Holds every read `matches` names until `release` is called. */
async function hold(page: Page, matches: (url: URL) => boolean) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(matches, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

const playlistsRead = (url: URL) => url.pathname.startsWith('/_serverFn/getPlaylists');
const auditRead = (url: URL) => url.pathname.startsWith('/_serverFn/getAuditPage');
const publishRead = (url: URL) => url.pathname.startsWith('/_serverFn/getPublish');
const skeleton = () => page.locator('[data-slot="page-skeleton"]');

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-pending-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Larkspur Depot', ADDRESS);
});

test.afterAll(() => page.context().close());

const bar = () => page.getByRole('progressbar', { name: 'Loading the page' });
const status = () => page.getByRole('status').filter({ hasText: 'Loading the page…' });

test('a slow page shows the pending bar and its skeleton, then the page', async () => {
  await page.goto('/spots');
  await hydrated(page);
  const release = await hold(page, playlistsRead);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Playlists' }).click();

  // The bar fades in past its delay; the skeleton stands in for the page; the status says it is loading.
  await expect.poll(() => bar().evaluate((b) => getComputedStyle(b).opacity)).toBe('1');
  await expect(bar()).toBeVisible();
  await expect(skeleton()).toBeVisible();
  await expect(status()).toBeAttached();
  // The bar itself, shown: the axe helper stills animations, which would keep it hidden.
  expect((await new AxeBuilder({ page }).include('[role="progressbar"]').analyze()).violations).toEqual([]);
  await axe(page);
  await shots(page, '99-pending');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(skeleton()).toBeVisible();
  await axe(page);
  await shots(page, '99-pending-phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  release();
  await expect(page.getByRole('heading', { name: 'Playlists', level: 1 })).toBeVisible();
  await expect(bar()).toHaveCount(0);
  await expect(skeleton()).toHaveCount(0);
  await expect(status()).toHaveCount(0);
  await page.unroute(playlistsRead);
});

test('under reduced motion the bar is still and full width, and the skeleton does not pulse', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/spots');
  await hydrated(page);
  const release = await hold(page, playlistsRead);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Playlists' }).click();
  await expect.poll(() => bar().evaluate((b) => getComputedStyle(b).opacity)).toBe('1');
  const fill = bar().locator('div');
  expect(await fill.evaluate((f) => getComputedStyle(f).animationName)).toBe('none');
  expect(await fill.evaluate((f) => f.getBoundingClientRect().width)).toBe(await bar().evaluate((b) => b.getBoundingClientRect().width));
  expect(
    await skeleton()
      .locator('.bg-muted')
      .first()
      .evaluate((e) => getComputedStyle(e).animationName),
  ).toBe('none');
  release();
  await expect(page.getByRole('heading', { name: 'Playlists', level: 1 })).toBeVisible();
  await page.unroute(playlistsRead);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('a loader that fails ends the wait with the error, not a skeleton', async () => {
  await page.goto('/spots');
  await hydrated(page);
  await page.route(playlistsRead, (route) => route.abort('connectionrefused'));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Playlists' }).click();
  // After the read's retries, bounded here, not timed.
  await expect(page.getByText('Something went wrong!')).toBeVisible({ timeout: 30_000 });
  await expect(bar()).toHaveCount(0);
  await expect(skeleton()).toHaveCount(0);
  await page.unroute(playlistsRead);
});

test("a filter on the same page keeps the page and the filter's focus, its rows marked busy", async () => {
  await page.goto('/audit');
  await hydrated(page);
  const release = await hold(page, auditRead);
  const what = page.getByLabel('What');
  await what.focus();
  await what.selectOption({ index: 1 });
  // Its rows wait on the held read, marked busy; the page and the select stay.
  await expect(page.locator('table').locator('xpath=..')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await expect(skeleton()).toHaveCount(0);
  await expect(what).toBeFocused();
  release();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(what).toBeFocused();
  await page.unroute(auditRead);
});

for (const [name, path, read, heading] of [
  ['Audit log', '/audit', auditRead, 'Audit log'],
  ['Publishes', '/publishes', publishRead, 'Publishes'],
] as const) {
  test(`entering ${name} from another page shows the skeleton while its read is held`, async () => {
    await page.goto('/spots');
    await hydrated(page);
    const release = await hold(page, read);
    await page.evaluate((to) => [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === to)?.click(), path);
    await expect(skeleton()).toBeVisible();
    release();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(skeleton()).toHaveCount(0);
    await page.unroute(read);
  });
}
