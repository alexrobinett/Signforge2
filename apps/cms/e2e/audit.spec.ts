import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { axe, fillUntilEnabled, hydrated, shots, signInAs } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client addresses, so its sign-in and pairing have their own rate limits. */
const ADDRESS = '192.0.2.41';
const SCREEN_ADDRESS = '192.0.2.42';

test('a change shows in the audit log, filters to it, pages and exports, with the pairing code redacted', async ({ page, request }) => {
  test.setTimeout(120_000);
  await signInAs(page, `e2e-audit-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Northside Market', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to SignForge' })).toHaveCount(0);

  // A change in the CMS: the org's time zone.
  await page.goto('/settings/general');
  await hydrated(page);
  await page.getByLabel('Time zone').selectOption('Europe/London');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // A screen paired, whose code the log keeps redacted, and renamed 55 times: more than a page.
  const start = await request.post(`http://127.0.0.1:${API_PORT}/v1/device/pair/start`, { headers: { 'cf-connecting-ip': SCREEN_ADDRESS } });
  const { code } = (await start.json()) as { code: string };
  const tool = async (name: string, input: unknown) => {
    const res = await page.request.post(`/api/tools/${name}`, { data: input });
    expect(res.status(), `${name}: ${await res.text()}`).toBe(200);
    return res.json() as Promise<{ screen: { id: string } }>;
  };
  const { screen } = await tool('claim_screen', { code, name: 'Lobby', timezone: 'UTC', orientation: 'landscape' });
  for (let i = 1; i <= 55; i++) await tool('rename_screen', { screenId: screen.id, name: `Lobby ${i}` });

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

  // Filter to the CMS change.
  await page.getByLabel('What').selectOption('update_org_settings');
  await expect(page).toHaveURL(/what=update_org_settings/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Settings changed');
  await expect(rows.first()).toContainText('timezone: Europe/London');

  // Search, then clear.
  await page.getByLabel('What').selectOption('');
  await page.getByLabel('Search').fill('Lobby 12');
  await page.getByLabel('Search').press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Renamed to Lobby 12');
  await page.getByRole('button', { name: 'Clear filters' }).click();
  // The whole log as last read: both pages, read again.
  await expect(rows).toHaveCount(58);
  await expect(page.getByLabel('Search')).toHaveValue('');

  // One target: the screen's own history.
  await page.getByLabel('Who').selectOption('people');
  await rows
    .first()
    .getByRole('link', { name: `Only screen ${screen.id}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`targetId=${screen.id}`));
  await expect(page.getByText(`Only Screen ${screen.id}.`)).toBeVisible();

  // Export what the filters match: the screen's 56 entries, its code still redacted.
  await page.getByRole('link', { name: 'Show every screen' }).click();
  await page.getByLabel('Target').selectOption('screen');
  await expect(rows).toHaveCount(50);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = readFileSync(await (await download).path(), 'utf8');
  const lines = csv.trimEnd().split('\r\n');
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
});
