import { expect, test, type Page } from '@playwright/test';
import { png } from '@signforge/media/testing';
import { axe, createOrg, hydrated, shots, signInAs, stageShows, tool } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.130';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-spots-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Diner');
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
  await expect(stage.getByRole('status')).toHaveText('The draft, as a screen would show it. Screens play what is published.');
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

/** Whether a template frame shows `city` in its `.city` and is playing: the draft is on the stage. */
async function stagePlays(page: Page, city: string) {
  for (const frame of page.frames())
    if (
      await frame
        .evaluate(
          (city) =>
            !!document.documentElement.style.getPropertyValue('--sf-duration') &&
            document.querySelector('.city')?.textContent === city &&
            document.getAnimations().some((a) => a.playState === 'running'),
          city,
        )
        .catch(() => false)
    )
      return true;
  return false;
}

/**
 * The weather preview at every time of day, each checked by axe: its scene follows sunrise, sunset
 * and the clock (#70), so they are set around the test's own clock, and every phase shows whenever
 * the test runs. Each phase is named in the city field, so the stage is known to show it.
 */
async function weatherAllDay() {
  const now = Math.floor(Date.now() / 1000);
  const h = 3600;
  const phases: [string, Record<string, number>][] = [
    ['Day', { code: 1, isDay: 1, sunrise: 0, sunset: 0 }],
    ['Night', { code: 71, isDay: 0, sunrise: 0, sunset: 0 }],
    ['Dawn', { code: 0, sunrise: now + 600, sunset: now + 10 * h }],
    ['Midday', { code: 2, sunrise: now - 5 * h, sunset: now + 5 * h }],
    ['Dusk', { code: 63, sunrise: now - 10 * h, sunset: now - 600 }],
    ['Midnight', { code: 0, sunrise: now - 14 * h, sunset: now - 4 * h }],
  ];
  // The fields a feed would fill are the fallback values, under "If the source is down": with no
  // source bound, they are what the stage plays.
  const fallback = page.getByRole('button', { name: 'If the source is down' });
  if ((await fallback.getAttribute('aria-expanded')) !== 'true') await fallback.click();
  for (const [phase, values] of phases) {
    for (const [field, value] of Object.entries(values)) await page.locator(`#field-${field}`).fill(String(value));
    await page.locator('#field-city').fill(phase);
    // On the stage, not just in the page: the form's own labels hold "Day" and "Night".
    await expect.poll(() => stagePlays(page, phase), { message: `weather at ${phase}`, timeout: 10_000 }).toBe(true);
    // Where CI's axe once caught the preview (run 44430579357): 0.87 s into a play, the forecast's last
    // row a third of the way into its fade-in, at 2.68:1. axe must read text as it rests, not mid-fade.
    for (const frame of page.frames())
      await frame
        .evaluate(() => {
          if (!document.documentElement.style.getPropertyValue('--sf-duration')) return;
          for (const a of document.getAnimations()) {
            a.pause();
            a.currentTime = 870;
          }
        })
        // A frame the player removed in the meantime.
        .catch(() => undefined);
    await axe(page);
  }
}

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
    const fields = Object.entries(v.manifest.fields as Record<string, { type: string; label: string; maxLength?: number; default?: unknown }>);
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
    // A date with no default starts unpicked, and the spot is held back until one is (Countdown's target).
    for (const [name, def] of fields.filter(([, d]) => (d.type === 'date' || d.type === 'datetime') && d.default === undefined))
      await page.locator(`#field-${name}`).fill(def.type === 'date' ? '2026-12-24' : '2026-12-24T18:00');
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
    if (t.key === 'weather') await weatherAllDay();
  }
  // At phone width the form and the stage stack.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Live preview' })).toBeVisible();
  await axe(page);
  await shots(page, '34-spot-editor-phone');
});

test('make an Announcement in a look, with a QR code, and see both on the real player', async () => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Spots' }).click();
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('combobox', { name: 'Template' }).selectOption({ label: 'Announcement' });
  await page.getByLabel('Name').fill('Pier 9 opening');
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page.getByRole('heading', { name: 'Pier 9 opening', level: 1 })).toBeVisible();
  await hydrated(page);
  // Every image field needs an image, the photo too: the one the test above uploaded.
  await page.getByRole('button', { name: 'Choose image for Photo' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /berries\.png/ })
    .click();
  const stage = page.getByRole('region', { name: 'Live preview' });
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });

  await page.getByLabel('Look').selectOption('night');
  await page.getByLabel('Headline').fill('Pier 9 opens Monday');
  await expect.poll(() => stageShows(page, 'Pier 9 opens Monday'), { timeout: 10_000 }).toBe(true);
  // No address, no code: it appears once one is typed, named by its label.
  const qr = async () => {
    for (const frame of page.frames())
      if (
        await frame
          .getByRole('img', { name: 'Scan for the floor plan' })
          .count()
          .catch(() => 0)
      )
        return true;
    return false;
  };
  expect(await qr()).toBe(false);
  await page.getByLabel('QR code link').fill('https://example.com/pier-9');
  await expect.poll(qr, { timeout: 10_000 }).toBe(true);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await axe(page);
});
