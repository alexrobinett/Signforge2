// A menu board fed by a CSV link (issue #84): read the file, pick its columns, see the stage play
// its rows; the real poller (the dev API's Cron Trigger, run with GET /__scheduled) reads the file
// from the run's file server (global-setup.ts, FEED_STUB_URL), and an edit to the file reaches the
// stage after the next poll. How a screen's sync carries it is apps/api/test/table-sources.test.ts.
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, d1, disabledOnServer, hydrated, newSpot, orgOf, shots, signInAs, stageShows, tool } from './helpers';
import { API_PORT, FEEDS_DIR } from './servers';

/** This spec's own client address, so its sign-in has its own rate limit. */
const ADDRESS = '192.0.2.34';
const LINK = 'https://menu.example.com/lunch.csv';

/** 24 dishes, twice what the menu board shows; odd rows are mains. */
function writeMenu({ second = 'Dish 2', item = 'Item' } = {}) {
  const rows = Array.from({ length: 24 }, (_, i) => [
    i === 1 ? second : `Dish ${i + 1}`,
    (4 + i / 4).toFixed(2),
    `Plate ${i + 1}`,
    i % 2 ? 'Mains' : 'Starters',
  ]);
  writeFileSync(`${FEEDS_DIR}lunch.csv`, [`${item},Price,Description,Section`, ...rows.map((r) => r.join(','))].join('\r\n'));
}

/** Runs the poller now on this spot's source alone: other specs' sources wait, so their states stay theirs. */
async function pollNow(spotId: string, sourceId: string) {
  d1(
    `UPDATE data_sources SET next_poll_at = CASE WHEN org_id = ${orgOf(spotId)} AND id = '${sourceId}' THEN 0 ELSE 9007199254740991 END, etag = NULL, last_modified = NULL`,
  );
  const res = await fetch(`http://127.0.0.1:${API_PORT}/__scheduled?cron=${encodeURIComponent('* * * * *')}`);
  expect(res.status).toBe(200);
  // The job runs in the background of that request (waitUntil): wait for its write.
  await expect
    .poll(async () => (await tool(page, 'get_data_source', { dataSourceId: sourceId })).dataSource.nextPollAt, { timeout: 15_000 })
    .toBeGreaterThan(0);
}

/** In the open spot's Source section: the link form, filled, and read. */
async function readLink(on: Page) {
  const form = on.getByRole('form', { name: 'Spot fields' });
  await form.getByRole('button', { name: 'From a CSV or JSON link' }).click();
  await form.getByLabel('Address').fill(LINK);
  await form.getByRole('button', { name: 'Read the file' }).click();
}

/**
 * Whether menu-board on the stage is between its intro and its outro: every intro animation
 * (`rise-in`, `fade-in`) has finished and no outro (`fade-out`, delayed to the spot's end) has begun,
 * so axe sees the template's own colours rather than a fade half done.
 */
async function stageBetweenFades(on: Page): Promise<boolean> {
  let seen = false;
  // The stage's frames only: the CMS's own page may animate (a spinner) without end.
  for (const frame of on.frames()) {
    if (frame === on.mainFrame()) continue;
    const state = await frame
      .evaluate(() =>
        document.getAnimations().map((a) => ({
          name: a instanceof CSSAnimation ? a.animationName : '',
          done: (a.currentTime ?? 0) >= (a.effect?.getComputedTiming().endTime ?? 0),
          idle: a.effect?.getComputedTiming().progress === null,
        })),
      )
      // A frame that went away while the stage redrew.
      .catch(() => []);
    for (const a of state) {
      seen = true;
      if (a.name === 'fade-out' ? !a.idle : !a.done) return false;
    }
  }
  return seen;
}

