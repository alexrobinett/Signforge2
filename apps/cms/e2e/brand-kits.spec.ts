import { expect, test, type Page } from '@playwright/test';
import { axe, createOrg, disabledOnServer, holdFirst, hydrated, shots, signInAs, tool } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.132';

/** A brand colour as the SDK set it in a template frame of the kit page's previews (`--sf-<name>`), from every frame that has one. */
async function themed(page: Page, name: string) {
  const values: string[] = [];
  for (const frame of page.frames()) {
    const v = await frame.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(`--sf-${n}`).trim(), name).catch(() => '');
    if (v) values.push(v);
  }
  return values;
}

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-kits-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Northside Bakery', ADDRESS);
  // A spot to see the kit on, and a screen in a group to give it to.
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key.endsWith('clock'));
  const version = clock.versions.findLast((v: { status: string }) => v.status === 'approved');
  await tool(page, 'create_spot', { name: 'Lobby clock', kind: 'template', templateVersionId: version.id, data: { greeting: 'Good to see you' } });
  const start = await page.request.post(`http://127.0.0.1:${API_PORT}/v1/device/pair/start`, { headers: { 'cf-connecting-ip': '192.0.2.133' } });
  const { code } = await start.json();
  const { screen } = await tool(page, 'claim_screen', { code, name: 'Coffee bar', timezone: 'UTC', orientation: 'landscape' });
  await tool(page, 'create_group', { name: 'Café screens', screenIds: [screen.id] });
});

test.afterAll(() => page.context().close());

