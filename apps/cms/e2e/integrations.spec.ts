// The Integrations page (issue #80): the org's data sources with their health, a failing one in
// words with its fix, connected accounts, and the connector catalogue. The poller does not run
// under `wrangler dev` and the feeds are not real, so the test writes into the run's local D1 what
// a poll would have written.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { axe, createOrg, d1, hydrated, shots, signInAs, tool } from './helpers';
import { CMS_URL } from './servers';

/** This spec's own client addresses, so its sign-ins have their own rate limits. */
const OWNER_ADDRESS = '192.0.2.134';
const VIEWER_ADDRESS = '192.0.2.135';
const STRANGER_ADDRESS = '192.0.2.136';

const MINUTE = 60_000;

/** As if a poll of the source had just found `data`, last confirmed `checkedAgo` ms ago, and nothing failing since. */
function pollFound(orgId: string, sourceId: string, checkedAgo = 0) {
  const at = Date.now() - checkedAgo;
  d1(
    `INSERT INTO data_snapshots (org_id, data_source_id, version, fetched_at, checked_at, data_json) VALUES ('${orgId}', '${sourceId}', 'e2e-${at}', ${at}, ${at}, '{"items":[]}') ` +
      'ON CONFLICT (org_id, data_source_id) DO UPDATE SET version = excluded.version, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at, data_json = excluded.data_json; ' +
      `UPDATE data_sources SET failures = 0, last_error = NULL, next_poll_at = ${Date.now() + 5 * MINUTE} WHERE org_id = '${orgId}' AND id = '${sourceId}'`,
  );
}

/** As if the last `n` polls had each had an error answer from the feed. */
const pollsFailed = (orgId: string, sourceId: string, n: number) =>
  d1(
    `UPDATE data_sources SET failures = ${n}, last_error = 'http-status', next_poll_at = ${Date.now() + 10 * MINUTE} WHERE org_id = '${orgId}' AND id = '${sourceId}'`,
  );

/** Make an org and return its id, for SQL on the run's D1. */
async function newOrg(page: Page, name: string): Promise<string> {
  await createOrg(page, name);
  const session = await page.request.get('/api/session');
  return (await session.json()).organization.id;
}

async function memberPage(browser: Browser, email: string, address: string) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
  await signInAs(page, email, address);
  return page;
}

test.describe.configure({ mode: 'serial' });

let owner: Page;
let orgId: string;
let calendar: string;
let blog: string;

test.beforeAll(async ({ browser }) => {
  owner = await memberPage(browser, `e2e-integrations-${Date.now()}@example.com`, OWNER_ADDRESS);
  orgId = await newOrg(owner, 'Northside Hotel');
});

test.afterAll(() => owner.context().close());

