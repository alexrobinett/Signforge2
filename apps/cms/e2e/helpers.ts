import { expect, type Page } from '@playwright/test';
import { codeFor } from './servers';

/**
 * Fill the email step and ask for a code. Retried until the page has hydrated: before that the
 * input takes text but React has not seen it, and the button stays disabled.
 */
export async function requestCode(page: Page, email: string) {
  const button = page.getByRole('button', { name: 'Email me a code' });
  await expect(async () => {
    await page.getByLabel('Email').fill('');
    await page.getByLabel('Email').fill(email);
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await button.click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/** The whole sign-in, reading the code from the API's terminal output. */
export async function signIn(page: Page, email: string) {
  await requestCode(page, email);
  await page.getByLabel('Sign-in code').fill(await codeFor(email));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export const orgSwitcher = (page: Page) => page.getByRole('button', { name: /switch organization$/ });

/** With `E2E_SCREENSHOTS=<dir>`, save a screenshot once menus and drawers have finished animating. */
export async function screenshot(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

/**
 * Fill a field and wait until `button` is enabled, retrying until the page has hydrated: before
 * that the input takes text but React has not seen it.
 */
export async function fillUntilEnabled(page: Page, label: string, value: string, button: string) {
  await expect(async () => {
    await page.getByLabel(label).fill('');
    await page.getByLabel(label).fill(value);
    await expect(page.getByRole('button', { name: button })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}