test('make a kit, see it on the real player as you pick colours, fix a pair that fails, and save it', async () => {
  await page.goto('/settings/general');
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Brand kits' }).click();
  await hydrated(page);
  await expect(page.getByRole('heading', { name: 'No brand kits yet' })).toBeVisible();
  await axe(page);
  await shots(page, '50-brand-kits-empty');

  await page.getByRole('button', { name: 'New kit' }).click();
  await page.getByLabel('Name').fill('Hearth Café');
  await page.getByRole('button', { name: 'Create kit' }).click();
  await expect(page).toHaveURL(/\/settings\/brand-kits\/bk_/);
  await expect(page.getByRole('heading', { name: 'Hearth Café', level: 1 })).toBeVisible();
  await hydrated(page);
  // The org's first kit is its default, so it reaches every screen.
  await expect(page.getByText('Default kit ·')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Edits reach' })).toHaveText('Edits reach 1 screen at the next publish: Coffee bar.');

  // The spot on the real player, wearing the kit.
  const previews = page.getByRole('region', { name: 'Your spots, with this kit' });
  await expect(previews.getByRole('link', { name: 'Lobby clock' })).toBeVisible();
  await expect.poll(() => themed(page, 'primary'), { timeout: 30_000 }).toEqual(['#2563eb']);

  // A colour reaches the player before anything is saved.
  const typedAt = Date.now();
  await page.getByLabel('Primary', { exact: true }).fill('#7a3e1d');
  await expect.poll(() => themed(page, 'primary'), { intervals: [20], timeout: 5_000 }).toEqual(['#7a3e1d']);
  console.log(`preview re-themed ${Date.now() - typedAt} ms after the edit`);
  await expect(page.getByText('Brand kit · Unsaved changes').or(page.getByText('Default kit · Unsaved changes'))).toBeVisible();

  // A pair set by hand that fails: its verdict in words, and a fix that derives it again.
  const contrast = page.getByRole('listitem').filter({ hasText: 'On accent on accent' });
  await page.getByLabel('Accent', { exact: true }).fill('#e9b872');
  await page.getByLabel('On accent', { exact: true }).fill('#ffffff');
  await expect(contrast).toContainText('1.8:1 Fail');
  await expect.poll(() => themed(page, 'on-accent'), { timeout: 5_000 }).toEqual(['#ffffff']);
  await shots(page, '51-brand-kit-failing-pair');
  await contrast.getByRole('button', { name: 'Fix On accent on accent: Use #000000 (11.5:1)' }).click();
  await expect(contrast).toContainText('11.5:1 Pass');
  await expect(page.getByText('Text on accent. Derived for 4.5:1 contrast')).toBeVisible();
  await expect.poll(() => themed(page, 'on-accent'), { timeout: 5_000 }).toEqual(['#000000']);

  // A font from the catalogue, drawn in its sample.
  await page.getByLabel('Display font').selectOption({ label: 'Montserrat' });
  await page.getByRole('button', { name: 'Save kit' }).click();
  await expect(page.getByText(/Default kit · Saved \d/)).toBeVisible();
  await axe(page);
  await shots(page, '52-brand-kit');

  // Saved: a reload shows it, with the derived on-colour still derived.
  await page.reload();
  await hydrated(page);
  await expect(page.getByLabel('Primary', { exact: true })).toHaveValue('#7a3e1d');
  await expect(page.getByLabel('Display font')).toHaveValue('base/montserrat');
  await expect(page.getByText('Text on accent. Derived for 4.5:1 contrast')).toBeVisible();
});

test('duplicate a kit, give it to a group, make it the default, and see the warnings of a pair below 4.5:1', async () => {
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByRole('heading', { name: 'Hearth Café copy', level: 1 })).toBeVisible();
  await hydrated(page);
  await expect(page.getByText('Brand kit · Saved')).toBeVisible();
  await expect(page.getByLabel('Primary', { exact: true })).toHaveValue('#7a3e1d');
  await expect(page.getByRole('status').filter({ hasText: 'screen' })).toHaveText(
    'No screen wears this kit yet. Edits reach screens once it is used and published.',
  );
  // The same players, now for the copy, re-theme with its edits (review of #103, 2).
  await page.getByLabel('Primary', { exact: true }).fill('#0f766e');
  await expect.poll(() => themed(page, 'primary'), { timeout: 5_000 }).toEqual(['#0f766e']);
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect.poll(() => themed(page, 'primary'), { timeout: 5_000 }).toEqual(['#7a3e1d']);

  // Given to the group by keyboard: its screen gets it at the next publish, over the default, and
  // the box keeps focus while the change is on its way (review of #103, 3).
  const use = page.getByRole('region', { name: 'Where it is used' });
  const group = use.getByRole('checkbox', { name: /Café screens/ });
  await group.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('status').filter({ hasText: 'Edits reach' })).toHaveText('Edits reach 1 screen at the next publish: Coffee bar.');
  await expect(group).toBeChecked();
  await expect(group).toBeFocused();

  // A muted colour too dark to read: a warning, not a refusal.
  await page.getByLabel('Muted', { exact: true }).fill('#3a3a3a');
  await expect(page.getByRole('listitem').filter({ hasText: 'Muted on background' })).toContainText('Fail');
  await expect(page.getByRole('status').filter({ hasText: 'Below 4.5:1' })).toHaveText('Below 4.5:1: Muted on background.');
  await page.getByRole('button', { name: 'Save kit' }).click();
  await expect(page.getByText(/Brand kit · Saved \d/)).toBeVisible();

  await page.getByRole('link', { name: 'Brand kits' }).first().click();
  await hydrated(page);
  const copy = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Hearth Café copy', exact: true }) });
  const original = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Hearth Café', exact: true }) });
  await expect(copy).toContainText('Chosen by group “Café screens”. It reaches 1 screen at the next publish.');
  await expect(copy).toContainText('1 contrast warning: muted on background is');
  await expect(original).toContainText('Default');
  await expect(original).toContainText('It reaches 0 screens at the next publish.');
  await axe(page);
  await shots(page, '53-brand-kits');

  await copy.getByRole('button', { name: 'Make default: Hearth Café copy' }).click();
  await expect(copy).toContainText('The default: every screen without a kit of its own');
  await expect(original).toContainText('Not used yet');

  // At phone width the list and the editor stack.
  await page.setViewportSize({ width: 390, height: 844 });
  await shots(page, '54-brand-kits-phone');
  await copy.getByRole('link', { name: 'Edit Hearth Café copy' }).click();
  await expect(page.getByRole('heading', { name: 'Hearth Café copy', level: 1 })).toBeVisible();
  await shots(page, '55-brand-kit-phone');
});

