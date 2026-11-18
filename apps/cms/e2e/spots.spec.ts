import { expect, test, type Page } from '@playwright/test';
import { png } from '@signforge/media/testing';
import { axe, fillUntilEnabled, hydrated, shots, signInAs } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.31';

/** Whether any frame on the page (the player's template frames included) shows `text`. */
async function stageShows(page: Page, text: string) {
  for (const frame of page.frames())
    if (
      (await frame
        .getByText(text, { exact: false })
        .count()
        .catch(() => 0)) > 0
    )
      return true;
  return false;
}

async function tool(page: Page, name: string, input: unknown) {
  const res = await page.request.post(`/api/tools/${name}`, { data: input });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-spots-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Northside Market', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Northside Market', level: 1 })).toBeVisible();
});

test.afterAll(() => page.context().close());

test('make a spot from a template, see it on the real player as you type, and keep it as a draft', async () => {
  test.setTimeout(120_000);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Spots' }).click();
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('combobox', { name: 'Template' }).selectOption({ label: 'Clock' });
  await page.getByLabel('Name').fill('Lobby clock');
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page).toHaveURL(/\/spots\/[^/?]+$/);
  await expect(page.getByRole('heading', { name: 'Lobby clock', level: 1 })).toBeVisible();

  const stage = page.getByRole('region', { name: 'Live preview' });
  await expect(stage.getByRole('status')).toHaveText('Draft. Not on any screen.');
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  await expect(stage.getByText('1920 × 1080 ·', { exact: false })).toBeVisible();

  // A keystroke reaches the player's frame without a round trip: measured from the fill.
  const greeting = page.getByLabel('Greeting (empty for good morning/afternoon/evening)');
  const typedAt = Date.now();
  await greeting.fill('Welcome to Northside');
  await expect.poll(() => stageShows(page, 'Welcome to Northside'), { intervals: [10], timeout: 5_000 }).toBe(true);
  const latency = Date.now() - typedAt;
  console.log(`stage updated ${latency} ms after the keystroke (Playwright's own polling included)`);
  expect(latency).toBeLessThan(1_000);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await axe(page);
  await shots(page, '30-spot-editor');

  // Invalid: the contract's message by the field, the stage keeps the last frame, nothing is saved.
  await greeting.fill('x'.repeat(41));
  await expect(page.getByText('field "greeting" is longer than 40')).toBeVisible();
  await expect(greeting).toHaveAttribute('aria-invalid', 'true');
  await expect(stage.getByText('Holding the last valid frame until the marked field is fixed.')).toBeVisible();
  await expect(page.getByText('Not saved: fix the marked field')).toBeVisible();
  expect(await stageShows(page, 'Welcome to Northside')).toBe(true);
  await axe(page);
  await shots(page, '31-spot-editor-invalid');
  await greeting.fill('Good to see you');
  await expect.poll(() => stageShows(page, 'Good to see you'), { timeout: 5_000 }).toBe(true);
  await expect(page.getByText(/Saved \d/)).toBeVisible();

  // Portrait, carried in the URL.
  await stage.getByRole('button', { name: 'Portrait' }).click();
  await expect(page).toHaveURL(/[?&]o=portrait/);
  await expect(stage.getByText('1080 × 1920 ·', { exact: false })).toBeVisible();
  await expect.poll(() => stageShows(page, 'Good to see you'), { timeout: 30_000 }).toBe(true);
  await axe(page);
  await shots(page, '32-spot-editor-portrait');

  // The draft was saved: a reload opens it as it was left.
  await page.reload();
  await expect(page.getByLabel('Greeting (empty for good morning/afternoon/evening)')).toHaveValue('Good to see you');
  await page.getByRole('link', { name: 'Spots' }).first().click();
  await expect(page.getByRole('link', { name: /Lobby clock/ })).toContainText('Clock · Draft, never published');
});

test('a change someone else made while the editor was open is not overwritten', async () => {
  test.setTimeout(60_000);
  await page.getByRole('link', { name: /Lobby clock/ }).click();
  await hydrated(page);
  const url = new URL(page.url());
  const spotId = url.pathname.split('/').at(-1);
  // Stands in for an agent: a change lands after the page read the spot.
  await tool(page, 'update_spot', { spotId, data: { message: 'From the agent' } });
  await page.getByLabel('Message').fill('From the person');
  await expect(page.getByText('This changed since you opened it.')).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByLabel('Message')).toHaveValue('From the agent');
});

test('every base template can be configured and previewed', async () => {
  test.setTimeout(300_000);
  // One image for the templates' image fields.
  await page.goto('/assets');
  await hydrated(page);
  await page.getByLabel('Upload images').setInputFiles([{ name: 'berries.png', mimeType: 'image/png', buffer: await png(800, 450) }]);
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(1, { timeout: 60_000 });
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  expect(templates.length).toBeGreaterThanOrEqual(7);
  // A desktop-sized window: below about half scale cstore-promo misses the player's 2 s ready
  // timeout on the stage (see docs/tickets/M3-16-spot-editor.md, What is left).
  await page.setViewportSize({ width: 1920, height: 1200 });
  for (const t of templates) {
    const v = t.versions.findLast((x: { status: string }) => x.status === 'approved');
    const fields = Object.entries(v.manifest.fields as Record<string, { type: string; label: string; maxLength?: number }>);
    await page.goto('/spots');
    await hydrated(page);
    await page.getByRole('button', { name: 'New spot' }).click();
    await page.getByRole('combobox', { name: 'Template' }).selectOption({ label: t.name });
    await page.getByLabel('Name').fill(`${t.name} spot`);
    await page.getByRole('button', { name: 'Create spot' }).click();
    await expect(page.getByRole('heading', { name: `${t.name} spot`, level: 1 })).toBeVisible();
    await hydrated(page);
    for (const [, def] of fields.filter(([, d]) => d.type === 'image')) {
      await page.getByRole('button', { name: `Choose image for ${def.label}` }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /berries\.png/ })
        .click();
    }
    const stage = page.getByRole('region', { name: 'Live preview' });
    await expect(stage.getByText('Drawn by the player your screens run.'), t.key).toBeVisible({ timeout: 30_000 });
    // A text field changed in the form reaches the stage.
    const text = fields.find(([, d]) => d.type === 'text' && (d.maxLength ?? 99) >= 6);
    if (text) {
      await page.locator(`#field-${text[0]}`).fill('Edited');
      await expect.poll(() => stageShows(page, 'Edited'), { message: t.key, timeout: 10_000 }).toBe(true);
      await expect(page.getByText(/Saved \d/), t.key).toBeVisible();
    }
    await axe(page);
    await shots(page, `33-template-${t.key}`);
  }
  // At phone width the form and the stage stack.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Live preview' })).toBeVisible();
  await axe(page);
  await shots(page, '34-spot-editor-phone');
});
