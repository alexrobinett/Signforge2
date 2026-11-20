import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { axe, createOrg, disabledOnServer, holdFirst, hydrated, orgSwitcher, shots, signInAs, tool } from './helpers';
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

/** Holds every request to the app's server functions (the loaders' reads) from now until `release`. */
async function holdReads(page: Page) {
  const held: Route[] = [];
  let waiting = { n: Number.POSITIVE_INFINITY, done: () => {} };
  const hold = (route: Route) => {
    held.push(route);
    if (held.length >= waiting.n) waiting.done();
  };
  await page.route('**/_serverFn/**', hold);
  /** Resolves once `n` reads are held. */
  const holding = (n: number) =>
    new Promise<void>((done) => {
      waiting = { n, done };
      if (held.length >= n) done();
    });
  /** Lets them go; resolves once each has its whole answer and the page has drawn two frames since. */
  const release = async () => {
    await page.unroute('**/_serverFn/**', hold);
    for (const route of held) await route.fulfill({ response: await route.fetch() });
    await page.evaluate(() => new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn))));
  };
  return { holding, release };
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
  await createOrg(page, 'Northside Market');

  // General: from the sidebar, /settings opens General.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await hydrated(page);
  await expect(settingsNav(page).getByText('Brand kits')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Northside Market Co');
  await page.getByLabel('Time zone').selectOption('Europe/London');
  await page.getByLabel('Locale').selectOption('en-GB');
  await page.getByText('Set hours').click();
  await expect(page.getByLabel('Keep entries for')).toHaveValue('365');
  await page.getByLabel('Keep entries for').fill('90');
  await axe(page);
  await shots(page, '40-settings-general');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Northside Market Co');
  await expect(page.getByLabel('Time zone')).toHaveValue('Europe/London');
  await expect(page.getByLabel('Locale')).toHaveValue('en-GB');
  await expect(page.getByLabel('Keep entries for')).toHaveValue('90');

  // Screens & groups: the offline alert waits 30 minutes.
  // After a reload, a click before hydration is lost: the router never sees it (CI, 2026-11-19).
  await hydrated(page);
  await settingsNav(page).getByRole('link', { name: 'Screens & groups' }).click();
  // The body is hydrated already from the page before, so wait for the navigation itself.
  await expect(page).toHaveURL(/\/settings\/screens$/);
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
  await expect(page).toHaveURL(/\/settings\/notifications$/);
  await expect(page.getByText('After 30 minutes; one alert each way')).toBeVisible();
  // Slack and the webhook can be chosen once they are set.
  await expect(page.getByLabel('Slack for: A screen goes offline, and when it is back')).toBeDisabled();
  await page.getByLabel('Who hears: A screen goes offline, and when it is back').selectOption('everyone');
  await page.getByLabel('Email for: An agent is refused').uncheck();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Who hears: A screen goes offline, and when it is back')).toHaveValue('everyone');
  await expect(page.getByLabel('Email for: An agent is refused')).not.toBeChecked();

  // Slack, by an incoming-webhook URL, which is never shown again.
  await hydrated(page);
  const slackUrl = 'https://hooks.slack.com/services/T0E2E0000/B0E2E0000/e2eSecretPart000000000';
  await page.getByLabel('Slack incoming-webhook URL').fill(slackUrl);
  await page.getByRole('button', { name: 'Connect Slack' }).click();
  await expect(page.getByText('Slack connected')).toBeVisible();
  await expect(page.getByText(/Connected by/).first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('e2eSecretPart');

  // A webhook: its signing secret is shown once, then gone.
  await page.getByLabel('Webhook URL', { exact: true }).fill('https://ops.example.com/hooks/signforge');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  const secretBox = page.getByRole('region', { name: "The webhook's signing secret" });
  await expect(secretBox).toContainText(/whsec_[A-Za-z0-9_-]{43}/);
  const secret = (await secretBox.locator('code').textContent()) ?? '';
  await axe(page);
  await shots(page, '42-settings-notifications');
  await secretBox.getByRole('button', { name: 'I have saved it' }).click();
  await expect(secretBox).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('ops.example.com')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secret);

  // A new URL, kept and not shown: the field is empty once it is saved.
  await hydrated(page);
  await page.getByText('Manage').nth(1).click();
  const webhookField = page.getByLabel('Webhook URL', { exact: true });
  await webhookField.fill('https://ops2.example.com/hooks/signforge');
  await page.getByRole('button', { name: 'Save URL' }).click();
  await expect(page.getByText('ops2.example.com')).toBeVisible();
  await expect(webhookField).toHaveValue('');

  // Offline alerts go to both; a test email shows in the log.
  await hydrated(page);
  await page.getByLabel('Slack for: A screen goes offline, and when it is back').check();
  await page.getByLabel('Webhook for: A screen goes offline, and when it is back').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.getByRole('button', { name: 'Email me a test' }).click();
  await expect(page.getByText('Test sent.')).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('list', { name: 'Recent deliveries' })).toContainText('Delivered', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.getByLabel('Slack for: A screen goes offline, and when it is back')).toBeChecked();
  await expect(page.getByLabel('Webhook for: A screen goes offline, and when it is back')).toBeChecked();
  await toTop(page.getByRole('region', { name: 'Recent deliveries' }));
  await axe(page);
  await shots(page, '42b-settings-notifications-log');

  // Removing Slack asks once more, then it is unset and its rule's box is disabled.
  await hydrated(page);
  await page.getByText('Manage').first().click();
  await page.getByRole('button', { name: 'Remove Slack' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Slack removed')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Slack' })).toBeVisible();
  await expect(page.getByLabel('Slack for: A screen goes offline, and when it is back')).toBeDisabled();

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
  await expect(invitee.getByLabel('Keep entries for')).toBeDisabled();
  await expect(invitee.getByLabel('Keep entries for')).toHaveValue('90');
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
  // Choosing what every screen plays goes with publishing (M3-18): no Publish and no Play on every screen.
  const made = await invitee.request.post('/api/tools/create_playlist', { data: { name: 'Editor loop' } });
  const { playlist } = await made.json();
  expect((await invitee.request.post('/api/tools/set_default_playlist', { data: { playlistId: playlist.id } })).status()).toBe(403);
  await invitee.goto(`/playlists/${playlist.id}`);
  await hydrated(invitee);
  await expect(invitee.getByRole('heading', { name: 'Editor loop', level: 1 })).toBeVisible();
  await expect(invitee.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
  await expect(invitee.getByRole('button', { name: 'Play on every screen' })).toHaveCount(0);
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
  await toTop(page.getByRole('region', { name: 'Who hears about what' }));
  await shots(page, '47b-settings-notifications-rules-phone');
  await toTop(page.getByRole('region', { name: 'Recent deliveries' }));
  await shots(page, '47c-settings-notifications-log-phone');
});

