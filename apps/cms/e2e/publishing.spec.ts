import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, d1, hydrated, orgOf, shots, signInAs, stageShows, tool, toolResponse } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.51';

test.describe.configure({ mode: 'serial' });

let page: Page;
/** A test screen in its own tab: the real player, paired to the org. */
let screen: Page;
let spotId = '';
let playlistId = '';

/** What the player in the tab says it plays (`window.__sf`). */
const playing = (tab: Page) =>
  tab.evaluate(() => {
    const s = (window as Window & { __sf?: { pairing: string; manifestId: string; played: number } }).__sf;
    return s ? { pairing: s.pairing, manifestId: s.manifestId, played: s.played } : undefined;
  });

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-publishing-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Gallery', ADDRESS);
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock')).versions.at(-1).id;
  ({
    spot: { id: spotId },
  } = await tool(page, 'create_spot', { name: 'Deal', kind: 'template', templateVersionId: clock, durationMs: 10_000, data: { message: 'Two for $4' } }));
  ({
    playlist: { id: playlistId },
  } = await tool(page, 'create_playlist', { name: 'Main', transition: { type: 'cut' }, spotIds: [spotId] }));

  // A test screen, paired by its code as the Screens page pairs one.
  screen = await (await browser.newContext()).newPage();
  await screen.goto('/test-screen/?kind=browser&content=/v1/device');
  await expect.poll(async () => (await playing(screen))?.pairing ?? '', { timeout: 20_000 }).not.toBe('');
  const code = (await playing(screen))!.pairing;
  await tool(page, 'claim_screen', { code, name: 'Front window', timezone: 'UTC', orientation: 'landscape' });
  await expect.poll(async () => (await playing(screen))?.pairing, { timeout: 20_000 }).toBe('');
});

test.afterAll(async () => {
  await screen.context().close();
  await page.context().close();
});

/** The toast saying `title`. */
const toastSays = (title: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: title });

