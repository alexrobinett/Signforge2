// Settings › API & agents (M4-07, #112): a stub MCP client connects through /connect and is listed;
// turning screens:manage off on its page refuses its next rename_screen with forbidden; Disconnect
// gives its next call 401. Light and dark, desktop and phone, with axe at each.
import { expect, test } from '@playwright/test';
import { callbackOf, stubClient } from './agent-stub';
import { axe, createOrg, hydrated, shots, signInAs } from './helpers';

/** This spec's own client addresses, so its sign-ins and registrations have their own rate limits. */
const ADDRESS = { owner: '192.0.2.171', stub: '192.0.2.172' };

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

  // It is listed, by its quoted name, with its scopes and who granted it.
  await page.goto('/settings/api');
  await hydrated(page);
  const row = page.getByRole('row', { name: /Kestrel agent/ });
  await expect(row).toContainText('“Kestrel agent”');
  await expect(row).toContainText('screens:manage');
  await expect(row).toContainText('This hour');
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
  // What it changed: nothing (its rename was refused, which writes nothing; the person's change is the person's).
  await expect(page.getByText('No changes yet.')).toBeVisible();
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await shots(page, '31-agent-detail');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '31-agent-detail-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Disconnect: back to the list, which has none, and the agent's next call gets 401.
  await page.getByRole('button', { name: 'Disconnect…' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Its next call is refused');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page).toHaveURL(/\/settings\/api\/?$/);
  await expect(page.getByText('No agents are connected yet.')).toBeVisible();
  expect(await stub.mcpStatus(accessToken)).toBe(401);
  await stub.dispose();
});
