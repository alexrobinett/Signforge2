import { expect, test, type APIRequestContext } from '@playwright/test';
import { axe, createOrg, d1, disabledOnServer, hydrated, innerCorner, publishImage, shots, signInAs, tool } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.11';

const DEVICE = `http://127.0.0.1:${API_PORT}/v1/device`;

/** A screen asking to pair, as the player does: its code, and how it collects its credential. */
async function startPairing(request: APIRequestContext) {
  const start = await request.post(`${DEVICE}/pair/start`, { headers: { 'cf-connecting-ip': '192.0.2.12' } });
  expect(start.status()).toBe(200);
  const { code, pollToken } = (await start.json()) as { code: string; pollToken: string };
  return {
    code,
    async credential() {
      const poll = await request.post(`${DEVICE}/pair/poll`, { data: { pollToken }, headers: { 'cf-connecting-ip': '192.0.2.12' } });
      const body = (await poll.json()) as { status: string; credential?: string };
      expect(body.status).toBe('paired');
      return body.credential!;
    },
  };
}

/** One sync, as a player playing `active` (by default nothing) would send it. */
async function sync(request: APIRequestContext, credential: string, display = { on: true }, active?: string) {
  const res = await request.post(`${DEVICE}/sync`, {
    headers: { authorization: `Bearer ${credential}` },
    data: {
      seq: 0,
      epoch: 'e2e',
      player: { version: '0.0.0-e2e', manifestSchemas: [2], protocols: [1, 2] },
      manifest: { ...(active ? { active } : {}), filesMissing: 0 },
      display,
      deviceTime: new Date().toISOString(),
      clock: { offsetMs: 0, trusted: true },
      playCounts: [],
      snapshots: {},
    },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { commands: unknown[] };
}

/**
 * As if the screen stopped syncing `minutes` ago: its last sync moved back in the run's local D1,
 * which the dev API reads (`e2e/global-setup.ts`). Waiting out the org's 5-minute minimum would do the same, slowly.
 */
test('pair a screen from the empty Screens page, watch it come online, wake, identify, set its hours and revoke it', async ({ page, request }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await axe(page);
  await shots(page, '10-sign-in');
  await signInAs(page, `e2e-screens-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Arcade', ADDRESS);

  // Empty: one path, pairing, with the code input on the page.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await expect(page.getByRole('heading', { name: 'See your first spot on a screen' })).toBeVisible();
  await axe(page);
  await shots(page, '11-screens-empty');

  const screen = await startPairing(request);
  // The whole code typed into the first box fills them all; case and the gap do not matter.
  await expect(async () => {
    await page.getByLabel('Character 1 of 6').fill(screen.code.toLowerCase());
    await expect(page.getByLabel('Character 6 of 6')).toHaveValue(screen.code.at(-1)!, { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await page.getByLabel('Name it').fill('Lobby');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();

  // Paired: the screen's page, before it has synced.
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1 })).toBeVisible();
  await expect(page.getByText('Not heard from yet').first()).toBeVisible();

  // The screen collects its credential and syncs: heard from, with nothing published to it.
  const credential = await screen.credential();
  await sync(request, credential);
  await page.reload();
  await hydrated(page);
  await expect(page.getByText('Needs you').first()).toBeVisible();
  await expect(page.getByRole('img', { name: 'Nothing published yet' })).toBeVisible();
  // The thumbnail's corner fits the stage around it: the stage's radius less its padding (#383).
  const stageCorner = await innerCorner(page.getByRole('img', { name: 'Nothing published yet' }));
  expect(stageCorner.radius).toBe(stageCorner.fits);
  // And a menu's item, its highlight, inside the menu (ui/dropdown-menu.tsx).
  await page.getByRole('button', { name: 'More actions: settings, display hours, revoke' }).click();
  const itemCorner = await innerCorner(page.getByRole('menuitem').first(), page.getByRole('menu'));
  expect(itemCorner.radius).toBe(itemCorner.fits);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByText('Nothing to cache yet: nothing is published to it.')).toBeVisible();
  // Nothing published is said by the thumbnail alone: no caption under it (#374).
  await expect(page.locator('figcaption')).toHaveCount(0);

  // Live seconds do not move the page (#375): heard 1 s, then 8 s ago, at phone width. The page shows the later
  // of the server's read time and its clock, fixed an hour ahead: the server's can't pass it before the test times out.
  const lobbyId = new URL(page.url()).pathname.split('/').at(-1);
  const ahead = 3_600_000;
  expect(test.info().timeout).toBeLessThan(ahead);
  const step = Math.ceil(Date.now() / 10_000) * 10_000 + ahead;
  await page.clock.setFixedTime(step);
  await page.setViewportSize({ width: 390, height: 844 });
  const heardLine = page.getByText(/^last heard \d+ s ago$/);
  const boxes = () => Promise.all([heardLine.boundingBox(), page.getByRole('button', { name: 'Sleep now' }).boundingBox()]);
  const heardAgo = async (seconds: number) => {
    await d1(`UPDATE screens SET last_seen_at = ${step - seconds * 1000} WHERE id = '${lobbyId}'`);
    await page.reload();
    await hydrated(page);
    await expect(heardLine).toHaveText(`last heard ${seconds} s ago`);
    return boxes();
  };
  expect(await heardAgo(8)).toEqual(await heardAgo(1));
  await page.setViewportSize({ width: 1280, height: 720 });
  // Its tile says nothing published once, in the thumbnail, not again under it (#374).
  await page.goto('/screens');
  await hydrated(page);
  const lobbyTile = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Lobby' }) });
  await expect(lobbyTile.getByRole('img', { name: 'Nothing published yet' })).toBeVisible();
  await expect(lobbyTile).not.toContainText('Nothing is published to it yet');
  await shots(page, '13-screens-tile-nothing-published');
  await page.getByRole('link', { name: 'Lobby' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1 })).toBeVisible();
  await hydrated(page);

  // Sleep now: stored, and carried by the next sync to the screen.
  await page.getByRole('button', { name: 'Sleep now' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sleeping it until' })).toBeVisible();
  await expect(page.getByText(/Put to sleep from the CMS until/)).toBeVisible();
  expect((await sync(request, credential)).commands).toEqual([{ type: 'display', override: { state: 'off', until: expect.any(String) } }]);
  await page.getByRole('button', { name: 'Back to display hours' }).click();
  await expect(page.getByRole('button', { name: 'Sleep now' })).toBeVisible();

  await page.getByRole('button', { name: 'Identify (10 s)' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'shows its name for 10 seconds' })).toBeVisible();

  // Display hours, checked as the player checks them.
  await page.getByRole('button', { name: 'Edit' }).click();
  const hours = page.getByRole('dialog', { name: 'Display hours for Lobby' });
  await hours.getByText('Set hours', { exact: true }).click();
  // Each window is a named group, so its times say whose they are (#377).
  await expect(hours.getByRole('group', { name: 'Window 1' }).getByLabel('On at')).toBeVisible();
  await expect(hours.getByRole('radio', { name: 'Set hours' })).toBeChecked();
  await hours.getByRole('button', { name: 'Sunday' }).click();
  await hours.getByRole('button', { name: 'Saturday' }).click();
  await hours.getByLabel('On at').fill('07:00');
  await hours.getByLabel('Off at').fill('19:00');
  await axe(page);
  await shots(page, '12-display-hours');
  await hours.getByRole('button', { name: 'Save' }).click();
  await expect(hours).toBeHidden();
  await expect(page.getByText('Mon–Fri 07:00–19:00').first()).toBeVisible();
  await expect(page.getByText('Display hours changed').first()).toBeVisible();
  await axe(page);
  await shots(page, '13-screen-detail');

  // A date with morning and evening hours keeps both through a save, and through an edit of one.
  await page.getByRole('button', { name: 'Edit' }).click();
  await hours.getByRole('button', { name: 'Add a date' }).click();
  await hours.getByLabel('Date', { exact: true }).fill('2026-12-24');
  await hours.getByLabel('Off all day').uncheck();
  const eve = hours.getByRole('group', { name: 'Hours on 2026-12-24' });
  await eve.getByLabel('On at').fill('08:00');
  await eve.getByLabel('Off at').fill('12:00');
  await eve.getByRole('button', { name: 'Add hours on this date' }).click();
  // Each window on the date is its own named group, as the weekly ones are (#377).
  const second = eve.getByRole('group', { name: 'Window 2 on 2026-12-24' });
  await second.getByLabel('On at').fill('17:00');
  await second.getByLabel('Off at').fill('21:00');
  await expect(eve.getByRole('group', { name: 'Window 1 on 2026-12-24' }).getByLabel('On at')).toHaveValue('08:00');
  await hours.getByRole('button', { name: 'Save' }).click();
  await expect(hours).toBeHidden();
  const reopen = async () => {
    await page.reload();
    await hydrated(page);
    await page.getByRole('button', { name: 'Edit' }).click();
    const values = async (label: string) => Promise.all((await eve.getByLabel(label).all()).map((f) => f.inputValue()));
    return [await values('On at'), await values('Off at')];
  };
  expect(await reopen()).toEqual([
    ['08:00', '17:00'],
    ['12:00', '21:00'],
  ]);
  await eve.getByLabel('Off at').first().fill('12:30');
  await hours.getByRole('button', { name: 'Save' }).click();
  await expect(hours).toBeHidden();
  expect(await reopen()).toEqual([
    ['08:00', '17:00'],
    ['12:30', '21:00'],
  ]);
  await hours.getByRole('button', { name: 'Cancel' }).click();

  // The wall, and the table.
  await page.getByRole('link', { name: 'Screens', exact: true }).first().click();
  await expect(page.getByRole('link', { name: 'Lobby' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 screen' })).toBeVisible();
  await axe(page);
  await shots(page, '14-screens-tiles');
  // A landscape tile does not say 16:9: only a portrait one says its ratio (#374).
  await expect(page.getByRole('main').getByText('16:9', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByRole('rowheader', { name: /Lobby/ })).toBeVisible();
  // By name unless a column says otherwise; a column's header sorts by it, and again the other way (#180).
  const heard = page.getByRole('columnheader', { name: 'Last heard' });
  await expect(page.getByRole('columnheader', { name: 'Screen', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  await heard.getByRole('link').click();
  await expect(page).toHaveURL(/sort=heard/);
  await expect(heard).toHaveAttribute('aria-sort', 'ascending');
  await heard.getByRole('link').click();
  await expect(page).toHaveURL(/sort=-heard/);
  await expect(heard).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByRole('columnheader', { name: 'Screen', exact: true })).not.toHaveAttribute('aria-sort');
  // A row's menu plays a playlist on its screen, in the schedule's entry dialog aimed at it (#181).
  await page.getByRole('button', { name: 'Actions for Lobby' }).click();
  await page.getByRole('menuitem', { name: 'Play on this screen…' }).click();
  const entry = page.getByRole('dialog', { name: 'Schedule a playlist' });
  await expect(entry.getByRole('combobox', { name: 'Plays on' })).toHaveText('Lobby');
  await entry.getByRole('button', { name: 'Cancel' }).click();
  await expect(entry).toBeHidden();
  await axe(page);
  await shots(page, '15-screens-table');

  await page.setViewportSize({ width: 412, height: 915 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Tiles' }).click();
  await axe(page);
  await shots(page, '16-phone-screens');
  await page.getByRole('link', { name: 'Lobby' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await axe(page);
  await shots(page, '17-phone-screen-detail');
  await page.setViewportSize({ width: 1280, height: 720 });

  // Revoke, behind a confirmation: the screen is refused from then on.
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Revoke…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText(/credential was revoked/)).toBeVisible();
  // Its thumbnail does not say it plays anything (#362).
  await expect(page.getByRole('img', { name: 'Revoked: plays nothing' })).toBeVisible();
  const refused = await request.post(`${DEVICE}/sync`, { headers: { authorization: `Bearer ${credential}` }, data: {} });
  expect(refused.status()).toBe(401);
});

test('an edit keeps a change someone else made while the form was open, and refuses one it would overwrite', async ({ page, request }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-versions-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Eastside Deli', ADDRESS);

  // The page's own session stands in for an agent: what matters is that its changes land in between.
  const tool = async (name: string, input: unknown) => {
    const res = await page.request.post(`/api/tools/${name}`, { data: input });
    expect(res.status(), `${name}: ${await res.text()}`).toBe(200);
    return (await res.json()) as { screen?: { id: string }; group?: { id: string; screenIds: string[] } };
  };
  const pair = async (name: string) =>
    (await tool('claim_screen', { code: (await startPairing(request)).code, name, timezone: 'UTC', orientation: 'landscape' })).screen!.id;
  const lobby = await pair('Lobby');
  const hall = await pair('Hall');
  // A portrait screen's tile says its ratio; a landscape one's says none (#374).
  await tool('claim_screen', { code: (await startPairing(request)).code, name: 'Kiosk', timezone: 'UTC', orientation: 'portrait' });
  await page.goto('/screens');
  await hydrated(page);
  await expect(page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Kiosk' }) })).toContainText('9:16');
  await expect(page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Hall' }) })).not.toContainText('16:9');
  const group = (await tool('create_group', { name: 'Windows' })).group!;

  await page.goto(`/screens/${lobby}`);
  await hydrated(page);
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Settings and groups…' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByLabel('Windows').check();

  // An agent puts Hall in the group while the form is open; saving the form keeps it there.
  await tool('add_group_members', { groupId: group.id, screenIds: [hall] });
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings).toBeHidden();
  const { groups } = (await (await page.request.post('/api/tools/list_groups', { data: {} })).json()) as { groups: { id: string; screenIds: string[] }[] };
  expect(groups.find((g) => g.id === group.id)?.screenIds).toEqual([hall, lobby].sort());

  // An agent renames the screen while the form is open; the person's rename is refused, not written over it.
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Settings and groups…' }).click();
  await tool('rename_screen', { screenId: lobby, name: 'Front lobby' });
  await settings.getByLabel('Name').fill('Main lobby');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText('This changed since you opened it.')).toBeVisible();
  await settings.getByRole('button', { name: 'Reload' }).click();
  await expect(settings).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Front lobby', level: 1 })).toBeVisible();

  // A long one-word name wraps at phone width instead of widening the page (#372).
  // Wide letters, so the breadcrumb's copy of the name is wider than the screen too.
  const long = `Frontlobby${'W'.repeat(30)}`;
  await tool('rename_screen', { screenId: lobby, name: long });
  await page.reload();
  await hydrated(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: long, level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a screen that stops syncing turns unreachable on the open Screens page, without a reload', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-fleet-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Westside Bakery', ADDRESS);

  // A screen paired, published to and playing it.
  const pairing = await startPairing(request);
  const claimed = await page.request.post('/api/tools/claim_screen', {
    data: { code: pairing.code, name: 'Window', timezone: 'UTC', orientation: 'landscape' },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  const screenId = ((await claimed.json()) as { screen: { id: string } }).screen.id;
  const credential = await pairing.credential();
  await sync(request, credential, { on: true }, await publishImage(page, screenId));

  await page.goto('/screens');
  await hydrated(page);
  const tile = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Window' }) });
  await expect(tile.getByText('Online')).toBeVisible();
  await expect(tile.getByText('Playing Welcome · as scheduled')).toBeVisible();
  await page.evaluate(() => Object.assign(window, { sfStayed: true }));

  // A publish to it, which it plays: the poll sees the new version and the page reads what it shows.
  await sync(request, credential, { on: true }, await publishImage(page, screenId, 'Specials'));
  await expect(tile.getByText('Playing Specials · as scheduled')).toBeVisible({ timeout: 30_000 });

  // It stops syncing; the page, left open, says so within a poll. Its last sync is put 20 minutes
  // before the page's own clock, fixed, so the minutes it shows do not depend on how long this takes.
  const at = Date.now();
  await page.clock.setFixedTime(at);
  await d1(`UPDATE screens SET last_seen_at = ${at - 20 * 60_000} WHERE id = '${screenId}'`);
  await expect(tile.getByText('Unreachable 20 min · still playing Specials')).toBeVisible({ timeout: 30_000 });
  await expect(tile.getByText('Online')).toBeHidden();
  expect(await page.evaluate(() => 'sfStayed' in window)).toBe(true);
  await axe(page);
  await shots(page, '18-screens-went-unreachable');
  await page.setViewportSize({ width: 412, height: 915 });
  await axe(page);
  await shots(page, '19-phone-screens-went-unreachable');
});

test('the Screens page says when its poll fails, until a good one, and an expired session goes to sign-in', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.goto('/sign-in');
  await hydrated(page);
  // Its own address: this spec's other tests use up ADDRESS's sign-in budget.
  await signInAs(page, `e2e-poll-${Date.now()}@example.com`, '192.0.2.15');
  await createOrg(page, 'Eastside Deli', '192.0.2.15');
  const pairing = await startPairing(request);
  const claimed = await page.request.post('/api/tools/claim_screen', {
    data: { code: pairing.code, name: 'Counter', timezone: 'UTC', orientation: 'landscape' },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  await sync(request, await pairing.credential());

  // The API does not answer the page's polls (every server function, which only the poll calls
  // while the page sits open), from the first: the notice comes, and holds through the next tries.
  // Only the status poll's tries are counted: the latest publish's read retries on its own, sooner.
  let statusRefused = 0;
  const refuse = () =>
    page.route('**/_serverFn/**', (route) => {
      if (new URL(route.request().url()).pathname.startsWith('/_serverFn/getScreenStatus_')) statusRefused += 1;
      return route.abort('connectionrefused');
    });
  await refuse();
  await page.goto('/screens');
  await hydrated(page);
  // The page's own notice: the sidebar's counts, read by the same server functions, say theirs are not current too (#361).
  const notice = page.getByRole('main').getByRole('status').filter({ hasText: 'Status is not current.' });
  await expect(page.getByRole('link', { name: 'Counter' })).toBeVisible();
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText(/SignForge has not answered since \d{1,2}\D\d{2}/);
  // Sampled in the page every 100 ms: each time the notice is missing, counted on the body.
  await page.evaluate(() => {
    let gone = 0;
    setInterval(() => {
      if (!document.body.textContent.includes('Status is not current.')) document.body.dataset.noticeGone = String(++gone);
    }, 100);
  });
  // Until the next status poll (every 15 s after the last try) and its retry are refused too.
  const before = statusRefused;
  await expect.poll(() => statusRefused, { timeout: 60_000 }).toBeGreaterThanOrEqual(before + 2);
  expect(await page.evaluate(() => document.body.dataset.noticeGone)).toBeUndefined();
  await axe(page);
  await shots(page, '20-screens-status-not-current');
  await page.setViewportSize({ width: 412, height: 915 });
  await axe(page);
  await shots(page, '21-phone-screens-status-not-current');
  await page.setViewportSize({ width: 1280, height: 720 });

  // It answers again: the next good poll clears the notice.
  await page.unroute('**/_serverFn/**');
  await expect(notice).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Counter' })).toBeVisible();
  // Its live region stays in the accessibility tree while empty, beside the summary's, so the next notice is announced.
  await expect(page.getByRole('main').getByRole('status')).toHaveCount(2);

  // It stops answering after a good poll: the notice comes back, and goes with the next good one.
  await refuse();
  await expect(notice).toBeVisible({ timeout: 40_000 });
  await page.unroute('**/_serverFn/**');
  await expect(notice).toBeHidden({ timeout: 30_000 });

  // The session ends while the page is open: the next poll goes to sign-in, which comes back here after it.
  await page.context().clearCookies();
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fscreens$/, { timeout: 40_000 });
});

test("a screen's actions are disabled in the server's HTML, until the page has hydrated (#136)", async ({ page, request }) => {
  // The page hydrates after the app (body[data-hydrated]): a click in between went nowhere.
  await signInAs(page, `e2e-screen-server-${Date.now()}@example.com`, '192.0.2.17');
  await createOrg(page, 'Northside Arcade', '192.0.2.17');
  const { code } = await startPairing(request);
  const { screen } = await tool(page, 'claim_screen', { code, name: 'Front window', timezone: 'UTC', orientation: 'landscape' });
  const path = `/screens/${screen.id}`;
  const names = ['Identify (10 s)', 'Restart player', 'More actions: settings, display hours, revoke'];
  expect(await disabledOnServer(page, path, names)).toEqual(Object.fromEntries(names.map((n) => [n, [true]])));
  // Rendered by the server, they are enabled once the page has hydrated.
  await page.goto(path);
  await hydrated(page);
  await expect(page.getByRole('button', { name: 'Identify (10 s)' })).toBeEnabled();
  // But for Restart: a screen not heard from yet cannot be reached, so it stays off, and says why (#253).
  const restart = page.getByRole('button', { name: 'Restart player' });
  await expect(restart).toBeDisabled();
  await expect(restart).toHaveAccessibleDescription('Restart is off: the screen cannot be reached now, and a restart only reaches a screen in touch.');
});

test("the Screens page's pairing form, and its search and filters, are disabled in the server's HTML, until the page has hydrated (#140)", async ({
  page,
  request,
}) => {
  // The page hydrates after the app (body[data-hydrated]): a field changed in between was set back
  // by React, and a filter chosen in between went nowhere.
  await signInAs(page, `e2e-screens-server-${Date.now()}@example.com`, '192.0.2.18');
  await createOrg(page, 'Northside Arcade', '192.0.2.18');
  // No screens yet: the pairing form is on the page.
  const pairing = [...Array.from({ length: 6 }, (_, i) => `Character ${i + 1} of 6`), 'Name it', 'Time zone', 'Orientation', 'Pair'];
  expect(await disabledOnServer(page, '/screens', pairing)).toEqual(Object.fromEntries(pairing.map((n) => [n, [true]])));
  await page.goto('/screens');
  await hydrated(page);
  await expect(page.getByLabel('Name it')).toBeEnabled();

  const { code } = await startPairing(request);
  const { screen } = await tool(page, 'claim_screen', { code, name: 'Front window', timezone: 'UTC', orientation: 'landscape' });
  // In a group, so the Group filter has it.
  await tool(page, 'create_group', { name: 'Windows', screenIds: [screen.id] });
  const filters = ['Search screens', 'Group', 'Status', 'Tiles', 'Table'];
  expect(await disabledOnServer(page, '/screens', filters)).toEqual(Object.fromEntries(filters.map((n) => [n, [true]])));
  await page.goto('/screens');
  await hydrated(page);
  await expect(page.getByLabel('Status', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('Group', { exact: true })).toBeEnabled();
});
