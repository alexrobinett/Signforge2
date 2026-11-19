import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, stageShows, tool } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.41';

test.describe.configure({ mode: 'serial' });

let page: Page;
/** Spot ids by name. */
const spots: Record<string, string> = {};
let playlistId = '';

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-playlists-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Market');
  // Spots to put in order: three short clocks, and a photo promo with no photo yet.
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const version = (key: string) => templates.find((t: { key: string }) => t.key.endsWith(`/${key}`) || t.key === key).versions.at(-1).id;
  const clocks: [string, string][] = [
    ['Opening', 'Good morning, Northside'],
    ['Lunch', 'Lunch is served'],
    ['Closing', 'See you tomorrow'],
  ];
  for (const [name, greeting] of clocks) {
    const { spot } = await tool(page, 'create_spot', { name, kind: 'template', templateVersionId: version('clock'), durationMs: 4000, data: { greeting } });
    spots[name] = spot.id;
  }
  const { spot } = await tool(page, 'create_spot', { name: 'Berries', kind: 'template', templateVersionId: version('photo-promo') });
  spots.Berries = spot.id;
});

test.afterAll(() => page.context().close());

test('make a playlist, add spots, and see the real player play the loop', async () => {
  test.setTimeout(120_000);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Playlists' }).click();
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'No playlists yet' })).toBeVisible();
  await axe(page);
  await shots(page, '40-playlists-empty');

  await page.getByRole('button', { name: 'New playlist' }).click();
  await page.getByLabel('Name').fill('Lunch loop');
  await page.getByRole('button', { name: 'Create playlist' }).click();
  await expect(page).toHaveURL(/\/playlists\/[^/?]+$/);
  playlistId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await expect(page.getByRole('heading', { name: 'Lunch loop', level: 1 })).toBeVisible();
  await hydrated(page);
  await expect(page.getByText('Add spots and the player plays the loop here.')).toBeVisible();

  await page.getByRole('button', { name: 'Add spots' }).click();
  const picker = page.getByRole('dialog', { name: 'Add spots' });
  for (const name of ['Opening', 'Lunch', 'Closing', 'Berries']) await picker.getByRole('button', { name: `Add ${name}` }).click();
  await axe(page);
  await shots(page, '41-playlist-add-spots');
  await page.keyboard.press('Escape');

  const list = page.getByRole('list', { name: 'Spots in play order' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  // The photo promo has no photo: the stage plays the rest, and says why it left it out.
  await expect(list.getByRole('listitem').nth(3)).toContainText('Not in the preview yet:');
  // Three 4 s clocks, and the promo's 8 s default: 20 s.
  await expect(page.getByText('4 spots · 20 s loop', { exact: false })).toBeVisible();

  const stage = page.getByRole('region', { name: 'Live preview' });
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => stageShows(page, 'Good morning, Northside'), { timeout: 10_000 }).toBe(true);
  // The loop moves on to the next spot after 4 s.
  await expect.poll(() => stageShows(page, 'Lunch is served'), { timeout: 15_000 }).toBe(true);
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await axe(page);
  await shots(page, '42-playlist-editor');
});

test('reorder by dragging and with the move buttons, remove and undo, and choose the transition', async () => {
  test.setTimeout(60_000);
  const list = page.getByRole('list', { name: 'Spots in play order' });
  const names = () => list.getByRole('listitem').evaluateAll((items) => items.map((li) => li.querySelector('.font-medium')?.textContent));

  // Drag Closing onto the first row.
  await list.getByRole('listitem').nth(2).dragTo(list.getByRole('listitem').nth(0));
  await expect.poll(names).toEqual(['Closing', 'Opening', 'Lunch', 'Berries']);
  await page.getByRole('button', { name: 'Move Berries up' }).click();
  await expect.poll(names).toEqual(['Closing', 'Opening', 'Berries', 'Lunch']);
  await page.getByRole('button', { name: 'Move Closing down' }).click();
  await expect.poll(names).toEqual(['Opening', 'Closing', 'Berries', 'Lunch']);

  await page.getByRole('button', { name: 'Remove Berries' }).click();
  await expect.poll(names).toEqual(['Opening', 'Closing', 'Lunch']);
  await expect(page.getByText('3 spots · 12 s loop', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(names).toEqual(['Opening', 'Closing', 'Berries', 'Lunch']);
  await page.getByRole('button', { name: 'Remove Berries' }).click();

  await page.getByRole('radio', { name: /^Crossfade/ }).check();
  await expect(page.getByText('a Raspberry Pi 4 drops about 1 frame in 10 while it runs')).toBeVisible();
  await page.getByRole('spinbutton', { name: 'Length' }).fill('0.8');
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);

  // What the editor saved is what the tools hold: the order, the transition.
  const { playlist } = await tool(page, 'get_playlist', { playlistId });
  expect(playlist).toMatchObject({
    name: 'Lunch loop',
    transition: { type: 'crossfade', ms: 800 },
    spotIds: [spots.Opening, spots.Closing, spots.Lunch],
    published: false,
  });
  await axe(page);
  await shots(page, '43-playlist-crossfade');

  // At phone width the form and the stage stack, and the move buttons reorder without a drag.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('region', { name: 'Live preview' })).toBeVisible();
  await page.getByRole('button', { name: 'Move Lunch up' }).click();
  await expect.poll(names).toEqual(['Opening', 'Lunch', 'Closing']);
  await axe(page);
  await shots(page, '44-playlist-editor-phone');
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByText(/Saved \d/)).toBeVisible();
});

test('a change someone else made while the editor was open is not overwritten', async () => {
  const { playlist } = await tool(page, 'get_playlist', { playlistId });
  // Stands in for an agent: a reorder lands after the page read the playlist.
  await tool(page, 'update_playlist', { playlistId, spotIds: [spots.Closing], ifVersion: playlist.version });
  await page.getByRole('radio', { name: /^Cut/ }).check();
  await expect(page.getByText('This changed since you opened it.')).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('list', { name: 'Spots in play order' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('radio', { name: /^Crossfade/ })).toBeChecked();
});

test('the list shows each playlist, and a playlist can be deleted', async () => {
  await page.getByRole('link', { name: 'Playlists' }).first().click();
  await hydrated(page);
  const row = page.getByRole('link', { name: /Lunch loop/ });
  await expect(row).toContainText('1 spot · 4 s loop · Crossfade 0.8 s · Draft, never published');
  await axe(page);
  await shots(page, '45-playlists');
  await page.setViewportSize({ width: 390, height: 844 });
  await shots(page, '46-playlists-phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  await row.click();
  await hydrated(page);
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Delete Lunch loop?');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/playlists$/);
  await expect(page.getByRole('heading', { name: 'No playlists yet' })).toBeVisible();
});
