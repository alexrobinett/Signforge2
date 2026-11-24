// An agent's draft in the spot editor (M4-11, #116): a person edits a published spot, then an agent
// over /mcp edits it on top. The editor says it is the agent's proposal, by its name, with what it
// changes against the published version and the spot's audit log. Reject puts the person's edit back,
// not the published version; its Undo puts the agent's back; Keep makes it the draft. Light and dark,
// desktop and phone, with axe at each.
import { expect, test } from '@playwright/test';
import { connectStub } from './agent-stub';
import { axe, createOrg, hydrated, shots, signInAs, tool } from './helpers';

/** This spec's own client addresses, so its sign-in and registration have their own rate limits. */
const ADDRESS = { owner: '192.0.2.231', stub: '192.0.2.232' };

test("an agent's edit over /mcp shows as its proposal; Reject puts the person's edit back, Undo the agent's, and Keep makes it the draft", async ({ page }) => {
  await signInAs(page, `e2e-proposals-${Date.now()}@example.com`, ADDRESS.owner);
  await createOrg(page, 'Pickle Row', ADDRESS.owner);
  const { templates } = await tool(page, 'list_templates', { status: 'approved' });
  const clock = templates.find((t: { key: string }) => t.key === 'clock' || t.key.endsWith('/clock'));
  const version = clock.versions.at(-1);
  const label: string = version.manifest.fields.greeting.label;
  const { spot } = await tool(page, 'create_spot', {
    name: 'Soup board',
    kind: 'template',
    templateVersionId: version.id,
    durationMs: 10_000,
    data: { greeting: 'Soup of the day' },
  });
  await tool(page, 'publish', {});
  // The person edits it after the publish: their draft, not on screens yet.
  const mine = (await tool(page, 'update_spot', { spotId: spot.id, data: { greeting: 'Opening soon' }, ifVersion: spot.version })).spot.version as number;

  // An agent with drafting only edits it on top, over /mcp.
  const { stub, token } = await connectStub(page, 'Deli bot', ADDRESS.stub);
  const edited = await stub.mcp(token, 'tools/call', {
    name: 'update_spot',
    arguments: { spotId: spot.id, data: { greeting: 'Tomato basil soup' }, ifVersion: mine },
  });
  expect(edited.result.isError).toBeUndefined();
  const theirs = edited.result.structuredContent.spot.version as number;

  await page.goto(`/spots/${spot.id}`);
  await hydrated(page);
  const panel = page.getByRole('region', { name: /Agent's draft/ });
  await expect(panel).toContainText(`Draft ${theirs} · Proposed by Deli bot, via MCP`);
  // What it changes against the published version: the person's edit is not what screens have.
  const row = panel.getByRole('row', { name: label });
  await expect(row.getByRole('deletion')).toHaveText('“Soup of the day”');
  await expect(row.getByRole('insertion')).toHaveText('“Tomato basil soup”');
  await expect(panel.getByRole('listitem').first()).toContainText('Deli bot, agent');
  await expect(panel.getByRole('heading', { name: 'Audit log for this spot' })).toBeVisible();
  await expect(panel.getByRole('listitem').first()).toContainText('Draft changed');
  await axe(page);
  await page.setViewportSize({ width: 1280, height: 1100 });
  await shots(page, '72-agent-draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await axe(page);
  await shots(page, '72-agent-draft-phone');
  await page.setViewportSize({ width: 1280, height: 900 });

  // Reject: the person's edit, not the published version.
  await panel.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText("Rejected the agent's draft")).toBeVisible();
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId: spot.id })).spot.data.greeting).toBe('Opening soon');
  const rejected = page.getByRole('region', { name: /Rejected/ });
  await expect(rejected.getByRole('button', { name: "Put the agent's draft back" })).toBeVisible();
  // Its Undo: the agent's, a proposal again.
  await page.locator('[data-sonner-toast]').filter({ hasText: "Rejected the agent's draft" }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await tool(page, 'get_spot', { spotId: spot.id })).spot.data.greeting).toBe('Tomato basil soup');
  await expect(panel).toBeVisible();
  // Keep: the draft, no longer a proposal; nothing published.
  await panel.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText("Kept the agent's draft")).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect((await tool(page, 'get_agent_draft', { spotId: spot.id })).proposed).toBe(false);
  expect((await tool(page, 'get_spot', { spotId: spot.id })).spot).toMatchObject({ draftChanged: true, data: { greeting: 'Tomato basil soup' } });
  await stub.dispose();
});
