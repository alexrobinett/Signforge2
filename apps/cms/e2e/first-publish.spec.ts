// A new org's first publish from the Schedule (#243): with no default playlist chosen, Play on this
// screen (and Take over) say the publish makes its playlist the default, and Save and publish reaches the screen,
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
  // A takeover would make it the default too, and says so.
  await page.getByRole('button', { name: 'Take over this screen…' }).click();
  const takeover = page.getByRole('dialog', { name: 'Take over screens' });
  await takeover.getByLabel('Playlist').selectOption({ label: 'Opening week' });
  await expect(takeover.getByText('This organization has no default playlist yet. Taking over makes Opening week the default')).toBeVisible();
  await takeover.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Play on this screen…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule a playlist' });
  await dialog.getByLabel('Playlist').selectOption({ label: 'Opening week' });
  // Said before it happens.
  await expect(dialog.getByText('This organization has no default playlist yet. Save and publish makes Opening week the default')).toBeVisible();
  await axe(page);
  await shots(page, '58-first-publish-default');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '58-first-publish-default-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  await dialog.getByRole('button', { name: 'Save and publish' }).click();
  const told = page.locator('[data-sonner-toast]').filter({ hasText: /Published v\d+ to 1 screen/ });
  await expect(told).toBeVisible();
  await expect(told).toContainText('Opening week is now the default playlist');
  await expect(dialog).toBeHidden();
  const { playlists } = await tool(page, 'list_playlists', {});
  expect(playlists.find((p: { id: string }) => p.id === opening)).toMatchObject({ isDefault: true });
  // The screen plays it: a manifest was compiled and reached it.
  await expect.poll(async () => (await playing(screen))?.playlist ?? '', { timeout: 30_000 }).toBe(opening);

  // The audit log says it, and the What filter for a default playlist change finds that publish.
  await page.goto('/audit?what=set_default_playlist');
  await hydrated(page);
  await expect(page.getByRole('row', { name: /made Opening week the default playlist/ })).toBeVisible();
  await screen.context().close();
});
