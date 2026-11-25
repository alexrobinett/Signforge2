// The agent's fill from a flyer, a photo or a link (#263), against the Anthropic stub's scripted
// answer (e2e/global-setup.ts): no test reaches a real model. The link is a page in FEEDS_DIR, which
// every fetch through the API's guards reaches in dev.
import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { rotatedPhoto } from '@signforge/media/testing';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';
import { ANTHROPIC_STUB_KEY, ANTHROPIC_STUB_MODELS, FEEDS_DIR, STUB_FILL } from './servers';

const ADDRESS = '192.0.2.160';
const LINK = 'https://harbour-bakery.example/bake-sale.html';

test('a member fills a new spot from a link and from a photo, checks the marked fields, and the log says it was the agent (#263)', async ({ page }) => {
  await signInAs(page, `e2e-fill-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbour Lane Bakery', ADDRESS);
  writeFileSync(
    `${FEEDS_DIR}bake-sale.html`,
    '<html><head><title>Bake sale</title></head><body><h1>Harbour bake sale</h1><p>Saturday. Scones, tea and a raffle, $2.50.</p></body></html>',
  );

  // No model yet: the dialog says so, and where an owner sets one.
  await page.goto('/spots');
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  const dialog = page.getByRole('dialog');
  // One filled button in the dialog, Create spot; filling from a flyer is the other way in (#364).
  await expect(dialog.locator('[data-slot="button"][data-variant="default"]')).toHaveText(['Create spot']);
  // Grouped by its heading and space, not a box inside the dialog (#377).
  const fillSection = dialog.getByRole('region', { name: 'Start from a flyer, photo or link' });
  expect(await fillSection.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('0px');
  await dialog.getByLabel('Or a link').fill(LINK);
  await expect(dialog.getByRole('button', { name: 'Fill a new spot' })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await dialog.getByRole('button', { name: 'Fill a new spot' }).click();
  await expect(dialog.getByRole('alert')).toContainText('No model is set up for the agent yet');
  await expect(dialog.getByRole('link', { name: 'Open Settings, AI & agents' })).toBeVisible();
  await axe(page);
  await dialog.evaluate((el) => el.scrollTo(0, 0));
  await shots(page, '98-fill-dialog');

  // The owner's own key, through the stub.
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, fastModel: ANTHROPIC_STUB_MODELS[0] });
  await dialog.getByRole('button', { name: 'Fill a new spot' }).click();
  await expect(page.getByRole('heading', { name: STUB_FILL.name, level: 1 })).toBeVisible();
  await hydrated(page);
  const banner = page.getByRole('region', { name: 'Filled by the agent from your link' });
  await expect(banner).toContainText('3 filled · 1 to check · 1 not filled');
  await expect(page.getByLabel('Headline')).toHaveValue(STUB_FILL.headline);
  await expect(page.getByLabel('Price tag')).toHaveValue(STUB_FILL.price);
  await expect(page.locator('[data-mark="check"]')).toHaveCount(1);
  await axe(page);
  await shots(page, '98-fill-marked');
  await page.setViewportSize({ width: 390, height: 844 });
  await shots(page, '98-fill-marked-phone');
  await page.setViewportSize({ width: 1280, height: 800 });

  // An edit takes its field's mark away; Done takes the rest.
  await expect(page.locator('[data-mark]')).toHaveCount(5);
  await page.getByLabel('Price tag').fill('$3');
  await expect(page.locator('[data-mark]')).toHaveCount(4);
  await banner.getByRole('button', { name: 'Done' }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator('[data-mark]')).toHaveCount(0);

  // From a photo: the agent fills it, and the photo goes up as any image does only when asked.
  await page.goto('/spots');
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await dialog.locator('input[type="file"]').setInputFiles([{ name: 'flyer.jpg', mimeType: 'image/jpeg', buffer: await rotatedPhoto() }]);
  await dialog.getByRole('button', { name: 'Fill a new spot' }).click();
  await expect(page.getByRole('region', { name: 'Filled by the agent from your photo' })).toBeVisible();
  await hydrated(page);
  expect((await tool(page, 'list_assets', {})).assets).toEqual([]);
  await page.getByRole('button', { name: 'Use as the photo' }).click();
  await expect(page.getByRole('button', { name: 'Use as the photo' })).toBeHidden({ timeout: 60_000 });
  await expect.poll(async () => (await tool(page, 'list_assets', {})).assets.length).toBe(1);

  // Undo the fill: the draft is back to a new spot's start.
  await page.getByRole('button', { name: 'Undo the fill' }).click();
  await expect(page.getByLabel('Headline')).toHaveValue('');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Photo Promo');

  // The log names the member, and that it was the agent.
  await page.goto('/audit');
  await hydrated(page);
  await expect(page.getByRole('cell', { name: 'You via agent' }).first()).toBeVisible();
});
