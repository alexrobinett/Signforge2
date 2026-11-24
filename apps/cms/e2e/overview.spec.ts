// Overview (#357, #334): a new org's setup checklist ticks each step off once screens have it (a spot
// from a template, a published default playlist with it, a screen that took a publish) and goes once
// all are done; then the page shows the org's status: a screen that needs someone, what screens
// report playing with its template's thumbnail, the drafts not published, and the latest publish.
// Hiding the checklist is kept on a reload; a 100-letter playlist name wraps on a phone; an editor
// where only owners publish sees the default as an owner's step; a failing poll says so. Axe at
// desktop and phone width, light and dark.
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, d1, hydrated, joinAsEditor, shots, signInAs, tool } from './helpers';

/** This spec's own client address, so its sign-ins and claims have their own rate limits. */
const ADDRESS = '192.0.2.211';
const EDITOR_ADDRESS = '192.0.2.212';

/** What the player in the tab says it plays (`window.__sf`). */
const player = (tab: Page) =>
  tab.evaluate(() => {
    const s = (window as Window & { __sf?: { pairing: string; playlist: string } }).__sf;
    return { pairing: s?.pairing ?? '', playlist: s?.playlist ?? '' };
  });

async function bothWidths(page: Page, name: string) {
  await axe(page);
  await shots(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, `${name}-phone`);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('a new org follows the setup checklist to a playing screen, and Overview shows its status', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, `e2e-overview-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Kestrel Lane', ADDRESS);

  const setup = page.getByRole('region', { name: 'Get your first spot on a screen' });
  await expect(setup).toContainText('0 of 3 done');
  await expect(setup.getByRole('listitem')).toHaveText([
    /Make a spot from a template \(to do\)/,
    /make that the default \(to do\)/,
    /Pair a screen.*\(to do\)/,
  ]);
  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('No screens are paired yet.');
  await expect(page.getByRole('region', { name: 'Unpublished drafts' })).toContainText('Everything is published.');
  await expect(page.getByRole('heading', { name: 'Sections' })).toHaveCount(0);
  await bothWidths(page, '110-overview-setup');

  // Step 1 opens New spot where spots are made.
  await setup.getByRole('link', { name: 'New spot' }).click();
  const dialog = page.getByRole('dialog', { name: 'New spot' });
  await expect(dialog).toBeVisible();
  await hydrated(page);
  await dialog.getByRole('radio', { name: 'Clock', exact: true }).check();
  await dialog.getByLabel('Name').fill('Opening');
  await dialog.getByRole('button', { name: 'Create spot' }).click();
  await expect(page.getByRole('heading', { name: 'Opening', level: 1 })).toBeVisible();
  const spotId = new URL(page.url()).pathname.split('/').at(-1);

  await page.goto('/');
  await expect(setup).toContainText('1 of 3 done');
  await expect(setup.getByRole('listitem').first()).toHaveText(/Make a spot from a template \(done\)/);
  await expect(page.getByRole('region', { name: 'Unpublished drafts' }).getByRole('link')).toHaveText([/Opening.*Spot · never published/]);

  // Step 2 ticks once a playlist with the spot is the default and published: a draft default plays nowhere.
  const { playlist } = await tool(page, 'create_playlist', { name: 'Opening week', transition: { type: 'cut' }, spotIds: [spotId] });
  await tool(page, 'set_default_playlist', { playlistId: playlist.id });
  await page.reload();
  await expect(setup).toContainText('1 of 3 done');
  await expect(setup.getByRole('link', { name: 'Open Opening week' })).toBeVisible();
  await tool(page, 'publish', {});
  await page.reload();
  await expect(setup).toContainText('2 of 3 done');

  // Step 3: a test screen, paired by its code, ticks once it has taken a publish; then the checklist goes.
  const screen = await (await browser.newContext()).newPage();
  await screen.goto('/test-screen/?kind=browser&content=/v1/device');
  await expect.poll(async () => (await player(screen)).pairing, { timeout: 20_000 }).not.toBe('');
  const claimed = await page.request.post('/api/tools/claim_screen', {
    headers: { 'cf-connecting-ip': ADDRESS },
    data: { code: (await player(screen)).pairing, name: 'Door', timezone: 'UTC', orientation: 'landscape' },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  const { screen: door } = (await claimed.json()) as { screen: { id: string } };
  await page.reload();
  await expect(setup).toContainText('2 of 3 done');
  // A new screen plays once a publish compiles for it: no draft, every screen compiled again.
  await tool(page, 'publish', { drafts: [] });
  await expect.poll(async () => (await player(screen)).playlist, { timeout: 30_000 }).not.toBe('');
  // The poll reads the list again once the screen reports the manifest: no reload.
  await expect(setup).toBeHidden({ timeout: 30_000 });
  const playing = page.getByRole('region', { name: 'Playing now' });
  await expect(playing.getByRole('link')).toHaveText([/Opening\s*On 1 screen · Opening week/]);
  await expect(playing.locator('img')).toHaveAttribute('src', '/template-thumbnails/clock.webp');
  await expect(page.getByRole('region', { name: 'Unpublished drafts' })).toContainText('Everything is published.');
  await expect(page.getByRole('region', { name: 'Needs you' })).toContainText('Nothing needs you.');

  // The screen goes quiet and misses the next publish (its last sync moved back in the run's local
  // D1, as screens.spec.ts does): it needs someone, and the page says why.
  await screen.context().close();
  await tool(page, 'update_spot', { spotId, name: 'Opening hours' });
  await page.reload();
  await expect(page.getByRole('region', { name: 'Unpublished drafts' }).getByRole('link')).toHaveText([/Opening hours.*Spot · changes not published/]);
  await tool(page, 'publish', {});
  await d1(`UPDATE screens SET last_seen_at = last_seen_at - ${30 * 60_000} WHERE id = '${door.id}'`);
  await page.reload();
  await expect(page.getByRole('region', { name: /Needs you/ }).getByRole('link')).toHaveText([/Door.*Unreachable and behind/]);
  // It has not taken the publish, so it is not counted as playing it; the finished checklist stays gone.
  await expect(page.getByRole('region', { name: 'Get your first spot on a screen' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Playing now' })).toContainText('None of the screens is playing its latest publish right now.');
  await expect(page.getByRole('region', { name: 'Latest publish' })).toBeVisible();
  await bothWidths(page, '111-overview-status');
});

test('a long playlist name wraps on a phone, hiding the checklist keeps it hidden, and a failing poll says so', async ({ page }) => {
  await signInAs(page, `e2e-overview-hide-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Kestrel Annex', ADDRESS);
  const setup = page.getByRole('region', { name: 'Get your first spot on a screen' });
  await expect(setup).toBeVisible();

  // Empty lists say what to do, with the one button that does it (#369): Spots, and Playlists with no spot to put in one.
  await page.goto('/spots');
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'Make your first spot from a template' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New spot' })).toHaveCount(1);
  await axe(page);
  await shots(page, '40-spots-empty');
  await page.goto('/playlists');
  await hydrated(page);
  const empty = page.getByRole('region', { name: 'Make a spot first, then a playlist' });
  await expect(page.getByRole('button', { name: 'New playlist' })).toHaveCount(0);
  await axe(page);
  await shots(page, '40-playlists-no-spots');
  await empty.getByRole('link', { name: 'New spot' }).click();
  await expect(page.getByRole('dialog', { name: 'New spot' })).toBeVisible();
  await page.goto('/');
  await hydrated(page);

  // The default's name is on its step's button: 100 letters, with no space to break at.
  const long = 'W'.repeat(100);
  const { playlist } = await tool(page, 'create_playlist', { name: long, transition: { type: 'cut' } });
  await tool(page, 'set_default_playlist', { playlistId: playlist.id });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await hydrated(page);
  await expect(setup.getByRole('link', { name: `Open ${long}` })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '112-overview-long-name-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('button', { name: 'Hide the setup checklist' }).click();
  await expect(setup).toBeHidden();
  await page.reload();
  await hydrated(page);
  await expect(setup).toBeHidden();
  await expect(page.getByRole('region', { name: 'Playing now' })).toContainText('No screen is playing anything yet.');

  // The status poll fails: the page says its status is not current, as Screens does.
  await page.route('**/_serverFn/**', (route) =>
    new URL(route.request().url()).pathname.startsWith('/_serverFn/getScreenStatus_') ? route.abort('connectionrefused') : route.fallback(),
  );
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Status is not current.' })).toBeVisible({ timeout: 20_000 });
  await axe(page);
  await page.unroute('**/_serverFn/**');
});

test('an editor where only owners publish sees the default as an owner’s step, with no button', async ({ page, browser }) => {
  const stamp = Date.now();
  const owner = await browser.newPage();
  await signInAs(owner, `e2e-overview-owner-${stamp}@example.com`, ADDRESS);
  await createOrg(owner, 'Kestrel Mews', ADDRESS);
  await tool(owner, 'update_org_settings', { editorsPublish: false });
  await joinAsEditor(owner, page, `e2e-overview-editor-${stamp}@example.com`, EDITOR_ADDRESS);
  await page.goto('/');
  await hydrated(page);
  const setup = page.getByRole('region', { name: 'Get your first spot on a screen' });
  const step = setup.getByRole('listitem').nth(1);
  await expect(step).toHaveText(/An owner sets the default \(for an owner\)/);
  await expect(step.getByRole('link')).toHaveCount(0);
  await axe(page);
});
