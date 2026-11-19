// Spots whose data comes from a source (issue #79): people pick where it comes from, never the
// values. The geocoder is a stub (global-setup.ts); the poller does not run under `wrangler dev`, so
// a test writes the snapshot it would have fetched into the run's local D1.
import { expect, test, type Page } from '@playwright/test';
import { canonicalJson } from '@signforge/contract';
import { parseNews } from '@signforge/feeds';
import { axe, d1, fillUntilEnabled, hydrated, shots, signInAs, stageShows, tool } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit. */
const ADDRESS = '192.0.2.33';

/** The org of the spot, in SQL: source ids are per org, and other specs' orgs share the database. */
const orgOf = (spotId: string) => `(SELECT org_id FROM spots WHERE id = '${spotId}')`;

/** As if the poller had just fetched `data` for the source. */
function pollFound(spotId: string, sourceId: string, data: unknown) {
  const now = Date.now();
  // As the poller stores it: keys sorted at every level.
  const json = canonicalJson(data).replaceAll("'", "''");
  d1(
    `INSERT INTO data_snapshots (org_id, data_source_id, version, fetched_at, checked_at, data_json) VALUES (${orgOf(spotId)}, '${sourceId}', 'e2e-${now}', ${now}, ${now}, '${json}') ` +
      'ON CONFLICT (org_id, data_source_id) DO UPDATE SET version = excluded.version, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at, data_json = excluded.data_json',
  );
}

/** As if every poll of the source had timed out. */
const pollFailed = (spotId: string, sourceId: string) =>
  d1(`UPDATE data_sources SET failures = 3, last_error = 'timeout' WHERE org_id = ${orgOf(spotId)} AND id = '${sourceId}'`);

const spotIdOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1) ?? '';

async function newSpot(page: Page, template: string, name: string) {
  await page.goto('/spots');
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('combobox', { name: 'Template' }).selectOption({ label: template });
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await hydrated(page);
  return spotIdOf(page);
}

