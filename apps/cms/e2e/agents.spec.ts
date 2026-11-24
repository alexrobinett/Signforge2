// Settings › API & agents (M4-07, #112): a stub MCP client connects through /connect and is listed
// with its last 7 days of calls (M4-08, #113); turning screens:manage off on its page refuses its next
// rename_screen with forbidden, which its page shows as its last refusal; Disconnect gives its next call 401. Light and dark, desktop and phone, with axe at each. A client whose name
// reads as SignForge is named by its host on the list, the audit log and its CSV, never by its name.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { callbackOf, stubClient } from './agent-stub';
import { axe, createOrg, hydrated, shots, signInAs } from './helpers';

/** This spec's own client addresses, so its sign-ins and registrations have their own rate limits. */
const ADDRESS = { owner: '192.0.2.171', stub: '192.0.2.172', namer: '192.0.2.173' };

test('a connected agent is listed, loses a scope and is disconnected, each from its next call', async ({ page }) => {
  await signInAs(page, `e2e-agents-${Date.now()}@example.com`, ADDRESS.owner);
  await createOrg(page, 'Kestrel Yard', ADDRESS.owner);
  await page.goto('/settings/api');
  await expect(page.getByRole('heading', { name: 'API & agents', level: 1 })).toBeVisible();
  await expect(page.getByText('No agents are connected yet.')).toBeVisible();
  await expect(page.getByLabel('MCP server address')).toHaveValue(/\/mcp$/);

  // The stub connects, with drafting and screens:manage.
  const stub = await stubClient('Kestrel agent', ADDRESS.stub);
  await page.goto(stub.authorizeUrl);
  await hydrated(page);
  await page.getByRole('checkbox', { name: /Manage screens/ }).check();
  const back = await callbackOf(page, () => page.getByRole('button', { name: 'Allow' }).click());
  const tokens = await stub.exchange(back.searchParams.get('code')!);
  expect(tokens.status).toBe(200);
  const accessToken = tokens.body.access_token!;
  // With screens:manage, renaming a screen that is not there is not found, not refused.
  const rename = () => stub.mcp(accessToken, 'tools/call', { name: 'rename_screen', arguments: { screenId: 'scr_nowhere', name: 'Lobby' } });
  expect((await rename()).result.structuredContent.error).toBe('not_found');
  // With content:draft it makes a playlist: a change, in the audit log and in its calls.
  const made = await stub.mcp(accessToken, 'tools/call', { name: 'create_playlist', arguments: { name: 'Kestrel specials' } });
  expect(made.result.isError).toBeUndefined();

  // It is listed, by its quoted name, with its scopes and who granted it.
  await page.goto('/settings/api');
  await hydrated(page);
  const row = page.getByRole('row', { name: /Kestrel agent/ });
  await expect(row).toContainText('“Kestrel agent”');
  await expect(row).toContainText('screens:manage');
  await expect(row).toContainText('This hour');
  await expect(row).toContainText('2 calls · 1 change');
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 1300 });
  await shots(page, '31-api-agents');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '31-api-agents-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Its page: screens:manage off applies from its next call.
  await row.getByRole('link', { name: /Manage/ }).click();
  await expect(page.getByRole('heading', { name: '“Kestrel agent”', level: 1 })).toBeVisible();
  await hydrated(page);
  await expect(page.getByRole('checkbox', { name: /See your content and screens/ })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Manage screens/ }).uncheck();
  await expect(page.getByText('Applies from its next call')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Manage screens/ })).not.toBeChecked();
  expect((await rename()).result).toMatchObject({ isError: true, structuredContent: { error: 'forbidden' } });
  // Its last 7 days: three calls, one change, one refused (forbidden; the rename not found is a call, not a refusal), named with the scope it needed.
  await page.reload();
  await hydrated(page);
  // Each number by its label alone: "Changes" is also in "Draft changes".
  const count = (label: string) =>
    page
      .locator('dl > div')
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator('dd');
  await expect(count('Tool calls')).toHaveText('3');
  await expect(count('Changes')).toHaveText('1');
  await expect(count('Draft changes')).toHaveText('1');
  await expect(count('Refused')).toHaveText('1');
  await expect(page.getByText('calling rename_screen: Refused · Needs screens:manage.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'rename_screen' }).last()).toContainText('Not found');
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 1700 });
  await shots(page, '31-agent-detail');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '31-agent-detail-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Its change links to its row in the audit log: the agent's, on that playlist.
  await page.getByRole('link', { name: 'See the change by create_playlist' }).click();
  await expect(page).toHaveURL(/\/audit\?.*target=playlist/);
  await hydrated(page);
  await expect(page.getByRole('row', { name: /Created/ })).toBeVisible();
  await page.goBack();
  await hydrated(page);

  // Disconnect: back to the list, which has none, and the agent's next call gets 401.
  await page.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Its next call is refused');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page).toHaveURL(/\/settings\/api\/?$/);
  await expect(page.getByText('No agents are connected yet.')).toBeVisible();
  expect(await stub.mcpStatus(accessToken)).toBe(401);
  await stub.dispose();
});

test('a client whose name reads as SignForge is named by its host on the list, the audit log and its CSV', async ({ page }) => {
  await signInAs(page, `e2e-agents-names-${Date.now()}@example.com`, ADDRESS.namer);
  await createOrg(page, 'Ospreys Mill', ADDRESS.namer);
  const stub = await stubClient('SI6NFOR6E', ADDRESS.stub);
  await page.goto(stub.authorizeUrl);
  await hydrated(page);
  await callbackOf(page, () => page.getByRole('button', { name: 'Allow' }).click());
  await stub.dispose();

  await page.goto('/settings/api');
  await hydrated(page);
  await expect(page.getByRole('row', { name: /An unverified app at 127\.0\.0\.1:33418/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage An unverified app at 127.0.0.1:33418' })).toBeVisible();
  expect(await page.content()).not.toContain('SI6NFOR6E');

  await page.goto('/audit');
  await hydrated(page);
  await expect(page.getByRole('row', { name: /Agent connected/ })).toBeVisible();
  expect(await page.content()).not.toContain('SI6NFOR6E');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = readFileSync(await (await download).path(), 'utf8');
  expect(csv).toContain('create_agent_grant');
  expect(csv).not.toContain('SI6NFOR6E');
});
