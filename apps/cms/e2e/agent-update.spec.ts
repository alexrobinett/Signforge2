// The agent's update of a spot from a photo or link (#264), against the Anthropic stub's scripted
// menu (e2e/global-setup.ts, STUB_MENU): no test reaches a real model. The link is a page in
// FEEDS_DIR, which every fetch through the API's guards reaches in dev.
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';
import { ANTHROPIC_STUB_KEY, ANTHROPIC_STUB_MODELS, FEEDS_DIR } from './servers';

const ADDRESS = '192.0.2.168';
const LINK = 'https://corner-bakehouse.example/today.html';

const BREAKFAST = [
  { name: 'Latte', description: '', price: '$4.50', tag: 'Popular' },
  { name: 'Mocha', description: '', price: '$5.00', tag: '' },
  { name: 'Scone', description: '', price: '$3.00', tag: '' },
];

/** A Menu Board spot with these items; its id. */
async function menuSpot(page: Page, name: string, items: Record<string, unknown>[]) {
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const menu = templates.find((t: { key: string }) => t.key === 'menu-board');
  const { spot } = await tool(page, 'create_spot', {
    name,
    kind: 'template',
    templateVersionId: menu.versions.at(-1).id,
    data: { title: name, items },
    idempotencyKey: crypto.randomUUID(),
  });
  return spot.id as string;
}

/** Opens Fill from a flyer in the editor, reads the link, and waits for the review. */
async function fillFromLink(page: Page) {
  await page.getByRole('button', { name: 'Fill from a flyer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Fill from a flyer, photo or link' });
  await dialog.getByLabel('Or a link').fill(LINK);
  await dialog.getByRole('button', { name: 'Read it' }).click();
  await expect(page.getByRole('region', { name: /What the agent would change/ })).toBeVisible();
}

test("a member updates a menu from today's, sees each row it changes before anything is kept, keeps it, undoes it, and reviews the same row on another menu (#264)", async ({
  page,
}) => {
  await signInAs(page, `e2e-update-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Corner Bakehouse', ADDRESS);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, fastModel: ANTHROPIC_STUB_MODELS[0] });
  writeFileSync(`${FEEDS_DIR}today.html`, '<html><body><h1>Today</h1><p>Latte $4.75 · Scone $3.00 · Flat white $4.00</p></body></html>');
  const breakfast = await menuSpot(page, 'Breakfast', BREAKFAST);
  const lunch = await menuSpot(page, 'Lunch menu', [
    { name: 'Soup', description: '', price: '$6.00', tag: '' },
    { name: 'Latte', description: '', price: '$4.50', tag: '' },
  ]);

  await page.goto(`/spots/${breakfast}`);
  await hydrated(page);
  await fillFromLink(page);
  const review = page.getByRole('region', { name: /What the agent would change/ });
  await expect(review.locator('[data-row="changed"]')).toContainText('Latte');
  await expect(review.locator('[data-row="changed"]')).toContainText('$4.50 → $4.75');
  await expect(review.locator('[data-row="added"]')).toContainText('Flat white · $4.00');
  await expect(review.locator('[data-row="removed"]')).toContainText('Mocha · $5.00');
  await expect(review).toContainText('Latte is also on Lunch menu');
  // Nothing saved before Keep.
  expect((await tool(page, 'get_spot', { spotId: breakfast })).spot.data.items).toEqual(BREAKFAST);
  await axe(page);
  await shots(page, '99-update-review');

  // On a phone the stage plays the change first, and the review's actions stay in view.
  await page.setViewportSize({ width: 390, height: 844 });
  const stage = page.getByTitle(/^Preview, landscape/);
  const keep = review.getByRole('button', { name: 'Keep in the draft' });
  expect((await stage.boundingBox())!.y).toBeLessThan((await review.boundingBox())!.y);
  await review.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(keep).toBeInViewport();
  await shots(page, '99-update-review-phone');
  await page.setViewportSize({ width: 1280, height: 800 });

  await keep.click();
  const banner = page.getByRole('region', { name: 'Updated by the agent' });
  await expect(banner).toContainText('1 field changed');
  // Exactly what the review showed: the latte dearer, its tag kept, the mocha gone, the flat white after the rest.
  const kept = [
    { name: 'Latte', description: '', price: '$4.75', tag: 'Popular' },
    { name: 'Scone', description: '', price: '$3.00', tag: '' },
    { name: 'Flat white', description: '', price: '$4.00', tag: '' },
  ];
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId: breakfast })).spot.data.items).toEqual(kept);
  await expect(page.locator('[data-mark="filled"]')).toHaveCount(1);
  await shots(page, '99-update-kept');

  // Undo puts back exactly what Keep changed.
  await banner.getByRole('button', { name: 'Undo the update' }).click();
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId: breakfast })).spot.data.items).toEqual(BREAKFAST);

  // Again, then the same latte on the lunch menu.
  await fillFromLink(page);
  await page.getByRole('button', { name: 'Keep in the draft' }).click();
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Review Lunch menu' }).click();
  await expect(page).toHaveURL(new RegExp(`/spots/${lunch}$`));
  const other = page.getByRole('region', { name: /What the agent would change, from the same rows on another spot/ });
  await expect(other.locator('[data-row="changed"]')).toContainText('$4.50 → $4.75');
  await expect(other.locator('[data-row="added"], [data-row="removed"]')).toHaveCount(0);
  await other.getByRole('button', { name: 'Keep in the draft' }).click();
  await expect
    .poll(async () => (await tool(page, 'get_spot', { spotId: lunch })).spot.data.items)
    .toEqual([
      { name: 'Soup', description: '', price: '$6.00', tag: '' },
      { name: 'Latte', description: '', price: '$4.75', tag: '' },
    ]);

  // A save made since the review was read is kept: Keep is refused, and Reload shows it.
  // The breakfast menu is already as the link has it: its items back first, so the link changes it again.
  const was = (await tool(page, 'get_spot', { spotId: breakfast })).spot;
  await tool(page, 'update_spot', { spotId: breakfast, data: { ...was.data, items: BREAKFAST }, ifVersion: was.version });
  await page.goto(`/spots/${breakfast}`);
  await hydrated(page);
  await fillFromLink(page);
  const now = (await tool(page, 'get_spot', { spotId: breakfast })).spot;
  await tool(page, 'update_spot', { spotId: breakfast, data: { ...now.data, title: 'Their title' }, ifVersion: now.version });
  await page.getByRole('button', { name: 'Keep in the draft' }).click();
  await expect(page.getByRole('region', { name: /What the agent would change/ }).getByRole('alert')).toContainText('Their change is kept');
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Their title');
  expect((await tool(page, 'get_spot', { spotId: breakfast })).spot.data.title).toBe('Their title');
});
