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
async function pairingCode(request: APIRequestContext, address = '192.0.2.186') {
  const start = await request.post(`${DEVICE}/pair/start`, { headers: { 'cf-connecting-ip': address } });
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
  await labels.getByRole('button', { name: 'Edit labels' }).click();

  const dialog = page.getByRole('dialog', { name: 'Labels' });
  await dialog.getByLabel('Label 1 key').fill('region');
  await dialog.getByLabel('Label 1 value').fill('nrth');
  await expect(dialog.getByText('nrth: no other screen has this value')).toBeVisible();
  // The warning's colour on the dialog, checked while it shows (review of #597).
  await axe(page);
  await dialog.getByLabel('Label 1 value').fill(' North ');
  await expect(dialog.getByText(/no other screen has this value/)).toBeHidden();
  await dialog.getByRole('button', { name: 'Add a label' }).click();
  await dialog.getByLabel('Label 2 key').fill('Type');
  await dialog.getByLabel('Label 2 value').fill('drive-thru');
  // A key another row has, once lowercased, is flagged, and nothing is saved until one goes (review of #597).
  await dialog.getByRole('button', { name: 'Add a label' }).click();
  await dialog.getByLabel('Label 3 key').fill('REGION');
  await dialog.getByLabel('Label 3 value').fill('south');
  await expect(dialog.getByText('region: another row has this key. Keep one.')).toBeVisible();
  await shotsBoth(page, '185-labels-dialog');
  await axe(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Fix the labels marked above first.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove label 3' }).click();
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
  // Choosing copies nothing: only the button does, so arrowing through the list never replaces typed labels.
  await expect(pair.getByLabel('Label 1 key')).toHaveCount(0);
  await pair.getByRole('button', { name: 'Copy its labels' }).click();
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

test('find screens by label: a typed chip kept in the URL across a reload, "+ Filter", and group by store', async ({ page, request }) => {
  await signInAs(page, `e2e-label-filters-${Date.now()}@example.com`, '192.0.2.187');
  await createOrg(page, 'Harbor Fleet', '192.0.2.187');
  const claim = async (name: string, labels: Record<string, string>) =>
    tool(page, 'claim_screen', { code: await pairingCode(request), name, timezone: 'Europe/London', orientation: 'landscape', labels });
  await claim('Drive North 1', { region: 'north', type: 'drive-thru', store: '0142' });
  await claim('Drive North 2', { region: 'North', type: 'drive-thru', store: '0142' });
  await claim('Kiosk North', { region: 'north', type: 'kiosk', store: '0009' });
  await claim('Drive South', { region: 'south', type: 'drive-thru' });

  await page.goto('/screens?view=table');
  await hydrated(page);
  const rows = page.getByRole('row').filter({ has: page.getByRole('rowheader') });
  await expect(rows).toHaveCount(4);
  // The search finds label values too; a typed key=value becomes a chip.
  await page.getByLabel('Search screens').fill('region=north');
  await page.getByLabel('Search screens').press('Enter');
  const chips = page.getByRole('list', { name: 'Label filters' });
  await expect(chips.getByText('region: north')).toBeVisible();
  await expect(page.getByLabel('Search screens')).toHaveValue('');
  await expect(rows).toHaveCount(3);
  await expect(page).toHaveURL(/l=region%3Anorth/);

  // Kept in the URL: a reload shows the same chip and the same screens.
  await page.reload();
  await hydrated(page);
  await expect(chips.getByText('region: north')).toBeVisible();
  await expect(rows).toHaveCount(3);

  // Typing in the middle of the search keeps the caret where it is (review of #601).
  const box = page.getByLabel('Search screens');
  await box.fill('drive north');
  await box.press('Home');
  for (let i = 0; i < 'drive'.length; i++) await box.press('ArrowRight');
  await box.pressSequentially('XY');
  await expect(box).toHaveValue('driveXY north');
  await box.fill('');

  // "+ Filter" adds a chip from the keys and values the screens have.
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const filter = page.getByRole('dialog', { name: 'Filter by a label' });
  await filter.getByLabel('Label', { exact: true }).selectOption('type');
  await filter.getByLabel('drive-thru').check();
  await axe(page);
  await filter.getByRole('button', { name: 'Apply' }).click();
  await expect(chips.getByText('type: drive-thru')).toBeVisible();
  await expect(rows).toHaveCount(2);

  // Group by store: a section per store, and one for the screens without it.
  await page.getByRole('button', { name: 'Remove filter type' }).click();
  await page.getByLabel('Group by').selectOption('store');
  await expect(page.getByRole('rowheader', { name: 'store: 0009 · 1 screen' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'store: 0142 · 2 screens' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove filter region' }).click();
  await expect(page.getByRole('rowheader', { name: 'No store · 1 screen' })).toBeVisible();
  await expect(page).toHaveURL(/by=store/);
  await shotsBoth(page, '185-table-grouped');
  await axe(page);

  // A key every object has on its prototype groups like any other (review of #601).
  await claim('Odd one', { constructor: 'x' });
  await page.goto('/screens?view=table&by=constructor');
  await hydrated(page);
  await expect(page.getByRole('rowheader', { name: 'constructor: x · 1 screen' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'No constructor · 4 screens' })).toBeVisible();

  // Tiles, grouped the same way, with each screen's labels under its name.
  await page.goto('/screens?by=store&l=type:drive-thru');
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'store: 0142 · 2 screens' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No store · 1 screen' })).toBeVisible();
  await shotsBoth(page, '185-tiles-grouped');
});

test('#185 done when: label 3 selected screens in bulk, filter by a chip and keep it across a reload, group by store', async ({ page, request }) => {
  await signInAs(page, `e2e-bulk-labels-${Date.now()}@example.com`, '192.0.2.188');
  await createOrg(page, 'Harbor Stores', '192.0.2.188');
  // Its own screens' address: the pairing limit counts per address, and the tests above pair seven.
  const claim = async (name: string, labels: Record<string, string>) =>
    tool(page, 'claim_screen', { code: await pairingCode(request, '192.0.2.189'), name, timezone: 'Europe/London', orientation: 'landscape', labels });
  await claim('Till 1', { region: 'north' });
  await claim('Till 2', { region: 'North' });
  await claim('Till 3', { region: 'south' });
  await claim('Lobby', { region: 'north', store: '0009' });

  await page.goto('/screens?view=table');
  await hydrated(page);
  for (const name of ['Till 1', 'Till 2', 'Till 3']) await page.getByLabel(`Select ${name}`).check();
  const bar = page.getByRole('region', { name: 'Selected screens' });
  await bar.getByRole('button', { name: 'Labels…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Labels on 3 screens' });
  // What the selection has now, by key, with the case exactly as shown: "north" and "North" are counted as one value.
  await expect(dialog.getByText('North (2), south (1)', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Takes effect at the next publish.')).toBeVisible();
  await dialog.getByLabel('Label', { exact: true }).fill('store');
  await dialog.getByLabel('Value').fill('0142');
  await expect(dialog.getByText('0142: no screen has this value yet')).toBeVisible();
  await shotsBoth(page, '185-bulk-labels');
  await axe(page);
  await dialog.getByRole('button', { name: 'Set on 3 screens' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Set store: 0142 on 3 screens')).toBeVisible();
  const row = (name: string) => page.getByRole('row').filter({ has: page.getByRole('rowheader', { name }) });
  for (const name of ['Till 1', 'Till 2', 'Till 3']) await expect(row(name).getByText('store: 0142')).toBeVisible();

  // Filter by a chip, and the URL keeps it across a reload.
  await page.getByLabel('Search screens').fill('store=0142');
  await page.getByLabel('Search screens').press('Enter');
  const rows = page.getByRole('row').filter({ has: page.getByRole('rowheader') });
  await expect(rows).toHaveCount(3);
  await page.reload();
  await hydrated(page);
  await expect(page.getByRole('list', { name: 'Label filters' }).getByText('store: 0142')).toBeVisible();
  await expect(rows).toHaveCount(3);

  // Group by store: the three in 0142, Lobby in 0009.
  await page.getByRole('button', { name: 'Remove filter store' }).click();
  await page.getByLabel('Group by').selectOption('store');
  await expect(page.getByRole('rowheader', { name: 'store: 0142 · 3 screens' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'store: 0009 · 1 screen' })).toBeVisible();
});