test('a role select or an invitation button keeps keyboard focus while its change runs, and a second change meanwhile is ignored (#126)', async ({
  page,
  browser,
}) => {
  // A control disabled while its own action ran lost focus to the page (Chromium moves it to body),
  // so the next Tab started from the top. Each answer is held until the test lets it go.
  test.setTimeout(120_000);
  const stamp = Date.now();
  const editorEmail = `e2e-settings-focus-editor-${stamp}@example.com`;
  const waitingEmail = `e2e-settings-focus-waiting-${stamp}@example.com`;
  await signInAs(page, `e2e-settings-focus-owner-${stamp}@example.com`, '192.0.2.37');
  await createOrg(page, 'Northside Market');
  await page.goto('/settings/members');
  await hydrated(page);
  await page.getByLabel('Emails, separated by commas').fill(`${editorEmail}, ${waitingEmail}`);
  await page.getByRole('button', { name: 'Send invites' }).click();
  await expect(page.getByText('2 invites sent')).toBeVisible();
  const invitee = await browser.newContext();
  const joining = await invitee.newPage();
  await signInAs(joining, editorEmail, '192.0.2.38');
  await joining.goto(await invitePathFor(editorEmail));
  await hydrated(joining);
  await joining.getByRole('button', { name: 'Accept' }).click();
  await expect(joining).toHaveURL(/\/$/);
  await invitee.close();

  // The role, by keyboard: Editor to Viewer. The select shows where it is going until the page has
  // read the members again; a change meanwhile (o, to Owner) is ignored, while the write runs and
  // while the page reads (review of #143, 1).
  await page.reload();
  await hydrated(page);
  const role = page.getByRole('region', { name: 'People' }).getByLabel(new RegExp(`Role for ${editorEmail.split('@')[0]}`));
  // Enabled once its part of the page has hydrated (#136), after body[data-hydrated].
  await expect(role).toBeEnabled();
  await expect(role).toHaveValue('editor');
  // Every choice the select fires, so the test knows each second one was really made: Chromium's
  // type-ahead joins letters pressed close together, and "vo" chooses nothing (re-check of #143, 5).
  await role.evaluate((select: HTMLSelectElement) => {
    select.dataset.chosen = '';
    select.addEventListener('change', () => {
      select.dataset.chosen += ` ${select.value}`;
    });
  });
  const chosen = async () => (await role.getAttribute('data-chosen'))?.trim().split(' ');
  /** Owner, by keyboard, after Tab away and back, which starts the type-ahead again. */
  const chooseOwner = async () => {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(role).toBeFocused();
    await page.keyboard.press('o');
  };
  const roleChange = await holdFirst(page, '/api/auth/organization/update-member-role');
  await role.focus();
  await expect(role).toBeFocused();
  await page.keyboard.press('v');
  const roleAnswer = await roleChange.arrived;
  await expect(role).toBeFocused();
  await expect(role).toHaveAttribute('aria-disabled', 'true');
  await expect(role).toHaveValue('viewer');
  await chooseOwner();
  expect(await chosen()).toEqual(['viewer', 'owner']);
  await expect(role).toHaveValue('viewer');
  const reads = await holdReads(page);
  await roleAnswer.continue();
  await reads.holding(1);
  await expect(page.getByText('Role changed')).toBeVisible();
  await expect(role).toHaveAttribute('aria-disabled', 'true');
  await expect(role).toHaveValue('viewer');
  await chooseOwner();
  expect(await chosen()).toEqual(['viewer', 'owner', 'owner']);
  await expect(role).toHaveValue('viewer');
  await reads.release();
  await expect(role).not.toHaveAttribute('aria-disabled');
  await expect(role).toBeFocused();
  await expect(role).toHaveValue('viewer');
  expect(roleChange.calls()).toBe(1);

  // Resend, by keyboard: a second Enter while it runs sends nothing more.
  const waiting = page.getByRole('region', { name: 'Waiting for a reply' }).getByRole('listitem').filter({ hasText: waitingEmail });
  const resend = waiting.getByRole('button', { name: 'Resend' });
  const resending = await holdFirst(page, '/api/auth/organization/invite-member');
  await resend.focus();
  await page.keyboard.press('Enter');
  const resendAnswer = await resending.arrived;
  await expect(resend).toBeFocused();
  await expect(resend).toHaveAttribute('aria-disabled', 'true');
  await expect(waiting.getByRole('button', { name: 'Revoke' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await resendAnswer.continue();
  await expect(page.getByText('Invite sent again')).toBeVisible();
  await expect(resend).not.toHaveAttribute('aria-disabled');
  await expect(resend).toBeFocused();
  expect(resending.calls()).toBe(1);

  await page.reload();
  await hydrated(page);
  await expect(role).toHaveValue('viewer');
  await expect(waiting).toBeVisible();

  // Removing them, its answer held: the dialog says it is waiting, and Escape closes it, focus back
  // on the page, the removal going on and the row saying so (re-check of #143, 3).
  const row = page.getByRole('region', { name: 'People' }).getByRole('listitem').filter({ hasText: editorEmail });
  await row.getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('alertdialog');
  const removal = await holdFirst(page, '/api/auth/organization/remove-member');
  await dialog.getByRole('button', { name: 'Remove' }).click();
  const removeAnswer = await removal.arrived;
  await expect(dialog.getByRole('status')).toHaveText('Removing… Waiting for SignForge to answer. You can close this; it goes on.');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('button', { name: 'Removing…' })).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.closest('[role="alertdialog"]') ?? null)).toBeNull();
  await removeAnswer.continue();
  await expect(page.getByText('Removed', { exact: true })).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("an edit typed while its save runs is kept: the next addresses to invite, and General's retention (review of #143, 4)", async ({ page }) => {
  // The invite form cleared itself once sent, and General remounted on the version its save made:
  // either wiped what was typed while the save ran.
  const stamp = Date.now();
  await signInAs(page, `e2e-settings-kept-${stamp}@example.com`, '192.0.2.39');
  await createOrg(page, 'Northside Market');
  await page.goto('/settings/members');
  await hydrated(page);
  const emails = page.getByLabel('Emails, separated by commas');
  await expect(emails).toBeEnabled();
  const first = `e2e-kept-first-${stamp}@example.com`;
  const next = `e2e-kept-next-${stamp}@example.com`;
  await emails.fill(first);
  const inviting = await holdFirst(page, '/api/auth/organization/invite-member');
  await emails.press('Enter');
  const inviteAnswer = await inviting.arrived;
  await emails.fill(next);
  await emails.press('Enter');
  await inviteAnswer.continue();
  await expect(page.getByText('Invite sent')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send invites' })).not.toHaveAttribute('aria-disabled');
  await expect(emails).toHaveValue(next);
  expect(inviting.calls()).toBe(1);
  const waiting = page.getByRole('region', { name: 'Waiting for a reply' });
  await expect(waiting).toContainText(first);
  await expect(waiting).not.toContainText(next);

  await page.goto('/settings/general');
  await hydrated(page);
  const retention = page.getByLabel('Keep entries for');
  const timezone = page.getByLabel('Time zone');
  await expect(retention).toBeEnabled();
  await retention.fill('100');
  const saving = await holdFirst(page, '/api/tools/update_org_settings');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const saveAnswer = await saving.arrived;
  await retention.fill('120');
  // Someone else sets the time zone once this save is written, before the page reads again.
  const reads = await holdReads(page);
  await saveAnswer.continue();
  await reads.holding(1);
  await tool(page, 'update_org_settings', { timezone: 'Europe/London' });
  await reads.release();
  // The page has drawn its reload when the time zone, untouched here, shows the other change
  // (re-check of #143, 6); the retention typed meanwhile is kept.
  await expect(timezone).toHaveValue('Europe/London');
  await expect(retention).toHaveValue('120');
  await expect(page.getByRole('button', { name: 'Save changes' })).not.toHaveAttribute('aria-disabled');

  // Saved again, it sends only the retention, on the version this page saved: the time zone set
  // since makes it a conflict, shown, never an overwrite of it (re-check of #143, 1).
  const sent = page.waitForRequest('**/api/tools/update_org_settings');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect(Object.keys((await sent).postDataJSON()).sort()).toEqual(['auditRetentionDays', 'ifVersion']);
  await expect(page.getByRole('alert').filter({ hasText: 'This changed since you opened it.' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(retention).toHaveValue('100');
  await expect(timezone).toHaveValue('Europe/London');
  await page.reload();
  await hydrated(page);
  await expect(timezone).toHaveValue('Europe/London');
  await expect(retention).toHaveValue('100');
});

test('edits belong to the org they were made in: after a switch, a late answer for the old org changes nothing in the new one (re-check of #143, 2)', async ({
  page,
}) => {
  // Display hours edited while a General save ran in one org followed a switch, and the next org
  // saved them as its own.
  test.setTimeout(90_000);
  await signInAs(page, `e2e-settings-orgs-${Date.now()}@example.com`, '192.0.2.47');
  await createOrg(page, 'Alpha Market');
  const switcher = orgSwitcher(page);
  await switcher.click();
  await page.getByRole('menuitem', { name: 'Create organization' }).click();
  const create = page.getByRole('dialog', { name: 'Create organization' });
  await create.getByLabel('Organization name').fill('Beta Market');
  await create.getByRole('button', { name: 'Create organization' }).click();
  await expect(switcher).toContainText('Beta Market');
  const switchTo = async (name: string) => {
    await switcher.click();
    await page.getByRole('menuitemradio', { name }).click();
    await expect(switcher).toContainText(name);
  };
  await switchTo('Alpha Market');

  await page.goto('/settings/general');
  await hydrated(page);
  const retention = page.getByLabel('Keep entries for');
  await expect(retention).toBeEnabled();
  await retention.fill('100');
  // Alpha's save is written; its answer is held on its way back.
  const saving = await holdFirst(page, '/api/tools/update_org_settings');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const saveAnswer = await saving.arrived;
  const written = await saveAnswer.fetch();
  await page.getByText('Set hours', { exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Set hours' })).toBeChecked();

  await switchTo('Beta Market');
  await saveAnswer.fulfill({ response: written });
  await expect(page.getByRole('radio', { name: 'Always on' })).toBeChecked();
  await expect(retention).toHaveValue('365');
  await retention.fill('200');
  const sent = page.waitForRequest('**/api/tools/update_org_settings');
  await page.getByRole('button', { name: 'Save changes' }).click();
  expect(Object.keys((await sent).postDataJSON()).sort()).toEqual(['auditRetentionDays', 'ifVersion']);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.reload();
  await hydrated(page);
  await expect(retention).toHaveValue('200');
  await expect(page.getByRole('radio', { name: 'Always on' })).toBeChecked();
  await switchTo('Alpha Market');
  await expect(retention).toHaveValue('100');
  await expect(page.getByRole('radio', { name: 'Always on' })).toBeChecked();
});

test('Keep it waits for a webhook removal that has been sent, and says so (review of #143, 5)', async ({ page }) => {
  // Keep it closed the confirmation while the removal it could no longer stop went on.
  await signInAs(page, `e2e-settings-keep-${Date.now()}@example.com`, '192.0.2.40');
  await createOrg(page, 'Northside Market');
  await page.goto('/settings/notifications');
  await hydrated(page);
  await expect(page.getByLabel('Webhook URL', { exact: true })).toBeEnabled();
  await page.getByLabel('Webhook URL', { exact: true }).fill('https://example.com/hooks/e2e-keep-it');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await expect(page.getByText('Webhook saved')).toBeVisible();
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await page.getByRole('listitem').filter({ hasText: 'example.com' }).getByText('Manage').click();
  await page.getByRole('button', { name: 'Remove Webhook' }).click();
  const asking = page.getByText('Stop sending alerts to Webhook?');
  await expect(asking).toBeVisible();

  const removing = await holdFirst(page, '/api/tools/remove_alert_channel');
  await page.getByRole('button', { name: 'Remove', exact: true }).focus();
  await page.keyboard.press('Enter');
  const removeAnswer = await removing.arrived;
  const keep = page.getByRole('button', { name: 'Keep it' });
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await expect(keep).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(asking).toBeVisible();
  await expect(page.getByRole('button', { name: 'Removing…' })).toBeVisible();

  // It holds up only its own page: General still saves (re-check of #143, 3).
  await settingsNav(page).getByRole('link', { name: 'General' }).click();
  const retention = page.getByLabel('Keep entries for');
  await expect(retention).toBeEnabled();
  await retention.fill('95');
  const sent = page.waitForRequest('**/api/tools/update_org_settings');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await sent;
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await removeAnswer.continue();
  await expect(page.getByText('Webhook removed')).toBeVisible();
  await settingsNav(page).getByRole('link', { name: 'Notifications' }).click();
  await expect(page.getByRole('button', { name: 'Add webhook' })).toBeVisible();
});

test("a refused sign-out of another session says why, on that session's row (review of #143, 6)", async ({ page, browser }) => {
  const email = `e2e-settings-sessions-${Date.now()}@example.com`;
  await signInAs(page, email, '192.0.2.45');
  await createOrg(page, 'Northside Market');
  const elsewhere = await browser.newContext();
  await signInAs(await elsewhere.newPage(), email, '192.0.2.46');
  await page.goto('/account');
  await hydrated(page);
  const other = page
    .getByRole('region', { name: "Where you're signed in" })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Sign out' }) });
  await expect(other).toHaveCount(1);
  await page.route('**/api/auth/revoke-session', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'FORBIDDEN', message: 'That session cannot be signed out from here.' }),
    }),
  );
  await other.getByRole('button', { name: 'Sign out' }).click();
  await expect(other.getByRole('alert')).toHaveText('That session cannot be signed out from here.');
  await expect(other.getByRole('button', { name: 'Sign out' })).not.toHaveAttribute('aria-disabled');
  await elsewhere.close();
});

test("settings fields that save or show at once, or hold a URL or an email, are disabled in the server's HTML, until the page has hydrated (#136)", async ({
  page,
}) => {
  // A page hydrates after the app (body[data-hydrated]): a controlled field changed in between was
  // set back by React, the change lost (a member's role saved again as it was); a form submitted
  // in between was the browser's own submit.
  const email = `e2e-settings-server-${Date.now()}@example.com`;
  await signInAs(page, email, '192.0.2.35');
  await createOrg(page, 'Northside Market');
  const pages: [path: string, names: string[]][] = [
    ['/settings/general', ['Name', 'Always on', 'Set hours', 'Save changes']],
    ['/settings/screens', ['From', 'Alert after', 'Save changes']],
    ['/settings/members', ['Emails, separated by commas', 'Send invites', `Role for ${email}`, 'Save']],
    [
      '/settings/notifications',
      ['Slack incoming-webhook URL', 'Connect Slack', 'Webhook URL', 'Add webhook', 'Email for: A screen goes offline, and when it is back'],
    ],
    ['/account', ['Name', 'Save', 'Light', 'Dark', 'System']],
  ];
  for (const [path, names] of pages) {
    expect(await disabledOnServer(page, path, names), path).toEqual(Object.fromEntries(names.map((n) => [n, [true]])));
  }
  // Rendered by the server, they are enabled once the page has hydrated.
  await page.goto('/settings/general');
  await hydrated(page);
  await expect(page.getByRole('radio', { name: 'Set hours' })).toBeEnabled();
  await page.goto('/settings/members');
  await hydrated(page);
  await expect(page.getByRole('combobox', { name: `Role for ${email}` })).toBeEnabled();
  await expect(page.getByLabel('Emails, separated by commas')).toBeEnabled();
  await page.goto('/settings/notifications');
  await hydrated(page);
  await expect(page.getByLabel('Webhook URL', { exact: true })).toBeEnabled();
  await page.goto('/account');
  await hydrated(page);
  await expect(page.getByRole('radio', { name: 'Dark' })).toBeEnabled();
});

test('a form that holds a URL or an email, submitted before the page has hydrated, posts: the page comes back with none of it in its URL', async ({
  page,
  browser,
}) => {
  // As a GET, the browser's own submit put a Slack or webhook URL, or invitees' emails, in the
  // page's URL: the address bar, history, a Referer and the Worker's request logs (#139's review).
  await signInAs(page, `e2e-settings-post-${Date.now()}@example.com`, '192.0.2.36');
  await createOrg(page, 'Northside Market');
  // Without script the page stays as the server sent it, as before hydration. Its fieldsets' gate
  // is taken off, so the form submits as one would that the gate did not hold.
  const context = await browser.newContext({ javaScriptEnabled: false });
  await context.addCookies(await page.context().cookies());
  const early = await context.newPage();
  await early.route(/\/settings\/(notifications|members)$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replaceAll('<fieldset disabled=""', '<fieldset') });
  });
  const forms = [
    { path: '/settings/notifications', field: 'Webhook URL', button: 'Add webhook', value: 'https://example.com/hooks/tok_SECRET136' },
    { path: '/settings/members', field: 'Emails, separated by commas', button: 'Send invites', value: 'sam-secret136@example.com' },
  ];
  for (const { path, field, button, value } of forms) {
    await early.goto(path);
    await early.getByLabel(field, { exact: true }).fill(value);
    const sent = early.waitForRequest((r) => r.isNavigationRequest());
    await early.getByRole('button', { name: button }).click();
    const request = await sent;
    // Sent in the body, and answered with the page again, by GET.
    expect(request.method(), path).toBe('POST');
    expect(request.postData(), path).toContain(encodeURIComponent(value));
    const answer = await request.response();
    expect(answer?.status(), path).toBe(303);
    expect(answer?.headers().location, path).toBe(path);
    await expect(early.getByLabel(field, { exact: true })).toHaveValue('');
    expect(new URL(early.url()).pathname + new URL(early.url()).search, path).toBe(path);
  }
  await context.close();
  // Account and sign-in post too; their answer echoes nothing.
  for (const path of ['/account', '/sign-in?redirect=%2Fscreens']) {
    const res = await page.request.post(path, { form: { name: 'Sam', email: 'sam@example.com', code: '123456' }, maxRedirects: 0 });
    expect(res.status(), path).toBe(303);
    expect(res.headers().location, path).toBe(path);
    expect(await res.text(), path).toBe('');
  }
});