test('a change someone else made while the kit was open is not overwritten, even after the page reads the kits again', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/settings/brand-kits');
  await hydrated(page);
  await page.getByRole('link', { name: 'Edit Hearth Café', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hearth Café', level: 1 })).toBeVisible();
  await hydrated(page);
  const kitId = new URL(page.url()).pathname.split('/').at(-1);
  await page.getByLabel('Primary', { exact: true }).fill('#c8102e');

  // Stands in for someone else: rounder corners land after the page read the kit.
  await tool(page, 'update_brand_kit', { brandKitId: kitId, shape: 'round' });
  // Giving the kit to a screen reads the kits again: the page now holds the other change's version,
  // and the draft is kept.
  const screen = page.getByRole('region', { name: 'Where it is used' }).getByRole('checkbox', { name: 'Coffee bar' });
  await screen.click();
  await expect(screen).toBeChecked();
  await expect(page.getByText('Edits reach 1 screen at the next publish: Coffee bar.')).toBeVisible();
  await expect(page.getByLabel('Primary', { exact: true })).toHaveValue('#c8102e');

  await page.getByRole('button', { name: 'Save kit' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This kit changed since you opened it.' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByLabel('Primary', { exact: true })).toHaveValue('#7a3e1d');
  await expect(page.getByRole('radio', { name: 'Round' })).toBeChecked();
});

test("the kit's fields and actions are disabled in the server's HTML, until the editor has hydrated (#136)", async () => {
  // The editor hydrates after the page (body[data-hydrated]): a field changed in between was set
  // back by React, and the change lost.
  const { brandKit } = await tool(page, 'create_brand_kit', {
    name: 'Server kit',
    colors: { primary: '#1d4ed8', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' },
    idempotencyKey: `server-kit-${Date.now()}`,
  });
  const path = `/settings/brand-kits/${brandKit.id}`;
  const names = ['Name', 'Primary colour picker', 'Display font', 'Duplicate'];
  expect(await disabledOnServer(page, path, names)).toEqual(Object.fromEntries(names.map((n) => [n, [true]])));
  // Rendered by the server, they are enabled once the editor has hydrated.
  await page.goto(path);
  await hydrated(page);
  await expect(page.getByLabel('Name', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Duplicate' })).toBeEnabled();
});

test('kit actions run one at a time: Duplicate during a save is ignored, then copies what was saved; New kit waits for Duplicate (review of #143, 3)', async () => {
  // A Duplicate during Save copied the colours from before it; New kit and Duplicate both ran,
  // and both navigate when they finish.
  const { brandKit } = await tool(page, 'create_brand_kit', {
    name: 'Serial kit',
    colors: { primary: '#2563eb', accent: '#f59e0b', background: '#0b0f17', surface: '#1a2130', text: '#f5f7fa', muted: '#a3acbb' },
    idempotencyKey: `serial-kit-${Date.now()}`,
  });
  await page.goto(`/settings/brand-kits/${brandKit.id}`);
  await hydrated(page);
  await expect(page.getByLabel('Primary', { exact: true })).toBeEnabled();
  await page.getByLabel('Primary', { exact: true }).fill('#335577');
  const copies = await holdFirst(page, '/api/tools/create_brand_kit');
  const saving = await holdFirst(page, '/api/tools/update_brand_kit');
  await page.getByRole('button', { name: 'Save kit' }).click();
  const saveAnswer = await saving.arrived;
  const duplicate = page.getByRole('button', { name: 'Duplicate' });
  await expect(duplicate).toHaveAttribute('aria-disabled', 'true');
  await duplicate.focus();
  await page.keyboard.press('Enter');
  await saveAnswer.continue();
  // Default kit or not (this test may run alone, its kit the org's first), it reads Saved and a time.
  await expect(page.getByText(/ · Saved \d/)).toBeVisible();
  await expect(duplicate).not.toHaveAttribute('aria-disabled');
  expect(copies.calls()).toBe(0);

  // From the list: Duplicate copies the saved colour, and New kit is ignored until it is done.
  await page.getByRole('link', { name: 'Brand kits' }).first().click();
  await hydrated(page);
  await page.getByRole('button', { name: 'Duplicate Serial kit' }).focus();
  await page.keyboard.press('Enter');
  const copy = await copies.arrived;
  expect(copy.request().postDataJSON()).toMatchObject({ name: 'Serial kit copy', colors: { primary: '#335577' } });
  await page.getByRole('button', { name: 'New kit' }).click();
  const dialog = page.getByRole('dialog', { name: 'New brand kit' });
  await dialog.getByLabel('Name').fill('Spring');
  await expect(dialog.getByRole('button', { name: 'Create kit' })).toHaveAttribute('aria-disabled', 'true');
  await dialog.getByLabel('Name').press('Enter');
  await copy.continue();
  await expect(page.getByRole('heading', { name: 'Serial kit copy', level: 1 })).toBeVisible();
  expect(copies.calls()).toBe(1);
});
