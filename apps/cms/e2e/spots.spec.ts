import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Request } from '@playwright/test';
import { png } from '@signforge/media/testing';
import { axe, createOrg, hydrated, shots, signInAs, stageShows, tool } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.130';
const TEMPLATES_DIR = fileURLToPath(new URL('../../../templates/', import.meta.url));

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-spots-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Diner', ADDRESS);
});

test.afterAll(() => page.context().close());

test('choose a template by its thumbnail, by keyboard alone, in two columns on a phone (#259)', async () => {
  await page.goto('/spots');
  await hydrated(page);
  const opener = page.getByRole('button', { name: 'New spot' });
  const dialog = page.getByRole('dialog', { name: 'New spot' });
  const radios = dialog.getByRole('group', { name: 'Template' }).getByRole('radio');

  // Every base template in templates/ shows the thumbnail the player drew, from the CMS's own assets.
  await opener.click();
  await expect(radios.first()).toBeChecked();
  const base = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d): { id: string; name: string } => JSON.parse(readFileSync(join(TEMPLATES_DIR, d.name, 'template.json'), 'utf8')));
  expect(base.length).toBeGreaterThan(0);
  for (const t of base) {
    const tile = dialog.locator('label').filter({ has: page.getByRole('radio', { name: t.name, exact: true }) });
    const image = tile.locator('img');
    await expect(image, t.name).toHaveAttribute('src', `/template-thumbnails/${t.id}.webp`);
    await expect(image, t.name).toHaveJSProperty('complete', true);
    expect(await image.evaluate((i) => i instanceof HTMLImageElement && i.naturalWidth > 0), t.name).toBe(true);
  }
  await axe(page);
  await shots(page, '29-new-spot-thumbnails');
  // Escape closes it, and focus goes back to what opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Two columns at phone width.
  await page.setViewportSize({ width: 390, height: 844 });
  await opener.click();
  // Once the dialog's zoom-in has finished, the first three tiles, measured at one moment: measured one by one, mid-animation, two tiles of a row came out half a pixel apart.
  await dialog.evaluate((d) => Promise.all(d.getAnimations({ subtree: true }).map((a) => a.finished)));
  const { a, b, c } = await dialog.getByRole('group', { name: 'Template' }).evaluate((g) => {
    const [a, b, c] = [...g.querySelectorAll('label')].map((l) => ({ x: l.getBoundingClientRect().x, y: l.getBoundingClientRect().y }));
    return { a: a!, b: b!, c: c! };
  });
  expect(b.y).toBe(a.y);
  expect(b.x).toBeGreaterThan(a.x);
  expect(c.y).toBeGreaterThan(a.y);
  expect(c.x).toBe(a.x);
  await axe(page);
  await shots(page, '29-new-spot-thumbnails-phone');
  // Wait for the close to finish: reopened mid-close, the steps below can land on the closing dialog.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });

  // Keyboard only: Enter on a template with no name goes to the name; then back, an arrow moves the choice, Enter creates.
  await opener.focus();
  await page.keyboard.press('Enter');
  await radios.first().focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Name')).toBeFocused();
  await page.keyboard.type('Picked by keyboard');
  await page.keyboard.press('Shift+Tab');
  await expect(radios.first()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Picked by keyboard', level: 1 })).toBeVisible();
});

test('make a spot from a template, see it on the real player as you type, and keep it as a draft', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Spots' }).click();
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('radio', { name: 'Clock', exact: true }).check();
  await page.getByLabel('Name').fill('Lobby clock');
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page).toHaveURL(/\/spots\/[^/?]+$/);
  await expect(page.getByRole('heading', { name: 'Lobby clock', level: 1 })).toBeVisible();

  const stage = page.getByRole('region', { name: 'Live preview' });
  await expect(stage.getByRole('status')).toHaveText('The draft, as a screen would show it. Screens play what is published.');
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  await expect(stage.getByText('1920 × 1080 ·', { exact: false })).toBeVisible();

  // A keystroke reaches the player's frame without a round trip: no request but the autosave's goes
  // out before the stage shows it. The time is logged, not asserted.
  const greeting = page.getByLabel('Greeting (empty for good morning/afternoon/evening)');
  const trips: string[] = [];
  const trip = (r: Request) => void (!r.url().endsWith('/api/tools/update_spot') && trips.push(r.url()));
  page.on('request', trip);
  const typedAt = Date.now();
  await greeting.fill('Welcome to Northside');
  await expect.poll(() => stageShows(page, 'Welcome to Northside'), { intervals: [10] }).toBe(true);
  page.off('request', trip);
  console.log(`stage updated ${Date.now() - typedAt} ms after the keystroke (Playwright's own polling included)`);
  expect(trips).toEqual([]);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await axe(page);
  await shots(page, '30-spot-editor');

  // Invalid: the problem by the field in words (#359), the stage keeps the last frame and says why, nothing is saved.
  await greeting.fill('x'.repeat(41));
  const tooLong = 'Greeting (empty for good morning/afternoon/evening) is longer than 40 characters.';
  await expect(page.locator('#field-greeting-error')).toHaveText(tooLong);
  await expect(greeting).toHaveAttribute('aria-invalid', 'true');
  await expect(stage.getByText(`Holding the last valid frame. ${tooLong}`)).toBeVisible();
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
    await page.getByRole('radio', { name: t.name, exact: true }).check();
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
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Spots' }).click();
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('radio', { name: 'Announcement', exact: true }).check();
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
  // Its label starts empty, as all its text does (#253).
  await page.getByLabel('QR code label').fill('Scan for the floor plan');
  await page.getByLabel('QR code link').fill('https://example.com/pier-9');
  await expect.poll(qr, { timeout: 10_000 }).toBe(true);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await axe(page);
});

