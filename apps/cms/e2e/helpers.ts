import AxeBuilder from '@axe-core/playwright';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, request as playwrightRequest, type Page } from '@playwright/test';
import { manifestIdInput, MANIFEST_SCHEMA, type ScreenManifest } from '@signforge/contract';
import { png } from '@signforge/media/testing';
import { ADMIN_TOKEN, API_PORT, CMS_URL, codeFor, RUN_DIR } from './servers';

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

/** Publish one image spot, called `spot`, to the screen, as `sf push` does: a manifest built outside the CMS. */
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

/** WCAG 2.1 A and AA: what axe checks on each page. */
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Run axe on the page as it is, in the light theme and the dark, and fail on any violation
 * (results axe cannot decide, such as text over a gradient, are not failures). Transitions and
 * animations are off in the top document while it runs: else it reads colours halfway through the
 * theme change, or a dialog's fade. The spot editor's preview is checked too: the real player
 * showing a template, so every base template's text must read on its colours (#57).
 */
export async function axe(page: Page) {
  const still = await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  for (const dark of [false, true]) {
    await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark);
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    const found = violations.flatMap((v) =>
      v.nodes.map((n) => `${dark ? 'dark' : 'light'} ${v.id}: ${n.target.join(' ')}: ${n.any[0]?.message ?? n.failureSummary}`),
    );
    expect(found, page.url()).toEqual([]);
  }
  await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), wasDark);
  await still.evaluate((el) => el.parentNode?.removeChild(el));
}

/** Whether any frame on the page (the player's template frames included) shows `text`. */
export async function stageShows(page: Page, text: string) {
  for (const frame of page.frames())
    if (
      (await frame
        .getByText(text, { exact: false })
        .count()
        .catch(() => 0)) > 0
    )
      return true;
  return false;
}

/** Call a tool as the signed-in member, as the CMS's pages do, and expect it to succeed. */
export async function tool(page: Page, name: string, input: unknown) {
  const res = await page.request.post(`/api/tools/${name}`, { data: input });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** Runs SQL on the run's local D1, which the dev API reads (`e2e/global-setup.ts`): for what the test cannot wait for. */
export function d1(command: string) {
  const run = spawnSync(
    'pnpm',
    ['exec', 'wrangler', 'd1', 'execute', 'DB', '--local', '--env', 'dev', '--persist-to', `${RUN_DIR}state`, '--command', command],
    {
      cwd: fileURLToPath(new URL('../../api/', import.meta.url)),
      env: { ...process.env, CLOUDFLARE_ENV: 'dev', NO_COLOR: '1' },
      encoding: 'utf8',
    },
  );
  expect(run.status, run.stderr).toBe(0);
}

/** As a member with no org yet: make one called `name`, as the first page asks, and land on it. */
export async function createOrg(page: Page, name: string) {
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', name, 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** The org of the spot, in SQL: source ids are per org, and other specs' orgs share the database. */
export const orgOf = (spotId: string) => `(SELECT org_id FROM spots WHERE id = '${spotId}')`;

export const spotIdOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1) ?? '';

/** A new template spot from the Spots page, open in its editor; its id. */
export async function newSpot(page: Page, template: string, name: string) {
  await page.goto('/spots');
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('combobox', { name: 'Template' }).selectOption({ label: template });
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await hydrated(page);
  return spotIdOf(page);
}