test('add a calendar and a feed from the catalogue; a failing one says why, what screens show and how to fix it', async () => {
  test.setTimeout(120_000);
  await owner.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Integrations' }).click();
  await expect(owner.getByRole('heading', { name: 'Integrations', level: 1 })).toBeVisible();
  await hydrated(owner);
  const now = owner.getByRole('region', { name: 'Feeding screens now' });
  await expect(now).toContainText('No data sources yet');
  await expect(owner.getByRole('group', { name: 'Show' }).getByRole('button')).toHaveText(['All 26', 'Connected 0', 'Built 5', 'Planned 17', 'Later 4']);

  // Connect iCal URL: the dialog opens on the add form.
  await owner.getByRole('button', { name: 'Connect iCal URL' }).click();
  const dialog = owner.getByRole('dialog', { name: 'iCal calendars' });
  await dialog.getByLabel('Address').fill('https://calendar.example.com/break-room.ics?key=private');
  await dialog.getByLabel('Name').fill('Break room');
  await dialog.getByRole('button', { name: 'Add calendar' }).click();
  await expect(dialog.getByText('Its first check of this address runs within a minute.')).toBeVisible();
  await expect(dialog).not.toContainText('key=private');
  await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Connect RSS / Atom' }).click();
  const feeds = owner.getByRole('dialog', { name: 'RSS / Atom feeds' });
  await feeds.getByLabel('Address').fill('https://news.example.com/northside.xml');
  await feeds.getByLabel('Name').fill('Northside blog');
  await feeds.getByRole('button', { name: 'Add feed' }).click();
  await expect(feeds.getByText('Northside blog')).toBeVisible();
  // Its stories' photos are on until someone turns them off.
  const photos = feeds.getByRole('checkbox', { name: 'Show story photos' });
  await expect(photos).toBeChecked();
  await photos.uncheck();
  await expect(feeds.getByText('Screens show headlines only.')).toBeVisible();
  await expect(photos).not.toBeChecked();
  // Enabled again once the change is saved.
  await expect(photos).toBeEnabled();
  await owner.keyboard.press('Escape');
  expect((await tool(owner, 'list_data_sources', {})).dataSources.find((d: { name: string }) => d.name === 'Northside blog')).toMatchObject({ photos: false });

  const { dataSources } = await tool(owner, 'list_data_sources', {});
  calendar = dataSources.find((d: { name: string }) => d.name === 'Break room').id;
  blog = dataSources.find((d: { name: string }) => d.name === 'Northside blog').id;
  // A spot reads the calendar (no tool binds one yet: the spot editor's sources are #79).
  const { spot } = await tool(owner, 'create_spot', { name: 'Break room agenda', kind: 'url', url: 'https://example.com/agenda' });
  d1(`UPDATE spots SET bindings_json = '{"events":{"source":"${calendar}","path":"events"}}' WHERE org_id = '${orgId}' AND id = '${spot.id}'`);

  // The feed is fine; the calendar was good two hours ago and its last 2 polls failed.
  pollFound(orgId, blog);
  pollFound(orgId, calendar, 120 * MINUTE);
  pollsFailed(orgId, calendar, 2);
  await owner.reload();
  await hydrated(owner);
  await expect(now.getByText('iCal · Break room')).toBeVisible();
  await expect(now.getByText('failed 2×')).toBeVisible();
  await expect(now).toContainText(
    /The Break room calendar answers with an error: its last 2 checks failed\. Its screens show the (?:\w{3} )?\d+:\d\d [AP]M copy\. It feeds the spot Break room agenda\./,
  );
  await expect(now.getByText('RSS · Northside blog')).toBeVisible();
  await expect(owner.getByText('1 calendar · failing')).toBeVisible();
  await expect(owner.getByText('1 feed', { exact: true })).toBeVisible();
  await axe(owner);
  await shots(owner, '60-integrations');

  // The filters and the search, kept in the URL.
  await owner.getByRole('button', { name: 'Connected 2' }).click();
  await expect(owner).toHaveURL(/show=connected/);
  await expect(owner.getByRole('main').getByRole('listitem')).toHaveCount(2);
  await owner.getByRole('button', { name: 'All 26' }).click();
  await owner.getByLabel('Find an integration').fill('square');
  await expect(owner.getByRole('heading', { level: 2, name: 'Point of sale and menus' })).toBeVisible();
  await expect(owner.getByRole('heading', { level: 2, name: 'Live data for templates' })).toHaveCount(0);
  await owner.getByLabel('Find an integration').fill('');

  // Phone width: the sources come first, above the catalogue, and nothing scrolls sideways.
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shots(owner, '61-integrations-phone');
  await owner.setViewportSize({ width: 1440, height: 1100 });
});

