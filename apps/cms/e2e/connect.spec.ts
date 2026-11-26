// Connecting an agent (M4-05, #110): an MCP client stub registers and opens the authorize URL; the
// person signs in, picks an org and scopes on /connect, and Allow sends the stub a code it exchanges
// for tokens; Cancel sends `access_denied`. An editor while editors may not publish is not offered it.
// The first-party CLI shows as verified, and the pages are never framed. An unverified name the page
// may not show (not plain, or reading as SignForge's) is withheld: the page says an unverified app, at its host.
import { randomBytes } from 'node:crypto';
import { expect, request as playwrightRequest, test } from '@playwright/test';
import { base64url, callbackOf, challengeOf, RESOURCE, stubClient } from './agent-stub';
import { axe, createOrg, disabledOnServer, fromAddress, hydrated, joinAsEditor, shots, signIn, signInAs, tool } from './helpers';
import { CMS_URL } from './servers';

/** This spec's own client addresses, so its sign-ins have their own rate limits. */
const ADDRESS = {
  owner: '192.0.2.161',
  person: '192.0.2.162',
  editor: '192.0.2.163',
  stub: '192.0.2.164',
  cli: '192.0.2.165',
  namer: '192.0.2.166',
  names: '192.0.2.167',
};
test('an agent connects: sign in and back, pick an org and scopes, Allow gives the stub a code; Cancel gives access_denied', async ({ page, browser }) => {
  const email = `e2e-connect-${Date.now()}@example.com`;
  // The person, with two orgs: set up in their own browser first.
  const setup = await browser.newPage();
  await signInAs(setup, email, ADDRESS.person);
  await createOrg(setup, 'Quayside Market', ADDRESS.person);
  await createOrg(setup, 'Harbour Café', ADDRESS.person);
  await setup.close();

  const stub = await stubClient('Test agent', ADDRESS.stub);
  // Signed out: the provider sends the browser to /connect, which sends it through sign-in and back.
  await fromAddress(page, ADDRESS.person);
  await page.goto(stub.authorizeUrl);
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fconnect/);
  await signIn(page, email);
  // An unverified client's name is quoted, as its own claim, and the heading says it is unverified.
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('“Test agent” wants to work in SignForge Unverified');
  await hydrated(page);
  await expect(page).toHaveURL(/\/connect\?q=/);

  // The controls wait for the page to hydrate.
  const connectPath = new URL(page.url()).pathname + new URL(page.url()).search;
  expect(await disabledOnServer(page, connectPath, ['Allow', 'Cancel', 'Organisation'])).toEqual({ Allow: [true], Cancel: [true], Organisation: [true] });

  // Neither page on the way can be framed by another site (clickjacking Allow): this one, and sign-in signed out.
  const signedOut = await playwrightRequest.newContext({ baseURL: CMS_URL });
  for (const res of [await page.request.get(connectPath), await signedOut.get('/sign-in')]) {
    expect(res.status(), res.url()).toBe(200);
    expect(res.headers()['x-frame-options'], res.url()).toBe('DENY');
    expect(res.headers()['content-security-policy'], res.url()).toBe("frame-ancestors 'none'");
  }
  await signedOut.dispose();

  // What it says: the client is unverified, where it sends the person, and what reading shares.
  await expect(page.getByRole('heading', { level: 1 }).getByText('Unverified', { exact: true })).toBeVisible();
  await expect(page.getByText('Unverified: SignForge has not checked who made this app. It sends you back to 127.0.0.1:33418.')).toBeVisible();
  await expect(page.getByText('the team list with names and email addresses')).toBeVisible();
  await expect(page.getByText('The connection works in this organisation only.')).toBeVisible();
  const read = page.getByRole('checkbox', { name: /See your content and screens/ });
  await expect(read).toBeChecked();
  await expect(read).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /Make and edit drafts/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Publish to live screens/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Manage the organisation/ })).not.toBeChecked();
  // Hover shades only a choice not chosen: a checked one keeps its tint, and a disabled one gets no hover (#416).
  const card = (name: RegExp) => page.locator('label').filter({ has: page.getByRole('checkbox', { name }) });
  const background = (name: RegExp) => card(name).evaluate((e) => getComputedStyle(e).backgroundColor);
  const hovered = async (name: RegExp) => {
    const before = await background(name);
    await card(name).hover();
    const during = await background(name);
    await page.mouse.move(0, 0);
    return { before, during };
  };
  for (const kept of [/Make and edit drafts/, /See your content and screens/]) {
    const { before, during } = await hovered(kept);
    expect(during, String(kept)).toBe(before);
  }
  const unchosen = await hovered(/Publish to live screens/);
  expect(unchosen.during).not.toBe(unchosen.before);
  expect(unchosen.during).not.toBe(await background(/Make and edit drafts/));
  await axe(page);
  // Tall enough for the whole card, the buttons and the note under it.
  await page.setViewportSize({ width: 1440, height: 1150 });
  await shots(page, '30-connect-agent');

  // Publishing on: the warning names the org.
  await page.getByLabel('Organisation', { exact: true }).selectOption({ label: 'Quayside Market' });
  await page.getByRole('checkbox', { name: /Publish to live screens/ }).check();
  const publishing = page.getByRole('status').filter({ hasText: 'Publishing lets' });
  await expect(publishing).toContainText('Publishing lets “Test agent” change what every screen in Quayside Market shows without asking.');
  // A misled agent publishes too: the person granting it is told so (#122).
  await expect(publishing).toContainText('can mislead it into publishing what you did not mean');
  await shots(page, '30-connect-agent-publish');
  await page.setViewportSize({ width: 390, height: 844 });
  await shots(page, '30-connect-agent-phone');
  await page.getByRole('button', { name: 'Allow' }).scrollIntoViewIfNeeded();
  await shots(page, '30-connect-agent-phone-end');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('checkbox', { name: /Publish to live screens/ }).uncheck();
  await page.getByRole('checkbox', { name: /Manage screens/ }).check();

  // Allow: the stub gets a code at its callback, with its state, and exchanges it for what was chosen.
  const back = await callbackOf(page, () => page.getByRole('button', { name: 'Allow' }).click());
  expect(back.searchParams.get('state')).toBe('stub-state');
  const tokens = await stub.exchange(back.searchParams.get('code')!);
  expect(tokens.status).toBe(200);
  expect(tokens.body.scope?.split(' ').sort()).toEqual(['content:draft', 'content:read', 'offline_access', 'screens:manage']);

  // The token works on /mcp, on this host: the grant's tools only, and a write audited as the agent with its client.
  const accessToken = tokens.body.access_token!;
  const listed: string[] = (await stub.mcp(accessToken, 'tools/list')).result.tools.map((t: { name: string }) => t.name);
  expect(listed).toEqual(expect.arrayContaining(['read', 'describe', 'save_playlist', 'update_screen']));
  expect(listed).not.toContain('publish');
  const made = (await stub.mcp(accessToken, 'tools/call', { name: 'save_playlist', arguments: { name: 'Made by the stub agent' } })).result;
  expect(made.isError).toBeUndefined();
  const audit = await stub.mcp(accessToken, 'tools/call', { name: 'list_audit_log', arguments: { action: 'save_playlist', actor: { kind: 'agent' } } });
  const { entries } = audit.result.structuredContent;
  expect(entries).toEqual([
    expect.objectContaining({
      actor: expect.objectContaining({ kind: 'agent', clientId: stub.clientId }),
      target: { kind: 'playlist', id: made.structuredContent.playlist.id },
    }),
  ]);

  // Cancel, for another authorization: access_denied, and no code.
  const refused = await callbackOf(page, async () => {
    await page.goto(stub.authorizeUrl);
    await hydrated(page);
    await page.getByRole('button', { name: 'Cancel' }).click();
  });
  expect(refused.searchParams.get('error')).toBe('access_denied');
  expect(refused.searchParams.has('code')).toBe(false);
  await stub.dispose();
});

