// A new org's first publish from the Schedule (#243): with no default playlist chosen, Take over and
// Play on this screen (narrower than every screen at all hours) ask for one first, prefilled with their
// playlist (owner decision); Save and publish makes it the default, publishes, and reaches the screen,
// which plays it, instead of compiling no manifest and leaving it blank. Axe at desktop and phone.
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';

/** This spec's own client address, so its sign-ins have their own rate limits. */
const ADDRESS = '192.0.2.181';

/** What the player in the tab says it plays (`window.__sf`). */
const playing = (tab: Page) =>
  tab.evaluate(() => {
    const s = (window as Window & { __sf?: { pairing: string; playlist: string } }).__sf;
    return s ? { pairing: s.pairing, playlist: s.playlist } : undefined;
  });

test('a new org with no default playlist plays a playlist on its screen: the publish makes it the default and reaches the screen', async ({
  page,
  browser,
}) => {
  await signInAs(page, `e2e-first-publish-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Juniper Row', ADDRESS);
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock')).versions.at(-1).id;
  const { spot } = await tool(page, 'create_spot', {
    name: 'Opening',
    kind: 'template',
    templateVersionId: clock,
    durationMs: 10_000,
    data: { greeting: 'Opening' },
  });
  const {
    playlist: { id: opening },
  } = await tool(page, 'create_playlist', { name: 'Opening week', transition: { type: 'cut' }, spotIds: [spot.id] });

  // A test screen, paired by its code, as the Screens page pairs one. No default playlist is chosen.
  const screen = await (await browser.newContext()).newPage();
  await screen.goto('/test-screen/?kind=browser&content=/v1/device');
  await expect.poll(async () => (await playing(screen))?.pairing ?? '', { timeout: 20_000 }).not.toBe('');
  // Claimed from this spec's own address: `tool` posts from the one every spec shares, and claims
  // are limited per address (10 a minute), which the specs running beside this one use up.
  const claimed = await page.request.post('/api/tools/claim_screen', {
    headers: { 'cf-connecting-ip': ADDRESS },
    data: { code: (await playing(screen))!.pairing, name: 'Door', timezone: 'UTC', orientation: 'landscape' },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  const { screen: paired } = (await claimed.json()) as { screen: { id: string } };

  await page.goto(`/screens/${paired.id}`);
  await hydrated(page);
  // A takeover asks for a default first, prefilled with its playlist (owner decision on #243).
  await page.getByRole('button', { name: 'Take over this screen…' }).click();
  const takeover = page.getByRole('dialog', { name: 'Take over screens' });
  await takeover.getByLabel('Playlist', { exact: true }).selectOption({ label: 'Opening week' });
  await expect(takeover.getByLabel('Default playlist', { exact: true })).toHaveValue(opening);
  await expect(takeover.getByText('Taking over makes the one chosen here the default first.')).toBeVisible();
  await takeover.getByRole('button', { name: 'Cancel' }).click();

  // So does Play on this screen: an entry on one screen is narrower than a default.
  await page.getByRole('button', { name: 'Play on this screen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a playlist' });
  await dialog.getByLabel('Playlist', { exact: true }).selectOption({ label: 'Opening week' });
  const choice = dialog.getByLabel('Default playlist', { exact: true });
  await expect(choice).toHaveValue(opening);
  await expect(choice).toHaveAccessibleDescription(/no default playlist yet.*Save and publish makes the one chosen here the default first/);
  await axe(page);
  await shots(page, '58-first-publish-default');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '58-first-publish-default-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Yes, as prefilled: it is made the default, then the entry is published, and reaches the screen.
  await dialog.getByRole('button', { name: 'Save and publish' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Published v\d+ to 1 screen/ })).toBeVisible();
  await expect(dialog).toBeHidden();
  const { playlists } = await tool(page, 'list_playlists', {});
  expect(playlists.find((p: { id: string }) => p.id === opening)).toMatchObject({ isDefault: true });
  // The screen plays it: a manifest was compiled and reached it.
  await expect.poll(async () => (await playing(screen))?.playlist ?? '', { timeout: 30_000 }).toBe(opening);

  // The audit log has the person's choice, under the What filter for a default playlist change.
  await page.goto('/audit?what=set_default_playlist');
  await hydrated(page);
  await expect(page.getByRole('row', { name: /Made the default/ })).toBeVisible();
  await screen.context().close();
});
