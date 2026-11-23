// Connecting an agent (M4-05, #110): an MCP client stub registers and opens the authorize URL; the
// person signs in, picks an org and scopes on /connect, and Allow sends the stub a code it exchanges
// for tokens; Cancel sends `access_denied`. An editor while editors may not publish is not offered it.
// The first-party CLI shows as verified, and the pages are never framed.
import { createHash, randomBytes } from 'node:crypto';
import { expect, request as playwrightRequest, test, type Page } from '@playwright/test';
import { axe, createOrg, disabledOnServer, fromAddress, hydrated, shots, signIn, signInAs, tool } from './helpers';
import { CMS_URL } from './servers';

/** This spec's own client addresses, so its sign-ins have their own rate limits. */
const ADDRESS = { owner: '192.0.2.161', person: '192.0.2.162', editor: '192.0.2.163', stub: '192.0.2.164', cli: '192.0.2.165' };
/** The stub's loopback callback, as a native MCP client registers one. */
const CALLBACK = 'http://127.0.0.1:33418/callback';
const RESOURCE = `${CMS_URL}/mcp`;
const ALL_SCOPES = 'content:read content:draft content:publish screens:manage org:manage offline_access';

const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const challengeOf = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());

/** An MCP client stub: registers by open registration, and builds an authorize URL with S256 PKCE. */
async function stubClient(name = 'Test agent') {
  const request = await playwrightRequest.newContext({ extraHTTPHeaders: { 'cf-connecting-ip': ADDRESS.stub } });
  const registered = await request.post(`${CMS_URL}/api/auth/oauth2/register`, {
    data: {
      client_name: name,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(registered.status(), await registered.text()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = base64url(randomBytes(32));
  const authorizeUrl = `${CMS_URL}/api/auth/oauth2/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: ALL_SCOPES,
    state: 'stub-state',
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    resource: RESOURCE,
  })}`;
  /** The stub's token request for a code: what it gets back. */
  const exchange = async (code: string) => {
    const res = await request.post(`${CMS_URL}/api/auth/oauth2/token`, {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: CALLBACK, client_id: clientId, resource: RESOURCE },
    });
    return { status: res.status(), body: (await res.json()) as { scope?: string; access_token?: string } };
  };
  return { clientId, authorizeUrl, exchange, dispose: () => request.dispose() };
}

/** The URL the page sends the browser to at the stub's callback, answered by the stub. */
async function callbackOf(page: Page, act: () => Promise<void>): Promise<URL> {
  let reached: URL | undefined;
  await page.route(`${CALLBACK}**`, async (route) => {
    reached = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'You can close this window.' });
  });
  await act();
  await expect.poll(() => reached?.href).toBeTruthy();
  await page.unroute(`${CALLBACK}**`);
  return reached!;
}

test('an agent connects: sign in and back, pick an org and scopes, Allow gives the stub a code; Cancel gives access_denied', async ({ page, browser }) => {
  const email = `e2e-connect-${Date.now()}@example.com`;
  // The person, with two orgs: set up in their own browser first.
  const setup = await browser.newPage();
  await signInAs(setup, email, ADDRESS.person);
  await createOrg(setup, 'Quayside Market', ADDRESS.person);
  await createOrg(setup, 'Harbour Café', ADDRESS.person);
  await setup.close();

  const stub = await stubClient();
  // Signed out: the provider sends the browser to /connect, which sends it through sign-in and back.
  await fromAddress(page, ADDRESS.person);
  await page.goto(stub.authorizeUrl);
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fconnect/);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Test agent wants to work in SignForge' })).toBeVisible();
  await hydrated(page);
  await expect(page).toHaveURL(/\/connect\?q=/);

  // The controls wait for the page to hydrate.
  const connectPath = new URL(page.url()).pathname + new URL(page.url()).search;
  expect(await disabledOnServer(page, connectPath, ['Allow', 'Cancel', 'Organisation'])).toEqual({ Allow: [true], Cancel: [true], Organisation: [true] });

  // Neither page in the way here can be framed by another site (clickjacking Allow).
  for (const path of [connectPath, '/sign-in']) {
    const headers = (await page.request.get(path)).headers();
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['content-security-policy'], path).toBe("frame-ancestors 'none'");
  }

  // What it says: the client is unverified, where it sends the person, and what reading shares.
  await expect(page.getByText('Unverified', { exact: true })).toBeVisible();
  await expect(page.getByText('Unverified: SignForge has not checked who made this app. It sends you back to 127.0.0.1:33418.')).toBeVisible();
  await expect(page.getByText('the team list with names and email addresses')).toBeVisible();
  await expect(page.getByText('The connection works in this organisation only.')).toBeVisible();
  const read = page.getByRole('checkbox', { name: /See your content and screens/ });
  await expect(read).toBeChecked();
  await expect(read).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /Make and edit drafts/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Publish to live screens/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Manage the organisation/ })).not.toBeChecked();
  await axe(page);
  // Tall enough for the whole card, the buttons and the note under it.
  await page.setViewportSize({ width: 1280, height: 1150 });
  await shots(page, '30-connect-agent');

  // Publishing on: the warning names the org.
  await page.getByLabel('Organisation', { exact: true }).selectOption({ label: 'Quayside Market' });
  await page.getByRole('checkbox', { name: /Publish to live screens/ }).check();
  await expect(page.getByRole('status')).toContainText('Test agent will be able to change what every screen in Quayside Market shows without asking.');
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
  const invited = await owner.request.post('/api/auth/organization/invite-member', {
    headers: { origin: CMS_URL },
    data: { email: editorEmail, role: 'editor' },
  });
  expect(invited.status(), await invited.text()).toBe(200);
  const { id: invitationId } = (await invited.json()) as { id: string };
  await owner.close();

  await signInAs(page, editorEmail, ADDRESS.editor);
  const accepted = await page.request.post('/api/auth/organization/accept-invitation', { headers: { origin: CMS_URL }, data: { invitationId } });
  expect(accepted.status(), await accepted.text()).toBe(200);
  const stub = await stubClient('Editor agent');
  await page.goto(stub.authorizeUrl);
  await expect(page.getByRole('heading', { name: 'Editor agent wants to work in SignForge' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'SignForge CLI wants to work in SignForge' })).toBeVisible();
  await expect(page.getByText('A SignForge app. It sends you back to 127.0.0.1:40123.')).toBeVisible();
  await expect(page.getByText('Unverified', { exact: true })).toHaveCount(0);
});
