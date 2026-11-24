// The agent's drawer (#267), read-only, against the Anthropic stub's scripted turn (a read of the
// screens' status, then STUB_CARD; e2e/global-setup.ts): no test reaches a real model.
import { expect, test } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';
import { ANTHROPIC_STUB_KEY, ANTHROPIC_STUB_MODELS, STUB_CARD } from './servers';

const ADDRESS = '192.0.2.169';

test('a member opens the agent, asks why screens are behind, sees the diagnosis card and its trace, and closes it (#267)', async ({ page }) => {
  await signInAs(page, `e2e-drawer-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Bayside Provisions', ADDRESS);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, capableModel: ANTHROPIC_STUB_MODELS[1] });
  await page.goto('/screens');
  await hydrated(page);

  // Opened from the Agent button: a panel beside the page, which the sidebar folds for.
  const opener = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' });
  await opener.click();
  const drawer = page.getByRole('dialog', { name: 'Agent' });
  await expect(drawer).toBeVisible();
  expect((await drawer.boundingBox())!.width).toBe(400);
  await axe(page);
  await shots(page, '100-drawer-empty');

  await drawer.getByLabel('Ask about your screens and content').fill('Why are 2 screens behind?');
  await drawer.getByRole('button', { name: 'Ask', exact: true }).click();
  const card = drawer.getByRole('article');
  await expect(card).toContainText(STUB_CARD.text);
  await expect(card).toContainText('Bayside, quiet since 09:14');
  await expect(card.getByRole('button', { name: 'Copy a note for the store' })).toBeVisible();
  // The answer reached the live region.
  await expect(drawer.getByRole('status')).toHaveText(STUB_CARD.text);
  // The trace, one line, expands to its calls.
  const trace = card.locator('summary');
  await expect(trace).toHaveText('Checked 0 screens');
  await trace.click();
  await expect(card.getByText('list_screen_status')).toBeVisible();
  await axe(page);
  await shots(page, '100-drawer-answer');

  // Escape closes it, and focus goes back to what opened it.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  // From ⌘K too, and the conversation is still there until the page reloads.
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('option', { name: 'Ask the agent…' }).click();
  await expect(drawer.getByRole('article')).toContainText(STUB_CARD.text);
  await page.keyboard.press('Escape');
  await page.reload();
  await hydrated(page);
  await opener.click();
  await expect(drawer.getByRole('article')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A sheet on a phone, opened from the top bar.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('banner').getByRole('button', { name: 'Ask the agent' }).click();
  expect((await drawer.boundingBox())!.width).toBe(390);
  await axe(page);
  await shots(page, '100-drawer-phone');
  await drawer.getByRole('button', { name: 'Close the agent' }).click();
  await expect(drawer).toBeHidden();
});