/** The stage is playing the spot, past its intro (`stageBetweenFades`). */
async function stageSettled(on: Page) {
  await expect(on.getByText('Drawn by the player your screens run.')).toBeVisible();
  await expect.poll(() => stageBetweenFades(on), { timeout: 15_000 }).toBe(true);
}

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1920, height: 1200 } })).newPage();
  await signInAs(page, `e2e-tables-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbour Kitchen');
});

test.afterAll(() => page.context().close());

test('a menu board fed by a CSV link: read it, map its columns, see its rows; the edited file after the next poll', async () => {
  test.setTimeout(180_000);
  writeMenu();
  const spotId = await newSpot(page, 'Menu Board', 'Lunch menu');
  const form = page.getByRole('form', { name: 'Spot fields' });
  // Until a file feeds them, the items are typed.
  await expect(form.getByRole('button', { name: 'Add a row' })).toBeVisible();

  await readLink(page);
  const first = form.getByRole('table', { name: 'First rows of the file' });
  await expect(first.getByRole('columnheader')).toHaveText(['Item', 'Price', 'Description', 'Section']);
  await expect(first.getByRole('row')).toHaveCount(6);
  await expect(form.getByRole('status').filter({ hasText: '24 rows, 4 columns.' })).toBeVisible();
  await form.locator('#source-table-name').fill('Lunch menu file');
  // The stage has drawn the spot's typed (empty) menu, past its intro animation.
  await expect.poll(() => stageShows(page, 'Menu'), { timeout: 15_000 }).toBe(true);
  await stageSettled(page);
  await axe(page);
  await shots(page, '41-spot-source-table-read');
  await form.getByRole('button', { name: 'Use this file' }).click();

  // Bound, with the columns guessed by name: 12 of its 24 rows, on the stage before the first poll.
  await expect(form.getByText('24 rows in the file; screens show 12 items, at most 12.')).toBeVisible();
  await expect(form.getByText('Read just now. Screens get it after the first check, within a minute.')).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Price' })).toHaveValue('Price');
  await expect(form.getByRole('button', { name: 'Add a row' })).toBeHidden();
  await expect.poll(() => stageShows(page, 'Dish 12'), { timeout: 15_000 }).toBe(true);
  expect(await stageShows(page, 'Dish 13')).toBe(false);

  // Mains only, dearest first.
  await form.getByRole('combobox', { name: 'Only rows where' }).selectOption('Section');
  await form.getByLabel('is', { exact: true }).fill('mains');
  await form.getByRole('combobox', { name: 'Order' }).selectOption('Price');
  await form.getByLabel('Highest or last first').check();
  await expect(form.getByRole('list', { name: 'First items' }).getByRole('listitem')).toHaveText(['Dish 24', 'Dish 22', 'Dish 20']);
  await expect.poll(() => stageShows(page, 'Dish 24'), { timeout: 15_000 }).toBe(true);
  expect(await stageShows(page, 'Dish 23')).toBe(false);
  await expect(page.getByText(/Saved \d/)).toBeVisible({ timeout: 15_000 });
  const { spot } = await tool(page, 'get_spot', { spotId });
  const sourceId: string = spot.bindings.items.dataSourceId;
  expect(spot.bindings.items).toEqual({
    dataSourceId: sourceId,
    path: 'rows',
    table: {
      columns: { name: 'Item', price: 'Price', description: 'Description' },
      filter: { column: 'Section', equals: 'mains' },
      sort: { column: 'Price', descending: true },
    },
  });
  await stageSettled(page);
  await axe(page);
  await shots(page, '42-spot-source-table-mapped');

  // The poller reads the file; then the file changes, and the next poll brings the change.
  await pollNow(spotId, sourceId);
  await page.reload();
  await hydrated(page);
  await expect(form.getByText('Checked just now.')).toBeVisible();
  writeMenu({ second: 'Harvest bowl' });
  await pollNow(spotId, sourceId);
  await page.reload();
  await hydrated(page);
  await expect(form.getByRole('list', { name: 'First items' }).getByRole('listitem').last()).toHaveText('Dish 20');
  // Waits for the editor to hydrate, after the page: until then the fields are disabled, as a change there would be lost.
  await form.getByRole('combobox', { name: 'Order' }).selectOption('');
  await expect(form.getByRole('list', { name: 'First items' }).getByRole('listitem').first()).toHaveText('Harvest bowl');
  await expect.poll(() => stageShows(page, 'Harvest bowl'), { timeout: 15_000 }).toBe(true);
  // Saved before the next reload: the file's order again.
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId })).spot.bindings.items.table.sort ?? null, { timeout: 15_000 }).toBeNull();

  // A column renamed in the file: the editor says so, and the stage shows the typed items.
  writeMenu({ item: 'Dish' });
  await pollNow(spotId, sourceId);
  await page.reload();
  await hydrated(page);
  await expect(form.getByText('No items: the table has no column "Item"')).toBeVisible();
  await expect(form.getByRole('combobox', { name: 'Name' })).toHaveValue('Item');
  await expect(form.getByRole('option', { name: 'Item (not in the file)' })).toBeAttached();
  await form.getByRole('combobox', { name: 'Name' }).selectOption('Dish');
  await expect(form.getByRole('list', { name: 'First items' }).getByRole('listitem').first()).toHaveText('Dish 2');

  // Typed again: the link the person added stays, for this spot or another to use.
  await form.getByRole('button', { name: 'Type the items instead' }).click();
  await expect(form.getByRole('button', { name: 'Add a row' })).toBeVisible();
  await expect(page.getByText(/Saved \d/)).toBeVisible({ timeout: 15_000 });
  expect((await tool(page, 'get_spot', { spotId })).spot.bindings).toBeNull();
  expect((await tool(page, 'list_data_sources', {})).dataSources.map((d: { id: string }) => d.id)).toContain(sourceId);
  await expect(form.getByRole('combobox', { name: 'Table' })).toBeVisible();
});

test("the editor's fields and Publish are disabled in the server's HTML: a choice made before its code has hydrated would be lost", async () => {
  // The spot editor is a route chunk that hydrates after the page (body[data-hydrated]); a select changed in
  // between was set back by React to its value, and the choice dropped (CI run 44652707436).
  const spotId = await newSpot(page, 'Menu Board', 'Server menu');
  // The header's Save draft and Publish (#127) too: a click there before the editor hydrates would go nowhere.
  const names = ['Duration', 'Save draft', 'Publish'];
  expect(await disabledOnServer(page, `/spots/${spotId}`, names)).toEqual(Object.fromEntries(names.map((n) => [n, [true]])));
  // Loaded from the server, they are enabled once the editor has hydrated (Save draft waits for a change).
  await page.reload();
  await hydrated(page);
  await expect(page.getByRole('form', { name: 'Spot fields' }).getByLabel('Name', { exact: true }).first()).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
});

test('the table source on a phone: no sideways scroll, light and dark', async () => {
  writeMenu();
  const spotId = await newSpot(page, 'Menu Board', 'Phone menu');
  const { dataSources } = await tool(page, 'list_data_sources', {});
  const form = page.getByRole('form', { name: 'Spot fields' });
  await form.getByRole('combobox', { name: 'Table' }).selectOption({ label: 'Lunch menu file' });
  await form.getByRole('button', { name: 'Use this table' }).click();
  await expect(form.getByRole('combobox', { name: 'Price' })).toHaveValue('Price');
  await page.setViewportSize({ width: 412, height: 915 });
  await form.getByRole('combobox', { name: 'Only rows where' }).scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '43-spot-source-table-phone');
  await form.getByRole('button', { name: 'Change source' }).click();
  await readLink(page);
  await expect(form.getByRole('table', { name: 'First rows of the file' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '44-spot-source-table-read-phone');
  await page.setViewportSize({ width: 1920, height: 1200 });
  expect(spotId).toBeTruthy();
  expect(dataSources).toHaveLength(1);
});
