import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { axe, createOrg, disabledOnServer, hydrated, shots, signInAs, tool } from './helpers';
import { API_PORT, CMS_URL } from './servers';

/** This spec's own client addresses, so its sign-in and pairing have their own rate limits. */
const ADDRESS = '192.0.2.41';
const SCREEN_ADDRESS = '192.0.2.42';

test('a change shows in the audit log, filters to it, pages and exports, with the pairing code redacted', async ({ page, request }) => {
  await signInAs(page, `e2e-audit-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Clinic', ADDRESS);

  // A change in the CMS: the org's time zone.
  await page.goto('/settings/general');
  await hydrated(page);
  await page.getByLabel('Time zone').selectOption('Europe/London');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // A screen paired, whose code the log keeps redacted, and renamed 55 times: more than a page.
  const start = await request.post(`http://127.0.0.1:${API_PORT}/v1/device/pair/start`, { headers: { 'cf-connecting-ip': SCREEN_ADDRESS } });
  const { code } = (await start.json()) as { code: string };
  const { screen } = (await tool(page, 'claim_screen', { code, name: 'Lobby', timezone: 'UTC', orientation: 'landscape' })) as { screen: { id: string } };
  for (let i = 1; i <= 55; i++) await tool(page, 'rename_screen', { screenId: screen.id, name: `Lobby ${i}` });

  /** Narrow the log to the screen from its first row's target link. */
  const onlyTheScreen = async () => {
    await rows
      .first()
      .getByRole('link', { name: `Only screen ${screen.id}` })
      .click();
    await expect(page).toHaveURL(new RegExp(`targetId=${screen.id}`));
    await expect(page.getByText(`Only Screen ${screen.id}.`)).toBeVisible();
  };

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit log' }).click();
  await expect(page).toHaveURL(/\/audit$/);
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await expect(page.getByText('Kept 365 days. Times in Europe/London.')).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText('Renamed to Lobby 55');
  await expect(rows.first()).toContainText('You');
  await expect(rows.first()).toContainText('CMS');
  await axe(page);
  await shots(page, '50-audit-log');

  // Load older: the rest, down to the first change.
  await page.getByRole('button', { name: 'Load older' }).click();
  await expect(rows).toHaveCount(58);
  await expect(page.getByRole('button', { name: 'Load older' })).toHaveCount(0);
  await expect(page.getByText('Showing 58 entries, all there are')).toBeVisible();
  const paired = rows.filter({ hasText: 'Paired' });
  await expect(paired).toContainText('code: [redacted]');
  await expect(paired).not.toContainText(code);

  // Filter to the CMS change. The filters' labels are matched exactly: a random id in a row's
  // "Only member <id>" link can contain "who" (#178's e2e run met mem_…kwhoy).
  await page.getByLabel('What', { exact: true }).selectOption('update_org_settings');
  await expect(page).toHaveURL(/what=update_org_settings/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Settings changed');
  await expect(rows.first()).toContainText('timezone: Europe/London');

  // Search, then clear.
  await page.getByLabel('What', { exact: true }).selectOption('');
  await page.getByLabel('Search', { exact: true }).fill('Lobby 12');
  await page.getByLabel('Search', { exact: true }).press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Renamed to Lobby 12');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  // The whole log as last read: both pages, read again.
  await expect(rows).toHaveCount(58);
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue('');

  // One target: the screen's own history.
  await page.getByLabel('Who', { exact: true }).selectOption('people');
  await onlyTheScreen();

  // Export what the filters match: the screen's 56 entries, its code still redacted.
  await page.getByRole('link', { name: 'Show every screen' }).click();
  await page.getByLabel('Target', { exact: true }).selectOption('screen');
  await expect(rows).toHaveCount(50);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = readFileSync(await (await download).path(), 'utf8');
  // A byte order mark first, so Excel reads it as UTF-8.
  expect(csv.startsWith('\uFEFF')).toBe(true);
  const lines = csv.slice(1).trimEnd().split('\r\n');
  expect(lines[0]).toBe('time,who,actor_kind,actor_id,via,action,what,target_kind,target_id,detail');
  expect(lines).toHaveLength(1 + 56);
  expect(lines.at(-1)).toContain('claim_screen');
  expect(lines.at(-1)).toContain('[redacted]');
  expect(csv).not.toContain(code);
  expect(csv).not.toContain('update_org_settings');
  await expect(page.getByText('Exported 56 entries.')).toBeVisible();

  // Phone width: the filters wrap and the table scrolls inside its frame.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(58);
  await axe(page);
  await shots(page, '51-audit-log-phone');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // One target from a phone: its link is in the line folded under What.
  await onlyTheScreen();

  // Hand-edited URLs: a name every object has, blank text, or an id without its kind filter nothing and break nothing.
  for (const search of ['when=constructor', 'q=%20', 'targetId=x']) {
    await page.goto(`/audit?${search}`);
    await expect(rows, search).toHaveCount(50);
    await expect(page.getByText(/^Only /)).toHaveCount(0);
  }
  await page.goto('/audit?who=constructor');
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();

  // The member switches org in another tab: Load older on this one is refused, not filled from the other org (#129).
  await page.goto('/audit');
  await hydrated(page);
  await expect(rows).toHaveCount(50);
  const other = await page.request.post('/api/auth/organization/create', {
    data: { name: 'Other Co', slug: `other-${Date.now()}` },
    headers: { origin: CMS_URL },
  });
  expect(other.status(), await other.text()).toBe(200);
  await page.getByRole('button', { name: 'Load older' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not load older entries: This tab is on Northside Clinic; you switched to Other Co in another tab. Reload.',
  );
  await expect(rows).toHaveCount(50);
});

test("the audit log's filters, search and Export CSV are disabled in the server's HTML, until the page has hydrated (#140)", async ({ page }) => {
  // The page hydrates after the app (body[data-hydrated]): a filter chosen in between was set back
  // by React, the browser's own submit put the search in the URL, and Export CSV made no file.
  await signInAs(page, `e2e-audit-server-${Date.now()}@example.com`, '192.0.2.49');
  await createOrg(page, 'Northside Clinic', '192.0.2.49');
  const names = ['Who', 'What', 'Target', 'When', 'Search', 'Export CSV'];
  expect(await disabledOnServer(page, '/audit', names)).toEqual(Object.fromEntries(names.map((n) => [n, [true]])));
  expect(await disabledOnServer(page, '/audit?when=day', ['Clear filters'])).toEqual({ 'Clear filters': [true] });
  // Rendered by the server, they are enabled once the page has hydrated.
  await page.goto('/audit');
  await hydrated(page);
  await expect(page.getByLabel('When', { exact: true })).toBeEnabled();
});

test("searching the audit log for an invitee's email keeps it out of the page's URL and every request's (#140)", async ({ page }) => {
  // A search can be an email or a name: in a URL it reaches history, a Referer and the Worker's request logs.
  await signInAs(page, `e2e-audit-search-${Date.now()}@example.com`, '192.0.2.50');
  await createOrg(page, 'Northside Clinic', '192.0.2.50');
  const invitee = `e2e-audit-invitee-${Date.now()}@example.com`;
  await page.goto('/settings/members');
  await hydrated(page);
  await page.getByLabel('Emails, separated by commas').fill(invitee);
  await page.getByRole('button', { name: 'Send invites' }).click();
  await expect(page.getByRole('region', { name: 'Waiting for a reply' })).toContainText(invitee);

  const requests: { url: string; body: string }[] = [];
  page.on('request', (r) => requests.push({ url: decodeURIComponent(r.url()), body: r.postData() ?? '' }));
  await page.goto('/audit?what=invite_member');
  await hydrated(page);
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  // The search narrows within the link's filters.
  await page.getByLabel('Search', { exact: true }).fill('nobody-here@example.com');
  await page.getByLabel('Search', { exact: true }).press('Enter');
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();
  await page.getByLabel('Search', { exact: true }).fill(invitee);
  await page.getByLabel('Search', { exact: true }).press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(invitee);

  // The link keeps the filters, not the search; the server got the search in a body.
  expect(new URL(page.url()).search).toBe('?what=invite_member');
  expect(requests.filter((r) => r.url.includes(invitee) || r.url.includes('nobody-here'))).toEqual([]);
  expect(requests.some((r) => r.body.includes(invitee))).toBe(true);
});
