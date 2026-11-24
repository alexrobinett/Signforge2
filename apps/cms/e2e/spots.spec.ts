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

test('with no spots, the empty state has New spot and the template gallery under it; a template opens New spot with it picked (#362, #369)', async () => {
  await page.goto('/spots');
  await hydrated(page);
  await expect(page.getByRole('region', { name: 'Make your first spot from a template' })).toBeVisible();
  // One filled button on the page, New spot; the gallery's templates are outlined tiles.
  await expect(page.getByRole('main').locator('[data-slot="button"][data-variant="default"]')).toHaveAccessibleName('New spot');
  const gallery = page.getByRole('region', { name: 'Templates' });
  const clock = gallery.getByRole('button', { name: 'Clock', exact: true });
  await expect(clock.locator('img')).toHaveAttribute('src', '/template-thumbnails/clock.webp');
  await axe(page);
  await shots(page, '28-spots-gallery');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '28-spots-gallery-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  // By keyboard: the card opens New spot with Clock picked, and Escape gives focus back to the card.
  await clock.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New spot' });
  await expect(dialog.getByRole('group', { name: 'Template' }).getByRole('radio', { name: 'Clock', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(clock).toBeFocused();
});

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

  // Keyboard only. The name follows the template until one is typed (#360). Cleared, Create says
  // why it is off, and Enter on a template goes to the name; then back, an arrow moves the choice, Enter creates.
  const templateName = (i: number) => dialog.getByRole('group', { name: 'Template' }).locator('label').nth(i).textContent();
  const name = dialog.getByLabel('Name');
  const create = dialog.getByRole('button', { name: 'Create spot' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(name).toHaveValue((await templateName(0))?.trim() ?? '');
  await radios.nth(1).check();
  await expect(name).toHaveValue((await templateName(1))?.trim() ?? '');
  await name.fill('');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAccessibleDescription('Give the spot a name first.');
  await radios.first().check();
  await expect(name).toHaveValue('');
  await page.keyboard.press('Enter');
  await expect(name).toBeFocused();
  await page.keyboard.type('Picked by keyboard');
  await expect(create).toBeEnabled();
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
  await expect(stage.getByText('The draft, as a screen would show it. Screens play what is published.')).toBeVisible();
  // What the stage is doing, said politely as it changes.
  await expect(stage.getByRole('status')).toHaveText(/Drawing…|Drawn by the player your screens run\./);
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
  await expect(page.getByRole('link', { name: /Lobby clock/ }).locator('img')).toHaveAttribute('src', '/template-thumbnails/clock.webp');
  // A template the player drew no thumbnail for: its name, clamped, in a frame that stays 16:9 in the row's 64 px slot.
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const fixture = templates.find((t: { name: string }) => t.name === 'Weather and headlines (test)').versions.at(-1).id;
  const { spot: undrawn } = await tool(page, 'create_spot', { name: 'Undrawn', kind: 'template', templateVersionId: fixture });
  await page.reload();
  await hydrated(page);
  const frame = page
    .getByRole('link', { name: /Undrawn/ })
    .locator('span[aria-hidden]')
    .first();
  await expect(frame).toContainText('Weather and headlines (test)');
  expect(
    await frame.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { ratio: Math.round((r.width / r.height) * 100) / 100, fits: el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1 };
    }),
  ).toEqual({ ratio: 1.78, fits: true });
  await tool(page, 'delete_spot', { spotId: undrawn.id });
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
  // Named after its template (#360): this spec's first Announcement.
  await expect(page.getByLabel('Name')).toHaveValue('Announcement');
  await axe(page);
  await shots(page, '35-new-spot-named');
  await page.getByLabel('Name').fill('Pier 9 opening');
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page.getByRole('heading', { name: 'Pier 9 opening', level: 1 })).toBeVisible();
  await hydrated(page);
  // It starts with the template's sample copy, marked until replaced; focusing a sample selects it, so typing replaces it.
  const headline = page.getByLabel('Headline');
  await expect(headline).toHaveValue('Pier 9 opens on Monday');
  await expect(headline).toHaveAccessibleDescription('Sample text. Replace it before you publish.');
  // The server records it, so a reload (or another tab) marks it too.
  await page.reload();
  await hydrated(page);
  await expect(headline).toHaveAccessibleDescription('Sample text. Replace it before you publish.');
  await headline.focus();
  expect(await headline.evaluate((i) => i instanceof HTMLInputElement && i.selectionStart === 0 && i.selectionEnd === i.value.length)).toBe(true);
  await axe(page);
  await shots(page, '35-spot-editor-sample');
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
  await expect(page.getByLabel('Headline')).not.toHaveAccessibleDescription(/Sample text/);
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
  // No address, no code: it appears once the address is typed.
  await page.getByLabel('QR code label').fill('Scan for the floor plan');
  await page.getByLabel('QR code link').fill('https://example.com/pier-9');
  await expect.poll(qr, { timeout: 10_000 }).toBe(true);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await axe(page);

  // Its other sample copy is still there: the server refuses the publish, and the page asks, naming it;
  // Edit first sends nothing (#360). Escape lets it go too, and gives focus back to Publish.
  const publishes = (await tool(page, 'list_publishes', {})).publishes.length;
  const publish = page.getByRole('button', { name: 'Publish', exact: true });
  await publish.click();
  const ask = page.getByRole('alertdialog', { name: 'Publish sample text?' });
  await expect(ask).toContainText('Eyebrow, Body, Posted by and QR code label still have sample text. Publish anyway?');
  await axe(page);
  await shots(page, '35-publish-sample-text');
  await ask.getByRole('button', { name: 'Edit first' }).click();
  await expect(ask).toBeHidden();
  expect((await tool(page, 'list_publishes', {})).publishes).toHaveLength(publishes);
  await publish.click();
  await expect(ask).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ask).toBeHidden();
  await expect(publish).toBeFocused();
  // At phone width the question's buttons stay in view; its words scroll within it.
  await page.setViewportSize({ width: 390, height: 844 });
  // Publish still has focus, given back by the question: Enter asks again.
  await publish.press('Enter');
  await expect(ask.getByRole('button', { name: 'Publish anyway' })).toBeInViewport();
  await axe(page);
  await shots(page, '35-publish-sample-text-phone');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 720 });
  // Publish anyway sends it, as it was asked for.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await ask.getByRole('button', { name: 'Publish anyway' }).click();
  await expect(ask).toBeHidden();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /Published|No screen|Not published/ })).toBeVisible();
});

