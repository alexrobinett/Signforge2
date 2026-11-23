import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { expect, request as playwrightRequest, type Page, type Route } from '@playwright/test';
import { manifestIdInput, MANIFEST_SCHEMA, type ScreenManifest } from '@signforge/contract';
import { png } from '@signforge/media/testing';
import { slugify } from '../src/lib/paths';
import { ADMIN_TOKEN, API_PORT, CMS_URL, codeFor } from './servers';

/**
 * Fill the email step and ask for a code. Retried until the page has hydrated: before that the
 * input takes text but React has not seen it, and the button stays disabled. Bounded by the test.
 */
export async function requestCode(page: Page, email: string) {
  const button = page.getByRole('button', { name: 'Email me a code' });
  await expect(async () => {
    await page.getByLabel('Email').fill('');
    await page.getByLabel('Email').fill(email);
    await expect(button).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await button.click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
}

/** The whole sign-in, reading the code from the API's terminal output. */
export async function signIn(page: Page, email: string) {
  await requestCode(page, email);
  await page.getByLabel('Sign-in code').fill(await codeFor(email));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The org switcher under the logo: a menu only for a member of two or more orgs (#182). */
export const orgSwitcher = (page: Page) => page.getByRole('button', { name: /switch organization$/ });

/** The account menu's button in the sidebar (wide screens). */
export const accountMenu = (page: Page) => page.getByRole('button', { name: /account and settings$/ });

/** Create an org from the account menu's dialog; it becomes the active org. */
export async function createOrgFromAccountMenu(page: Page, name: string) {
  await accountMenu(page).click();
  await page.getByRole('menuitem', { name: 'Create organization…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create organization' });
  await dialog.getByLabel('Organization name').fill(name);
  await dialog.getByRole('button', { name: 'Create organization' }).click();
  await expect(dialog).toBeHidden();
}

/** With `E2E_SCREENSHOTS=<dir>`, save a screenshot: Playwright finishes menus' and drawers' animations first, with no wait on a clock. */
export async function screenshot(page: Page, name: string) {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  await page.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });
}

/**
 * Fill a field and wait until `button` is enabled, retrying until the page has hydrated: before
 * that the input takes text but React has not seen it. Bounded by the test.
 */
export async function fillUntilEnabled(page: Page, label: string, value: string, button: string) {
  await expect(async () => {
    await page.getByLabel(label).fill('');
    await page.getByLabel(label).fill(value);
    await expect(page.getByRole('button', { name: button })).toBeEnabled({ timeout: 1_000 });
  }).toPass();
}

/** Wait until React has hydrated the page (`data-hydrated` on body), so clicks reach handlers. */
export async function hydrated(page: Page) {
  await expect(page.locator('body[data-hydrated]')).toBeAttached();
}

/**
 * Whether each control named in `names` is disabled in the server's HTML of `path`, one entry per
 * control of that name (its aria-label, else its label's text, else its own). A page's own part
 * hydrates after `body[data-hydrated]`, and a field changed in between is set back by React, the
 * old value saved (#135, #136): the editors keep their controls disabled until then.
 */
export async function disabledOnServer(page: Page, path: string, names: string[]): Promise<Record<string, boolean[]>> {
  const html = await (await page.request.get(path)).text();
  return page.evaluate(
    ({ html, names }) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const controls = [...doc.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')].map((el) => ({
        name: (el.getAttribute('aria-label') ?? el.labels?.[0]?.textContent ?? el.textContent).trim(),
        disabled: el.matches(':disabled'),
      }));
      return Object.fromEntries(names.map((n) => [n, controls.filter((c) => c.name === n).map((c) => c.disabled)]));
    },
    { html, names },
  );
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
  await fromAddress(page, address);
}

/**
 * The page's calls come from `address` (the CMS passes it to the API), sign-in's included. Better
 * Auth counts a path's calls per address until 10 s pass with none, so on one shared address every
 * spec's shell read added up and a long run got 429.
 */