test('an editor in an org where only owners publish is not offered publishing', async ({ page, browser }) => {
  const stamp = Date.now();
  const ownerEmail = `e2e-connect-owner-${stamp}@example.com`;
  const editorEmail = `e2e-connect-editor-${stamp}@example.com`;
  const owner = await browser.newPage();
  await signInAs(owner, ownerEmail, ADDRESS.owner);
  await createOrg(owner, 'Owners Publish', ADDRESS.owner);
  await tool(owner, 'update_org_settings', { editorsPublish: false });
  await joinAsEditor(owner, page, editorEmail, ADDRESS.editor);
  const stub = await stubClient('Editor agent', ADDRESS.stub);
  await page.goto(stub.authorizeUrl);
  await expect(page.getByRole('heading', { name: '“Editor agent” wants to work in SignForge' })).toBeVisible();
  await hydrated(page);
  await expect(page.getByLabel('Organisation', { exact: true })).toHaveValue(/.+/);
  await expect(page.getByText('Signed in as')).toContainText('Editor');
  await expect(page.getByRole('checkbox', { name: /Make and edit drafts/ })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Publish to live screens/ })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /Manage the organisation/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await shots(page, '30-connect-agent-editor');
  await stub.dispose();
});

test('the SignForge CLI shows as verified, a client’s own `q` does not get in the way, and a bare /connect says what it is for', async ({ page }) => {
  await signInAs(page, `e2e-connect-cli-${Date.now()}@example.com`, ADDRESS.cli);
  await createOrg(page, 'Pier Kiosk', ADDRESS.cli);

  await page.goto('/connect');
  await expect(page.getByRole('heading', { name: 'This request can’t be used' })).toBeVisible();
  await expect(page.getByText('This page opens when an app asks to connect to SignForge.')).toBeVisible();

  // The CLI's loopback callback, on a port of its choosing, and a parameter of its own named as the page's is.
  await page.goto(
    `/api/auth/oauth2/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: 'sf-cli',
      redirect_uri: 'http://127.0.0.1:40123/callback',
      scope: 'content:read content:draft offline_access',
      state: 'cli-state',
      code_challenge: challengeOf(base64url(randomBytes(32))),
      code_challenge_method: 'S256',
      resource: RESOURCE,
      q: 'the client’s own',
    })}`,
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('SignForge CLI wants to work in SignForge');
  await expect(page.getByText('A SignForge app. It sends you back to 127.0.0.1:40123.')).toBeVisible();
  await expect(page.getByText('Unverified', { exact: true })).toHaveCount(0);
});

test('an unverified name that reads as SignForge is not on the page; a plain one is quoted; a long one wraps', async ({ page }) => {
  await signInAs(page, `e2e-connect-names-${Date.now()}@example.com`, ADDRESS.namer);
  await createOrg(page, 'Lantern Quay', ADDRESS.namer);
  /** The heading for a client the stub registers as `name` (five at most: registration's limit per address). */
  const headingFor = async (name: string) => {
    const stub = await stubClient(name, ADDRESS.names);
    await page.goto(stub.authorizeUrl);
    await stub.dispose();
    return page.getByRole('heading', { level: 1 });
  };

  // Names from the reviews of #299: digits read as letters, and boxed letters spelling SIGNFORGE.
  await expect(await headingFor('SI6NFOR6E')).toHaveAccessibleName('An unverified app at 127.0.0.1:33418 wants to work in SignForge Unverified');
  expect(await page.content()).not.toContain('SI6NFOR6E');
  await expect(await headingFor('🆂🅸🅶🅽🅵🅾🆁🅶🅴')).toHaveAccessibleName('An unverified app at 127.0.0.1:33418 wants to work in SignForge Unverified');
  await hydrated(page);
  await expect(page.getByRole('status').filter({ hasText: 'Without publishing' })).toContainText('Without publishing, changes by this app stay drafts');
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 1150 });
  await shots(page, '30-connect-agent-unnamed');

  // Claude Code with a server named after SignForge, and a name that only runs into "signforge", are shown.
  await expect(await headingFor('Claude Code (signforge)')).toHaveAccessibleName('“Claude Code (signforge)” wants to work in SignForge Unverified');
  await expect(await headingFor('Design Forge')).toHaveAccessibleName('“Design Forge” wants to work in SignForge Unverified');

  // A long name with no break wraps in the card rather than widen the page.
  await page.setViewportSize({ width: 390, height: 844 });
  const long = 'W'.repeat(80);
  await expect(await headingFor(long)).toHaveAccessibleName(`“${long}” wants to work in SignForge Unverified`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
