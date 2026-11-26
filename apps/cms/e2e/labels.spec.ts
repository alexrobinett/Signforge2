import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';
import { API_PORT } from './servers';

// Screen labels in the CMS (#185): a screen labelled on its page, with the typo guard, and a new screen paired with
// labels copied from it. Its own client addresses, so its sign-in and pairing have rate limits of their own.
const ADDRESS = '192.0.2.185';
const DEVICE = `http://127.0.0.1:${API_PORT}/v1/device`;

/** With E2E_SCREENSHOTS: light and dark at the desktop's width, then at a phone's (390 px). */
async function shotsBoth(page: Page, name: string, at?: Locator) {
  if (!process.env.E2E_SCREENSHOTS) return;
  const size = page.viewportSize()!;
  await shots(page, `${name}-desktop`);
  await page.setViewportSize({ width: 390, height: 844 });
  await at?.scrollIntoViewIfNeeded();
  await shots(page, `${name}-390`);
  await page.setViewportSize(size);
}

/** A code a screen shows, as the player asks for one. */
async function pairingCode(request: APIRequestContext) {
  const start = await request.post(`${DEVICE}/pair/start`, { headers: { 'cf-connecting-ip': '192.0.2.186' } });
  expect(start.status()).toBe(200);
  return ((await start.json()) as { code: string }).code;
}

test('label a screen on its page, see a lonely value flagged, and pair a new screen with its labels copied', async ({ page, request }) => {
  await signInAs(page, `e2e-labels-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbor Drive-thrus', ADDRESS);
  const first = (await tool(page, 'claim_screen', { code: await pairingCode(request), name: 'Drive 1', timezone: 'Europe/London', orientation: 'landscape' }))
    .screen as { id: string };
  await tool(page, 'claim_screen', {
    code: await pairingCode(request),
    name: 'Lobby',
    timezone: 'Europe/London',
    orientation: 'landscape',
    labels: { region: 'north', store: '0142' },
  });

  await page.goto(`/screens/${first.id}`);
  await hydrated(page);
  const labels = page.getByRole('region', { name: 'Labels' });
  await expect(labels.getByText('No labels yet.')).toBeVisible();
  // System labels are shown, read-only, from its settings.
  await expect(labels.getByText('orientation: landscape')).toBeVisible();
  await labels.getByRole('button', { name: 'Edit' }).click();

  const dialog = page.getByRole('dialog', { name: 'Labels' });
  await dialog.getByLabel('Label 1 key').fill('region');
  await dialog.getByLabel('Label 1 value').fill('nrth');
  await expect(dialog.getByText('nrth: no other screen has this value')).toBeVisible();
  await dialog.getByLabel('Label 1 value').fill(' North ');
  await expect(dialog.getByText(/no other screen has this value/)).toBeHidden();
  await dialog.getByRole('button', { name: 'Add a label' }).click();
  await dialog.getByLabel('Label 2 key').fill('Type');
  await dialog.getByLabel('Label 2 value').fill('drive-thru');
  await shotsBoth(page, '185-labels-dialog');
  await axe(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  // Trimmed, and the key lowercased, as every key is.
  await expect(labels.getByText('region: North')).toBeVisible();
  await expect(labels.getByText('type: drive-thru')).toBeVisible();
  await shotsBoth(page, '185-screen-labels', labels);

  // A new screen in the same store: its labels copied from Lobby as it is paired.
  await page.goto('/screens?pair=true');
  await hydrated(page);
  const pair = page.getByRole('dialog', { name: 'Pair a screen' });
  await pair.getByLabel('Copy labels from…').selectOption({ label: 'Lobby' });
  await expect(pair.getByLabel('Label 1 key')).toHaveValue('region');
  await expect(pair.getByLabel('Label 2 value')).toHaveValue('0142');
  await pair
    .getByRole('textbox')
    .first()
    .fill(await pairingCode(request));
  await pair.getByLabel('Name it').fill('Drive 2');
  await shotsBoth(page, '185-pair-labels', pair.getByLabel('Copy labels from…'));
  await pair.getByRole('button', { name: 'Pair' }).click();
  await expect(page.getByRole('heading', { name: 'Drive 2', level: 1 })).toBeVisible();
  const paired = page.getByRole('region', { name: 'Labels' });
  await expect(paired.getByText('region: north')).toBeVisible();
  await expect(paired.getByText('store: 0142')).toBeVisible();
});