export async function fromAddress(page: Page, address: string) {
  await page
    .context()
    .route(`${CMS_URL}/**`, async (route) => route.fallback({ headers: { ...(await route.request().allHeaders()), 'cf-connecting-ip': address } }));
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
 * theme change, or a dialog's fade. The spot editor's preview is checked too, in the light pass: the
 * real player showing a template, so every base template's text must read on its colours (#57). The
 * dark pass leaves the player's frames out, as the CMS's `.dark` never reaches them. Its template
 * frames keep playing, so each is held at rest, after its intro and before its outro (which starts
 * at least 0.6 s before the end): mid-fade, weather's last row once read 2.68:1 (#70). The next play
 * restarts them. The player's own slots fade between spots, and an analysis during that fade reads
 * a spot half shown: each analysis waits for the slots to settle and is repeated if a fade began
 * during it (#95).
 */
export async function axe(page: Page) {
  const still = await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  const report = (theme: string, violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) =>
    violations.flatMap((v) => v.nodes.map((n) => `${theme} ${v.id}: ${n.target.join(' ')}: ${n.any[0]?.message ?? n.failureSummary}`));
  try {
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    // A play or slot fade that began during an analysis may have shown it a spot mid-intro or half
    // faded: settle, hold, analyse again. A stage looping 4 s spots can do that several times.
    let found: string[] = [];
    let held = false;
    for (let tries = 0; tries < 5 && !held; tries++) {
      // Often: between 4 s spots with a long fade, the stage is still for about a second.
      await expect.poll(() => slotFades(page), { message: 'a player slot is still fading', intervals: [50], timeout: 15_000 }).not.toBeUndefined();
      const fades = await slotFades(page);
      if (fades === undefined) continue;
      await holdTemplates(page);
      found = report('light', (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations);
      held = (await holdTemplates(page)) && (await slotFades(page)) === fades;
    }
    expect(held, 'a template frame started a play, or a player slot a fade, during each of 5 analyses').toBe(true);
    expect(found, page.url()).toEqual([]);
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(report('dark', (await new AxeBuilder({ page }).withTags(WCAG).exclude('iframe').analyze()).violations), page.url()).toEqual([]);
  } finally {
    // Also after a failure, so the test's own teardown and screenshots see the page as it was.
    await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), wasDark);
    await still.evaluate((el) => el.parentNode?.removeChild(el));
  }
}

/**
 * The number of slot fades the player has begun, or undefined while one runs. The player (a
 * document with `.slot`s) shows a spot by fading its slot's opacity: settled, every slot is at 0 or
 * 1 with no transition on it or around it. The count (from `transitionrun`, watched from the first
 * call) shows a fade that began and ended between two calls, such as a fade's second half.
 */
async function slotFades(page: Page): Promise<number | undefined> {
  let fades = 0;
  for (const frame of page.frames()) {
    const n = await frame
      .evaluate(() => {
        const slots = [...document.querySelectorAll<HTMLElement>('.slot')];
        if (!slots.length) return 0;
        const root = document.documentElement;
        if (!root.dataset.sfAxeFades) {
          root.dataset.sfAxeFades = '0';
          document.addEventListener(
            'transitionrun',
            (e) => {
              if (e.target instanceof Element && e.target.matches('.slot')) root.dataset.sfAxeFades = String(Number(root.dataset.sfAxeFades) + 1);
            },
            true,
          );
        }
        const half = slots.some((el) => {
          const o = Number(getComputedStyle(el).opacity);
          return o > 0 && o < 1;
        });
        const moving = document.getAnimations().some((a) => {
          const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
          return a.playState !== 'finished' && target instanceof Element && slots.some((el) => target.contains(el));
        });
        return half || moving ? -1 : Number(root.dataset.sfAxeFades);
      })
      // A frame the player removed in the meantime.
      .catch(() => 0);
    if (n < 0) return undefined;
    fades += n;
  }
  return fades;
}

/**
 * Hold every template frame (a document with `--sf-duration`) at rest: its animations paused after
 * its intro and before its outro. True when none was playing: a frame the SDK has just prepared is
 * paused (at 0) and hidden until it plays, so it is moved to rest but does not count as playing. A
 * frame the player removed in the meantime is skipped: it is no longer on the page.
 */
async function holdTemplates(page: Page): Promise<boolean> {
  let held = true;
  for (const frame of page.frames()) {
    const still = await frame
      .evaluate(() => {
        const ms = Number.parseFloat(document.documentElement.style.getPropertyValue('--sf-duration'));
        if (!ms) return true;
        const animations = document.getAnimations();
        const playing = animations.some((a) => a.playState === 'running');
        for (const a of animations) {
          a.pause();
          a.currentTime = ms - 1500;
        }
        return !playing;
      })
      .catch(() => true);
    held &&= still;
  }
  return held;
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

/** The dev API's D1, by the placeholder id `env.dev` gives it in apps/api/wrangler.jsonc. */
const DEV_DB_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Runs SQL on the run's local D1, which the dev API reads (`e2e/global-setup.ts`): for what the
 * test cannot wait for. It goes through the dev API's own Local Explorer, so the process that
 * holds the database runs it. `wrangler d1 execute`, a second process on the same file, found it
 * locked (SQLITE_BUSY) once specs ran side by side, and could lock the API's own writes out (#249).
 */
export async function d1(sql: string) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}/cdn-cgi/local/explorer/api/d1/database/${DEV_DB_ID}/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await res.text();
  expect(res.status, body).toBe(200);
  expect(JSON.parse(body), body).toMatchObject({ success: true });
}

/**
 * Make an org called `name` through the API, as the CMS does (it becomes the active org), and land
 * on it, hydrated. Only sign-in-and-orgs.spec.ts makes one through the page. Slugs are global and a spec may
 * make two orgs of one name, so each gets its own.
 */
export async function createOrg(page: Page, name: string) {
  const slug = `${slugify(name)}-${randomUUID().slice(0, 8)}`;
  const res = await page.request.post('/api/auth/organization/create', { headers: { origin: CMS_URL }, data: { name, slug } });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  // A fresh load, as the page's own create was not: a click before this would go nowhere.
  await hydrated(page);
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

/** Holds the first request to `path` until the test continues it; later ones go through, counted. */
export async function holdFirst(page: Page, path: string) {
  let calls = 0;
  let hold: (route: Route) => void = () => {};
  const arrived = new Promise<Route>((resolve) => {
    hold = resolve;
  });
  await page.route(`**${path}`, (route) => {
    calls += 1;
    if (calls === 1) hold(route);
    else void route.continue();
  });
  return { arrived, calls: () => calls };
}
