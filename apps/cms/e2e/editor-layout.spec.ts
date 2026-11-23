import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, hydrated, newSpot, shots, signInAs } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.150';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await signInAs(page, `e2e-layout-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbor Coffee');
});

test.afterAll(() => page.context().close());

/** The stage's frame, from the top of the page, as a box. */
async function stageBox() {
  await page.evaluate(() => window.scrollTo(0, 0));
  const frame = page.getByRole('region', { name: 'Live preview' }).locator('iframe');
  await expect(frame).toBeVisible({ timeout: 30_000 });
  return (await frame.boundingBox())!;
}

test('at 1440×900 the stage is in the first viewport, in the spot and playlist editors (#260)', async () => {
  // A long form: the stage's column is as tall as it, and a centred stage fell below the fold.
  await newSpot(page, 'Announcement', 'Harvest Night');
  // Centred in that column, its top was at about 690 px and its bottom past 1,000.
  const spot = await stageBox();
  expect(spot.y + spot.height).toBeLessThanOrEqual(900);
  await shots(page, '90-spot-editor-stage-top');

  await page.goto('/playlists');
  await hydrated(page);
  await page.getByRole('button', { name: 'New playlist' }).click();
  await page.getByLabel('Name').fill('Lobby loop');
  await page.getByRole('button', { name: 'Create playlist' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby loop', level: 1 })).toBeVisible();
  await hydrated(page);
  await page.getByRole('button', { name: 'Add spots' }).click();
  await page.getByRole('dialog', { name: 'Add spots' }).getByRole('button', { name: 'Add Harvest Night' }).click();
  await page.keyboard.press('Escape');
  const playlist = await stageBox();
  expect(playlist.y + playlist.height).toBeLessThanOrEqual(900);
  await shots(page, '91-playlist-editor-stage-top');
});

test('the sidebar folds to an icon rail and back, by keyboard, with names and tooltips, and remembers it (#260)', async () => {
  await page.goto('/spots');
  await hydrated(page);
  const sidebar = page.getByRole('complementary', { name: 'Sidebar' });
  const fold = sidebar.getByRole('button', { name: 'Fold the sidebar' });
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  const before = (await sidebar.boundingBox())!.width;

  await fold.focus();
  await page.keyboard.press('Enter');
  const unfold = sidebar.getByRole('button', { name: 'Unfold the sidebar' });
  await expect(unfold).toBeFocused();
  await expect(unfold).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(100);
  expect(before).toBeGreaterThan(200);

  // Each item keeps its name, and a tooltip says it when focused.
  const nav = sidebar.getByRole('navigation', { name: 'Main' });
  for (const name of ['Overview', 'Screens', 'Spots', 'Playlists', 'Schedule', 'Settings']) await expect(nav.getByRole('link', { name })).toBeVisible();
  await nav.getByRole('link', { name: 'Screens' }).focus();
  await expect(page.getByRole('tooltip', { name: 'Screens' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Search and actions' })).toBeVisible();
  await axe(page);
  await shots(page, '92-sidebar-folded');

  // Kept for the next visit.
  await page.reload();
  await hydrated(page);
  await expect(sidebar.getByRole('button', { name: 'Unfold the sidebar' })).toBeVisible();

  await sidebar.getByRole('button', { name: 'Unfold the sidebar' }).focus();
  await page.keyboard.press('Space');
  await expect(sidebar.getByRole('button', { name: 'Fold the sidebar' })).toBeFocused();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(200);
});

test('a phone keeps its top bar and navigation drawer, with no fold button (#260)', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/spots');
  await hydrated(page);
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer.getByRole('link', { name: 'Screens' })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /fold the sidebar/i })).toBeHidden();
  await axe(page);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
});
