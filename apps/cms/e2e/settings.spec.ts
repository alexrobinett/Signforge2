import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { axe, fillUntilEnabled, hydrated, shots, signInAs } from './helpers';
import { API_LOG } from './servers';

/** This spec's own client addresses, so its sign-ins have their own rate limits. */
const OWNER_ADDRESS = '192.0.2.31';
const INVITEE_ADDRESS = '192.0.2.32';

/** The invitation link in the newest invite email the dev API printed for `email`. */
async function invitePathFor(email: string): Promise<string> {
  const pattern = new RegExp(`\\[email\\] to ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Join [^\\n]*\\n[\\s\\S]*?(/accept-invitation/[a-z0-9_]+)`, 'g');
  let path: string | undefined;
  await expect(async () => {
    path = [...readFileSync(API_LOG, 'utf8').matchAll(pattern)].at(-1)?.[1];
    expect(path).toBeTruthy();
  }).toPass({ timeout: 10_000 });
  return path!;
}

const settingsNav = (page: Page) => page.getByRole('navigation', { name: 'Settings' });
/** Scroll so `section` starts at the top of the viewport, for a screenshot of it. */
const toTop = (section: Locator) => section.evaluate((el) => el.scrollIntoView({ block: 'start' }));

test('an owner sets defaults, alerts and members; an invited editor joins and can only read them', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const ownerEmail = `e2e-settings-owner-${stamp}@example.com`;
  const editorEmail = `e2e-settings-editor-${stamp}@example.com`;

  await signInAs(page, ownerEmail, OWNER_ADDRESS);
  await page.goto('/');
  await fillUntilEnabled(page, 'Organization name', 'Northside Market', 'Create organization');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to SignForge' })).toHaveCount(0);

  // General: from the sidebar, /settings opens General.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await hydrated(page);
  await expect(settingsNav(page).getByText('Brand kits')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Northside Market Co');
  await page.getByLabel('Time zone').selectOption('Europe/London');
  await page.getByLabel('Locale').selectOption('en-GB');
  await page.getByText('Set hours').click();
  await axe(page);
  await shots(page, '40-settings-general');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Northside Market Co');
  await expect(page.getByLabel('Time zone')).toHaveValue('Europe/London');
  await expect(page.getByLabel('Locale')).toHaveValue('en-GB');

  // Screens & groups: the offline alert waits 30 minutes.
  await settingsNav(page).getByRole('link', { name: 'Screens & groups' }).click();
  await hydrated(page);
  await page.getByLabel('Alert after').fill('30');
  await page.getByLabel('From').fill('03:00');
  await axe(page);
  await shots(page, '41-settings-screens');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Alert after')).toHaveValue('30');
  await expect(page.getByLabel('From')).toHaveValue('03:00');

  // An agent changes the threshold while the page is open; the person's save is refused, not
  // written over it, and a reload shows the agent's value. The page's own session stands in for it.
  await hydrated(page);
  const agent = await page.request.post('/api/tools/update_org_settings', { data: { unreachableAfterMinutes: 45 } });
  expect(agent.status(), await agent.text()).toBe(200);
  await page.getByLabel('Alert after').fill('20');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('This changed since you opened it.')).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByLabel('Alert after')).toHaveValue('45');
  await page.getByLabel('Alert after').fill('30');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // Notifications: everyone hears when a screen goes offline.
  await settingsNav(page).getByRole('link', { name: 'Notifications' }).click();
  await hydrated(page);
  await expect(page.getByText('After 30 minutes; one email each way')).toBeVisible();
  await page.getByLabel('Who hears: A screen goes offline, and when it is back').selectOption('everyone');
  await page.getByLabel('Email for: An agent is refused').uncheck();
  await axe(page);
  await shots(page, '42-settings-notifications');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Who hears: A screen goes offline, and when it is back')).toHaveValue('everyone');
  await expect(page.getByLabel('Email for: An agent is refused')).not.toBeChecked();

  // A new screen starts in the org's time zone (the empty fleet shows the pairing form).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Screens' }).click();
  await expect(page.getByLabel('Time zone')).toHaveValue('Europe/London');

  // Members: invite an editor.
  await page.goto('/settings/members');
  await hydrated(page);
  await page.getByLabel('Emails, separated by commas').fill(editorEmail);
  await page.getByLabel('Role', { exact: true }).selectOption('editor');
  await page.getByRole('button', { name: 'Send invites' }).click();
  await expect(page.getByText('Invite sent')).toBeVisible();
  const waiting = page.getByRole('region', { name: 'Waiting for a reply' });
  await expect(waiting).toContainText(editorEmail);
  await axe(page);
  await shots(page, '43-settings-members');

  // The invitee follows the link, signs in, and joins as an editor.
  const invitee = await (await browser.newContext()).newPage();
  await signInAs(invitee, editorEmail, INVITEE_ADDRESS);
  await invitee.goto(await invitePathFor(editorEmail));
  await expect(invitee.getByRole('heading', { name: 'Join Northside Market Co' })).toBeVisible();
  await hydrated(invitee);
  await axe(invitee);
  await shots(invitee, '44-accept-invitation');
  await invitee.getByRole('button', { name: 'Accept' }).click();
  await expect(invitee).toHaveURL(/\/$/);

  // An editor reads the settings but cannot change them, or anyone's role.
  await invitee.goto('/settings/general');
  await expect(invitee.getByLabel('Name', { exact: true })).toBeDisabled();
  await expect(invitee.getByText('Only owners can change these.')).toBeVisible();
  await expect(invitee.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
  await invitee.goto('/settings/members');
  await expect(invitee.getByRole('heading', { name: 'Members & roles' })).toBeVisible();
  await expect(invitee.getByRole('region', { name: 'People' })).toContainText(editorEmail);
  await expect(invitee.getByRole('region', { name: 'Invite' })).toHaveCount(0);
  await expect(invitee.getByRole('combobox')).toHaveCount(0);
  await expect(invitee.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(invitee.getByLabel('Editors can publish')).toBeDisabled();
  await toTop(invitee.getByRole('region', { name: 'Who publishes' }));
  await axe(invitee);
  await shots(invitee, '49-settings-who-publishes-editor');

  // Who publishes (Q7): the owner stops editors publishing, and the editor's publish control goes.
  const publishOption = async (count: number) => {
    await invitee.reload();
    await hydrated(invitee);
    await invitee.keyboard.press('ControlOrMeta+k');
    const menu = invitee.getByRole('dialog', { name: 'Command menu' });
    await expect(menu.getByRole('option', { name: /rename_screen/ })).toHaveCount(1);
    await expect(menu.getByRole('option', { name: /publish_manifest_to_screen/ })).toHaveCount(count);
    await invitee.keyboard.press('Escape');
  };
  await publishOption(1);
  await page.reload();
  await hydrated(page);
  await page.getByLabel('Editors can publish').uncheck();
  await page.getByRole('region', { name: 'Who publishes' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(
    page
      .getByRole('row', { name: /Publish to screens/ })
      .getByRole('cell')
      .nth(1)
      .getByLabel('No'),
  ).toBeVisible();
  await toTop(page.getByRole('region', { name: 'Who publishes' }));
  await axe(page);
  await shots(page, '48-settings-who-publishes');
  await publishOption(0);
  const refused = await invitee.request.post('/api/tools/publish_manifest_to_screen', { data: { screenId: 'scr_none', manifestId: 'f'.repeat(64) } });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ error: 'forbidden', message: 'Only owners publish in this organization' });
  await page.reload();
  await hydrated(page);
  await page.getByLabel('Editors can publish').check();
  await page.getByRole('region', { name: 'Who publishes' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await publishOption(1);

  // The owner makes them a viewer, then removes them.
  await page.reload();
  await hydrated(page);
  const people = page.getByRole('region', { name: 'People' });
  await people.getByLabel(new RegExp(`Role for ${editorEmail.split('@')[0]}`)).selectOption('viewer');
  await expect(page.getByText('Role changed')).toBeVisible();
  await people.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Removed')).toBeVisible();
  await expect(people).not.toContainText(editorEmail);
  await invitee.close();

  // Your account: name and theme.
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Your account' }).click();
  await hydrated(page);
  await page.getByLabel('Name', { exact: true }).fill('Maria Okafor');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(page.getByText('This browser')).toBeVisible();
  await page.getByText('Dark', { exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByText('Light', { exact: true }).click();
  await axe(page);
  await shots(page, '45-account');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings/members');
  await hydrated(page);
  await axe(page);
  await shots(page, '46-settings-members-phone');
  await toTop(page.getByRole('region', { name: 'Who publishes' }));
  await axe(page);
  await shots(page, '50-settings-who-publishes-phone');
  await page.goto('/settings/notifications');
  await axe(page);
  await shots(page, '47-settings-notifications-phone');
});
