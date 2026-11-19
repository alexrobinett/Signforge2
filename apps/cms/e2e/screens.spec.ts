import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { axe, fillUntilEnabled, hydrated, publishImage, shots, signInAs } from './helpers';
import { API_PORT, RUN_DIR } from './servers';

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
function stopSyncing(screenId: string, minutes: number) {
  const sql = `UPDATE screens SET last_seen_at = last_seen_at - ${minutes * 60_000} WHERE id = '${screenId}'`;
  const run = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--env', 'dev', '--persist-to', `${RUN_DIR}state`, '--command', sql], {
    cwd: fileURLToPath(new URL('../../api/', import.meta.url)),
    env: { ...process.env, CLOUDFLARE_ENV: 'dev', NO_COLOR: '1' },
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
}

test('pair a screen from the empty Screens page, watch it come online, wake, identify, set its hours and revoke it', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await axe(page);
  await shots(page, '10-sign-in');
  await signInAs(page, `e2e-screens-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Northside Market', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Northside Market', level: 1 })).toBeVisible();

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
  await expect(page.getByText('Nothing published to it yet', { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing to cache yet: nothing is published to it.')).toBeVisible();

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
  await eve.getByLabel('On at').nth(1).fill('17:00');
  await eve.getByLabel('Off at').nth(1).fill('21:00');
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
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByRole('rowheader', { name: /Lobby/ })).toBeVisible();
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
  const refused = await request.post(`${DEVICE}/sync`, { headers: { authorization: `Bearer ${credential}` }, data: {} });
  expect(refused.status()).toBe(401);
});

test('an edit keeps a change someone else made while the form was open, and refuses one it would overwrite', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-versions-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Eastside Deli', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Eastside Deli', level: 1 })).toBeVisible();

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
});

test('a screen that stops syncing turns unreachable on the open Screens page, without a reload', async ({ page, request }) => {
  test.setTimeout(90_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-fleet-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Westside Bakery', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Westside Bakery', level: 1 })).toBeVisible();

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

  // It stops syncing; the page, left open, says so within a poll.
  stopSyncing(screenId, 20);
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
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Eastside Deli', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Eastside Deli', level: 1 })).toBeVisible();
  const pairing = await startPairing(request);
  const claimed = await page.request.post('/api/tools/claim_screen', {
    data: { code: pairing.code, name: 'Counter', timezone: 'UTC', orientation: 'landscape' },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  await sync(request, await pairing.credential());

  // The API does not answer the page's polls (every server function, which only the poll calls
  // while the page sits open), from the first: the notice comes, and holds through the next tries.
  const refuse = () => page.route('**/_serverFn/**', (route) => route.abort('connectionrefused'));
  await refuse();
  await page.goto('/screens');
  await hydrated(page);
  const notice = page.getByRole('status').filter({ hasText: 'Status is not current.' });
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
  await page.waitForTimeout(17_000);
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
