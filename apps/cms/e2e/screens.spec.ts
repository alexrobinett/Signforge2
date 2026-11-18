import { expect, test, type APIRequestContext } from '@playwright/test';
import { fillUntilEnabled, hydrated, shots, signInAs } from './helpers';
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

/** One sync, as a player with nothing to play would send it. */
async function sync(request: APIRequestContext, credential: string, display = { on: true }) {
  const res = await request.post(`${DEVICE}/sync`, {
    headers: { authorization: `Bearer ${credential}` },
    data: {
      seq: 0,
      epoch: 'e2e',
      player: { version: '0.0.0-e2e', manifestSchemas: [2], protocols: [1, 2] },
      manifest: { filesMissing: 0 },
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

test('pair a screen from the empty Screens page, watch it come online, wake, identify, set its hours and revoke it', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto('/sign-in');
  await hydrated(page);
  await shots(page, '10-sign-in');
  await signInAs(page, `e2e-screens-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Northside Market', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Northside Market', level: 1 })).toBeVisible();

  // Empty: one path, pairing, with the code input on the page.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await expect(page.getByRole('heading', { name: 'See your first spot on a screen' })).toBeVisible();
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
  await shots(page, '12-display-hours');
  await hours.getByRole('button', { name: 'Save' }).click();
  await expect(hours).toBeHidden();
  await expect(page.getByText('Mon–Fri 07:00–19:00').first()).toBeVisible();
  await expect(page.getByText('Display hours changed').first()).toBeVisible();
  await shots(page, '13-screen-detail');

  // The wall, and the table.
  await page.getByRole('link', { name: 'Screens', exact: true }).first().click();
  await expect(page.getByRole('link', { name: 'Lobby' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '1 screen' })).toBeVisible();
  await shots(page, '14-screens-tiles');
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page).toHaveURL(/view=table/);
  await expect(page.getByRole('rowheader', { name: /Lobby/ })).toBeVisible();
  await shots(page, '15-screens-table');

  await page.setViewportSize({ width: 412, height: 915 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Tiles' }).click();
  await shots(page, '16-phone-screens');
  await page.getByRole('link', { name: 'Lobby' }).click();
  await expect(page.getByRole('heading', { name: 'Lobby', level: 1 })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