test('an Announcement with its photo off draws once the stage is in view, and the player is not asked to draw it out of view (#342)', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const announcement = templates.find((t: { key: string }) => t.key.endsWith('announcement') || t.key === 'announcement');
  const { spot } = await tool(page, 'create_spot', {
    name: 'No photo',
    kind: 'template',
    templateVersionId: announcement.versions.at(-1).id,
    data: { showPhoto: false },
  });
  const skipped: string[] = [];
  const listen = (m: { text(): string }) => m.text().includes('[sf] skipped') && skipped.push(m.text());
  page.on('console', listen);
  await page.goto(`/spots/${spot.id}`);
  await hydrated(page);
  // The form is long: at 720 px the stage starts below the fold, where a browser runs no animation frames.
  const stage = page.getByRole('region', { name: 'Live preview' });
  expect(await stage.evaluate((el) => el.getBoundingClientRect().top > innerHeight)).toBe(true);
  await stage.scrollIntoViewIfNeeded();
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  page.off('console', listen);
  expect(skipped).toEqual([]);

  // #359: the photo turned on says nothing under its field until Publish, then says it in words; the choice by its label.
  await expect(page.getByLabel('Look').locator('option:checked')).toHaveText('Pop');
  await page.getByLabel('Show the photo').check();
  // The stage draws once back in view: it keeps the frame it drew, and says why in the same words.
  await stage.scrollIntoViewIfNeeded();
  await expect(stage.getByText('Holding the last valid frame. No image for Photo: choose one, or untick Show the photo.')).toBeVisible();
  const photoError = page.locator('#field-photo-error');
  await expect(photoError).toBeEmpty();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(photoError).toHaveText('No image for Photo: choose one, or untick Show the photo.');
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 720 });
});

const site = async (name: string) => (await tool(page, 'create_spot', { name, kind: 'url', url: 'https://example.com/board' })).spot.id as string;

/** The spot's editor, with Delete pressed: its confirmation. */
async function askToDelete(spotId: string) {
  await page.goto(`/spots/${spotId}`);
  await hydrated(page);
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  return page.getByRole('alertdialog');
}

test('a spot no playlist plays is deleted after its confirmation, at desktop and phone width (#242)', async () => {
  const spotId = await site('Old opening hours');
  const dialog = await askToDelete(spotId);
  await expect(dialog).toContainText('Delete Old opening hours?');
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  // Cancel leaves it.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/spots$/);
  await hydrated(page);
  await expect(page.getByRole('link', { name: /Old opening hours/ })).toHaveCount(0);
  const { entries } = await tool(page, 'list_audit_log', { limit: 5 });
  expect(entries[0]).toMatchObject({ action: 'delete_spot', target: { kind: 'spot', id: spotId } });
});

test('a spot a playlist plays is refused, naming the playlist with a link to it, and kept (#242)', async () => {
  const spotId = await site('Weekend specials');
  const { playlist } = await tool(page, 'create_playlist', { name: 'Saturday loop', spotIds: [spotId] });
  const dialog = await askToDelete(spotId);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Playlists play this spot, so it cannot be deleted');
  await expect(dialog.getByRole('link', { name: 'Saturday loop' })).toBeVisible();
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  expect((await tool(page, 'get_spot', { spotId })).spot.name).toBe('Weekend specials');

  await dialog.getByRole('link', { name: 'Saturday loop' }).click();
  await expect(page).toHaveURL(new RegExp(`/playlists/${playlist.id}$`));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
