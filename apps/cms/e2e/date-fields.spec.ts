// A spot from a template whose datetime has no default or min (#192): the New spot dialog makes
// it with the target not picked, the editor says it needs one, and a picked one is saved.
import { expect, test, type Page } from '@playwright/test';
import { createOrg, d1, hydrated, signInAs, spotIdOf, tool } from './helpers';

/** This spec's own client address, so its sign-in has its own rate limit and leaves the other specs theirs. */
const ADDRESS = '192.0.2.140';

// Not the base Countdown (#198): an org's own template, named apart from it.
const countdown = {
  id: 'launch-countdown',
  version: '1.0.0',
  name: 'Launch countdown',
  fields: { title: { type: 'text', label: 'Title', default: 'Doors open' }, target: { type: 'datetime', label: 'Target' } },
  duration: { defaultMs: 8000, minMs: 4000, maxMs: 60000 },
  orientations: ['landscape'],
  uses: [],
  background: '#000',
  protocol: 2,
};

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
  await signInAs(page, `e2e-dates-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Launch Hall');
  const orgId: string = (await (await page.request.get('/api/session')).json()).organization.id;
  // The org's own approved template, in SQL: registering one runs the runtime check, which the local API has no container for.
  // The form is what this spec is about: the stage never gets the bundle, which is not uploaded.
  const at = Date.now();
  const report = JSON.stringify({ ok: true, bundleBytes: 1000, checks: [], checkedAt: at, sourcesSha256: '0'.repeat(64) });
  await d1(
    `INSERT INTO templates (id, org_id, key, name, created_at, updated_at) VALUES ('tpl_e2e_${at}', '${orgId}', 'launch-countdown', 'Launch countdown', ${at}, ${at}); ` +
      'INSERT INTO template_versions (id, org_id, template_id, version, manifest_json, bundle_sha256, status, check_report_json, created_at, updated_at) ' +
      `VALUES ('tv_e2e_${at}', '${orgId}', 'tpl_e2e_${at}', '1.0.0', '${JSON.stringify(countdown)}', '${'f'.repeat(64)}', 'approved', '${report}', ${at}, ${at})`,
  );
});
test.afterAll(() => page.context().close());

test('a new spot leaves a datetime with no default for the editor to pick, says it needs one, and saves the one picked', async () => {
  await page.goto('/spots');
  await hydrated(page);
  await page.getByRole('button', { name: 'New spot' }).click();
  await page.getByRole('combobox', { name: 'Template' }).selectOption({ label: 'Launch countdown' });
  await page.getByLabel('Name').fill('Grand opening');
  await page.getByRole('button', { name: 'Create spot' }).click();
  await expect(page.getByRole('heading', { name: 'Grand opening', level: 1 })).toBeVisible();
  await hydrated(page);
  const spotId = spotIdOf(page);

  const target = page.getByLabel('Target');
  await expect(target).toHaveAttribute('type', 'datetime-local');
  await expect(target).toHaveValue('');
  await expect(target).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#field-target-error')).toHaveText('field "target" has no date and time yet');
  expect((await tool(page, 'get_spot', { spotId })).spot.data).toEqual({ target: '' });

  await target.fill('2026-12-24T18:00');
  await expect(page.locator('#field-target-error')).toHaveCount(0);
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId })).spot.data, { timeout: 10_000 }).toEqual({ target: '2026-12-24T18:00' });
});
