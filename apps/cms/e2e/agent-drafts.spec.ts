// The agent's drawer drafting a change (#268), against the Anthropic stub's scripted turn on a spot
// (read it, then draft STUB_DRAFT into its data; e2e/global-setup.ts): no test reaches a real model.
import { expect, test } from '@playwright/test';
import { axe, createOrg, hydrated, shots, signInAs, stageShows, tool } from './helpers';
import { ANTHROPIC_STUB_KEY, ANTHROPIC_STUB_MODELS, STUB_DRAFT, STUB_DRAFTED } from './servers';

const ADDRESS = '192.0.2.183';

test('a member asks the agent for a punchier headline and a QR link, sees what it would change, saves it, sees the stage redraw, and undoes it (#268)', async ({
  page,
}) => {
  await signInAs(page, `e2e-drafts-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Ridgeway Diner', ADDRESS);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, capableModel: ANTHROPIC_STUB_MODELS[1] });
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  // The alert template: a headline and a QR code's link, and no photo to wait for.
  const alert = templates.find((t: { key: string }) => t.key === 'alert');
  const { spot } = await tool(page, 'save_spot', {
    name: 'Breakfast',
    kind: 'template',
    templateVersionId: alert.versions.at(-1).id,
    data: { headline: 'Breakfast served' },
    idempotencyKey: crypto.randomUUID(),
  });

  await page.goto(`/spots/${spot.id}`);
  await hydrated(page);
  await expect(page.getByRole('region', { name: 'Live preview' }).getByRole('status')).toHaveText('Preview ready', { timeout: 30_000 });
  await expect.poll(() => stageShows(page, 'Breakfast served'), { timeout: 10_000 }).toBe(true);
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent' });
  await drawer.getByLabel('Ask about your screens and content').fill('Make the headline punchier and add a QR link to the menu');
  await drawer.getByRole('button', { name: 'Ask', exact: true }).click();

  // What it would change, before anything is written.
  const changes = drawer.getByRole('region', { name: 'Changes the agent drafted' });
  await expect(drawer.getByRole('article')).toContainText(STUB_DRAFTED.text);
  await expect(changes).toContainText('Spot Breakfast');
  await expect(changes).toContainText(`Headline: Breakfast served → ${STUB_DRAFT.headline}`);
  // The QR code's link in full, marked to check.
  const link = changes.locator('[data-check]');
  await expect(link).toContainText(STUB_DRAFT.qrUrl);
  await expect(link).toContainText('Check');
  await expect(changes).toContainText('Reaches 0 screens at the next publish');
  expect((await tool(page, 'get_spot', { spotId: spot.id })).spot.data.headline).toBe('Breakfast served');
  await axe(page);
  await shots(page, '101-drafts-proposed');

  // Saved as a draft, as the member via the agent: the stage plays it, and the editor marks what changed.
  await changes.getByRole('button', { name: 'Save as draft' }).click();
  await expect(changes).toContainText('Saved as draft');
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId: spot.id })).spot.data).toMatchObject(STUB_DRAFT);
  await expect.poll(() => stageShows(page, STUB_DRAFT.headline), { timeout: 10_000 }).toBe(true);
  await expect(page.locator('[data-mark="filled"]').first()).toBeVisible();
  await expect(changes.getByRole('button', { name: 'Publish now…' })).toBeVisible();
  const [entry] = (await tool(page, 'list_audit_log', { limit: 1 })).entries;
  expect(entry).toMatchObject({ action: 'save_spot', actor: { kind: 'user', clientId: 'cms-agent' } });
  await shots(page, '101-drafts-saved');

  // Undo these changes: the draft as it was before the turn.
  await changes.getByRole('button', { name: 'Undo these changes' }).click();
  await expect(changes).toContainText('Undone');
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId: spot.id })).spot.data.headline).toBe('Breakfast served');
  await expect.poll(() => stageShows(page, 'Breakfast served'), { timeout: 10_000 }).toBe(true);

  // On a phone the card is in the sheet, and axe passes there too.
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '101-drafts-phone');
});
