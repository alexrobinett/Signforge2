// The agent's confirmation cards (#269) and Ask agent in ⌘K (#270), against the Anthropic stub's
// scripted turns (e2e/global-setup.ts): asked about the storm, it takes every screen over, which stops
// at a card until the person presses it. No test reaches a real model.
import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { axe, createOrg, hydrated, joinAsEditor, shots, signInAs, tool } from './helpers';
import { ANTHROPIC_STUB_KEY, ANTHROPIC_STUB_MODELS, CMS_URL, STUB_CANCELLED, STUB_CARD, STUB_TAKEN } from './servers';

const ADDRESS = '192.0.2.193';
/** An editor's sign-in, from its own address. */
const EDITOR_ADDRESS = '192.0.2.194';

/** Keys only: from the question, Shift+Tab back up the drawer until `target` has focus. */
async function tabTo(page: Page, target: Locator) {
  await page.getByLabel('Ask about your screens and content').click();
  for (let i = 0; i < 20 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Shift+Tab');
  await expect(target).toBeFocused();
}

test('a member asks the agent to put up the storm closure, sees the takeover card, presses it by keyboard, and ends it from the Schedule (#269)', async ({
  page,
}) => {
  await signInAs(page, `e2e-confirm-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Bayside Storm Supplies', ADDRESS);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, capableModel: ANTHROPIC_STUB_MODELS[1] });
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock')).versions.at(-1).id;
  const { spot } = await tool(page, 'save_spot', {
    name: 'Closed',
    kind: 'template',
    templateVersionId: clock,
    durationMs: 10_000,
    data: { greeting: 'Closed' },
  });
  await tool(page, 'save_playlist', { name: 'Storm closure', transition: { type: 'cut' }, spotIds: [spot.id] });

  await page.goto('/schedule');
  await hydrated(page);
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent' });
  await drawer.getByLabel('Ask about your screens and content').fill('Bayside closes at 2 for the storm: put the closure up everywhere');
  await drawer.getByRole('button', { name: 'Ask', exact: true }).click();

  // The card: what happens, to how many screens, until when, and how it is undone. Nothing is done yet.
  const card = drawer.getByRole('region', { name: 'Take over screens' }).first();
  await expect(card).toContainText('Plays Storm closure on every screen (0 screens), over anything scheduled.');
  await expect(card).toContainText('Publishes Storm closure too: it was never published.');
  await expect(card).toContainText('End it early with End now on the Schedule.');
  expect((await tool(page, 'list_schedule_entries', {})).entries).toEqual([]);
  await axe(page);
  await shots(page, '102-confirm-card');

  // Pressed by keyboard: it runs, once, and the agent says what it did.
  // By keyboard alone: Tab from the question to the card's button, then Enter.
  await tabTo(page, card.getByRole('button', { name: 'Take over' }));
  await page.keyboard.press('Enter');
  await expect(card).toContainText('Done.');
  await expect(drawer.getByRole('article').last()).toContainText(STUB_TAKEN.text);
  await expect(card.getByRole('button', { name: 'Take over' })).toHaveCount(0);
  const [entry] = (await tool(page, 'list_schedule_entries', {})).entries;
  expect(entry).toMatchObject({ endsAt: expect.any(String) });
  const [audit] = (await tool(page, 'list_audit_log', { limit: 5 })).entries.filter((e: { action: string }) => e.action === 'takeover');
  expect(audit).toMatchObject({ actor: { kind: 'user', clientId: 'cms-agent' } });

  // Another card, let go by keyboard: focus goes on to the question, and the live region says it was cancelled.
  await drawer.getByLabel('Ask about your screens and content').fill('The storm is worse: put the closure up again');
  await drawer.getByRole('button', { name: 'Ask', exact: true }).click();
  const again = drawer.getByRole('region', { name: 'Take over screens' }).last();
  await expect(again.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await tabTo(page, again.getByRole('button', { name: 'Cancel' }));
  await page.keyboard.press('Enter');
  await expect(again).toContainText('Cancelled: nothing was done.');
  await expect(drawer.getByLabel('Ask about your screens and content')).toBeFocused();
  await expect(drawer.getByRole('status')).toHaveText('Cancelled: nothing was done.');

  // On a phone the card fits the sheet, and axe passes there too.
  await page.setViewportSize({ width: 390, height: 844 });
  // The sheet is drawn anew at this width, so the card can be between mounts when first measured: poll until it is back.
  await expect.poll(async () => (await card.boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(390);
  await axe(page);
  await shots(page, '102-confirm-phone');
  await drawer.getByRole('button', { name: 'Close the agent' }).click();

  // Ended from the Schedule.
  await page.setViewportSize({ width: 1280, height: 900 });
  const takeovers = page.getByRole('region', { name: 'Takeovers' }).getByRole('listitem');
  await expect(takeovers).toHaveCount(1);
  await takeovers.first().getByRole('button', { name: 'End now' }).click();
  await expect(page.getByRole('region', { name: 'Takeovers' })).toHaveCount(0);
});

test('an owner asks the agent to cancel an invitation: a card says whose, the press cancels it, and the audit log names the invitee to owners only (#321)', async ({
  page,
  browser,
}) => {
  await signInAs(page, `e2e-confirm-invite-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Bayside Invitations', ADDRESS);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, capableModel: ANTHROPIC_STUB_MODELS[1] });
  const invited = await page.request.post('/api/auth/organization/invite-member', {
    headers: { origin: CMS_URL, 'cf-connecting-ip': ADDRESS },
    data: { email: 'kim.bayside@example.com', role: 'editor' },
  });
  expect(invited.status(), await invited.text()).toBe(200);
  const { id } = (await invited.json()) as { id: string };

  await page.goto('/settings/members');
  await hydrated(page);
  await page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' }).click();
  const drawer = page.getByRole('dialog', { name: 'Agent' });
  await drawer.getByLabel('Ask about your screens and content').fill(`Cancel the invitation ${id}`);
  await drawer.getByRole('button', { name: 'Ask', exact: true }).click();
  const card = drawer.getByRole('region', { name: 'Cancel an invitation' });
  await expect(card).toContainText('The invitation for kim.bayside@example.com as editor stops working: its link no longer lets them in.');
  await expect(card).toContainText('No undo: an owner invites them again.');
  expect((await tool(page, 'list_invitations', {})).invitations).toHaveLength(1);
  await axe(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shots(page, '104-cancel-invitation-card');
  await page.setViewportSize({ width: 1280, height: 900 });

  await card.getByRole('button', { name: 'Cancel the invitation' }).click();
  await expect(card).toContainText('Done.');
  await expect(drawer.getByRole('article').last()).toContainText(STUB_CANCELLED.text);
  expect((await tool(page, 'list_invitations', {})).invitations).toEqual([]);
  await drawer.getByRole('button', { name: 'Close the agent' }).click();

  // The audit log says who it was for, and that the agent did it for the owner.
  await page.goto('/audit');
  await hydrated(page);
  const row = page.getByRole('row', { name: /Invitation cancelled/ });
  await expect(row).toContainText('via agent');
  await expect(row).toContainText('email: kim.bayside@example.com');
  await axe(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shots(page, '104-cancel-invitation-audit');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '104-cancel-invitation-audit-phone');

  // An editor who asks to cancel one is told who may, and nothing of whose it is (review of #414).
  const editor = await (await browser.newContext()).newPage();
  await joinAsEditor(page, editor, `e2e-confirm-invite-editor-${Date.now()}@example.com`, EDITOR_ADDRESS);
  await editor.goto('/settings/members');
  await hydrated(editor);
  await editor.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' }).click();
  const theirs = editor.getByRole('dialog', { name: 'Agent' });
  await theirs.getByLabel('Ask about your screens and content').fill(`Cancel the invitation ${id}`);
  await theirs.getByRole('button', { name: 'Ask', exact: true }).click();
  const refused = theirs.getByRole('region', { name: 'Cancel an invitation' });
  await expect(refused).toContainText('Only owners can do this: ask an owner.');
  await expect(refused).not.toContainText('kim.bayside');
  await expect(refused.getByRole('button', { name: 'Cancel the invitation' })).toHaveCount(0);
  await axe(editor);
  await editor.setViewportSize({ width: 1440, height: 1000 });
  await shots(editor, '104-cancel-invitation-editor-card');
  await editor.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await refused.boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(390);
  await axe(editor);
  await shots(editor, '104-cancel-invitation-editor-card-phone');
  await editor.setViewportSize({ width: 1280, height: 900 });
  await theirs.getByRole('button', { name: 'Close the agent' }).click();

  // Their audit log, and its CSV export, say an invitation was cancelled, never whose.
  await editor.goto('/audit');
  await hydrated(editor);
  await expect(editor.getByRole('row', { name: /Invitation cancelled/ })).toBeVisible();
  await expect(editor.getByRole('table')).not.toContainText('kim.bayside');
  const download = editor.waitForEvent('download');
  await editor.getByRole('button', { name: 'Export CSV' }).click();
  const csv = readFileSync(await (await download).path(), 'utf8');
  expect(csv).toContain('cancel_invitation');
  expect(csv).not.toContain('kim.bayside');
});

test('⌘K asks the agent a sentence typed into it, by keyboard: Enter opens the drawer with it, ⌘Enter keeps the menu (#270)', async ({ page }) => {
  await signInAs(page, `e2e-ask-cmdk-${Date.now()}@example.com`, ADDRESS);
  await createOrg(page, 'Harbour Grocers', ADDRESS);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, capableModel: ANTHROPIC_STUB_MODELS[1] });
  await page.goto('/screens');
  await hydrated(page);

  // Empty, it suggests three questions for the page, then the drawer itself.
  await page.keyboard.press('ControlOrMeta+k');
  const menu = page.getByRole('dialog', { name: 'Command menu' });
  await expect(menu.getByRole('group', { name: 'Ask the agent' }).getByRole('option')).toHaveCount(4);
  await axe(page);

  // A sentence: the agent's row first, and Enter asks it.
  await page.keyboard.type('why are two screens behind');
  await expect(menu.getByRole('option').first()).toHaveText('Ask agent: why are two screens behind');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  const drawer = page.getByRole('dialog', { name: 'Agent' });
  await expect(drawer.getByText('why are two screens behind', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('article')).toContainText(STUB_CARD.text);
  await page.keyboard.press('Escape');

  // Two words still find the page first.
  await page.keyboard.press('ControlOrMeta+k');
  await menu.getByRole('combobox').fill('go screens');
  await expect(menu.getByRole('option').first()).not.toHaveText(/^Ask agent/);
  await expect(menu.getByRole('option', { name: 'Ask agent: go screens' })).toBeVisible();

  // ⌘Enter asks and keeps the menu.
  await menu.getByRole('combobox').fill('');
  await page.keyboard.type('which screens need me now');
  await expect(menu.getByRole('option').first()).toHaveText('Ask agent: which screens need me now');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(menu).toBeVisible();
  await expect(drawer.getByText('which screens need me now', { exact: true })).toBeVisible();
});

test("an editor where only owners publish asks for the takeover: the card names both of the tool's actions and who may, and runs nothing (#345)", async ({
  page,
  browser,
}) => {
  const owner = '192.0.2.195';
  await signInAs(page, `e2e-confirm-takeover-owner-${Date.now()}@example.com`, owner);
  await createOrg(page, 'Bayside Storm Rota', owner);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, capableModel: ANTHROPIC_STUB_MODELS[1] });
  await tool(page, 'save_playlist', { name: 'Storm closure', transition: { type: 'cut' } });
  await tool(page, 'update_org_settings', { editorsPublish: false });
  const editor = await (await browser.newContext()).newPage();
  await joinAsEditor(page, editor, `e2e-confirm-takeover-editor-${Date.now()}@example.com`, '192.0.2.196');

  await editor.goto('/schedule');
  await hydrated(editor);
  await editor.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' }).click();
  const drawer = editor.getByRole('dialog', { name: 'Agent' });
  await drawer.getByLabel('Ask about your screens and content').fill('Bayside closes at 2 for the storm: put the closure up everywhere');
  await drawer.getByRole('button', { name: 'Ask', exact: true }).click();
  const refused = drawer.getByRole('region', { name: 'Take over screens, or end a takeover' });
  await expect(refused).toContainText('Only owners publish in this organization');
  await expect(refused.getByRole('button', { name: 'Take over' })).toHaveCount(0);
  expect((await tool(editor, 'list_schedule_entries', {})).entries).toEqual([]);
  await axe(editor);
  await editor.setViewportSize({ width: 1440, height: 1000 });
  await shots(editor, '105-takeover-refused-card');
  await editor.setViewportSize({ width: 390, height: 844 });
  await shots(editor, '105-takeover-refused-card-phone');
});