test('fixing the URL clears the failing state after the next poll, and a bound source cannot be deleted', async () => {
  test.setTimeout(120_000);
  const now = owner.getByRole('region', { name: 'Feeding screens now' });
  await now.getByRole('button', { name: 'Fix the iCal URL for Break room' }).click();
  const dialog = owner.getByRole('dialog', { name: 'iCal calendars' });
  await expect(dialog.getByLabel('New address for Break room')).toBeFocused();
  await axe(owner);
  await shots(owner, '62-integrations-fix');
  await dialog.getByLabel('New address for Break room').fill('https://calendar.example.com/break-room-2026.ics');
  await dialog.getByRole('button', { name: 'Save URL' }).click();
  await expect(dialog.getByText('Its first check of this address runs within a minute.')).toBeVisible();
  await owner.keyboard.press('Escape');
  await expect(now.getByText('checking')).toBeVisible();
  await expect(now.getByText('failed 2×')).toHaveCount(0);

  // The next poll succeeds: the open page shows its time within its 30-second refresh.
  pollFound(orgId, calendar);
  await expect(now.getByText('checking')).toHaveCount(0, { timeout: 45_000 });
  await expect(now).not.toContainText('answers with an error');
  await expect(owner.getByText('1 calendar', { exact: true })).toBeVisible();

  // Delete asks first, saying the address must be typed again; a source a spot reads is not deleted, one no spot reads is.
  await owner.getByRole('button', { name: 'Manage iCal URL' }).click();
  await dialog.getByRole('button', { name: 'Delete Break room' }).click();
  const confirm = owner.getByRole('alertdialog', { name: 'Delete Break room?' });
  await expect(confirm).toContainText('type its address again');
  await axe(owner);
  await shots(owner, '64-integrations-delete');
  await confirm.getByRole('button', { name: 'Delete source' }).click();
  await expect(confirm.getByRole('alert')).toHaveText('Break room is used by Break room agenda. Choose another source in those spots first.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Manage RSS / Atom' }).click();
  const feeds = owner.getByRole('dialog', { name: 'RSS / Atom feeds' });
  await feeds.getByRole('button', { name: 'Delete Northside blog' }).click();
  await owner.getByRole('alertdialog', { name: 'Delete Northside blog?' }).getByRole('button', { name: 'Delete source' }).click();
  await expect(feeds.getByText('None yet.')).toBeVisible();
  await owner.keyboard.press('Escape');
  await expect(now.getByText('RSS · Northside blog')).toHaveCount(0);

  // A weather source is named and reused by its place and units (the spot editor's): no address is typed for it here,
  // and a failing one is the forecast service's.
  const { dataSource: weather } = await tool(owner, 'create_data_source', {
    id: 'weather-5746545-f-mph-e2e001',
    name: 'Weather, Portland',
    format: 'json',
    feedUrl: 'https://api.open-meteo.com/v1/forecast?latitude=45.52&longitude=-122.68&current=temperature_2m',
    idempotencyKey: crypto.randomUUID(),
  });
  pollFound(orgId, weather.id, 60 * MINUTE);
  pollsFailed(orgId, weather.id, 1);
  await owner.reload();
  await hydrated(owner);
  await expect(now).toContainText('The forecast service is not answering. SignForge keeps checking it; there is nothing to change here.');
  await expect(now.getByRole('button', { name: /for Weather, Portland$/ })).toHaveCount(0);
  await owner.getByRole('button', { name: 'Manage Weather' }).click();
  const forecasts = owner.getByRole('dialog', { name: 'Weather' });
  await expect(forecasts.getByRole('button', { name: 'Delete Weather, Portland' })).toBeVisible();
  await expect(forecasts.getByRole('button', { name: 'Change the URL of Weather, Portland' })).toHaveCount(0);
  await forecasts.getByRole('button', { name: 'Delete Weather, Portland' }).click();
  const confirmWeather = owner.getByRole('alertdialog', { name: 'Delete Weather, Portland?' });
  await expect(confirmWeather).toContainText('choose the place again in a weather spot');
  await expect(confirmWeather).not.toContainText('address');
  await confirmWeather.getByRole('button', { name: 'Cancel' }).click();
  await owner.keyboard.press('Escape');
});