test('an Announcement with its photo off draws once the stage is in view, and the player is not asked to draw it out of view (#342)', async () => {
  // On a phone the stage follows the form; beside it, on a wide screen, it stays in view (#363).
  await page.setViewportSize({ width: 390, height: 844 });
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
  // Each draft the player is sent, as it arrives: whether its frame was in the page's window then. In every frame:
  // the player's frame starts as about:blank, where this runs, and keeps its window when the player loads; only it is sent drafts.
  await page.addInitScript(() => {
    addEventListener('message', (e) => {
      if (e.data?.type !== 'draft') return;
      const box = window.frameElement?.getBoundingClientRect();
      const inView = box !== undefined && box.bottom > 0 && box.top < window.parent.innerHeight;
      Reflect.set(window, 'sfDrafts', [...(Reflect.get(window, 'sfDrafts') ?? []), inView]);
    });
  });
  await page.goto(`/spots/${spot.id}`);
  await hydrated(page);
  // The form is long: the stage starts below the fold, where a browser runs no animation frames.
  const stage = page.getByRole('region', { name: 'Live preview' });
  expect(await stage.evaluate((el) => el.getBoundingClientRect().top > innerHeight)).toBe(true);
  const player = () => page.frames().find((f) => f.url().includes('/player/'));
  const drafts = async () => (await player()?.evaluate(() => Reflect.get(window, 'sfDrafts') ?? [])) ?? [];
  await expect(stage.getByText('Drawing…').first()).toBeAttached();
  await stage.scrollIntoViewIfNeeded();
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  // Every draft the player was sent arrived with its frame in view: none while it was below the fold.
  const arrived = await drafts();
  expect(arrived.length).toBeGreaterThan(0);
  expect(arrived.every(Boolean)).toBe(true);
  page.off('console', listen);
  expect(skipped).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 720 });

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

