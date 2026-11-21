import { expect, test } from '@playwright/test';
import { axe, fillUntilEnabled, hydrated, screenshot, signInAs, tool } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client address, for its own sign-in rate limit. */
const ADDRESS = '192.0.2.13';

test('the command menu, keyboard only: open, filter, run a tool with and without a form, see a refusal, go to a page, close', async ({ page, request }) => {
  await page.goto('/sign-in');
  await hydrated(page);
  await signInAs(page, `e2e-command-${Date.now()}@example.com`, ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Riverside Deli', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Riverside Deli', level: 1 })).toBeVisible();
  await hydrated(page);

  const menu = page.getByRole('dialog', { name: 'Command menu' });
  const search = menu.getByRole('combobox', { name: 'Search pages, screens and actions' });
  const toast = (text: string | RegExp) => page.locator('[data-sonner-toast]').filter({ hasText: text });

  // Open with Ctrl+K: focus is in the search, every tool an owner may use is listed.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await expect(menu.getByRole('option', { name: /claim_screen/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /revoke_screen_credential/ })).toHaveCount(1);
  await axe(page);
  await screenshot(page, '30-command-menu');

  // Filter to a tool that needs input, run it from its form: pair a screen a player started.
  const start = await request.post(`http://127.0.0.1:${API_PORT}/v1/device/pair/start`, { headers: { 'cf-connecting-ip': '192.0.2.14' } });
  const { code } = (await start.json()) as { code: string };
  await page.keyboard.type('pair a screen');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Pair a screen');
  await page.keyboard.press('Enter');
  await expect(menu.getByLabel('code')).toBeFocused();
  await page.keyboard.type(code);
  await page.keyboard.press('Tab');
  await page.keyboard.type('Deli counter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Europe/London');
  await axe(page);
  await screenshot(page, '31-command-form');
  await page.keyboard.press('Enter');
  await expect(toast('Deli counter')).toBeVisible();
  await expect(menu).toBeHidden();

  // A tool that needs no input runs at once.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('list_screens');
  await page.keyboard.press('Enter');
  await expect(toast('1 screens')).toBeVisible();

  // A refusal is a toast with the tool's own message, and the form stays open to fix.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('rename_screen');
  await page.keyboard.press('Enter');
  await page.keyboard.type('scr_missing');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Nowhere');
  await page.keyboard.press('Enter');
  await expect(toast(/not found/)).toBeVisible();
  await expect(menu.getByLabel('name')).toBeVisible();

  // A field the menu cannot read is refused before anything is sent: focus leaves Run for that
  // field, which reads out the error as its description.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('pair a screen');
  await page.keyboard.press('Enter');
  await expect(menu.getByLabel('code')).toBeFocused();
  await page.keyboard.type('ABC234');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Back office');
  await page.keyboard.press('Tab');
  await page.keyboard.type('UTC');
  const hours = menu.getByLabel('displayHours');
  await hours.fill('{"mon": [');
  const run = menu.getByRole('button', { name: 'Run' });
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(hours).toBeFocused();
  await expect(hours).toHaveAttribute('aria-invalid', 'true');
  await expect(hours).toHaveAccessibleDescription(/must be JSON/);
  // Refused again after a move back to Run: focus returns to the field.
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(hours).toBeFocused();

  // Escape closes it; Ctrl+K again, a page by name, Enter goes there.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('go to screens');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/screens$/);
  await expect(page.getByRole('link', { name: 'Deli counter' })).toBeVisible();
  await expect(menu).toBeHidden();

  // Ctrl+K toggles it closed too.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(search).toBeFocused();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(menu).toBeHidden();

  // Typing part of a screen's name finds it (#180); Enter shows its actions, Open first.
  const { screens } = await tool(page, 'list_screens', {});
  const deli = screens.find((s: { name: string }) => s.name === 'Deli counter').id;
  const { group } = await tool(page, 'create_group', { name: 'Front of house', screenIds: [deli] });
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('deli');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Deli counter');
  await expect(menu.getByRole('option', { name: /Front of house/ })).toHaveCount(0);
  await axe(page);
  await screenshot(page, '32-command-menu-screen');
  await page.keyboard.press('Enter');
  const actions = menu.getByRole('option');
  await expect(actions).toHaveText(['Open', 'Identify (10 s)', 'Restart player']);
  await expect(menu.getByRole('combobox', { name: 'Actions for Deli counter' })).toBeFocused();
  await axe(page);
  await screenshot(page, '33-command-menu-screen-actions');
  await page.keyboard.type('identify');
  await page.keyboard.press('Enter');
  await expect(toast('Identify (10 s): Deli counter')).toBeVisible();
  await expect(menu).toBeHidden();

  // Back returns to what was found; Open goes to the screen's page.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('counter');
  await page.keyboard.press('Enter');
  await menu.getByRole('button', { name: 'Back to commands' }).click();
  await expect(search).toHaveValue('counter');
  await expect(search).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/screens/${deli}$`));
  await expect(page.getByRole('heading', { name: 'Deli counter', level: 1 })).toBeVisible();

  // A group by its name, or a screen by its group's: the group's action shows its screens on the Screens page.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('house');
  await expect(menu.getByRole('option', { name: /Deli counter/ })).toBeVisible();
  await menu.getByRole('option', { name: /Front of house/ }).click();
  await expect(menu.getByRole('option')).toHaveText(['Show its screens']);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/screens\\?group=${group.id}$`));
  await expect(page.getByRole('button', { name: 'Front of house 1', pressed: true })).toBeVisible();
  await expect(menu).toBeHidden();
});
