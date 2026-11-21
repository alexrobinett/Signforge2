// Groups in the CMS (#183): add selected screens to a group in one action from the Screens table,
// rename a group and refuse to delete one a schedule entry aims at (the entry shown), from
// Settings, Screens & groups; and a revoked screen leaving the default list for the Retired filter.
import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.71';
const DEVICE = `http://127.0.0.1:${API_PORT}/v1/device`;

/** A screen paired from its own address (pairing is rate limited per address), with its credential collected. */
async function pairScreen(page: Page, name: string, address: string) {
  const headers = { 'cf-connecting-ip': address };
  const start = await page.request.post(`${DEVICE}/pair/start`, { headers });
  expect(start.status()).toBe(200);
  const { code, pollToken } = (await start.json()) as { code: string; pollToken: string };
  const { screen } = (await tool(page, 'claim_screen', { code, name, timezone: 'UTC', orientation: 'landscape' })) as { screen: { id: string } };
  const poll = await page.request.post(`${DEVICE}/pair/poll`, { data: { pollToken }, headers });
  const { credential } = (await poll.json()) as { credential: string };
  return { id: screen.id, credential };
}

test('add three selected screens to a group at once, rename a group, refuse to delete one an entry aims at, and retire a screen', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAs(page, `e2e-groups-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbor Coffee');
  const left = await pairScreen(page, 'Drive-thru L', '192.0.2.72');
  await pairScreen(page, 'Drive-thru R', '192.0.2.73');
  await pairScreen(page, 'Menu board', '192.0.2.74');
  const lobby = await pairScreen(page, 'Lobby', '192.0.2.75');
  const { group: drive } = (await tool(page, 'create_group', { name: 'Drive' })) as { group: { id: string } };
  const { group: north } = (await tool(page, 'create_group', { name: 'North', screenIds: [lobby.id] })) as { group: { id: string } };
  // Drive-thru L syncs with nothing published to it: it needs you.
  const synced = await page.request.post(`${DEVICE}/sync`, {
    headers: { authorization: `Bearer ${left.credential}` },
    data: {
      seq: 0,
      epoch: 'e2e',
      player: { version: '0.0.0-e2e', manifestSchemas: [2], protocols: [1, 2] },
      manifest: { filesMissing: 0 },
      display: { on: true },
      deviceTime: new Date().toISOString(),
      clock: { offsetMs: 0, trusted: true },
      playCounts: [],
      snapshots: {},
    },
  });
  expect(synced.status()).toBe(200);

  // Three rows ticked and added to Drive: one call, not one per screen.
  await page.goto('/screens?view=table');
  await hydrated(page);
  const adds: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/tools/add_group_members')) adds.push(r.postData() ?? '');
  });
  for (const name of ['Drive-thru L', 'Drive-thru R', 'Menu board']) await page.getByLabel(`Select ${name}`).check();
  const bar = page.getByRole('region', { name: 'Selected screens' });
  await expect(bar.getByRole('status')).toHaveText('3 selected');
  await axe(page);
  await shots(page, '90-screens-selection');
  await bar.getByRole('button', { name: 'Add to group' }).click();
  await page.getByRole('menuitem', { name: 'Drive' }).click();
  await expect(page.getByText('Added 3 screens to Drive')).toBeVisible();
  expect(adds).toHaveLength(1);
  expect((JSON.parse(adds[0]!) as { screenIds: string[] }).screenIds).toHaveLength(3);
  await expect(page.getByLabel('Group', { exact: true })).toContainText('Drive (3)');

  // Needs attention names the group with a screen that needs you, and filters to it.
  const attention = page.getByRole('region', { name: 'Needs attention' });
  await expect(attention.getByRole('button')).toHaveCount(1);
  await expect(attention.getByRole('button')).toContainText('Drive1 needs you');
  await attention.getByRole('button').click();
  await expect(page).toHaveURL(new RegExp(`group=${drive.id}`));
  await expect(page.getByRole('rowheader')).toHaveCount(3);

  // The Group filter links to the Groups list.
  await page.getByRole('link', { name: 'Manage groups' }).click();
  await expect(page).toHaveURL(/\/settings\/screens#groups$/);
  await hydrated(page);
  const groups = page.getByRole('region', { name: 'Groups' });
  await expect(groups.getByRole('row', { name: /Drive/ })).toContainText('3 screens');

  // Rename.
  await groups.getByRole('button', { name: 'Change Drive' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename the group' });
  await rename.getByLabel('Name').fill('Drive-thru');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(rename).toBeHidden();
  await expect(groups.getByRole('rowheader', { name: 'Drive-thru' })).toBeVisible();

  // An entry aims at North: its delete is refused, with the entry shown, and North stays.
  const { playlist } = (await tool(page, 'create_playlist', { name: 'Breakfast' })) as { playlist: { id: string } };
  await tool(page, 'create_schedule_entry', { playlistId: playlist.id, target: 'group', groupId: north.id, from: '06:00', to: '10:30' });
  await page.reload();
  await hydrated(page);
  await expect(groups.getByRole('row', { name: /North/ })).toContainText('1 entry');
  await groups.getByRole('button', { name: 'Change North' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const del = page.getByRole('dialog', { name: 'Delete North?' });
  await del.getByRole('button', { name: 'Delete' }).click();
  await expect(del.getByRole('alert')).toContainText('1 schedule entry is aimed at North.');
  await expect(del.getByRole('list', { name: 'Entries aimed at it' }).getByRole('listitem')).toHaveText(/^Breakfast · .*06:00–10:30$/);
  await expect(del.getByRole('button', { name: 'Delete' })).toBeHidden();
  await expect(del.getByRole('link', { name: 'Open the schedule' })).toBeVisible();
  await axe(page);
  await shots(page, '91-group-delete-refused');
  // Following it closes the dialog: Back brings the list, not the old refusal.
  await del.getByRole('link', { name: 'Open the schedule' }).click();
  await expect(page).toHaveURL(/\/schedule$/);
  await page.goBack();
  await expect(groups.getByRole('rowheader', { name: 'North' })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();

  // Members: a searchable checklist; Drive-thru R ticked into North.
  await groups.getByRole('button', { name: 'Change North' }).click();
  await page.getByRole('menuitem', { name: 'Members…' }).click();
  const members = page.getByRole('dialog', { name: 'Screens in North' });
  await members.getByLabel('Search screens').fill('drive');
  await expect(members.getByRole('checkbox')).toHaveCount(2);
  await members.getByLabel('Drive-thru R').check();
  await members.getByRole('button', { name: 'Save' }).click();
  await expect(members).toBeHidden();
  await expect(groups.getByRole('row', { name: /North/ })).toContainText('2 screens');
  await axe(page);
  await shots(page, '92-settings-groups');

  // Lobby revoked: it leaves the list, its count and North's; the Retired filter shows it.
  await page.goto(`/screens/${lobby.id}`);
  await hydrated(page);
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Revoke…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('the Retired filter still shows it');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText(/credential was revoked/)).toBeVisible();
  await page.goto('/screens');
  await hydrated(page);
  await expect(page.getByRole('link', { name: 'Drive-thru R' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lobby' })).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '3 screens' })).toBeVisible();
  await expect(page.getByLabel('Group', { exact: true })).toContainText('North (1)');
  await page.getByLabel('Status', { exact: true }).selectOption('Retired');
  await expect(page.getByRole('link', { name: 'Lobby' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Drive-thru R' })).toBeHidden();
  await page.getByLabel('Status', { exact: true }).selectOption('Any');

  // At phone width, Needs attention is one line and the first screen is in the first view.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const card = page.getByRole('region', { name: 'Needs attention' }).getByRole('button');
  expect((await card.boundingBox())?.height).toBeLessThan(50);
  await expect(
    page
      .getByRole('main')
      .getByRole('link', { name: /^Drive-thru|^Menu board/ })
      .first(),
  ).toBeInViewport();
  await axe(page);
  await shots(page, '93-phone-screens-needs-attention');
});