test("an editor gives the stage the room: the sidebar folded to its rail, the stage filling its column, and the template's thumbnail with Drawing… until the player draws (#363)", async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const announcement = templates.find((t: { key: string }) => t.key === 'announcement');
  const { spot } = await tool(page, 'create_spot', {
    name: 'Room to draw',
    kind: 'template',
    templateVersionId: announcement.versions.at(-1).id,
    data: { showPhoto: false },
  });
  // The player is held back, so the stage shows what it shows while it waits.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/player/index.html*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/spots/${spot.id}`);
  await hydrated(page);
  await expect(page.getByRole('button', { name: 'Unfold the sidebar' })).toHaveAttribute('aria-expanded', 'false');
  const stage = page.getByRole('region', { name: 'Live preview' });
  await expect(stage.getByText('Drawing…').first()).toBeVisible();
  await expect(stage.locator('img[src="/template-thumbnails/announcement.webp"]')).toBeVisible();
  // The column is the editor's height, and the stage fills it.
  const fills = await stage.evaluate((el) => {
    const column = el.parentElement!.getBoundingClientRect();
    const own = el.getBoundingClientRect();
    return Math.abs(own.height - column.height) < 1 && column.height > innerHeight / 2;
  });
  expect(fills).toBe(true);
  // Beside the form, in view, at desktop widths, folded and not: the row never wraps there.
  const beside = () =>
    stage.evaluate((el) => {
      const form = document.querySelector('form[aria-label="Spot fields"]')!.getBoundingClientRect();
      const own = el.getBoundingClientRect();
      return own.left >= form.right - 1 && own.top < innerHeight && own.bottom <= innerHeight + 1;
    });
  expect(await beside()).toBe(true);
  await page.setViewportSize({ width: 1024, height: 720 });
  expect(await beside()).toBe(true);
  await axe(page);
  await shots(page, '92-spot-editor-drawing');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  release();
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  await page.unroute('**/player/index.html*');

  // The editor, not the window, decides: at 1024 with the agent's drawer open the stage stacks under the form, at full width.
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' }).click();
  const stacked = await stage.evaluate((el) => {
    const form = document.querySelector('form[aria-label="Spot fields"]')!.getBoundingClientRect();
    const own = el.getBoundingClientRect();
    return own.top >= form.bottom - 1 && own.width >= form.width - 1;
  });
  expect(stacked).toBe(true);
  await page.getByRole('button', { name: 'Close the agent' }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  // At 100% the screen scrolls inside the stage: the stage's status stays in the window.
  await page.getByRole('group', { name: 'Scale' }).getByRole('button', { name: '100%' }).click();
  const status = stage.getByRole('status');
  await expect(status).toBeInViewport();
  expect(await status.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await page.getByRole('group', { name: 'Scale' }).getByRole('button', { name: 'Fit' }).click();

  // Unfolded here, it stays open on this visit, and the stage stays beside the form; the list keeps the person's own choice.
  await page.getByRole('button', { name: 'Unfold the sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Fold the sidebar' })).toHaveAttribute('aria-expanded', 'true');
  expect(await beside()).toBe(true);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Spots' }).click();
  await expect(page.getByRole('button', { name: 'Fold the sidebar' })).toBeVisible();
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