test('a playlist reaches no screen until it is the default, then publishes from its editor and plays', async () => {
  await page.goto(`/playlists/${playlistId}`);
  await hydrated(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  // Its drafts are published, but with no default playlist no screen can play anything.
  await expect(toastSays('Published v1')).toContainText('choose a default playlist');

  await page.getByRole('button', { name: 'Play on every screen' }).click();
  await expect(toastSays('Main plays on every screen')).toBeVisible();
  await expect(page.getByText('The default playlist: every screen plays it')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(toastSays('Published v2 to 1 screen')).toBeVisible();
  await axe(page);
  await shots(page, '50-playlist-published');
  await expect.poll(() => stageShows(screen, 'Two for $4'), { timeout: 30_000 }).toBe(true);
  expect((await tool(page, 'get_playlist', { playlistId })).playlist).toMatchObject({ published: true, draftChanged: false });

  // Publishing again with nothing changed touches no screen.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(toastSays('Nothing to publish')).toBeVisible();
  expect((await tool(page, 'list_publishes', {})).publishes).toHaveLength(2);
});

test('an edit to a spot, published from the spot editor, is on the screen in seconds, offers Undo, and a roll back takes it back', async () => {
  const before = (await playing(screen))!.manifestId;
  await page.goto(`/spots/${spotId}`);
  await hydrated(page);
  await page.getByLabel('Message').fill('Three for $5');
  const started = Date.now();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const published = toastSays('Published v3 to 1 screen');
  await expect(published).toBeVisible();
  // It offers Undo, a roll back to v2: checked as it appears, since the toast goes on its own and a
  // slow runner's screen can take longer than that. The roll back below comes from Publishes.
  await expect(published.getByRole('button', { name: 'Undo' })).toBeVisible();
  // Logged, not asserted: CI's runners are many times slower than a laptop. The poll's limit is the bound.
  await expect.poll(() => stageShows(screen, 'Three for $5'), { timeout: 20_000, intervals: [100] }).toBe(true);
  const seconds = (Date.now() - started) / 1000;
  console.info(`publishing: edit saved, published and on the test screen in ${seconds.toFixed(1)} s`);
  await shots(page, '51-spot-published-toast');

  // Back to v2 from the history: the screen goes back to the manifest it had, with nothing compiled again.
  await page.goto('/publishes');
  await hydrated(page);
  await page.getByRole('button', { name: 'Roll back to v2' }).click();
  await expect(toastSays('Screens pointed back at v2')).toBeVisible();
  // A roll back cannot itself be undone from its toast: Undo belongs to a publish.
  await expect(toastSays('Screens pointed back at v2').getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect.poll(async () => (await playing(screen))?.manifestId, { timeout: 20_000 }).toBe(before);
  await expect.poll(() => stageShows(screen, 'Two for $4'), { timeout: 20_000 }).toBe(true);
});

test('the Screens page shows the latest rollout, and the Publishes page why each screen waits, with the history to roll back to', async () => {
  test.setTimeout(120_000);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await hydrated(page);
  const latest = page.getByRole('region', { name: 'Latest publish' });
  await expect(latest).toContainText('v4');
  await expect(latest.getByRole('img', { name: /^Rollout of v4: back to v2: 1 playing v2 again/ })).toBeVisible({ timeout: 30_000 });
  // Its tile shows the template the player drew and the template's name, not its key or a hash (#362).
  // It took the publish, so its tile says Playing, not Updating to (#362).
  const thumb = page.getByRole('img', { name: 'Playing: Deal' });
  await expect(thumb.locator('img')).toHaveAttribute('src', '/template-thumbnails/clock.webp');
  await expect(page.getByRole('main')).not.toContainText('base/clock@');
  await expect(page.getByRole('listitem').filter({ has: thumb })).toContainText('Clock');
  await axe(page);
  await shots(page, '52-screens-latest-publish');

  await latest.getByRole('link', { name: 'View rollout' }).click();
  await expect(page.getByRole('heading', { name: 'v4: back to v2' })).toBeVisible();
  await expect(page.getByText('1 playing v2 again')).toBeVisible();
  const history = page.getByRole('list').filter({ hasText: 'v3' });
  await expect(history.getByRole('listitem')).toHaveCount(4);
  await axe(page);
  await shots(page, '53-publishes');

  // Roll forward to v3 from the history: the screen plays the newer spot again.
  await history.getByRole('button', { name: 'Roll back to v3' }).click();
  await expect(toastSays('Screens pointed back at v3')).toBeVisible();
  await expect.poll(() => stageShows(screen, 'Three for $5'), { timeout: 20_000 }).toBe(true);
  await expect(page.getByRole('heading', { name: 'v5: back to v3' })).toBeVisible();

  await page.setViewportSize({ width: 412, height: 915 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '54-phone-publishes');
  await page.goto('/screens');
  await hydrated(page);
  await expect(page.getByRole('region', { name: 'Latest publish' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shots(page, '55-phone-screens-latest-publish');
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('a publish made more than 90 days ago can no longer be rolled back to, and the page says why (#235)', async () => {
  // v1 made 91 days ago: past the storage clean-up's grace period, its files may be gone.
  await d1(`UPDATE publishes SET created_at = created_at - ${91 * 24 * 60 * 60_000} WHERE revision = 1 AND org_id = ${orgOf(spotId)}`);
  await page.goto('/publishes');
  await hydrated(page);
  const old = page.getByRole('button', { name: 'Roll back to v1' });
  await expect(old).toBeDisabled();
  // What each publish changed, so a roll back is to something seen, not remembered (#370): v1 made the spot and the
  // playlist live; v2 only compiled the screens again, for the new default; v3 published the spot's edit.
  const history = page.getByRole('region', { name: 'Publish history' });
  await expect(history.getByRole('listitem').filter({ hasText: /^v1/ })).toContainText('Spot Deal; playlist Main');
  await expect(history.getByRole('listitem').filter({ hasText: /^v2/ })).toContainText('No draft changed: the screens were compiled again');
  await expect(history.getByRole('listitem').filter({ hasText: /^v3/ })).toContainText('Spot Deal');
  await expect(old).toHaveAccessibleDescription('Spot Deal; playlist Main Over 90 days old: its files are no longer kept.');
  await expect(page.getByRole('button', { name: 'Roll back to v2' })).toBeEnabled();
  // The tool refuses it too, and says why.
  const { publishes } = await tool(page, 'list_publishes', {});
  const v1 = publishes.find((p: { revision: number }) => p.revision === 1);
  const refused = await toolResponse(page, 'roll_back_publish', { publishId: v1.id });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: 'conflict', details: { tooOld: true } });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await old.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await axe(page);
    await shots(page, `56-publish-too-old-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('Publish pressed while an autosave is on its way waits for it, and publishes the latest edit (#150)', async () => {
  await page.goto(`/spots/${spotId}`);
  await hydrated(page);
  // The first save's answer is held: the server has it, the page does not yet.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route('**/api/tools/update_spot', async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const saving = page.waitForRequest('**/api/tools/update_spot');
  await page.getByLabel('Message').fill('Four for $6');
  // The autosave, a second after the edit.
  await saving;
  await page.getByLabel('Message').fill('Five for $7');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  release();
  await expect(toastSays(/Published v\d+ to 1 screen/)).toBeVisible();
  await expect(toastSays('Not published')).toHaveCount(0);
  await expect.poll(() => stageShows(screen, 'Five for $7'), { timeout: 20_000 }).toBe(true);
  expect((await tool(page, 'get_spot', { spotId })).spot).toMatchObject({ data: { message: 'Five for $7' }, draftChanged: false });
  await page.unroute('**/api/tools/update_spot');
});