test('connected accounts: reconnect and disconnect, a failing read, and what the provider callback sends back', async ({ browser }) => {
  test.setTimeout(150_000);
  // No provider is configured in dev (each connector ticket adds its own), so the account is put in the run's D1.
  const at = Date.now();
  d1(
    `INSERT INTO connections (id, org_id, provider, account, scopes_json, status, created_by, created_at, updated_at) ` +
      `VALUES ('con_e2e_${at}', '${orgId}', 'google', 'facilities@example.com', '[]', 'needs_reconnect', 'e2e', ${at}, ${at})`,
  );
  await owner.reload();
  await hydrated(owner);
  const accounts = owner.getByRole('region', { name: 'Connected accounts' });
  await expect(accounts.getByText('Google · facilities@example.com')).toBeVisible();
  await expect(accounts.getByText('Needs reconnecting')).toBeVisible();
  await axe(owner);
  await shots(owner, '63-integrations-accounts');
  // Reconnect asks the API for the provider's page (held here a moment, as a slow answer would be),
  // saying so on its own button; this deployment connects none, and says so.
  await owner.route('**/api/tools/start_connection', async (route) => {
    await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });
  await accounts.getByRole('button', { name: 'Reconnect facilities@example.com' }).click();
  await expect(accounts.getByRole('button', { name: 'Reconnect facilities@example.com' })).toHaveText('Opening…');
  await expect(accounts.getByRole('button', { name: 'Disconnect facilities@example.com' })).toHaveText('Disconnect');
  await expect(accounts.getByRole('alert')).toContainText('cannot be connected here');
  await owner.unroute('**/api/tools/start_connection');
  // Disconnect asks first, saying what stops working; a refusal is said once, in the confirm.
  await accounts.getByRole('button', { name: 'Disconnect facilities@example.com' }).click();
  const confirm = owner.getByRole('alertdialog', { name: 'Disconnect facilities@example.com?' });
  await expect(confirm).toContainText('Sources that read through it stop updating');
  await owner.route('**/api/tools/disconnect', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable', message: 'The provider did not answer. Try again.' } }),
  );
  await confirm.getByRole('button', { name: 'Disconnect' }).click();
  await expect(confirm.getByRole('alert')).toHaveText('The provider did not answer. Try again.');
  await expect(owner.getByText('The provider did not answer. Try again.')).toHaveCount(1);
  await owner.unroute('**/api/tools/disconnect');
  await confirm.getByRole('button', { name: 'Disconnect' }).click();
  // Its last account gone and no provider to connect here, the card goes.
  await expect(accounts).toHaveCount(0);
  expect((await tool(owner, 'list_connections', {})).connections).toEqual([]);

  // The page's 30-second read fails (no server function answers): it says its sources are not current, until a good read.
  const refuse = '**/_serverFn/**';
  await owner.route(refuse, (route) => route.abort('connectionrefused'));
  const stale = owner.getByRole('region', { name: 'Feeding screens now' }).getByRole('status');
  await expect(stale).toContainText(/Not current\. SignForge has not answered since \d+:\d\d [AP]M\./, { timeout: 45_000 });
  await axe(owner);
  await shots(owner, '65-integrations-not-current');
  await owner.unroute(refuse);
  await expect(stale).toBeEmpty({ timeout: 45_000 });

  // Back from a provider that refused: the page says so until dismissed.
  await owner.goto('/integrations?connectionError=denied');
  await hydrated(owner);
  await expect(owner.getByRole('status').filter({ hasText: 'Not connected' })).toHaveText('Not connected: the provider says you did not approve it.');
  await owner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(owner).not.toHaveURL(/connectionError/);

  // A signed-out browser back from the provider goes to sign-in, on its way to this page.
  const signedOut = await (await browser.newContext()).newPage();
  await signedOut.goto('/api/connections/callback?state=whatever-state-value&code=whatever');
  await expect(signedOut).toHaveURL(/\/sign-in\?redirect=%2Fintegrations%3FconnectionError%3Dsigned_out/);
  await signedOut.context().close();
});

test("a viewer reads the sources and changes nothing; another org's sources never show", async ({ browser }) => {
  test.setTimeout(120_000);
  const viewerEmail = `e2e-integrations-viewer-${Date.now()}@example.com`;
  const viewer = await memberPage(browser, viewerEmail, VIEWER_ADDRESS);
  // Better Auth's own endpoints, as the Members page calls them (it checks the origin).
  const headers = { origin: CMS_URL };
  const invited = await owner.request.post('/api/auth/organization/invite-member', {
    headers,
    data: { email: viewerEmail, role: 'viewer', organizationId: orgId },
  });
  expect(invited.status(), await invited.text()).toBe(200);
  const accepted = await viewer.request.post('/api/auth/organization/accept-invitation', { headers, data: { invitationId: (await invited.json()).id } });
  expect(accepted.status(), await accepted.text()).toBe(200);

  await viewer.goto('/integrations');
  await hydrated(viewer);
  const now = viewer.getByRole('region', { name: 'Feeding screens now' });
  await expect(now.getByText('iCal · Break room')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^Connect / })).toHaveCount(0);
  await viewer.getByRole('button', { name: 'View iCal URL' }).click();
  const dialog = viewer.getByRole('dialog', { name: 'iCal calendars' });
  await expect(dialog.getByText('Used by Break room agenda.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Change the URL|Delete/ })).toHaveCount(0);
  await viewer.context().close();

  const stranger = await memberPage(browser, `e2e-integrations-stranger-${Date.now()}@example.com`, STRANGER_ADDRESS);
  await newOrg(stranger, 'Elsewhere');
  await stranger.goto('/integrations');
  await hydrated(stranger);
  await expect(stranger.getByRole('region', { name: 'Feeding screens now' })).toContainText('No data sources yet');
  expect((await tool(stranger, 'list_data_sources', {})).dataSources).toEqual([]);
  await stranger.context().close();
});
