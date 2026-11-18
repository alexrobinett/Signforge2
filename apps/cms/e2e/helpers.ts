import { createHash } from 'node:crypto';
import { expect, request as playwrightRequest, type Page } from '@playwright/test';
import { manifestIdInput, MANIFEST_SCHEMA, type ScreenManifest } from '@signforge/contract';
import { png } from '@signforge/media/testing';
import { ADMIN_TOKEN, API_PORT, CMS_URL, codeFor } from './servers';

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

/** Wait until React has hydrated the page (`data-hydrated` on body), so clicks reach handlers. */
export async function hydrated(page: Page) {
  await expect(page.locator('body[data-hydrated]')).toBeAttached({ timeout: 30_000 });
}

/** Each with E2E_SCREENSHOTS: a screenshot in the light theme, then in the dark. */
export async function shots(page: Page, name: string) {
  await screenshot(page, `${name}-light`);
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await screenshot(page, `${name}-dark`);
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
}

/**
 * Sign in by email code straight against the API, as a client at `address` (through the dev CMS
 * every request comes from one address, so a spec that signs in this way has its own rate limit),
 * and give the browser the session cookies.
 */
export async function signInAs(page: Page, email: string, address: string) {
  const api = `http://127.0.0.1:${API_PORT}/api`;
  const headers = { 'cf-connecting-ip': address };
  // Its own request context, so a spec's device calls go without the session cookie.
  const request = await playwrightRequest.newContext();
  const sent = await request.post(`${api}/auth/email-otp/send-verification-otp`, { headers, data: { email, type: 'sign-in' } });
  expect(sent.status()).toBe(200);
  const signedIn = await request.post(`${api}/auth/sign-in/email-otp`, { headers, data: { email, otp: await codeFor(email) } });
  expect(signedIn.status()).toBe(200);
  const cookies = signedIn.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
  await page.context().addCookies(
    cookies.map((h) => {
      const [pair = ''] = h.value.split(';');
      const at = pair.indexOf('=');
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: CMS_URL };
    }),
  );
  await request.dispose();
}

const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

/** Publish one image spot, called `spot`, to the screen, as `sf push` does until the CMS publishes (M3-18). */
export async function publishImage(page: Page, screenId: string, spot = 'Welcome'): Promise<string> {
  const admin = `http://127.0.0.1:${API_PORT}/admin/screens/${screenId}`;
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const image = await png(640, 360);
  const file = sha256(image);
  const body: Omit<ScreenManifest, 'id'> = {
    schema: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    screen: { id: screenId, name: 'Test screen', timezone: 'UTC', orientation: 'landscape' },
    files: { [file]: { size: image.byteLength, type: 'image/png' } },
    templates: {},
    spots: { welcome: { id: 'welcome', name: spot, kind: 'image', file, fit: 'cover', durationMs: 5000 } },
    playlists: { main: { id: 'main', name: 'Main', transition: { type: 'cut' }, items: [{ spot: 'welcome' }] } },
    dataSources: {},
    schedule: [],
    defaultPlaylist: 'main',
  };
  const manifest = { ...body, id: sha256(manifestIdInput(body)) };
  const put = await page.request.put(`${admin}/blobs/${file}`, { headers: { ...headers, 'content-type': 'image/png' }, data: image });
  expect(put.status(), await put.text()).toBe(200);
  const published = await page.request.put(`${admin}/manifest`, { headers, data: JSON.stringify(manifest) });
  expect(published.status(), await published.text()).toBe(200);
  return manifest.id;
}
