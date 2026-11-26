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
  await signInAs(page, `e2e-groups-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbor Coffee', ADDRESS);
  const left = await pairScreen(page, 'Drive-thru L', '192.0.2.72');
  await pairScreen(page, 'Drive-thru R', '192.0.2.73');
  await pairScreen(page, 'Menu board', '192.0.2.74');
  const lobby = await pairScreen(page, 'Lobby', '192.0.2.75');
  const { group: drive } = (await tool(page, 'save_group', { name: 'Drive' })) as { group: { id: string } };
  const { group: north } = (await tool(page, 'save_group', { name: 'North', screenIds: [lobby.id] })) as { group: { id: string } };
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
    if (r.url().endsWith('/api/tools/save_group')) adds.push(r.postData() ?? '');
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
  const { playlist } = (await tool(page, 'save_playlist', { name: 'Breakfast' })) as { playlist: { id: string } };
  await tool(page, 'save_schedule_entry', { playlistId: playlist.id, target: 'group', groupId: north.id, from: '06:00', to: '10:30' });
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

test('groups and screens in name order wherever they are listed, though their ids run the other way (#180)', async ({ page }) => {
  await signInAs(page, `e2e-group-order-${Date.now()}@example.com`, '192.0.2.76');
  await createOrg(page, 'Order Deli', '192.0.2.76');
  // Names given after the ids are known, so each list's id order is the reverse of its name order, and plain string
  // order puts Screen 10 before Screen 2.
  const pairs = [await pairScreen(page, 'First', '192.0.2.77'), await pairScreen(page, 'Second', '192.0.2.78')].map((s) => s.id).sort();
  await tool(page, 'update_screen', { screenId: pairs[0], name: 'Screen 10' });
  await tool(page, 'update_screen', { screenId: pairs[1], name: 'Screen 2' });
  const made = [];
  for (const name of ['One', 'Two']) made.push(((await tool(page, 'save_group', { name, screenIds: pairs })) as { group: { id: string } }).group.id);
  const [zeta, alpha] = made.sort();
  await tool(page, 'save_group', { groupId: zeta, name: 'Zeta' });
  await tool(page, 'save_group', { groupId: alpha, name: 'Alpha' });
  const colors = { primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' };
  const kits = [];
  for (const name of ['Kit A', 'Kit B'])
    kits.push(
      ((await tool(page, 'save_brand_kit', { name, colors, idempotencyKey: `${name.replace(' ', '-')}-${Date.now()}` })) as { brandKit: { id: string } })
        .brandKit.id,
    );
  await tool(page, 'assign_brand_kit', { brandKitId: kits[0], groupId: alpha });
  await tool(page, 'assign_brand_kit', { brandKitId: kits[1], groupId: zeta });
  const labels = (boxes: ReturnType<Page['getByRole']>) => boxes.evaluateAll((els) => els.map((el) => el.closest('label')?.textContent.trim()));

  // The pair form's groups.
  await page.goto('/screens');
  await hydrated(page);
  await page.getByRole('button', { name: 'Pair a screen' }).click();
  const pair = page.getByRole('dialog', { name: 'Pair a screen' });
  // No heading above its display hours, so their legend shows (#374).
  await expect(pair.getByText('Display hours', { exact: true })).toBeVisible();
  // Shown at its size, not screen-reader only (a 1 px box).
  expect((await pair.getByText('Display hours', { exact: true }).boundingBox())?.height).toBeGreaterThan(8);
  await expect(pair.getByRole('group', { name: 'Groups' }).getByRole('checkbox')).toHaveCount(2);
  expect(await labels(pair.getByRole('group', { name: 'Groups' }).getByRole('checkbox'))).toEqual(['Alpha', 'Zeta']);
  await page.keyboard.press('Escape');

  // A screen's page: its groups in the header, and in its settings.
  await page.goto(`/screens/${pairs[0]}`);
  await hydrated(page);
  await expect(page.getByText('group Alpha, Zeta')).toBeVisible();
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Settings and groups…' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings.getByRole('checkbox', { name: 'Alpha' })).toBeVisible();
  expect(await labels(settings.getByRole('checkbox'))).toEqual(['Alpha', 'Zeta']);
  await page.keyboard.press('Escape');

  // Settings: the Groups table, and a group's members, Screen 2 before Screen 10.
  await page.goto('/settings/screens');
  await hydrated(page);
  const groups = page.getByRole('region', { name: 'Groups' });
  await expect(groups.getByRole('rowheader')).toHaveText(['Alpha', 'Zeta']);
  await groups.getByRole('button', { name: 'Change Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Members…' }).click();
  const members = page.getByRole('dialog', { name: 'Screens in Alpha' });
  await expect(members.getByRole('checkbox')).toHaveCount(2);
  expect(await labels(members.getByRole('checkbox'))).toEqual(['Screen 2', 'Screen 10']);
  await page.keyboard.press('Escape');

  // A brand kit's conflict alert: both screens are in groups that chose different kits.
  await page.goto(`/brand-kits/${kits[0]}`);
  await hydrated(page);
  await expect(page.getByText('Screen 2, Screen 10 are in groups that chose different kits')).toBeVisible();
});

test('a smart group is shown where a screen is in it, never offered to tick by hand (#186, review of #608)', async ({ page }) => {
  await signInAs(page, `e2e-smart-groups-${Date.now()}@example.com`, '192.0.2.201');
  await createOrg(page, 'Smart Deli', '192.0.2.201');
  const { id } = await pairScreen(page, 'Bayside door', '192.0.2.202');
  await tool(page, 'update_screen_labels', { screenIds: [id], set: { store: 'bayside' } });
  await tool(page, 'save_group', { name: 'Listed', idempotencyKey: `listed-${Date.now()}` });
  await tool(page, 'save_group', {
    name: 'Bayside',
    selector: { all: [{ key: 'store', op: 'eq', values: ['bayside'] }] },
    idempotencyKey: `bayside-${Date.now()}`,
  });
  const ticks = (where: ReturnType<Page['getByRole']>) => where.getByRole('group', { name: 'Groups' }).getByRole('checkbox');

  // Its page names the group its rule puts it in, and its settings offer only the listed one.
  await page.goto(`/screens/${id}`);
  await hydrated(page);
  await expect(page.getByText('group Bayside')).toBeVisible();
  await page.getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Settings and groups…' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(ticks(settings)).toHaveCount(1);
  await expect(ticks(settings)).toHaveAccessibleName('Listed');
  await page.keyboard.press('Escape');

  // The pair form and the selection bar offer the listed group alone too.
  await page.goto('/screens?view=table');
  await hydrated(page);
  await page.getByRole('button', { name: 'Pair a screen' }).click();
  const pair = page.getByRole('dialog', { name: 'Pair a screen' });
  await expect(ticks(pair)).toHaveCount(1);
  await expect(ticks(pair)).toHaveAccessibleName('Listed');
  await page.keyboard.press('Escape');
  await page.getByLabel('Select Bayside door').check();
  await page.getByRole('region', { name: 'Selected screens' }).getByRole('button', { name: 'Add to group' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Listed']);
});

/** With E2E_SCREENSHOTS: light and dark at the desktop's width, then at a phone's (390 px). */
async function shotsBoth(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  const size = page.viewportSize()!;
  await shots(page, `${name}-desktop`);
  await page.setViewportSize({ width: 390, height: 844 });
  await shots(page, `${name}-390`);
  await page.setViewportSize(size);
}

test('a smart group made from a rule, the screens it matches seen before it is saved, and whom it reaches (#186)', async ({ page }) => {
  await signInAs(page, `e2e-group-rule-${Date.now()}@example.com`, '192.0.2.203');
  await createOrg(page, 'Rule Deli', '192.0.2.203');
  const door = await pairScreen(page, 'North door', '192.0.2.204');
  const till = await pairScreen(page, 'North till', '192.0.2.205');
  const south = await pairScreen(page, 'South door', '192.0.2.206');
  await tool(page, 'update_screen_labels', { screenIds: [door.id, till.id], set: { region: 'north' } });
  await tool(page, 'update_screen_labels', { screenIds: [south.id], set: { region: 'south', store: '0142' } });
  await tool(page, 'save_playlist', { name: 'Storm closure', transition: { type: 'cut' } });

  // New group: a rule, its screens matched as the conditions are chosen.
  await page.goto('/settings/screens');
  await hydrated(page);
  await page.getByRole('button', { name: 'New group…' }).click();
  const made = page.getByRole('dialog', { name: 'New group' });
  await made.getByLabel('Name').fill('North');
  await made.getByRole('radio', { name: /Screens that match/ }).click();
  const first = made.getByRole('group', { name: 'Condition 1' });
  await first.getByLabel('Label').selectOption('region');
  await first.getByLabel('Value').fill('NORTH');
  const matched = made.getByRole('region', { name: 'Matching screens' });
  await expect(matched).toContainText('Matches 2 screens now');
  await expect(matched).toContainText('North door, North till');
  // A second condition no screen meets with the first: it says none matches, and why when no screen meets it at all.
  await made.getByRole('button', { name: 'Add a condition' }).click();
  const second = made.getByRole('group', { name: 'Condition 2' });
  await second.getByLabel('Label').selectOption('store');
  await second.getByLabel('Compared').selectOption({ label: 'is one of' });
  await second.getByRole('checkbox', { name: '0142' }).check();
  await expect(matched.getByRole('alert')).toHaveText('Matches no screen now.');
  await second.getByLabel('Compared').selectOption({ label: 'is not set' });
  await expect(matched).toContainText('Matches 2 screens now');
  await axe(page);
  await shotsBoth(page, '186-new-smart-group');
  await made.getByRole('button', { name: 'Create group' }).click();
  await expect(made).toBeHidden();

  // The table marks it a rule, and its menu changes the rule rather than ticking screens.
  const groups = page.getByRole('region', { name: 'Groups' });
  await expect(groups.getByRole('row', { name: /North/ })).toContainText('Rule');
  await expect(groups.getByRole('row', { name: /North/ })).toContainText('2 screens');
  await groups.getByRole('button', { name: 'Change North' }).click();
  await expect(page.getByRole('menuitem', { name: 'Members…' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Rule…' }).click();
  const rule = page.getByRole('dialog', { name: 'North’s rule' });
  await expect(rule.getByRole('group', { name: 'Condition 2' }).getByLabel('Compared')).toHaveValue('missing');
  await rule.getByRole('button', { name: 'Remove condition 2' }).click();
  await rule.getByRole('group', { name: 'Condition 1' }).getByLabel('Value').fill('south');
  await expect(rule.getByRole('region', { name: 'Matching screens' })).toContainText('Matches 1 screen now');
  await rule.getByRole('button', { name: 'Save' }).click();
  await expect(rule).toBeHidden();
  await expect(groups.getByRole('row', { name: /North/ })).toContainText('1 screen');
  await shotsBoth(page, '186-groups-rule-badge');

  // A takeover's picker: the group marked a rule, and whom it reaches when sent.
  await page.goto('/schedule');
  await hydrated(page);
  await page.getByRole('button', { name: 'Take over screens' }).click();
  const takeover = page.getByRole('dialog', { name: 'Take over screens' });
  await takeover.getByRole('combobox', { name: 'Plays on' }).click();
  const picker = page.getByRole('dialog', { name: 'Plays on' });
  await expect(picker.getByRole('option', { name: /^North Rule/ })).toContainText('Rule');
  await picker.getByRole('option', { name: /^North Rule/ }).click();
  await expect(takeover.getByRole('combobox', { name: 'Plays on' })).toHaveAccessibleDescription('Reaches this screen now: South door');
  await shotsBoth(page, '186-takeover-reach');
});