test('an editor where only owners publish asks to remove a published schedule entry: the card says the removal needs the right to publish, and runs nothing (#523)', async ({
  page,
  browser,
}) => {
  const owner = '192.0.2.197';
  await signInAs(page, `e2e-confirm-remove-owner-${Date.now()}@example.com`, owner);
  await createOrg(page, 'Bayside Lunch Rota', owner);
  await tool(page, 'save_ai_provider', { provider: 'anthropic', apiKey: ANTHROPIC_STUB_KEY, capableModel: ANTHROPIC_STUB_MODELS[1] });
  const { playlist } = await tool(page, 'save_playlist', { name: 'Lunch', transition: { type: 'cut' } });
  const { entry } = await tool(page, 'save_schedule_entry', { playlistId: playlist.id, target: 'org' });
  await tool(page, 'publish', {});
  await tool(page, 'update_org_settings', { editorsPublish: false });
  const editor = await (await browser.newContext()).newPage();
  await joinAsEditor(page, editor, `e2e-confirm-remove-editor-${Date.now()}@example.com`, '192.0.2.198');

  await editor.goto('/schedule');
  await hydrated(editor);
  await editor.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Ask the agent' }).click();
  const drawer = editor.getByRole('dialog', { name: 'Agent' });
  await drawer.getByLabel('Ask about your screens and content').fill(`Remove the schedule entry ${entry.id}`);
  await drawer.getByRole('button', { name: 'Ask', exact: true }).click();
  const refused = drawer.getByRole('region', { name: 'Delete playlist, or remove schedule entry' });
  await expect(refused).toContainText('Only owners publish in this organization, and this change needs the right to publish: ask an owner.');
  await expect(refused.getByRole('button')).toHaveCount(0);
  expect((await tool(editor, 'list_schedule_entries', {})).entries).toMatchObject([{ id: entry.id, deleted: false }]);
  await axe(editor);
  await editor.setViewportSize({ width: 1440, height: 1000 });
  await shots(editor, '106-remove-entry-refused-card');
  await editor.setViewportSize({ width: 390, height: 844 });
  await shots(editor, '106-remove-entry-refused-card-phone');
});
