// The approvals queue (M4-10, #115): an agent without content:publish asks to publish its edit of a
// spot; the owner sees the count in the sidebar and the banner on API & agents, opens the queue, sees
// the spot on the real player as screens have it and as approving publishes it, and approves after a
// confirmation that lists exactly what the request pinned and the sample text it publishes: the
// rollout starts. A second request is declined, put back with Undo, and declined again: the draft
// stays a draft, and the agent's get_publish_request says declined. An editor who may not publish
// sees the queue without its actions. Light and dark, desktop and phone, with axe at each.
import { expect, test, type Page } from '@playwright/test';
import { callbackOf, stubClient } from './agent-stub';
import { axe, createOrg, d1, hydrated, joinAsEditor, shots, signInAs, stageShows, tool } from './helpers';
import { API_PORT } from './servers';

/** This spec's own client addresses, so its sign-ins, pairing and registration have their own rate limits. */
const ADDRESS = { owner: '192.0.2.221', stub: '192.0.2.222', screen: '192.0.2.223', editor: '192.0.2.224' };
const DEVICE = `http://127.0.0.1:${API_PORT}/v1/device`;

/** A screen paired from its own address, as a device pairs. */
async function pairScreen(page: Page, name: string) {
  const headers = { 'cf-connecting-ip': ADDRESS.screen };
  const start = await page.request.post(`${DEVICE}/pair/start`, { headers });
  expect(start.status()).toBe(200);
  const { code } = (await start.json()) as { code: string };
  const claimed = await page.request.post('/api/tools/claim_screen', {
    headers: { 'cf-connecting-ip': ADDRESS.owner },
    data: { code, name, timezone: 'UTC', orientation: 'landscape' },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
  return ((await claimed.json()) as { screen: { id: string } }).screen.id;
}

test('an agent asks, the owner approves what it pinned and the rollout starts; another is declined, put back and declined; one who may not publish sees no actions', async ({
  page,
  browser,
}) => {
  await signInAs(page, `e2e-approvals-${Date.now()}@example.com`, ADDRESS.owner);
  await createOrg(page, 'Saltmarsh Deli', ADDRESS.owner);
  const screenId = await pairScreen(page, 'Deli counter');
  // The soup board, on a default playlist, published: the screen plays it.
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock')).versions.at(-1).id;
  const { spot } = await tool(page, 'create_spot', {
    name: 'Soup board',
    kind: 'template',
    templateVersionId: clock,
    durationMs: 10_000,
    data: { greeting: 'Soup of the day' },
  });
  const { playlist } = await tool(page, 'create_playlist', { name: 'Deli', transition: { type: 'cut' }, spotIds: [spot.id] });
  await tool(page, 'set_default_playlist', { playlistId: playlist.id });
  await tool(page, 'publish', {});

  // The agent connects with drafting only, edits the board and asks to publish it.
  const stub = await stubClient('Deli helper', ADDRESS.stub);
  await page.goto(stub.authorizeUrl);
  await hydrated(page);
  const back = await callbackOf(page, () => page.getByRole('button', { name: 'Allow' }).click());
  const token = (await stub.exchange(back.searchParams.get('code')!)).body.access_token!;
  const call = async (name: string, args: unknown) => {
    const { result } = await stub.mcp(token, 'tools/call', { name, arguments: args });
    expect(result.isError, JSON.stringify(result)).toBeUndefined();
    return result.structuredContent;
  };
  const edit = async (greeting: string) => {
    const { spot: now } = await call('get_spot', { spotId: spot.id });
    return (await call('update_spot', { spotId: spot.id, data: { greeting }, ifVersion: now.version })).spot.version as number;
  };
  const asked = async (greeting: string, reason: string) => {
    const version = await edit(greeting);
    return (await call('request_publish', { drafts: [{ kind: 'spot', id: spot.id, version }], reason })).request.id as string;
  };
  const first = await asked('Tomato basil soup', 'Today’s soup is tomato basil.');
  const version = (await tool(page, 'get_spot', { spotId: spot.id })).spot.version as number;
  // Its greeting still the template's sample text, as the server records it (#360): approving acknowledges it, exactly.
  await d1(`UPDATE spots SET sample_fields_json = '{"texts":["greeting"],"lists":{}}' WHERE id = '${spot.id}'`);

  // The sidebar counts it, and API & agents says it waits, with the way to it.
  await page.goto('/settings/api');
  await hydrated(page);
  await expect(page.getByRole('link', { name: /Approvals.*1 waiting/ })).toBeVisible();
  const banner = page.getByRole('region', { name: '1 publish waiting for approval' });
  await expect(banner).toContainText('Agents without content:publish asked to put these on screens.');
  await banner.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for approval', level: 1 })).toBeVisible();
  await hydrated(page);

  const card = page.getByRole('article', { name: 'Publish Soup board' });
  await expect(card).toContainText('Deli helper, agent via MCP');
  await expect(card).toContainText('Asked for: “Today’s soup is tomato basil.”');
  await expect(card).toContainText('1 field change · 1 screen: Deli counter · approving publishes as you');
  // The stage split: what screens play now, and what approving publishes, each on the real player.
  await expect(card.getByText('Now on 1 screen · v1')).toBeVisible();
  await expect(card.getByText(`After approval · Draft ${version}`)).toBeVisible();
  await expect(card.locator('iframe')).toHaveCount(2);
  // Each player plays its own: the board as published, and the agent's edit.
  await expect.poll(() => stageShows(page, 'Soup of the day')).toBe(true);
  await expect.poll(() => stageShows(page, 'Tomato basil soup')).toBe(true);
  await expect(card.getByRole('link', { name: 'Open draft' })).toHaveAttribute('href', `/spots/${spot.id}`);
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await shots(page, '70-approvals');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '70-approvals-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Approve asks first, with exactly what it pinned and the sample text it publishes anyway.
  await card.getByRole('button', { name: 'Approve and publish' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Approve and publish?' });
  await expect(confirm.getByRole('list', { name: 'The drafts it publishes' })).toHaveText(`Spot Soup board, version ${version}`);
  await expect(confirm).toContainText('Screens: 1 screen: Deli counter.');
  await expect(confirm.getByRole('list', { name: 'Sample text it publishes' })).toHaveText(`Soup board, version ${version}: greeting`);
  await axe(page);
  await shots(page, '70-approvals-confirm');
  const approving = page.waitForRequest((r) => r.url().endsWith('/api/tools/approve_publish_request'));
  await confirm.getByRole('button', { name: 'Approve and publish anyway' }).click();
  expect((await approving).postDataJSON()).toEqual({
    publishRequestId: first,
    allowSample: [{ spotId: spot.id, version, fields: ['greeting'] }],
  });
  await expect(page.getByText('Approved. Rollout started.')).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Nothing is waiting for approval' })).toBeVisible();
  // The rollout started: the approval's publish reaches the screen, as the approver.
  const approved = (await call('get_publish_request', { publishRequestId: first })).request;
  expect(approved.status).toBe('approved');
  const { publish } = await tool(page, 'get_publish', { publishId: approved.publishId });
  expect(publish).toMatchObject({ revision: 2, screens: 1 });

  // A second: declined, put back with Undo, declined again. The draft stays a draft, and the agent reads it declined.
  const second = await asked('Leek and potato soup', 'Tomorrow’s soup.');
  await page.reload();
  await hydrated(page);
  const next = page.getByRole('article', { name: 'Publish Soup board' });
  await next.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByText('Declined. The agent is told.')).toBeVisible();
  await expect(next).toHaveCount(0);
  await page.locator('[data-sonner-toast]').filter({ hasText: 'Declined. The agent is told.' }).getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Put back. It is waiting for approval again.')).toBeVisible();
  await expect(next).toBeVisible();
  await next.getByRole('button', { name: 'Decline' }).click();
  await expect(next).toHaveCount(0);
  expect((await call('get_publish_request', { publishRequestId: second })).request.status).toBe('declined');
  expect((await tool(page, 'get_spot', { spotId: spot.id })).spot).toMatchObject({ draftChanged: true, data: { greeting: 'Leek and potato soup' } });

  // An editor where only owners publish sees a request waiting, without Approve or Decline.
  const third = await asked('Pea soup', 'The day after.');
  await tool(page, 'update_org_settings', { editorsPublish: false });
  const editor = await (await browser.newContext()).newPage();
  await joinAsEditor(page, editor, `e2e-approvals-editor-${Date.now()}@example.com`, ADDRESS.editor);
  await editor.goto('/approvals');
  await hydrated(editor);
  const theirs = editor.locator(`article#${third}`);
  await expect(theirs).toContainText('only someone who may publish can approve it');
  await expect(theirs.getByRole('button')).toHaveCount(0);
  await expect(theirs.getByRole('link', { name: 'Open draft' })).toBeVisible();
  await expect(editor.getByRole('link', { name: /waiting/ })).toHaveCount(0);
  await axe(editor);
  await stub.dispose();
});
