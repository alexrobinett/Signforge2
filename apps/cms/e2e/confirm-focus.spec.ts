// Focus through an inline removal (#289), by keyboard only: when Remove gives way to its
// confirmation, focus goes to the confirmation's question; Keep it puts it back on Remove; and a
// removal leaves it on the form that takes the place of what was removed, never on the page body.
// Settings › Notifications (the webhook) and Settings › AI & agents (the key), axe at each, light
// and dark, at desktop and phone widths.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';
import { ANTHROPIC_STUB_KEY } from './servers';

const ADDRESS = '192.0.2.241';

/** Keys only from `start`: Enter presses it. */
async function press(page: Page, start: Locator) {
  await start.focus();
  await expect(start).toBeFocused();
  await page.keyboard.press('Enter');
}

/** The confirmation open, by keyboard, at desktop and phone widths, with axe at each and its shots. */
async function confirmationShown(page: Page, question: Locator, name: string) {
  await expect(question).toBeFocused();
  // Axe at the width the shots are taken at (review of #421).
  await page.setViewportSize({ width: 1440, height: 900 });
  await axe(page);
  await shots(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
  await question.scrollIntoViewIfNeeded();
  await expect(question).toBeFocused();
  await axe(page);
  await shots(page, `${name}-phone`);
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('a removal moves focus into its confirmation, Keep it puts it back on Remove, and a removal leaves it on the form that replaces it (#289)', async ({
  page,
}) => {
  await signInAs(page, `e2e-confirm-focus-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbour Lights Deli', ADDRESS);
  await tool(page, 'set_webhook_alert_channel', {
    webhookUrl: 'https://ops.example.com/hooks/signforge',
    signingSecret: 'whsec_0123456789abcdefghijklmnopqrstuvwxyzABCD',
  });
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY });

  // Notifications: the webhook's Remove, inside its card's Manage.
  await page.goto('/settings/notifications');
  await hydrated(page);
  const manage = page.getByText('Manage', { exact: true });
  await press(page, manage);
  const remove = page.getByRole('button', { name: 'Remove Webhook' });
  await press(page, remove);
  const question = page.getByText('Stop sending alerts to Webhook?');
  await confirmationShown(page, question, '106-remove-webhook-confirm');
  // Tab reaches its answers: Remove, then Keep it, which puts focus back on Remove Webhook.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(remove).toBeFocused();
  await axe(page);
  await shots(page, '106-remove-webhook-kept');
  // Removed: the card's form to set a webhook takes focus.
  await page.keyboard.press('Enter');
  await expect(question).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Webhook removed')).toBeVisible();
  await expect(page.getByLabel('Webhook URL', { exact: true })).toBeFocused();

  // AI & agents: Remove key.
  await page.goto('/settings/ai');
  await hydrated(page);
  const removeKey = page.getByRole('button', { name: 'Remove key' });
  await press(page, removeKey);
  const asked = page.getByText('Remove the key?');
  await confirmationShown(page, asked, '106-remove-key-confirm');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(removeKey).toBeFocused();
  await axe(page);
  await shots(page, '106-remove-key-kept');
  // Escape is Keep it: the confirmation goes, and focus is back on Remove key (review of #421).
  await page.keyboard.press('Enter');
  await expect(asked).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(asked).toHaveCount(0);
  await expect(removeKey).toBeFocused();
  // Removed: the form is read afresh without a key, and its key field takes focus.
  await page.keyboard.press('Enter');
  await expect(asked).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('API key', { exact: true })).toBeFocused();
  expect(await tool(page, 'get_ai_provider', {})).toEqual({ provider: null });
});