const ATLANTA = {
  current: { temperature_2m: 88.4, weather_code: 3, is_day: 1, wind_speed_10m: 7, relative_humidity_2m: 40 },
  daily: { temperature_2m_max: [91], temperature_2m_min: [70] },
};

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1920, height: 1200 } })).newPage();
  await signInAs(page, `e2e-sources-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Northside Market', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Northside Market', level: 1 })).toBeVisible();
});

test.afterAll(() => page.context().close());

test('a weather spot: pick a place and units, see live weather on the stage, and type no temperature', async () => {
  test.setTimeout(120_000);
  const spotId = await newSpot(page, 'Weather Now', 'Lobby weather');
  const form = page.getByRole('form', { name: 'Spot fields' });
  const stage = page.getByRole('region', { name: 'Live preview' });
  // Nothing to type for the weather itself: those fields wait in the collapsed fallback.
  for (const label of ['Temperature', "Today's high", 'WMO weather code', 'Humidity %']) await expect(form.getByLabel(label, { exact: true })).toBeHidden();

  await form.getByLabel('Temperature in').selectOption('°F');
  await form.getByLabel('Place').fill('Atl');
  const places = form.getByRole('list', { name: 'Places found' });
  await expect(places.getByRole('button')).toHaveText(['Atlanta, Georgia, United States', 'Atlanta, Alabama, United States']);
  // Announced, not only shown: the search's state is a status message.
  await expect(form.getByRole('status')).toHaveText('2 places found.');
  await places.getByRole('button', { name: 'Atlanta, Georgia, United States' }).click();
  // The button that had focus is gone: focus goes to what replaced the picker.
  await expect(form.getByRole('button', { name: 'Change source' })).toBeFocused();

  await expect(form.getByText('Weather, Atlanta, Georgia, United States (°F, mph)')).toBeVisible();
  await expect(form.getByText('Waiting for the first check')).toBeVisible();
  await expect(form.getByLabel('City')).toHaveValue('Atlanta');
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  const { dataSources } = await tool(page, 'list_data_sources', {});
  expect(dataSources).toHaveLength(1);
  const atlanta: string = dataSources[0].id;
  expect(atlanta).toMatch(/^weather-4180439-f-mph-[0-9a-f]{6}$/);
  const { spot } = await tool(page, 'get_spot', { spotId });
  expect(spot.bindings).toMatchObject({
    temp: { dataSourceId: atlanta, path: 'current.temperature_2m' },
    high: { dataSourceId: atlanta, path: 'daily.temperature_2m_max.0' },
  });

  // The first poll lands: live values in the form, read-only, and on the stage.
  pollFound(spotId, atlanta, ATLANTA);
  await page.reload();
  await hydrated(page);
  await expect(form.getByText('88°F, overcast')).toBeVisible();
  await expect(form.getByText(/Checked (just now|.* ago)\./)).toBeVisible();
  await expect(stage.getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => stageShows(page, '91°'), { timeout: 10_000 }).toBe(true);
  await axe(page);
  await shots(page, '35-spot-source-weather');

  // The stage's Data switch plays what screens fall back to: the template's own values.
  await stage.getByRole('button', { name: 'Fallback' }).click();
  await expect(page).toHaveURL(/[?&]data=fallback/);
  await expect.poll(() => stageShows(page, '78°'), { timeout: 10_000 }).toBe(true);
  await page.getByText('If the source is down').click();
  const high = form.getByLabel("Today's high", { exact: true });
  await expect(high).toHaveValue('78');
  // Retyping a fallback passes through an empty box, which is invalid: the section stays open, focus in the box.
  await high.fill('');
  await high.pressSequentially('8');
  await expect(high).toBeVisible();
  await expect(high).toBeFocused();
  await expect(high).toHaveValue('8');
  await stage.getByRole('button', { name: 'Live data' }).click();
  await expect.poll(() => stageShows(page, '91°'), { timeout: 10_000 }).toBe(true);
});

test('a second spot for the same place and units shares the source; moving it leaves the first where it was', async () => {
  test.setTimeout(120_000);
  const first = spotIdOf(page);
  const spotId = await newSpot(page, 'Weather Now', 'Front door weather');
  const form = page.getByRole('form', { name: 'Spot fields' });
  await form.getByLabel('Place').fill('Atlanta');
  await form.getByRole('list', { name: 'Places found' }).getByRole('button', { name: 'Atlanta, Georgia, United States' }).click();
  await expect(form.getByText('88°F, overcast')).toBeVisible();
  expect((await tool(page, 'list_data_sources', {})).dataSources).toHaveLength(1);

  // Change the place: the picker opens looking up the city the spot names.
  await form.getByRole('button', { name: 'Change source' }).click();
  await expect(form.getByLabel('Place')).toHaveValue('Atlanta');
  await form.getByLabel('Temperature in').selectOption('°C');
  await form.getByLabel('Place').fill('Reyk');
  await form.getByRole('list', { name: 'Places found' }).getByRole('button', { name: 'Reykjavík, Capital Region, Iceland' }).click();
  await expect(form.getByText('Weather, Reykjavík, Capital Region, Iceland (°C, mph)')).toBeVisible();
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  const { dataSources } = await tool(page, 'list_data_sources', {});
  expect(dataSources.map((d: { id: string }) => d.id.split('-').slice(0, 3).join('-')).sort()).toEqual(['weather-3413829-c', 'weather-4180439-f']);
  const reykjavik: string = dataSources.find((d: { id: string }) => d.id.startsWith('weather-3413829')).id;
  expect((await tool(page, 'get_spot', { spotId })).spot).toMatchObject({
    data: { unit: '°C', city: 'Reykjavík' },
    bindings: { temp: { dataSourceId: reykjavik } },
  });
  expect((await tool(page, 'get_spot', { spotId: first })).spot.bindings.temp.dataSourceId).toMatch(/^weather-4180439-f-mph-/);

  // A failing source: the editor says so, and the stage shows the fallback, as a screen would.
  pollFailed(spotId, reykjavik);
  await page.reload();
  await hydrated(page);
  await expect(form.getByText('The first check failed: the feed took too long to answer.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live preview' }).getByText('Drawn by the player your screens run.')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => stageShows(page, '78°'), { timeout: 10_000 }).toBe(true);
  await axe(page);
  await shots(page, '36-spot-source-failing');

  // Moved again, the source it leaves is bound by no other spot: it goes, so it no longer counts against the org's ten.
  await form.getByRole('button', { name: 'Change source' }).click();
  await form.getByLabel('Temperature in').selectOption('°F');
  await form.getByRole('list', { name: 'Places found' }).getByRole('button', { name: 'Reykjavík, Capital Region, Iceland' }).click();
  await expect(form.getByText('Weather, Reykjavík, Capital Region, Iceland (°F, mph)')).toBeVisible();
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  const prefixes = async () =>
    ((await tool(page, 'list_data_sources', {})).dataSources as { id: string }[]).map((d) => d.id.split('-').slice(0, 3).join('-')).sort();
  await expect.poll(prefixes).toEqual(['weather-3413829-f', 'weather-4180439-f']);
});

test('a news spot: add a feed by its address, see the headlines live, and edit none of them', async () => {
  test.setTimeout(120_000);
  const spotId = await newSpot(page, 'News', 'World news');
  const form = page.getByRole('form', { name: 'Spot fields' });
  await expect(form.getByRole('button', { name: 'Add a row' })).toBeHidden();
  await form.getByLabel('Address').fill('https://feeds.example.com/world.rss');
  await form.getByLabel('Name', { exact: true }).last().fill('World desk');
  await form.getByRole('button', { name: 'Add feed' }).click();
  await expect(form.getByText('World desk')).toBeVisible();
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  const { dataSources } = await tool(page, 'list_data_sources', {});
  const feed = dataSources.find((d: { name: string }) => d.name === 'World desk');
  expect(feed).toMatchObject({ format: 'rss' });
  expect((await tool(page, 'get_spot', { spotId })).spot.bindings).toEqual({
    items: { dataSourceId: feed.id, path: 'items' },
    language: { dataSourceId: feed.id, path: 'language' },
  });

  // The feed as the poller converts it: one dated item, one undated, the feed's title as their source.
  const pubDate = new Date(Date.now() - 20 * 60_000).toUTCString();
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>World desk</title><language>en</language>
    <item><title>Harbour bridge reopens after repairs</title><pubDate>${pubDate}</pubDate></item>
    <item><title>City library extends its weekend hours</title></item>
  </channel></rss>`;
  pollFound(spotId, feed.id, parseNews(rss));
  await page.reload();
  await hydrated(page);
  await expect(form.getByRole('listitem').filter({ hasText: 'Harbour bridge reopens after repairs' })).toBeVisible();
  await expect.poll(() => stageShows(page, 'Harbour bridge reopens'), { timeout: 30_000 }).toBe(true);
  await expect(form.getByRole('button', { name: 'Add a row' })).toBeHidden();
  await axe(page);
  await shots(page, '37-spot-source-news');

  // Another news spot picks the feed the org has.
  await newSpot(page, 'News', 'Lobby news');
  // Choosing in the list binds nothing (arrow keys change a closed select on Windows); the button does.
  await form.getByLabel('News feed').selectOption({ label: 'World desk' });
  await expect(form.getByRole('listitem').filter({ hasText: 'Harbour bridge reopens after repairs' })).toBeHidden();
  await form.getByRole('button', { name: 'Use this feed' }).click();
  await expect(form.getByRole('listitem').filter({ hasText: 'Harbour bridge reopens after repairs' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Change source' })).toBeFocused();

  // A feed someone typed is kept when its last spot moves away: its address is never shown again, so it
  // would have to be found and typed again. (A weather source the editor made is deleted: the second test.)
  await form.getByRole('button', { name: 'Change source' }).click();
  await form.getByRole('button', { name: 'Add a feed by its address' }).click();
  await form.getByLabel('Address').fill('https://feeds.example.com/local.rss');
  await form.getByLabel('Name', { exact: true }).last().fill('Local desk');
  await form.getByRole('button', { name: 'Add feed' }).click();
  await expect(form.getByText('Local desk')).toBeVisible();
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  await form.getByRole('button', { name: 'Change source' }).click();
  await form.getByLabel('News feed').selectOption({ label: 'World desk' });
  await form.getByRole('button', { name: 'Use this feed' }).click();
  await expect(form.getByRole('listitem').filter({ hasText: 'Harbour bridge reopens after repairs' })).toBeVisible();
  await expect(page.getByText(/Saved \d/)).toBeVisible();
  // Long enough for a cleanup after the save to have run.
  await page.waitForTimeout(2_000);
  const names = async () => ((await tool(page, 'list_data_sources', {})).dataSources as { name: string }[]).map((d) => d.name);
  expect(await names()).toContain('Local desk');

  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '38-spot-source-phone');
});
